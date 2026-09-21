import { readFileSync } from "node:fs";

import { lintComment } from "./lint.ts";

/** Exit code for an unreadable stdin, distinct from 1 (the comment breaks the format). */
const INPUT_ERROR_EXIT_CODE = 2;

let body: string;
try {
  body = readFileSync(0, "utf8");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`comment-lint: cannot read stdin: ${message}\n`);
  process.exit(INPUT_ERROR_EXIT_CODE);
}

const result = lintComment(body);
if (!result.ok) {
  process.stderr.write(`comment-lint: ${result.reason}\n`);
  process.exit(1);
}
