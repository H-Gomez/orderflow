/**
 * Checks an agent comment against docs/conventions/agent-comments.md (STORY #48).
 * Only the mechanically checkable rules live here; bullet count and length are for the reader.
 */

export const STATUS_WORDS = ["ACTION NEEDED", "FYI", "BLOCKED", "DONE"] as const;

/** Most non-blank lines allowed outside `<details>` blocks. */
export const MAX_VISIBLE_LINES = 12;

export type LintResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const STATUS_LINES: ReadonlySet<string> = new Set(STATUS_WORDS.map((word) => `**${word}**`));
const DETAILS_OPEN = /<details[\s>]/gi;
const DETAILS_CLOSE = /<\/details\s*>/gi;

const countMatches = (line: string, pattern: RegExp): number => line.match(pattern)?.length ?? 0;

/** Returns `ok: false` with a one-line reason for the first rule the comment breaks. */
export function lintComment(body: string): LintResult {
  const lines = body.split(/\r?\n/);

  const firstLine = lines.find((line) => line.trim() !== "")?.trim();
  if (firstLine === undefined || !STATUS_LINES.has(firstLine)) {
    return {
      ok: false,
      reason: `line 1 must be one of ${[...STATUS_LINES].join(", ")}; got ${JSON.stringify(firstLine ?? "")}`,
    };
  }

  let depth = 0;
  let visible = 0;
  for (const line of lines) {
    const opens = countMatches(line, DETAILS_OPEN);
    const closes = countMatches(line, DETAILS_CLOSE);
    // A line that opens, closes or sits inside a fold counts as folded.
    if (line.trim() !== "" && depth === 0 && opens === 0 && closes === 0) {
      visible += 1;
    }
    depth = Math.max(0, depth + opens - closes);
  }

  if (depth > 0) {
    return { ok: false, reason: "a <details> block is opened and never closed" };
  }
  if (visible > MAX_VISIBLE_LINES) {
    return {
      ok: false,
      reason: `${String(visible)} non-blank lines sit outside <details>; the limit is ${String(MAX_VISIBLE_LINES)}`,
    };
  }
  return { ok: true };
}
