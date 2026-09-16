#!/usr/bin/env node
// Deterministic helpers for the /ship skill. Reads a story issue with `gh` and prints plain text.
//
//   node story.mjs branch <issue>              suggested branch name story-<id>-<slug>
//   node story.mjs pr-body <issue>             "Closes #N" + the Verification section as a checklist
//   node story.mjs touchable <issue>           Touchable files, one pattern per line (notes after a tab)
//   node story.mjs scope <issue> [base]        changed files vs Touchable files; exit 1 if any is outside
//   node story.mjs languages [base]            owning manifest per changed file; exit 1 if unsupported
//
// `base` defaults to origin/main. Exit 2 means the helper itself could not run.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const MANIFESTS = [
  ["package.json", "typescript"],
  ["pyproject.toml", "python"],
  ["requirements.txt", "python"],
  ["go.mod", "go"],
  ["Cargo.toml", "rust"],
  ["pom.xml", "java"],
  ["build.gradle", "java"],
  ["build.gradle.kts", "kotlin"],
];
const SUPPORTED_LANGUAGES = new Set(["typescript"]);
const STOPWORDS = new Set(["a", "an", "and", "the", "of", "for", "to", "with", "in", "on"]);

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();

function readIssue(number) {
  if (!/^\d+$/.test(number ?? "")) {
    throw new Error(`expected an issue number, got "${String(number)}"`);
  }
  return JSON.parse(run("gh", ["issue", "view", number, "--json", "number,title,body"]));
}

/** Lines under the first `## <name>...` heading, up to the next `## ` heading. */
function section(body, name) {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) =>
    line.toLowerCase().startsWith(`## ${name.toLowerCase()}`),
  );
  if (start === -1) {
    throw new Error(`issue has no "## ${name}" section`);
  }
  const end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/** Bullet items, with wrapped continuation lines joined. Non-bullet lines are items of their own. */
function items(lines) {
  const result = [];
  let current;
  for (const line of lines) {
    const bullet = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (bullet) {
      current = bullet[1].trim();
      result.push(current);
    } else if (line.trim() === "") {
      current = undefined;
    } else if (current !== undefined && /^\s/.test(line)) {
      result[result.length - 1] = `${result[result.length - 1]} ${line.trim()}`;
    } else {
      current = line.trim();
      result.push(current);
    }
  }
  return result;
}

/** Splits on commas that are not inside parentheses. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let part = "";
  for (const char of text) {
    depth += char === "(" ? 1 : char === ")" ? -1 : 0;
    if (char === "," && depth === 0) {
      parts.push(part);
      part = "";
    } else {
      part += char;
    }
  }
  parts.push(part);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** [{ pattern, note }] where note is the parenthetical restriction, if any. */
function touchable(body) {
  return items(section(body, "Touchable files"))
    .flatMap(splitTopLevel)
    .map((entry) => {
      const match = /^`?([^`(]+?)`?\s*(?:\((.*)\))?$/.exec(entry);
      return { pattern: (match?.[1] ?? entry).trim(), note: match?.[2]?.trim() ?? "" };
    });
}

function changedFiles(base) {
  return run("git", ["diff", "--name-only", `${base}...HEAD`])
    .split("\n")
    .filter(Boolean);
}

function owningManifest(file, root) {
  let dir = path.dirname(path.join(root, file));
  for (;;) {
    for (const [manifest, language] of MANIFESTS) {
      if (existsSync(path.join(dir, manifest))) {
        return { manifest: path.relative(root, path.join(dir, manifest)), language };
      }
    }
    if (dir === root || dir === path.dirname(dir)) {
      return undefined;
    }
    dir = path.dirname(dir);
  }
}

const commands = {
  branch([number]) {
    const { title } = readIssue(number);
    const match = /^STORY-(\d+[a-z]?)\s*:?\s*(.*)$/i.exec(title);
    if (!match) {
      throw new Error(`title "${title}" does not start with STORY-<id>`);
    }
    const words = match[2]
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word && !STOPWORDS.has(word))
      .slice(0, 4);
    console.log(`story-${match[1].toLowerCase()}-${words.join("-")}`);
    return 0;
  },

  "pr-body"([number]) {
    const issue = readIssue(number);
    const checklist = items(section(issue.body, "Verification")).map((item) => `- [ ] ${item}`);
    console.log(
      [
        `Closes #${issue.number}`,
        "",
        "## Verification",
        "",
        ...checklist,
        "",
        "## Evidence",
        "",
      ].join("\n"),
    );
    return 0;
  },

  touchable([number]) {
    for (const { pattern, note } of touchable(readIssue(number).body)) {
      console.log(note ? `${pattern}\t${note}` : pattern);
    }
    return 0;
  },

  scope([number, base = "origin/main"]) {
    const entries = touchable(readIssue(number).body);
    let outside = 0;
    for (const file of changedFiles(base)) {
      const entry = entries.find(({ pattern }) => path.matchesGlob(file, pattern));
      if (!entry) {
        outside += 1;
        console.log(`OUTSIDE\t${file}`);
      } else if (entry.note) {
        console.log(`CHECK\t${file}\t${entry.note}`);
      } else {
        console.log(`OK\t${file}`);
      }
    }
    return outside === 0 ? 0 : 1;
  },

  languages([base = "origin/main"]) {
    const root = run("git", ["rev-parse", "--show-toplevel"]);
    let unsupported = 0;
    for (const file of changedFiles(base)) {
      const owner = owningManifest(file, root);
      const language = owner?.language ?? "unknown";
      const ok = SUPPORTED_LANGUAGES.has(language);
      unsupported += ok ? 0 : 1;
      console.log(`${ok ? "OK" : "UNSUPPORTED"}\t${language}\t${owner?.manifest ?? "-"}\t${file}`);
    }
    return unsupported === 0 ? 0 : 1;
  },
};

const [name, ...args] = process.argv.slice(2);
const command = commands[name];
if (!command) {
  console.error(`usage: story.mjs ${Object.keys(commands).join(" | ")} ...`);
  process.exit(2);
}
try {
  process.exit(command(args));
} catch (error) {
  console.error(`story.mjs ${name}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
