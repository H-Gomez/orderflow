/**
 * Finds the paths a Bash command writes to, so `guard-bash.ts` can check them against `pathRules`.
 *
 * This is a tripwire, not a sandbox. It cannot see a script that writes when run (`node x.js`,
 * `make`, `pnpm format`) or a path built at runtime. `/ship finish` scope checks and CODEOWNERS
 * remain the backstop. Only the writers in `writeRequests` are known: `find -delete`, `xargs rm` and
 * `git reset --hard` are not. The text check for inline code looks for declared `roots`, so it does
 * not see `.env`, which is a basename rule, or a path assembled in the code.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { findBlockingPathRule, realPath } from "./guard-paths.ts";
import { bashWriteUnresolvedRule, coversGuardedRoot, pathRules } from "./rules.ts";
import type { BashWriteRule, PathRule } from "./rules.ts";

/** How a piece of a word was quoted, which decides whether `$VAR` and globs apply to it. */
export type Quote = "none" | "single" | "double";

export interface WordPart {
  readonly text: string;
  readonly quote: Quote;
}

export interface WordToken {
  readonly kind: "word";
  readonly parts: readonly WordPart[];
  /** Tokens of each `$(...)` or backtick substitution inside this word. */
  readonly nested: readonly (readonly Token[])[];
}

export interface OperatorToken {
  readonly kind: "operator";
  readonly text: string;
}

export interface HeredocToken {
  readonly kind: "heredoc";
  readonly body: string;
}

export type Token = WordToken | OperatorToken | HeredocToken;

/** Longest first, so `>>` is never read as two `>`. */
const OPERATORS = [
  "&>>",
  "<<<",
  "<<-",
  "&&",
  "||",
  ";;",
  ";&",
  "|&",
  ">>",
  ">|",
  ">&",
  "<>",
  "<&",
  "<<",
  "&>",
  ";",
  "&",
  "|",
  "<",
  ">",
];

const isWordEnd = (char: string): boolean => char === "" || " \t\r\n;&|<>()".includes(char);

/** The text of a word with its quoting removed. */
export const wordText = (word: WordToken): string => word.parts.map((part) => part.text).join("");

/** The index just past the `closer` that balances an opener already consumed before `start`. */
function balancedEnd(src: string, start: number, opener: string, closer: string): number {
  let depth = 1;
  for (let pos = start; pos < src.length; pos += 1) {
    const char = src.charAt(pos);
    if (char === "\\") {
      pos += 1;
    } else if (char === opener) {
      depth += 1;
    } else if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        return pos + 1;
      }
    }
  }
  throw new Error(`unterminated ${opener} in command`);
}

/** Reads `$...` at `pos`, which is inside a word. Returns the raw text and where it ends. */
function readDollar(
  src: string,
  pos: number,
  nested: (readonly Token[])[],
): { raw: string; end: number } {
  if (src.startsWith("$((", pos)) {
    const end = balancedEnd(src, pos + 3, "(", ")");
    return { raw: src.slice(pos, end + 1), end: end + 1 };
  }
  if (src.startsWith("$(", pos)) {
    const inner = scan(src, pos + 2, true);
    nested.push(inner.tokens);
    return { raw: src.slice(pos, inner.end), end: inner.end };
  }
  if (src.startsWith("${", pos)) {
    const end = balancedEnd(src, pos + 2, "{", "}");
    return { raw: src.slice(pos, end), end };
  }
  return { raw: "$", end: pos + 1 };
}

/** Reads a backtick substitution starting at `pos`. */
function readBacktick(
  src: string,
  pos: number,
  nested: (readonly Token[])[],
): { raw: string; end: number } {
  let end = pos + 1;
  while (end < src.length && src.charAt(end) !== "`") {
    end += src.charAt(end) === "\\" ? 2 : 1;
  }
  if (end >= src.length) {
    throw new Error("unterminated backtick in command");
  }
  nested.push(scan(src.slice(pos + 1, end), 0, false).tokens);
  return { raw: src.slice(pos, end + 1), end: end + 1 };
}

/** Reads a `"..."` string whose opening quote is at `pos`. */
function readDoubleQuoted(
  src: string,
  pos: number,
  nested: (readonly Token[])[],
): { text: string; end: number } {
  let text = "";
  let at = pos + 1;
  while (at < src.length) {
    const char = src.charAt(at);
    if (char === '"') {
      return { text, end: at + 1 };
    }
    if (char === "\\") {
      const next = src.charAt(at + 1);
      if (next === "\n") {
        at += 2;
      } else {
        text += '$`"\\'.includes(next) ? next : `\\${next}`;
        at += 2;
      }
    } else if (char === "$" || char === "`") {
      const read = char === "$" ? readDollar(src, at, nested) : readBacktick(src, at, nested);
      text += read.raw;
      at = read.end;
    } else {
      text += char;
      at += 1;
    }
  }
  throw new Error('unterminated " in command');
}

/** Reads one word starting at `pos`. */
function readWord(src: string, pos: number): { word: WordToken; end: number } {
  const parts: WordPart[] = [];
  const nested: (readonly Token[])[] = [];
  let bare = "";
  let at = pos;
  const flush = (): void => {
    if (bare !== "") {
      parts.push({ text: bare, quote: "none" });
      bare = "";
    }
  };
  while (!isWordEnd(src.charAt(at))) {
    const char = src.charAt(at);
    if (char === "\\") {
      const next = src.charAt(at + 1);
      if (next !== "\n") {
        flush();
        parts.push({ text: next, quote: "single" });
      }
      at += 2;
    } else if (char === "'" || src.startsWith("$'", at)) {
      const open = char === "'" ? at : at + 1;
      let close = src.indexOf("'", open + 1);
      while (char !== "'" && close > 0 && src.charAt(close - 1) === "\\") {
        close = src.indexOf("'", close + 1);
      }
      if (close < 0) {
        throw new Error("unterminated ' in command");
      }
      const body = src.slice(open + 1, close);
      flush();
      // `$'\x2e'` decodes at run time, so it stays bare and reads as unresolved.
      parts.push(
        char !== "'" && body.includes("\\")
          ? { text: src.slice(at, close + 1), quote: "none" }
          : { text: body, quote: "single" },
      );
      at = close + 1;
    } else if (char === '"') {
      const read = readDoubleQuoted(src, at, nested);
      flush();
      parts.push({ text: read.text, quote: "double" });
      at = read.end;
    } else if (char === "$" || char === "`") {
      const read = char === "$" ? readDollar(src, at, nested) : readBacktick(src, at, nested);
      bare += read.raw;
      at = read.end;
    } else {
      bare += char;
      at += 1;
    }
  }
  flush();
  return { word: { kind: "word", parts, nested }, end: at };
}

/** Tokenizes from `start`. With `inSubstitution`, stops after the `)` that closes the `$(`. */
function scan(
  src: string,
  start: number,
  inSubstitution: boolean,
): { tokens: Token[]; end: number } {
  const tokens: Token[] = [];
  const pending: { readonly index: number; readonly delimiter: string; readonly strip: boolean }[] =
    [];
  let pos = start;
  let depth = 0;

  /** Replaces each pending heredoc's empty body with the lines that follow the newline at `pos`. */
  const readHeredocBodies = (): void => {
    for (const { index, delimiter, strip } of pending) {
      const lines: string[] = [];
      for (;;) {
        if (pos >= src.length) {
          break;
        }
        const newline = src.indexOf("\n", pos);
        const end = newline < 0 ? src.length : newline;
        const line = src.slice(pos, end);
        pos = newline < 0 ? src.length : newline + 1;
        if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) {
          break;
        }
        lines.push(line);
      }
      tokens[index] = { kind: "heredoc", body: lines.join("\n") };
    }
    pending.length = 0;
  };

  while (pos < src.length) {
    const char = src.charAt(pos);
    if (src.startsWith("\\\n", pos)) {
      pos += 2;
    } else if (char === " " || char === "\t" || char === "\r") {
      pos += 1;
    } else if (char === "\n") {
      tokens.push({ kind: "operator", text: "\n" });
      pos += 1;
      readHeredocBodies();
    } else if (char === "#") {
      const newline = src.indexOf("\n", pos);
      pos = newline < 0 ? src.length : newline;
    } else if (char === "(") {
      depth += 1;
      tokens.push({ kind: "operator", text: "(" });
      pos += 1;
    } else if (char === ")") {
      if (inSubstitution && depth === 0) {
        return { tokens, end: pos + 1 };
      }
      depth = Math.max(0, depth - 1);
      tokens.push({ kind: "operator", text: ")" });
      pos += 1;
    } else {
      const operator = OPERATORS.find((candidate) => src.startsWith(candidate, pos));
      if (operator === "<<" || operator === "<<-") {
        pos += operator.length;
        while (src.charAt(pos) === " " || src.charAt(pos) === "\t") {
          pos += 1;
        }
        const read = readWord(src, pos);
        pos = read.end;
        pending.push({
          index: tokens.length,
          delimiter: wordText(read.word),
          strip: operator === "<<-",
        });
        tokens.push({ kind: "heredoc", body: "" });
      } else if (operator !== undefined) {
        tokens.push({ kind: "operator", text: operator });
        pos += operator.length;
      } else {
        const read = readWord(src, pos);
        pos = read.end;
        // `2>` keeps only the `>`: the fd number is not an argument.
        const [only, ...rest] = read.word.parts;
        const isFd =
          only?.quote === "none" &&
          rest.length === 0 &&
          /^\d+$/.test(only.text) &&
          (src.charAt(pos) === ">" || src.charAt(pos) === "<");
        if (!isFd) {
          tokens.push(read.word);
        }
      }
    }
  }
  if (inSubstitution) {
    throw new Error("unterminated $( in command");
  }
  readHeredocBodies();
  return { tokens, end: pos };
}

/**
 * Splits a command into words, operators and heredocs. Not a shell grammar: it knows quotes,
 * escapes, line continuations, operators, substitutions and heredocs, and nothing else. Throws on
 * unterminated quoting, so the hook fails closed.
 */
export function tokenize(command: string): readonly Token[] {
  return scan(command, 0, false).tokens;
}

/** What a command would write to. `undefined` target means it could not be resolved. */
interface WriteRequest {
  readonly target: Target | undefined;
  readonly raw: string;
  /** Also block when the target is a parent of a guarded root (`rm -rf .claude`). */
  readonly ancestors: boolean;
}

interface Target {
  readonly text: string;
  /** Index of the first unquoted wildcard in `text`, or -1. */
  readonly globAt: number;
}

interface ShellState {
  /** `undefined` once a `cd` could not be followed. */
  cwd: string | undefined;
  readonly vars: Map<string, string>;
}

export interface BashWriteBlock {
  readonly rule: PathRule | BashWriteRule;
  readonly target: string;
}

const COMMAND_SEPARATORS = new Set([";", ";;", ";&", "&&", "||", "&", "\n", "(", ")", "|", "|&"]);
const WRITE_REDIRECTS = new Set([">", ">>", ">|", "<>", "&>", "&>>", ">&"]);
const RESERVED_WORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "while",
  "until",
  "do",
  "!",
  "{",
  "time",
]);
const WRAPPER_VALUE_FLAGS: Readonly<Record<string, readonly string[]>> = {
  sudo: ["-u", "-g", "-h", "-p", "-C", "-T", "-r", "-t", "-U"],
  env: ["-u", "-C", "-S"],
  command: [],
  exec: ["-a"],
  time: ["-f", "-o"],
  nice: ["-n", "--adjustment"],
};
const DECLARATIONS = new Set(["export", "declare", "typeset", "local", "readonly"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const INTERPRETER = /^(?:python[\d.]*|node|nodejs|deno|bun|perl|ruby|php|lua)$/;
const PACKAGE_RUNNERS = new Set(["pnpm", "pnpx", "npx", "npm", "yarn"]);
const EVERY_OPERAND_ANCESTORS = new Set(["rm", "rmdir", "chmod", "chown", "chgrp"]);
const EVERY_OPERAND = new Set(["tee", "unlink", "shred", "truncate", "touch", "mkdir"]);
const GIT_PATH_COMMANDS = new Set(["checkout", "restore", "rm", "mv"]);
const GIT_VALUE_FLAGS = new Set(["-b", "-B", "--orphan", "-s", "--source", "--pathspec-from-file"]);

const VARIABLE = /\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})/g;
const UNEXPANDED = /\$[A-Za-z0-9_@*#?!$({'[-]|`/;
const GLOB = /[*?[]|\{[^}]*,/;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;

/** Expands variables, `~` and globs in a word. `undefined` when it cannot be known statically. */
function expand(word: WordToken, vars: ReadonlyMap<string, string>): Target | undefined {
  let text = "";
  let globAt = -1;
  for (const [index, part] of word.parts.entries()) {
    if (part.quote === "single") {
      text += part.text;
      continue;
    }
    const known = [...part.text.matchAll(VARIABLE)].every((match) =>
      vars.has(match[1] ?? match[2] ?? ""),
    );
    let value = part.text.replace(
      VARIABLE,
      (_match, plain?: string, braced?: string) => vars.get(plain ?? braced ?? "") ?? "",
    );
    if (!known || UNEXPANDED.test(value)) {
      return undefined;
    }
    if (part.quote === "none") {
      if (index === 0 && value.startsWith("~")) {
        const home = vars.get("HOME");
        if (home === undefined || !/^~(?:\/|$)/.test(value)) {
          return undefined;
        }
        value = home + value.slice(1);
      }
      const glob = GLOB.exec(value);
      if (glob && globAt < 0) {
        globAt = text.length + glob.index;
      }
    }
    text += value;
  }
  return { text, globAt };
}

/** The word without its first `length` characters, which must be in its first part. */
function dropPrefix(word: WordToken, length: number): WordToken {
  const [first, ...rest] = word.parts;
  return first ? { ...word, parts: [{ ...first, text: first.text.slice(length) }, ...rest] } : word;
}

/** Non-flag arguments. A flag in `valueFlags` takes the next word with it. */
function operandsOf(
  args: readonly WordToken[],
  valueFlags: ReadonlySet<string> = new Set(),
): WordToken[] {
  const operands: WordToken[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    const text = wordText(arg);
    if (text === "--") {
      operands.push(...args.slice(index + 1));
      break;
    }
    if (text.startsWith("-") && text !== "-") {
      index += valueFlags.has(text) ? 1 : 0;
    } else {
      operands.push(arg);
    }
  }
  return operands;
}

const isDirectoryLike = (text: string, cwd: string): boolean => {
  if (text.endsWith("/")) {
    return true;
  }
  const absolute = path.resolve(cwd, text);
  return existsSync(absolute) && statSync(absolute).isDirectory();
};

/** Pulls `-t DIR` or `--target-directory=DIR` out of copy-style arguments. */
function splitTargetDir(args: readonly WordToken[]): {
  targetDir: WordToken | undefined;
  rest: WordToken[];
} {
  const rest: WordToken[] = [];
  let targetDir: WordToken | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    const text = wordText(arg);
    if (/^-[a-zA-Z]*t$/.test(text) || text === "--target-directory") {
      targetDir = args[index + 1];
      index += 1;
    } else if (text.startsWith("--target-directory=")) {
      targetDir = dropPrefix(arg, "--target-directory=".length);
    } else {
      rest.push(arg);
    }
  }
  return { targetDir, rest };
}

/** Requests for `cp`, `install`, `rsync` (`allSources` false) and `mv`, `ln` (`allSources` true). */
function copyRequests(
  args: readonly WordToken[],
  state: ShellState,
  options: {
    readonly allSources: boolean;
    readonly ancestors: boolean;
    readonly targetFlag: boolean;
  },
): WriteRequest[] {
  const split = options.targetFlag
    ? splitTargetDir(args)
    : { targetDir: undefined, rest: [...args] };
  const operands = operandsOf(split.rest);
  const dest = split.targetDir ?? (operands.length > 1 ? operands.at(-1) : undefined);
  const sources = split.targetDir ? operands : operands.slice(0, -1);
  const request = (word: WordToken): WriteRequest => ({
    target: expand(word, state.vars),
    raw: wordText(word),
    ancestors: options.ancestors,
  });
  const requests = options.allSources ? sources.map(request) : [];
  if (dest === undefined) {
    return requests;
  }
  requests.push(request(dest));
  const destTarget = expand(dest, state.vars);
  const intoDirectory =
    split.targetDir !== undefined ||
    (destTarget !== undefined && isDirectoryLike(destTarget.text, state.cwd ?? "/"));
  if (destTarget === undefined || !intoDirectory) {
    return requests;
  }
  for (const source of sources) {
    const sourceTarget = expand(source, state.vars);
    const joined = destTarget.text.replace(/\/+$/, "");
    requests.push({
      target:
        sourceTarget &&
        (sourceTarget.globAt >= 0
          ? { text: `${joined}/*`, globAt: joined.length + 1 }
          : { text: `${joined}/${path.basename(sourceTarget.text)}`, globAt: -1 }),
      raw: `${wordText(source)} into ${wordText(dest)}`,
      ancestors: false,
    });
  }
  return requests;
}

/** File operands of a command whose first operand is its script, unless a flag supplied one. */
function fileOperands(args: readonly WordToken[], valueFlag: RegExp): WordToken[] {
  const operands: WordToken[] = [];
  let scriptGiven = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    const text = wordText(arg);
    if (text === "--") {
      operands.push(...args.slice(index + 1));
      break;
    }
    if (text.startsWith("-") && text !== "-") {
      if (valueFlag.test(text)) {
        scriptGiven ||= /^--?[a-zA-Z]*[ef]/.test(text);
        index += 1;
      }
    } else {
      operands.push(arg);
    }
  }
  return scriptGiven ? operands : operands.slice(1);
}

/** The words a known writer writes to. Empty for anything else. */
function writeRequests(
  name: string,
  args: readonly WordToken[],
  state: ShellState,
): WriteRequest[] {
  const each = (words: readonly WordToken[], ancestors: boolean): WriteRequest[] =>
    words.map((word) => ({ target: expand(word, state.vars), raw: wordText(word), ancestors }));
  const texts = args.map(wordText);
  const unresolved = (raw: string): WriteRequest[] => [
    { target: undefined, raw, ancestors: false },
  ];

  if (EVERY_OPERAND_ANCESTORS.has(name)) {
    return each(operandsOf(args), true);
  }
  if (EVERY_OPERAND.has(name)) {
    return each(operandsOf(args), false);
  }
  switch (name) {
    case "cp":
      return copyRequests(args, state, { allSources: false, ancestors: false, targetFlag: true });
    case "install":
      return texts.some((text) => /^-[a-zA-Z]*d[a-zA-Z]*$/.test(text))
        ? each(operandsOf(args), false)
        : copyRequests(args, state, { allSources: false, ancestors: false, targetFlag: true });
    case "rsync":
      return copyRequests(args, state, { allSources: false, ancestors: false, targetFlag: false });
    case "mv":
      return copyRequests(args, state, { allSources: true, ancestors: true, targetFlag: true });
    case "ln":
      return copyRequests(args, state, { allSources: true, ancestors: false, targetFlag: true });
    case "dd":
      return each(
        args
          .filter((arg) => wordText(arg).startsWith("of="))
          .map((arg) => dropPrefix(arg, "of=".length)),
        false,
      );
    case "sed":
      return texts.some((text) => /^-[a-zA-Z]*i/.test(text) || text.startsWith("--in-place"))
        ? each(fileOperands(args, /^(?:-[a-zA-Z]*[ef]|--expression|--file)$/), false)
        : [];
    case "perl":
      return texts.some((text) => /^-[a-zA-Z0-9]*i/.test(text))
        ? each(fileOperands(args, /^-[a-zA-Z0-9]*[eE]$/), false)
        : [];
    case "awk":
    case "gawk": {
      const inplace = texts.some(
        (text, index) =>
          text === "-iinplace" ||
          text === "--include=inplace" ||
          ((text === "-i" || text === "--include") && texts[index + 1] === "inplace"),
      );
      return inplace
        ? each(fileOperands(args, /^(?:-[efvFi]|--include|--file|--source|--assign)$/), false)
        : [];
    }
    case "prettier":
      return texts.includes("--write") || texts.includes("-w") ? each(operandsOf(args), true) : [];
    case "patch":
      return unresolved("patch");
    default:
      return [];
  }
}

/** Requests for `git`, whose global `-C DIR` moves where the paths resolve. */
function gitRequests(
  args: readonly WordToken[],
  state: ShellState,
): {
  readonly requests: WriteRequest[];
  readonly state: ShellState;
} {
  let at = 0;
  let cwd = state.cwd;
  for (;;) {
    const arg = args[at];
    const text = arg === undefined ? undefined : wordText(arg);
    if (text === "-C") {
      const dir = args[at + 1];
      const target = dir && expand(dir, state.vars);
      cwd = target && cwd !== undefined ? path.resolve(cwd, target.text) : undefined;
      at += 2;
    } else if (text === "-c" || text === "--git-dir" || text === "--work-tree") {
      at += 2;
    } else if (text?.startsWith("-")) {
      at += 1;
    } else {
      break;
    }
  }
  const scoped: ShellState = { ...state, cwd };
  const subcommand = args[at];
  const name = subcommand && wordText(subcommand);
  const rest = args.slice(at + 1);
  if (name === "apply") {
    return { requests: [{ target: undefined, raw: "git apply", ancestors: false }], state: scoped };
  }
  if (name === undefined || !GIT_PATH_COMMANDS.has(name)) {
    return { requests: [], state: scoped };
  }
  const requests = operandsOf(rest, GIT_VALUE_FLAGS).map((word) => ({
    target: expand(word, state.vars),
    raw: wordText(word),
    ancestors: true,
  }));
  return { requests, state: scoped };
}

const relativeToRoot = (root: string, absolute: string): string =>
  path.relative(realPath(root), realPath(absolute)).split(path.sep).join("/").toLowerCase();

/** The rule a glob's prefix runs into: the wildcard could expand onto anything past it. */
function findBlockingGlob(target: Target, root: string, cwd: string): PathRule | undefined {
  const slash = target.text.lastIndexOf("/", target.globAt);
  const dir = target.text.slice(0, slash + 1);
  const partial = target.text.slice(slash + 1, target.globAt);
  const tail = target.text.slice(slash + 1);
  const relativeDir = relativeToRoot(root, path.resolve(cwd, dir === "" ? "." : dir));
  const underGuarded = dir === "" ? undefined : findBlockingPathRule(dir, root, cwd);
  if (underGuarded) {
    return underGuarded;
  }
  if (partial !== "") {
    const prefix = `${relativeDir === "" ? "" : `${relativeDir}/`}${partial}`.toLowerCase();
    return (
      findBlockingPathRule(`${dir}${partial}`, root, cwd) ??
      pathRules.find((rule) => rule.roots?.some((guarded) => guarded.startsWith(prefix)))
    );
  }
  const matchesEverything = tail === "*" || tail === "**" || tail.includes("/");
  return matchesEverything || tail.startsWith("{") ? coversGuardedRoot(relativeDir) : undefined;
}

function checkRequest(
  request: WriteRequest,
  state: ShellState,
  root: string,
): BashWriteBlock | undefined {
  const { target, raw, ancestors } = request;
  if (target === undefined || (state.cwd === undefined && !path.isAbsolute(target.text))) {
    return { rule: bashWriteUnresolvedRule, target: raw };
  }
  const cwd = state.cwd ?? root;
  const rule =
    target.globAt >= 0
      ? findBlockingGlob(target, root, cwd)
      : (findBlockingPathRule(target.text, root, cwd) ??
        (ancestors
          ? coversGuardedRoot(relativeToRoot(root, path.resolve(cwd, target.text)))
          : undefined));
  return rule ? { rule, target: raw } : undefined;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The first rule whose root is named in `code`. A plain text check; story B replaces it. */
function findMentionedRoot(code: string): PathRule | undefined {
  return pathRules.find((rule) =>
    rule.roots?.some((root) =>
      new RegExp(`(?<![\\w-])${escapeRegExp(root)}(?![\\w-])`, "i").test(code),
    ),
  );
}

/** The code a shell or interpreter was handed through a flag, or through `eval`. */
function inlineCode(name: string, args: readonly WordToken[]): string[] {
  const texts = args.map(wordText);
  if (name === "eval") {
    return [texts.join(" ")];
  }
  const flag = SHELLS.has(name)
    ? /^-[a-zA-Z]*c$/
    : INTERPRETER.test(name)
      ? /^(?:-[a-zA-Z]*[cep]|--eval|--print)$/
      : undefined;
  if (flag === undefined) {
    return [];
  }
  return texts.flatMap((text, index) => {
    const code = texts[index + 1];
    return flag.test(text) && code !== undefined ? [code] : [];
  });
}

/** Records `NAME=value`, or forgets NAME when the value cannot be known. */
function assign(word: WordToken, name: string, state: ShellState): void {
  const value = expand(dropPrefix(word, name.length + 1), state.vars);
  if (value) {
    state.vars.set(name, value.text);
  } else {
    state.vars.delete(name);
  }
}

/** Removes reserved words, assignments and wrappers from the front of a command. */
function stripPrefixes(words: readonly WordToken[], state: ShellState): WordToken[] {
  let rest = [...words];
  for (;;) {
    const [first, ...others] = rest;
    if (first === undefined) {
      return rest;
    }
    const firstPart = first.parts[0];
    const name = wordText(first);
    const assignment =
      firstPart?.quote === "none" ? ASSIGNMENT.exec(firstPart.text)?.[1] : undefined;
    const wrapperFlags = WRAPPER_VALUE_FLAGS[path.basename(name)];
    if (assignment !== undefined) {
      assign(first, assignment, state);
      rest = others;
    } else if (RESERVED_WORDS.has(name) && firstPart?.quote === "none") {
      rest = others;
    } else if (wrapperFlags !== undefined) {
      let at = 0;
      for (;;) {
        const arg = others[at];
        const text = arg === undefined ? "" : wordText(arg);
        if (!text.startsWith("-") || text === "-") {
          break;
        }
        at += wrapperFlags.includes(text) ? 2 : 1;
      }
      rest = others.slice(at);
    } else {
      return rest;
    }
  }
}

function followCd(args: readonly WordToken[], state: ShellState): void {
  const [dir] = operandsOf(args);
  const target = dir ? expand(dir, state.vars) : undefined;
  const destination = dir ? target?.text : state.vars.get("HOME");
  state.cwd =
    destination === undefined || destination === "-" || state.cwd === undefined
      ? destination !== undefined && path.isAbsolute(destination)
        ? destination
        : undefined
      : path.resolve(state.cwd, destination);
}

/** Checks one simple command. `piped` holds text an earlier command in the pipeline wrote out. */
function checkSimpleCommand(
  tokens: readonly Token[],
  state: ShellState,
  root: string,
  piped: string[],
): BashWriteBlock | undefined {
  for (const token of tokens) {
    if (token.kind === "word") {
      for (const inner of token.nested) {
        const block = checkTokens(inner, { ...state, vars: new Map(state.vars) }, root);
        if (block) {
          return block;
        }
      }
    }
  }

  const words: WordToken[] = [];
  const redirected: WordToken[] = [];
  const stdin: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind === "word") {
      words.push(token);
    } else if (token?.kind === "heredoc") {
      stdin.push(token.body);
    } else if (token?.kind === "operator") {
      const next = tokens[index + 1];
      if (next?.kind !== "word") {
        continue;
      }
      if (WRITE_REDIRECTS.has(token.text)) {
        // `>&2` duplicates a descriptor. `>&file` is a real redirect.
        if (!(token.text === ">&" && /^(?:\d+-?|-)$/.test(wordText(next)))) {
          redirected.push(next);
        }
        index += 1;
      } else if (token.text === "<<<") {
        stdin.push(wordText(next));
        index += 1;
      } else if (token.text === "<" || token.text === "<&") {
        index += 1;
      }
    }
  }
  const [command, ...args] = stripPrefixes(words, state);
  // Inside `[[ a > b ]]`, `>` compares strings.
  if (command !== undefined && wordText(command) === "[[") {
    return undefined;
  }
  for (const word of redirected) {
    const block = checkRequest(
      { target: expand(word, state.vars), raw: wordText(word), ancestors: false },
      state,
      root,
    );
    if (block) {
      return block;
    }
  }
  if (command === undefined) {
    return undefined;
  }

  let name = path.basename(wordText(command));
  let writerArgs: readonly WordToken[] = args;
  if (PACKAGE_RUNNERS.has(name)) {
    const prettierAt = args.findIndex((arg) => wordText(arg) === "prettier");
    if (prettierAt >= 0) {
      name = "prettier";
      writerArgs = args.slice(prettierAt + 1);
    }
  }

  if (name === "cd" || name === "pushd") {
    followCd(args, state);
    return undefined;
  }
  if (name === "popd") {
    state.cwd = undefined;
    return undefined;
  }
  if (DECLARATIONS.has(name)) {
    for (const arg of args) {
      const assigned = arg.parts[0]?.quote === "none" && ASSIGNMENT.exec(wordText(arg))?.[1];
      if (assigned) {
        assign(arg, assigned, state);
      }
    }
    return undefined;
  }

  const code = inlineCode(name, args);
  if (SHELLS.has(name) || INTERPRETER.test(name)) {
    code.push(...stdin, ...piped);
  }
  for (const text of code) {
    const rule = findMentionedRoot(text);
    if (rule) {
      return { rule, target: `inline code passed to ${name}` };
    }
  }
  piped.push(...stdin);
  if (name === "echo" || name === "printf") {
    piped.push(args.map(wordText).join(" "));
  }

  const git = name === "git" ? gitRequests(args, state) : undefined;
  const requests = git ? git.requests : writeRequests(name, writerArgs, state);
  for (const request of requests) {
    const block = checkRequest(request, git ? git.state : state, root);
    if (block) {
      return block;
    }
  }
  return undefined;
}

/** Walks a token list command by command, following `cd`, subshells and assignments. */
function checkTokens(
  tokens: readonly Token[],
  state: ShellState,
  root: string,
): BashWriteBlock | undefined {
  const subshells: (string | undefined)[] = [];
  let current: Token[] = [];
  let piped: string[] = [];
  for (const token of tokens) {
    if (token.kind !== "operator" || !COMMAND_SEPARATORS.has(token.text)) {
      current.push(token);
      continue;
    }
    const block = checkSimpleCommand(current, state, root, piped);
    if (block) {
      return block;
    }
    current = [];
    if (token.text !== "|" && token.text !== "|&") {
      piped = [];
    }
    if (token.text === "(") {
      subshells.push(state.cwd);
    } else if (token.text === ")") {
      state.cwd = subshells.pop();
    }
  }
  return checkSimpleCommand(current, state, root, piped);
}

/**
 * The first guarded or unresolved write in `command`, if any. Throws if the command cannot be
 * tokenized, so the hook fails closed.
 */
export function findBlockingBashWrite(
  command: string,
  root: string,
  cwd: string,
): BashWriteBlock | undefined {
  const vars = new Map<string, string>([["CLAUDE_PROJECT_DIR", root]]);
  const home = process.env["HOME"];
  if (home !== undefined) {
    vars.set("HOME", home);
  }
  return checkTokens(tokenize(command), { cwd, vars }, root);
}
