import { describe, expect, it } from "vitest";

import { tokenize, wordText } from "./bash-writes.ts";
import type { Token } from "./bash-writes.ts";

/** Words as plain text, operators as `<op>`, heredocs as `[body]`. */
const summary = (tokens: readonly Token[]): string[] =>
  tokens.map((token) => {
    if (token.kind === "word") {
      return wordText(token);
    }
    return token.kind === "operator" ? `<${token.text}>` : `[${token.body}]`;
  });

describe("tokenize", () => {
  it.each<readonly [string, readonly string[]]>([
    ["echo hi", ["echo", "hi"]],
    ["a  \t b", ["a", "b"]],
    ["a && b || c; d | e & f", ["a", "<&&>", "b", "<||>", "c", "<;>", "d", "<|>", "e", "<&>", "f"]],
    ["a\nb", ["a", "<\n>", "b"]],
    ["(a; b)", ["<(>", "a", "<;>", "b", "<)>"]],
    ["a # comment > x\nb", ["a", "<\n>", "b"]],
    ["a#b", ["a#b"]],
  ])("splits words and operators: %j", (command, expected) => {
    expect(summary(tokenize(command))).toEqual(expected);
  });

  it.each<readonly [string, readonly string[]]>([
    ["a > x", ["a", "<>>", "x"]],
    ["a >x", ["a", "<>>", "x"]],
    ["a >> x", ["a", "<>>>", "x"]],
    ["a >| x", ["a", "<>|>", "x"]],
    ["a <> x", ["a", "<<>>", "x"]],
    ["a &> x", ["a", "<&>>", "x"]],
    ["a &>> x", ["a", "<&>>>", "x"]],
    ["a 2> x", ["a", "<>>", "x"]],
    ["a 2>> x", ["a", "<>>>", "x"]],
    ["a 2>&1", ["a", "<>&>", "1"]],
    ["a < x", ["a", "<<>", "x"]],
    ["a <<< x", ["a", "<<<<>", "x"]],
  ])("reads redirects and drops fd numbers: %j", (command, expected) => {
    expect(summary(tokenize(command))).toEqual(expected);
  });

  it("keeps a number that is only an argument", () => {
    expect(summary(tokenize("head -n 2 x"))).toEqual(["head", "-n", "2", "x"]);
  });

  it.each<readonly [string, string]>([
    [`'a b'`, "a b"],
    [`"a b"`, "a b"],
    [`a\\ b`, "a b"],
    [`a'b'"c"d`, "abcd"],
    [`.cl"aud"e/set'tings'.json`, ".claude/settings.json"],
    [`\\.claude`, ".claude"],
    [`"a\\"b"`, 'a"b'],
    [`"a\\qb"`, "a\\qb"],
    [`$'abc'`, "abc"],
  ])("removes quoting from %s", (command, expected) => {
    expect(summary(tokenize(command))).toEqual([expected]);
  });

  it("joins line continuations, outside and inside words and strings", () => {
    expect(summary(tokenize("a \\\n b"))).toEqual(["a", "b"]);
    expect(summary(tokenize("fo\\\no"))).toEqual(["foo"]);
    expect(summary(tokenize('"fo\\\no"'))).toEqual(["foo"]);
  });

  it("records how each part of a word was quoted", () => {
    const [word] = tokenize(`a'$b'"$c"\\$d`);
    expect(word).toMatchObject({
      kind: "word",
      parts: [
        { text: "a", quote: "none" },
        { text: "$b", quote: "single" },
        { text: "$c", quote: "double" },
        { text: "$", quote: "single" },
        { text: "d", quote: "none" },
      ],
    });
  });

  it("does not treat an ANSI-C string with escapes as literal", () => {
    const [word] = tokenize(`$'\\x2eenv'`);
    expect(word).toMatchObject({ parts: [{ text: `$'\\x2eenv'`, quote: "none" }] });
  });

  it.each<readonly [string, readonly string[]]>([
    ['echo "a > b; c"', ["echo", "a > b; c"]],
    ["echo 'a > b; c'", ["echo", "a > b; c"]],
    ["echo a\\>b", ["echo", "a>b"]],
  ])("does not read operators inside quotes or escapes: %j", (command, expected) => {
    expect(summary(tokenize(command))).toEqual(expected);
  });

  describe("substitutions", () => {
    it("keeps a substitution in one word with its spaces", () => {
      expect(summary(tokenize('echo x > "$(mktemp -d)/f"'))).toEqual([
        "echo",
        "x",
        "<>>",
        "$(mktemp -d)/f",
      ]);
    });

    it("exposes the tokens inside a substitution", () => {
      const [word] = tokenize("$(echo x > y)");
      expect(word?.kind).toBe("word");
      if (word?.kind === "word") {
        expect(word.nested.map(summary)).toEqual([["echo", "x", "<>>", "y"]]);
      }
    });

    it("handles nesting, subshells and backticks", () => {
      expect(summary(tokenize("a $(b $(c) (d)) e"))).toEqual(["a", "$(b $(c) (d))", "e"]);
      const [word] = tokenize("`echo x > y`");
      if (word?.kind === "word") {
        expect(word.nested.map(summary)).toEqual([["echo", "x", "<>>", "y"]]);
      }
    });

    it("keeps arithmetic and parameter expansion in one word without nested tokens", () => {
      const [arithmetic] = tokenize("$(( (1 + 2) > 1 ))");
      expect(arithmetic).toMatchObject({ kind: "word", nested: [] });
      expect(summary(tokenize("${A:-b c} d"))).toEqual(["${A:-b c}", "d"]);
    });

    it("reads the commit-message idiom, apostrophes and parens in the heredoc included", () => {
      const command = `git commit -m "$(cat <<'EOF'\nfix: don't (break) "this"\nEOF\n)"`;
      const tokens = tokenize(command);
      expect(summary(tokens).slice(0, 3)).toEqual(["git", "commit", "-m"]);
      expect(tokens).toHaveLength(4);
      expect(tokens[3]).toMatchObject({ kind: "word" });
      const message = tokens[3];
      expect(message?.kind === "word" ? message.nested.map(summary) : []).toEqual([
        ["cat", `[fix: don't (break) "this"]`, "<\n>"],
      ]);
    });
  });

  describe("heredocs", () => {
    it.each<readonly [string, string]>([
      ["cat <<EOF\nbody > x\nEOF", "body > x"],
      ["cat <<'EOF'\n$a\nEOF", "$a"],
      ['cat <<"EOF"\na\nb\nEOF', "a\nb"],
      ["cat << EOF\na\nEOF", "a"],
      ["cat <<-EOF\n\ta\n\tEOF", "\ta"],
      ["cat <<EOF\nno terminator", "no terminator"],
    ])("drops the body out of the word stream: %j", (command, body) => {
      expect(summary(tokenize(command))).toEqual(["cat", `[${body}]`, "<\n>"]);
    });

    it("carries on with the commands after the terminator", () => {
      expect(summary(tokenize("cat <<EOF\nx > y\nEOF\necho z > w"))).toEqual([
        "cat",
        "[x > y]",
        "<\n>",
        "echo",
        "z",
        "<>>",
        "w",
      ]);
    });

    it("reads a redirect that follows the heredoc marker on the same line", () => {
      expect(summary(tokenize("cat <<EOF > out\nbody\nEOF"))).toEqual([
        "cat",
        "[body]",
        "<>>",
        "out",
        "<\n>",
      ]);
    });

    it("reads two heredocs on one line in order", () => {
      expect(summary(tokenize("a <<X <<Y\none\nX\ntwo\nY"))).toEqual([
        "a",
        "[one]",
        "[two]",
        "<\n>",
      ]);
    });
  });

  it.each(["echo 'a", 'echo "a', "echo $(a", "echo `a", "echo ${a"])(
    "throws on unterminated quoting, so the hook fails closed: %s",
    (command) => {
      expect(() => tokenize(command)).toThrow(/unterminated/);
    },
  );
});
