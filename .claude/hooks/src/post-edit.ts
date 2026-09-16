/**
 * PostToolUse hook on file-editing tools: formats each edited file with Prettier, then typechecks the
 * package that owns it. Problems go to stderr with exit 2 so the agent sees them. The hook fails open:
 * if it cannot run, it exits 1, which Claude Code does not treat as a block.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as prettier from "prettier";

import { BLOCK_EXIT_CODE, projectDir, readHookInput, targetFilePaths } from "./hook-io.ts";

const TYPECHECKED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const TYPECHECK_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_LINES = 30;
const MAX_OUTPUT_CHARS = 4_000;
const TSC = path.join(import.meta.dirname, "..", "node_modules", "typescript", "bin", "tsc");

export function truncate(output: string): string {
  const lines = output.trimEnd().split("\n");
  let text = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
  if (text.length > MAX_OUTPUT_CHARS) {
    text = text.slice(0, MAX_OUTPUT_CHARS);
  }
  const omitted = lines.length > MAX_OUTPUT_LINES || text.length < output.trimEnd().length;
  return omitted ? `${text}\n… output truncated` : text;
}

/** The nearest directory at or above `filePath` that has a package.json. */
export function owningPackageDir(filePath: string): string | undefined {
  let dir = path.dirname(filePath);
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/** Formats `filePath` in place. Returns a problem description, or undefined when all is well. */
export async function formatFile(filePath: string, root: string): Promise<string | undefined> {
  const info = await prettier.getFileInfo(filePath, {
    ignorePath: [path.join(root, ".prettierignore")],
    resolveConfig: true,
  });
  if (info.ignored || info.inferredParser === null) {
    return undefined;
  }
  try {
    const source = readFileSync(filePath, "utf8");
    const options = (await prettier.resolveConfig(filePath)) ?? {};
    const formatted = await prettier.format(source, { ...options, filepath: filePath });
    if (formatted !== source) {
      writeFileSync(filePath, formatted);
    }
    return undefined;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return `Prettier could not format ${filePath}:\n${truncate(detail)}`;
  }
}

/** Typechecks the package that owns `filePath`. Returns a problem description, or undefined. */
export function typecheckOwningPackage(filePath: string): string | undefined {
  if (!TYPECHECKED_EXTENSIONS.has(path.extname(filePath))) {
    return undefined;
  }
  const packageDir = owningPackageDir(filePath);
  if (packageDir === undefined || !existsSync(path.join(packageDir, "tsconfig.json"))) {
    return undefined;
  }
  const result = spawnSync(
    process.execPath,
    [TSC, "--noEmit", "--pretty", "false", "-p", "tsconfig.json"],
    {
      cwd: packageDir,
      encoding: "utf8",
      timeout: TYPECHECK_TIMEOUT_MS,
    },
  );
  if (result.error) {
    return `Typecheck of ${packageDir} did not finish (${result.error.message}).`;
  }
  if (result.status === 0) {
    return undefined;
  }
  return `Typecheck failed in ${packageDir} after editing ${filePath}:\n${truncate(result.stdout + result.stderr)}`;
}

async function main(): Promise<void> {
  const input = readHookInput();
  const root = projectDir(input);
  const problems: string[] = [];
  for (const target of targetFilePaths(input)) {
    const filePath = path.resolve(input.cwd ?? root, target);
    if (!existsSync(filePath) || filePath.split(path.sep).includes("node_modules")) {
      continue;
    }
    const formatProblem = await formatFile(filePath, root);
    const typeProblem = typecheckOwningPackage(filePath);
    problems.push(...[formatProblem, typeProblem].filter((p) => p !== undefined));
  }
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n\n")}\n`);
    process.exit(BLOCK_EXIT_CODE);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`post-edit hook could not run: ${detail}\n`);
    process.exit(1);
  });
}
