import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { lintComment, MAX_VISIBLE_LINES, STATUS_WORDS } from "./lint.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

const VALID = `**ACTION NEEDED**
Review the diff and merge, or tell me what to change.

- ADR-002 is still TBD; picked X, reversible in one commit.
- Risk: the matching test is time-sensitive and may flake in CI.

<details><summary>Full notes</summary>

Every step, every command, every output.

\`\`\`
pnpm test
exit 0
\`\`\`

</details>
`;

const BAD_STATUS = `Done! Here is what I did.

<details><summary>Full notes</summary>
Notes.
</details>
`;

const TOO_LONG = `**FYI**
Nothing.

${Array.from({ length: MAX_VISIBLE_LINES - 1 }, (_, i) => `- point ${String(i + 1)}`).join("\n")}
`;

const UNCLOSED = `**DONE**
Nothing.

<details><summary>Full notes</summary>

Notes that never get folded shut.
`;

const lint = (body: string) =>
  spawnSync(process.execPath, [CLI], { input: body, encoding: "utf8" });

describe("lintComment", () => {
  it("accepts a comment in the format", () => {
    expect(lintComment(VALID)).toEqual({ ok: true });
  });

  it.each(STATUS_WORDS)("accepts the status word %s", (word) => {
    expect(lintComment(`**${word}**\nNothing.\n`)).toEqual({ ok: true });
  });

  it("rejects a first line that is not a bold status word", () => {
    const result = lintComment(BAD_STATUS);
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty("reason", expect.stringContaining("line 1") as unknown);
  });

  it.each(["", "**Done**", "DONE", "**DONE** with extra", "**MERGED**"])(
    "rejects the first line %j",
    (line) => {
      expect(lintComment(`${line}\nNothing.\n`).ok).toBe(false);
    },
  );

  it("rejects more than the limit of visible lines", () => {
    const result = lintComment(TOO_LONG);
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty(
      "reason",
      expect.stringContaining("outside <details>") as unknown,
    );
  });

  it("accepts exactly the limit of visible lines", () => {
    const lines = TOO_LONG.trimEnd().split("\n").slice(0, -1).join("\n");
    expect(lintComment(lines)).toEqual({ ok: true });
  });

  it("does not count lines inside <details>", () => {
    const folded = `**FYI**\nNothing.\n<details><summary>Full notes</summary>\n${"line\n".repeat(50)}</details>\n`;
    expect(lintComment(folded)).toEqual({ ok: true });
  });

  it("rejects a <details> block that is never closed", () => {
    const result = lintComment(UNCLOSED);
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty("reason", expect.stringContaining("never closed") as unknown);
  });
});

describe("cli", () => {
  it("exits 0 for a valid comment", () => {
    const run = lint(VALID);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
  });

  it.each([
    ["bad status", BAD_STATUS],
    ["too long", TOO_LONG],
    ["unclosed", UNCLOSED],
  ])("exits 1 with a one-line reason: %s", (_name, body) => {
    const run = lint(body);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/^comment-lint: [^\n]+\n$/);
  });
});
