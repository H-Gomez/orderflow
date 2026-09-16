/** PreToolUse hook on file-editing tools: blocks writes to the protected paths listed in `rules.ts`. */
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { blockMessage, exitBlocked, projectDir, runGuard, targetFilePaths } from "./hook-io.ts";
import { pathRules } from "./rules.ts";
import type { PathRule } from "./rules.ts";

/** Resolves symlinks in the longest existing prefix of `target`, which may not exist yet. */
export function realPath(target: string): string {
  const absolute = path.resolve(target);
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      return absolute;
    }
    existing = parent;
  }
  return path.join(realpathSync(existing), path.relative(existing, absolute));
}

/** The first rule that protects `filePath`, if any. Relative paths resolve against `cwd`. */
export function findBlockingPathRule(
  filePath: string,
  root: string,
  cwd: string,
): PathRule | undefined {
  const absolute = realPath(path.resolve(cwd, filePath));
  const relativePath = path
    .relative(realPath(root), absolute)
    .split(path.sep)
    .join("/")
    .toLowerCase();
  const baseName = path.basename(absolute).toLowerCase();
  return pathRules.find((rule) => rule.matches(relativePath, baseName));
}

if (import.meta.main) {
  runGuard("guard-paths", (input) => {
    const root = projectDir(input);
    for (const filePath of targetFilePaths(input)) {
      const rule = findBlockingPathRule(filePath, root, input.cwd ?? root);
      if (rule) {
        exitBlocked(blockMessage(rule, filePath));
      }
    }
  });
}
