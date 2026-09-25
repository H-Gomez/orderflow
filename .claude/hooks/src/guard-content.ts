/**
 * PreToolUse hook on file-editing tools: blocks writes whose content matches a rule in `rules.ts`.
 * It reads the text from the tool call's payload, never from disk, so it checks what is about to be
 * written rather than what is already there.
 */
import path from "node:path";

import { blockMessage, exitBlocked, projectDir, runGuard, targetFilePaths } from "./hook-io.ts";
import type { HookInput } from "./hook-io.ts";
import { realPath } from "./guard-paths.ts";
import { contentRules } from "./rules.ts";
import type { ContentRule } from "./rules.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Every piece of text the call is about to write: `content` for Write, `new_string` for Edit and
 * `edits[].new_string` for MultiEdit. Throws if there is none, so a payload we cannot read fails closed.
 */
export function pendingContent(input: HookInput): string[] {
  const { content, new_string: newString, edits } = input.toolInput;
  const texts: unknown[] = [content, newString];
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      texts.push(isRecord(edit) ? edit["new_string"] : undefined);
    }
  }
  const found = texts.filter((text): text is string => typeof text === "string");
  if (found.length === 0) {
    throw new Error(`${input.toolName} input has no content`);
  }
  return found;
}

export interface ContentMatch {
  readonly rule: ContentRule;
  readonly filePath: string;
  /** The text that matched, as written. */
  readonly statement: string;
}

/** The first rule the pending content breaks, if any. Relative paths resolve against `cwd`. */
export function findBlockingContent(input: HookInput, cwd: string): ContentMatch | undefined {
  for (const filePath of targetFilePaths(input)) {
    const baseName = path.basename(realPath(path.resolve(cwd, filePath))).toLowerCase();
    const rules = contentRules.filter((rule) => rule.appliesTo(baseName));
    if (rules.length === 0) {
      continue;
    }
    for (const text of pendingContent(input)) {
      for (const rule of rules) {
        const match = rule.pattern.exec(text);
        if (match) {
          return { rule, filePath, statement: match[0] };
        }
      }
    }
  }
  return undefined;
}

if (import.meta.main) {
  runGuard("guard-content", (input) => {
    const found = findBlockingContent(input, input.cwd ?? projectDir(input));
    if (found) {
      exitBlocked(blockMessage(found.rule, `${found.filePath} (${found.statement})`));
    }
  });
}
