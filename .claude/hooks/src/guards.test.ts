import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { BLOCK_EXIT_CODE } from "./hook-io.ts";
import { bashRules, contentRules, pathRules } from "./rules.ts";
import type { Rule } from "./rules.ts";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const FIXTURE_NAME = /^(?<ruleId>[a-z0-9-]+)\.(?<expect>block|allow)(?:\.[a-z0-9-]+)?\.json$/;

function runHook(script: string, stdin: string): { status: number | null; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: "/repo" };
  delete env["DATABASE_URL"];
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, script)], {
    input: stdin,
    encoding: "utf8",
    env,
  });
  return { status: result.status, stderr: result.stderr };
}

interface GuardSuite {
  readonly script: string;
  readonly fixtureDir: string;
  readonly rules: readonly Rule[];
}

const suites: readonly GuardSuite[] = [
  { script: "guard-bash.ts", fixtureDir: "bash", rules: bashRules },
  { script: "guard-paths.ts", fixtureDir: "paths", rules: pathRules },
  { script: "guard-content.ts", fixtureDir: "content", rules: contentRules },
];

describe.each(suites)("$script", ({ script, fixtureDir, rules }) => {
  const dir = path.join(FIXTURES, fixtureDir);
  const fixtures = readdirSync(dir).map((file) => {
    const groups = FIXTURE_NAME.exec(file)?.groups;
    return { file, ruleId: groups?.["ruleId"], expect: groups?.["expect"] };
  });

  it.each(rules.map((rule) => rule.id))(
    "rule %s has a block fixture and a near-miss fixture",
    (id) => {
      const expectations = fixtures.filter((f) => f.ruleId === id).map((f) => f.expect);
      expect(expectations).toContain("block");
      expect(expectations).toContain("allow");
    },
  );

  it.each(fixtures)("$file exits as its name says", ({ file, ruleId, expect: expected }) => {
    expect(
      rules.map((rule) => rule.id),
      `unknown rule in fixture name ${file}`,
    ).toContain(ruleId);
    const { status, stderr } = runHook(script, readFileSync(path.join(dir, file), "utf8"));
    if (expected === "block") {
      expect(status).toBe(BLOCK_EXIT_CODE);
      expect(stderr).toContain(`"${String(ruleId)}"`);
      expect(stderr).toContain(rules.find((rule) => rule.id === ruleId)?.reason);
      expect(stderr).toContain("CLAUDE.md");
    } else {
      expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
    }
  });

  it("fails closed on malformed JSON", () => {
    const { status, stderr } = runHook(
      script,
      readFileSync(path.join(FIXTURES, "malformed-input.txt"), "utf8"),
    );
    expect(status).toBe(BLOCK_EXIT_CODE);
    expect(stderr).toContain("fails closed");
  });

  it("fails closed on a payload without tool_input", () => {
    const { status } = runHook(script, JSON.stringify({ tool_name: "Bash" }));
    expect(status).toBe(BLOCK_EXIT_CODE);
  });
});

describe("guard-paths.ts", () => {
  it("fails closed when an edit names no file", () => {
    const payload = { tool_name: "Edit", tool_input: { old_string: "a", new_string: "b" } };
    expect(runHook("guard-paths.ts", JSON.stringify(payload)).status).toBe(BLOCK_EXIT_CODE);
  });

  it("checks every file in a multi-file edit", () => {
    const payload = {
      tool_name: "MultiEdit",
      tool_input: {
        edits: [{ file_path: "/repo/README.md" }, { file_path: "/repo/infra/prod/a.ts" }],
      },
    };
    expect(runHook("guard-paths.ts", JSON.stringify(payload)).status).toBe(BLOCK_EXIT_CODE);
  });

  it("resolves relative paths against the session cwd", () => {
    const payload = {
      cwd: "/repo/infra",
      tool_name: "Write",
      tool_input: { file_path: "prod/a.ts" },
    };
    expect(runHook("guard-paths.ts", JSON.stringify(payload)).status).toBe(BLOCK_EXIT_CODE);
  });
});
