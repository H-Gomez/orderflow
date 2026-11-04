import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { findBlockingBashWrite } from "./bash-writes.ts";
import { findBlockingPathRule } from "./guard-paths.ts";
import { BLOCK_EXIT_CODE } from "./hook-io.ts";
import { pathRules } from "./rules.ts";

const ROOT = "/repo";

const blockedBy = (command: string, cwd = ROOT, root = ROOT): string | null =>
  findBlockingBashWrite(command, root, cwd)?.rule.id ?? null;

/** A path each rule protects. The test below fails if a new rule has none. */
const SAMPLES: Readonly<Record<string, string>> = {
  "infra-prod": "infra/prod/main.ts",
  "secrets-env-file": ".env",
  "claude-settings": ".claude/settings.json",
  "claude-hooks": ".claude/hooks/src/rules.ts",
  "github-dir": ".github/workflows/ci.yml",
  "claude-md": "CLAUDE.md",
};

/** Every write construct from the story's Contract. `T` is the target. */
const WRITE_CONSTRUCTS: readonly string[] = [
  "echo x > T",
  "echo x >> T",
  "echo x >| T",
  "cat <> T",
  "echo x &> T",
  "echo x &>> T",
  "echo x 2> T",
  "echo x 2>> T",
  "echo x >T",
  "tee T",
  "tee -a a.txt T",
  "echo x | tee T",
  "cp a.txt T",
  "cp -r a.txt b.txt T",
  "cp -t T a.txt",
  "install a.txt T",
  "install -t T a.txt",
  "rsync a.txt T",
  "mv T b.txt",
  "mv a.txt T",
  "ln -s T b.txt",
  "ln -s a.txt T",
  "rm T",
  "rm -f T",
  "rmdir T",
  "unlink T",
  "shred T",
  "truncate -s 0 T",
  "touch T",
  "mkdir -p T",
  "chmod 644 T",
  "chown root T",
  "chgrp root T",
  "dd if=a.txt of=T",
  "sed -i s/a/b/ T",
  "sed -i.bak -e s/a/b/ T",
  "perl -i -pe s/a/b/ T",
  "perl -pi -e s/a/b/ T",
  "awk -i inplace 1 T",
  "prettier --write T",
  "git checkout -- T",
  "git checkout main T",
  "git restore T",
  "git rm T",
  "git mv T b.txt",
  "git mv a.txt T",
  "sudo rm T",
  "sudo -u root rm T",
  "env A=1 rm T",
  "command rm T",
  "exec rm T",
  "time rm T",
  "nice -n 5 rm T",
];

describe("the sample table", () => {
  it.each(pathRules.map((rule) => rule.id))("rule %s has a sample path", (id) => {
    expect(SAMPLES[id]).toBeDefined();
  });

  it.each(Object.entries(SAMPLES))("sample for %s is what that rule blocks", (id, sample) => {
    expect(findBlockingPathRule(sample, ROOT, ROOT)?.id).toBe(id);
  });
});

describe("matrix: every write construct against every rule's sample", () => {
  const cases = WRITE_CONSTRUCTS.flatMap((template) =>
    Object.entries(SAMPLES).map(([id, sample]) => ({
      command: template.replaceAll("T", sample),
      id,
    })),
  );
  it.each(cases)("$id: $command", ({ command, id }) => {
    expect(blockedBy(command)).toBe(id);
  });
});

/** `[command, rule id]`, or `[command, rule id, cwd]`. */
type BlockCase = readonly [string, string, string?];

const CHAINS_AND_EVASION: readonly BlockCase[] = [
  ["cd .claude/hooks && echo x > rules.ts", "claude-hooks"],
  ["cd .claude && cd hooks && rm rules.ts", "claude-hooks"],
  ["cd /tmp; cd /repo/.github; touch x", "github-dir"],
  ['F=.claude/settings.json; echo x > "$F"', "claude-settings"],
  ["F=.claude/settings.json; echo x > $F", "claude-settings"],
  ["F=.claude; echo x > ${F}/settings.json", "claude-settings"],
  ["export F=CLAUDE.md; echo x > $F", "claude-md"],
  ['echo x > ".claude/settings.json"', "claude-settings"],
  ["echo x > '.claude/settings.json'", "claude-settings"],
  ["echo x > .claude/settings\\.json", "claude-settings"],
  ["echo x > .cl\"aud\"e/set'tings'.json", "claude-settings"],
  ["echo x > .claude/x/../settings.json", "claude-settings"],
  ["echo x > ./docs/../CLAUDE.md", "claude-md"],
  ["echo x > /repo/CLAUDE.md", "claude-md"],
  ["rm -rf .claude", "claude-settings"],
  ["rm -rf .claude/", "claude-settings"],
  ["rm -rf .claude/*", "claude-settings"],
  ["rm .claude/sett*", "claude-settings"],
  ["rm -rf .claude/hoo?s", "claude-hooks"],
  ["rm .claude/{settings.json,x}", "claude-settings"],
  ["rm -rf .clau*/settings.json", "claude-settings"],
  ["rm -rf infra", "infra-prod"],
  ["rm -rf .", "infra-prod"],
  ["rm -rf *", "infra-prod"],
  ["rm -rf ..", "infra-prod"],
  ["mv .claude /tmp/x", "claude-settings"],
  ["chmod -R 777 .claude", "claude-settings"],
  ["git restore .", "infra-prod"],
  ["git checkout -- .", "infra-prod"],
  ["prettier --write .", "infra-prod"],
  ["echo x > .CLAUDE/Settings.JSON", "claude-settings"],
  ["echo x > claude.md", "claude-md"],
  ["echo x > .GitHub/a.yml", "github-dir"],
  ["echo ok && echo x > CLAUDE.md", "claude-md"],
  ["echo ok; echo x > CLAUDE.md", "claude-md"],
  ["false || echo x > CLAUDE.md", "claude-md"],
  ["echo ok\necho x > CLAUDE.md", "claude-md"],
  ["echo a | tee b.txt > CLAUDE.md", "claude-md"],
  ["> CLAUDE.md echo x", "claude-md"],
  ["(cd /tmp); echo x > CLAUDE.md", "claude-md"],
  ["(echo x > CLAUDE.md)", "claude-md"],
  ["{ echo x > CLAUDE.md; }", "claude-md"],
  ["if true; then echo x > CLAUDE.md; fi", "claude-md"],
  ["while true; do rm CLAUDE.md; done", "claude-md"],
  ["! rm CLAUDE.md", "claude-md"],
  ["/bin/rm CLAUDE.md", "claude-md"],
  ["\\rm CLAUDE.md", "claude-md"],
  ['"rm" CLAUDE.md', "claude-md"],
  ['echo "$(echo x > CLAUDE.md)"', "claude-md"],
  ["echo `rm CLAUDE.md`", "claude-md"],
  ["pnpm exec prettier --write CLAUDE.md", "claude-md"],
  ["npx prettier --write CLAUDE.md", "claude-md"],
  ["git -C .claude/hooks checkout -- src/rules.ts", "claude-hooks"],
  ['echo x > "$CLAUDE_PROJECT_DIR/CLAUDE.md"', "claude-md"],
  ["echo x > ${CLAUDE_PROJECT_DIR}/CLAUDE.md", "claude-md"],
  ["HOME=/repo; echo x > ~/CLAUDE.md", "claude-md"],
  ['HOME=/repo; echo x > "$HOME/CLAUDE.md"', "claude-md"],
  ["echo x > rules.ts", "claude-hooks", "/repo/.claude/hooks/src"],
  ["echo x > ../CLAUDE.md", "claude-md", "/repo/docs"],
  // Directory destinations: the file lands under the directory with the source's name.
  ["cp x/settings.json .claude/", "claude-settings"],
  ["mv x/settings.json .claude/", "claude-settings"],
  ["install x/settings.json .claude/", "claude-settings"],
  ["ln -s x/settings.json .claude/", "claude-settings"],
  ["rsync x/settings.json .claude/", "claude-settings"],
  ["cp -t .claude/ x/settings.json", "claude-settings"],
  ["cp -r x/CLAUDE.md y/ ./", "claude-md"],
  // A redirect on a heredoc is still a write.
  ["cat <<EOF > .claude/settings.json\nx\nEOF", "claude-settings"],
];

const INLINE_CODE: readonly BlockCase[] = [
  ['bash -c "echo x > .claude/settings.json"', "claude-settings"],
  ['sh -c "cat .claude/settings.json"', "claude-settings"],
  ['bash -lc "rm CLAUDE.md"', "claude-md"],
  ['eval "echo x > .github/a.yml"', "github-dir"],
  ["eval echo x \\> CLAUDE.md", "claude-md"],
  [`python3 -c "open('.claude/settings.json','w')"`, "claude-settings"],
  [`node -e "fs.writeFileSync('.claude/hooks/src/rules.ts','')"`, "claude-hooks"],
  [`perl -e "unlink 'CLAUDE.md'"`, "claude-md"],
  [`ruby -e "File.delete('INFRA/PROD/a')"`, "infra-prod"],
  // Heredocs split by receiver: an interpreter's stdin is code.
  [`python3 - <<'EOF'\nopen('.claude/settings.json','w').write('x')\nEOF`, "claude-settings"],
  [`python <<EOF\nopen('CLAUDE.md','w')\nEOF`, "claude-md"],
  [`node <<'EOF'\nrequire('fs').rmSync('.github')\nEOF`, "github-dir"],
  [`bash <<'EOF'\necho x > .claude/hooks/a\nEOF`, "claude-hooks"],
  [`sh <<< "rm CLAUDE.md"`, "claude-md"],
  [`cat <<'EOF' | python3\nopen('CLAUDE.md','w')\nEOF`, "claude-md"],
];

const UNRESOLVED: readonly string[] = [
  'echo x > "$UNKNOWN"',
  "echo x > $UNKNOWN",
  "echo x > ${UNKNOWN}",
  'echo x > "$UNKNOWN/settings.json"',
  'echo x > "$(mktemp)"',
  "echo x > `mktemp`",
  'rm "$UNKNOWN"',
  'tee "$UNKNOWN"',
  'sed -i s/a/b/ "$UNKNOWN"',
  "echo x > $'\\x2eenv'",
  'cd "$UNKNOWN" && echo x > y.txt',
  "F=$(mktemp); echo x > $F",
  'for f in a b; do sed -i s/x/y/ "$f"; done',
  "git apply x.patch",
  "git apply --check x.patch",
  "patch -p1 < x.patch",
  "patch a.txt x.patch",
];

describe("chains and evasion", () => {
  it.each(CHAINS_AND_EVASION)("blocks %j as %s", (command, id, cwd) => {
    expect(blockedBy(command, cwd ?? ROOT)).toBe(id);
  });
});

describe("inline code and interpreter heredocs", () => {
  it.each(INLINE_CODE)("blocks %j as %s", (command, id) => {
    expect(blockedBy(command)).toBe(id);
  });
});

describe("unresolved targets", () => {
  it.each(UNRESOLVED)("blocks %j", (command) => {
    expect(blockedBy(command)).toBe("bash-write-unresolved");
  });

  it("tells the agent to use a literal path", () => {
    expect(findBlockingBashWrite('echo x > "$UNKNOWN"', ROOT, ROOT)?.rule.reason).toContain(
      "literal path",
    );
  });
});

const ALLOWED: readonly string[] = [
  // The story's Invariants, one by one.
  "pnpm test",
  "pnpm build",
  "pnpm typecheck && pnpm lint",
  "pnpm install --frozen-lockfile",
  'git commit -m "feat: x"',
  "git commit -F /tmp/x",
  "git push",
  "git push -u origin story-72-x",
  'gh pr create --draft --title "x" --body-file /tmp/x',
  "prettier --write packages/db/src/x.ts",
  "pnpm exec prettier --write packages/db/src/x.ts",
  "cat .claude/settings.json",
  "grep -n x .claude/settings.json CLAUDE.md",
  "git diff -- .claude/hooks/src/rules.ts",
  "sed -n 1,5p .claude/settings.json",
  "sed -n 1,5p CLAUDE.md",
  "sed -e s/a/b/ .claude/hooks/src/rules.ts",
  "cp .claude/settings.json /tmp/x",
  "cp -r .claude/hooks/src /tmp/x",
  'echo ".claude/settings.json"',
  "echo '> .claude/settings.json'",
  'gh pr create --body "edit .claude/hooks and CLAUDE.md"',
  "cat <<EOF\necho x > .claude/settings.json\nEOF",
  "cat <<'EOF' > /tmp/x\nrm -rf .claude/hooks\nEOF",
  `git commit -m "$(cat <<'EOF'\nfix: don't write > CLAUDE.md (really)\nEOF\n)"`,
  "gh issue comment 72 --body-file - <<'EOF'\n.claude/settings.json\nEOF",
  "echo x > /dev/null",
  "ls 2> /dev/null",
  "echo x > .env.example",
  "echo x > .claude/hooks-notes.md",
  "echo x > .claude/hooks-proposed/src/rules.ts",
  "echo x 2>&1",
  "echo x >&2",
  "pnpm test > /tmp/x 2>&1",
  // Near misses of the rest of the construct table.
  "echo x > out.txt",
  "echo x > docs/CLAUDE.md",
  "echo x > .github-notes/a.md",
  "echo x > infra/staging/a.ts",
  "echo '$HOME' > literal.txt",
  "echo x > '$HOME'",
  "echo $UNKNOWN",
  'echo "$(mktemp)"',
  "cat < .claude/settings.json",
  "cat .env.example > /tmp/x",
  "rm -rf dist",
  "rm -rf packages/db/dist/*",
  "rm *.log",
  "rm -rf .claude/hooks-proposed",
  "mkdir -p .claude/agents/x",
  "touch .claude",
  "mkdir -p .claude",
  "git checkout main",
  "git switch --no-track -c story-72-x origin/main",
  "git status --porcelain",
  "git log --oneline -- CLAUDE.md",
  "git show HEAD:.claude/settings.json",
  "gh api -X PATCH repos/o/r/pulls/1 -F body=@/tmp/x",
  "node .claude/hooks/src/guard-bash.ts",
  "cd packages && echo x > y.ts",
  "cd .claude/hooks && cat src/rules.ts",
  "cd .claude/hooks && pnpm vitest run",
  "(cd .claude/hooks && cat a); echo x > out.txt",
  "F=out.txt; echo x > $F",
  // Inline code that does not mention a guarded root.
  'bash -c "pnpm test"',
  'bash -c "echo x > .claude/hooks-notes.md"',
  'python3 -c "print(1)"',
  'node -e "console.log(1)"',
  "python3 - <<'EOF'\nprint(1)\nEOF",
  "python3 script.py",
  'grep -c "bash -c" CLAUDE.md',
];

describe("allowed", () => {
  it.each(ALLOWED)("allows %j", (command) => {
    expect(blockedBy(command)).toBeNull();
  });
});

describe("symlinks", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bash-writes-"));
  mkdirSync(path.join(dir, ".claude", "hooks"), { recursive: true });
  mkdirSync(path.join(dir, "elsewhere"));
  symlinkSync(path.join(dir, ".claude", "hooks"), path.join(dir, "link"));
  symlinkSync(path.join(dir, "elsewhere"), path.join(dir, "safe-link"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("blocks a write through a real symlink into a guarded path", () => {
    expect(blockedBy("echo x > link/rules.ts", dir, dir)).toBe("claude-hooks");
    expect(blockedBy("cd link && echo x > rules.ts", dir, dir)).toBe("claude-hooks");
  });

  it("allows a write through a symlink that leads elsewhere", () => {
    expect(blockedBy("echo x > safe-link/a.txt", dir, dir)).toBeNull();
  });
});

describe("guard-bash.ts, spawned", () => {
  function runHook(command: string): { status: number | null; stderr: string } {
    const script = path.join(import.meta.dirname, "guard-bash.ts");
    const result = spawnSync(process.execPath, [script], {
      input: JSON.stringify({ cwd: ROOT, tool_name: "Bash", tool_input: { command } }),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
    });
    return { status: result.status, stderr: result.stderr };
  }

  it("exits 2 with the rule id on stderr for a guarded write", () => {
    const { status, stderr } = runHook("echo x > .claude/settings.json");
    expect(status).toBe(BLOCK_EXIT_CODE);
    expect(stderr).toContain('"claude-settings"');
  });

  it("exits 0 with empty stderr for a read of the same file", () => {
    expect(runHook("cat .claude/settings.json")).toEqual({ status: 0, stderr: "" });
  });

  it("fails closed when the command cannot be tokenized", () => {
    const { status, stderr } = runHook("echo 'unterminated");
    expect(status).toBe(BLOCK_EXIT_CODE);
    expect(stderr).toContain("fails closed");
  });
});

describe("drift against .claude/settings.json", () => {
  const settings: unknown = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "..", "..", "settings.json"), "utf8"),
  );
  const { deny } = (settings as { permissions: { deny: string[] } }).permissions;
  const samples = deny.map((entry) => ({
    entry,
    sample: entry
      .replace(/^(?:Edit|Write)\((.*)\)$/, "$1")
      .replace(/^\*\*\//, "")
      .replace(/\/\*\*$/, "/x"),
  }));

  it("has deny entries to check", () => {
    expect(samples.length).toBeGreaterThan(0);
  });

  it.each(samples)("pathRules blocks $sample ($entry)", ({ sample }) => {
    expect(findBlockingPathRule(sample, ROOT, ROOT)).toBeDefined();
  });
});

it("the table has at least 25 cases", () => {
  const total =
    WRITE_CONSTRUCTS.length * Object.keys(SAMPLES).length +
    CHAINS_AND_EVASION.length +
    INLINE_CODE.length +
    UNRESOLVED.length +
    ALLOWED.length;
  expect(total).toBeGreaterThanOrEqual(25);
});
