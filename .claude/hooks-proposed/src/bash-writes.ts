/**
 * Finds the paths a Bash command writes to, so `guard-bash.ts` can check them against `pathRules`.
 *
 * This is a tripwire, not a sandbox. It cannot see a script that writes when run (`node x.js`,
 * `make`, `pnpm format`) or a path built at runtime. `/ship finish` scope checks and CODEOWNERS
 * remain the backstop.
 */

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

/** Stub until the red run is pasted. Real implementation follows. */
export function findBlockingBashWrite(
  _command: string,
  _root: string,
  _cwd: string,
):
  | { readonly rule: { readonly id: string; readonly reason: string }; readonly target: string }
  | undefined {
  return undefined;
}
