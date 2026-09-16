/** PreToolUse hook on `Bash`: blocks destructive commands listed in `rules.ts`. */
import { blockMessage, exitBlocked, runGuard } from "./hook-io.ts";
import { bashRules } from "./rules.ts";
import type { BashRule } from "./rules.ts";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Tools that load a different environment, so an inline DATABASE_URL may not be what runs. */
const ENV_LOADERS = /\b(?:dotenv|env-cmd|source)\b|--env-file/;

/**
 * Lowercased, whitespace-collapsed forms of a command: one as written, one with quotes, backslashes
 * and SQL block comments removed, so `DR""OP  TABLE` and `drop/**\/table` still match.
 */
export function normaliseCommand(command: string): string[] {
  const collapse = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
  const written = collapse(command.replace(/\\\r?\n/g, " "));
  const stripped = collapse(
    command
      .replace(/\\\r?\n/g, " ")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/["'`\\]/g, ""),
  );
  return [written, stripped];
}

export function isLocalDatabaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return LOCAL_HOSTS.has(parsed.hostname) && !parsed.searchParams.has("host");
  } catch {
    return false;
  }
}

const databaseUrls = (text: string): string[] =>
  [...text.matchAll(/DATABASE_URL=(?:"([^"]*)"|'([^']*)'|(\S+))/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );

const matchesRule = (rule: BashRule, text: string): boolean =>
  normaliseCommand(text).some((form) => rule.pattern.test(form));

/**
 * True only if every command segment that matches `rule` sets DATABASE_URL inline in that same
 * segment, and every DATABASE_URL anywhere in the command is a local database.
 */
export function targetsLocalDatabase(rule: BashRule, command: string): boolean {
  if (ENV_LOADERS.test(command) || !databaseUrls(command).every(isLocalDatabaseUrl)) {
    return false;
  }
  const matching = command.split(/[;&|\n]+/).filter((segment) => matchesRule(rule, segment));
  return matching.length > 0 && matching.every((segment) => databaseUrls(segment).length > 0);
}

/** The first rule that blocks `command`, if any. */
export function findBlockingBashRule(command: string): BashRule | undefined {
  return bashRules.find(
    (rule) =>
      matchesRule(rule, command) &&
      !(rule.allowWhenLocalTarget && targetsLocalDatabase(rule, command)),
  );
}

if (import.meta.main) {
  runGuard("guard-bash", (input) => {
    const { command } = input.toolInput;
    if (typeof command !== "string") {
      throw new Error("Bash input has no string command");
    }
    const rule = findBlockingBashRule(command);
    if (rule) {
      exitBlocked(blockMessage(rule, command));
    }
  });
}
