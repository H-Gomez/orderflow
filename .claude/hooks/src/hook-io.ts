import { readFileSync } from "node:fs";

import type { Rule } from "./rules.ts";

/** Exit code Claude Code treats as "block this tool call". Exit 1 does not block. */
export const BLOCK_EXIT_CODE = 2;

/** The subset of the Claude Code hook payload these hooks read. */
export interface HookInput {
  readonly cwd: string | undefined;
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Parses a hook payload. Throws on anything malformed, so callers fail closed. */
export function parseHookInput(raw: string): HookInput {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("hook input is not a JSON object");
  }
  const { cwd, tool_name: toolName, tool_input: toolInput } = parsed;
  if (typeof toolName !== "string") {
    throw new Error("hook input has no string tool_name");
  }
  if (!isRecord(toolInput)) {
    throw new Error("hook input has no object tool_input");
  }
  return { cwd: typeof cwd === "string" ? cwd : undefined, toolName, toolInput };
}

export function readHookInput(): HookInput {
  return parseHookInput(readFileSync(0, "utf8"));
}

/** Every file path a file-editing tool call targets. Throws if there is none. */
export function targetFilePaths(input: HookInput): string[] {
  const { file_path: filePath, notebook_path: notebookPath, edits } = input.toolInput;
  const paths = [filePath, notebookPath];
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      paths.push(isRecord(edit) ? edit["file_path"] : undefined);
    }
  }
  const found = paths.filter((p): p is string => typeof p === "string" && p.length > 0);
  if (found.length === 0) {
    throw new Error(`${input.toolName} input has no file path`);
  }
  return found;
}

/** The repository root: where the Claude Code session started. */
export function projectDir(input: HookInput | undefined): string {
  return process.env["CLAUDE_PROJECT_DIR"] ?? input?.cwd ?? process.cwd();
}

export function blockMessage(rule: Rule, subject: string): string {
  return [
    `Blocked by OrderFlow hook rule "${rule.id}": ${rule.reason}`,
    `Target: ${subject}`,
    "See CLAUDE.md (Invariants). If this is needed, ask a human to run it.",
  ].join("\n");
}

export function exitBlocked(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(BLOCK_EXIT_CODE);
}

/** Runs a PreToolUse guard. Any error, including unparseable input, blocks the call. */
export function runGuard(name: string, guard: (input: HookInput) => void): void {
  try {
    guard(readHookInput());
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    exitBlocked(
      `Blocked: the ${name} hook could not check this call (${detail}). It fails closed. See CLAUDE.md (Invariants).`,
    );
  }
}
