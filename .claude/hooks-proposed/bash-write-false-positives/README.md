# Proposal: fewer false blocks from the Bash write guard

Proposed by an agent on 14 Nov 2026, from a retro of five sessions (#78, #79, #36, #98, PR #87).
Human review and commit only: `.claude/hooks/**` changes by human commit.

## Why

The guard blocked harmless commands in four of the five sessions, and again in the retro itself.
Every block cost a call and a rewrite.

| Session       | Command shape                                                                     | Rule                    |
| ------------- | --------------------------------------------------------------------------------- | ----------------------- |
| #78, L594     | `for c in format:check typecheck lint test build; do pnpm $c > "$P/check-$c.log"` | `bash-write-unresolved` |
| #36, L339     | the same loop, `check-$c.log`                                                     | `bash-write-unresolved` |
| #98, L121     | `for n in 91 37 96 …; do gh api … > $D/$n.md`                                     | `bash-write-unresolved` |
| retro, 14 Nov | `for f in 993e5bbd …; do python3 … > $S/digest-$f.txt`                            | `bash-write-unresolved` |
| #98, L496     | a `python3` heredoc whose text names `~/.claude/settings.json`                    | `claude-settings`       |

The first four are one cause: a `for` loop variable is never known, so any write target that uses it
is unresolved. All four lists are literal words, and every target was a scratch directory. The fifth
is a text match on `.claude/settings.json` inside `~/.claude/settings.json`, the user's own settings
file, which is not in the repository.

Not proposed: PR #87, L299 was a read-only `python3` parse of `.github/workflows/claude-review.yml`,
blocked by `github-dir`. That is the guard working as designed: inline code is blocked on any mention
of a guarded root, read or write (the `sh -c "cat .claude/settings.json"` row in `INLINE_CODE`). Agents
read those files with the Read tool.

## Change 1: expand `for` loops over literal words

In `bash-writes.ts`:

- On a command named `for` of the form `for NAME in W1 … Wn`, expand each word with `expand`. If every
  word expands and none has a glob (`globAt < 0`), record `NAME` as a list of those values in a new
  `ShellState.lists: Map<string, readonly string[]>`. Otherwise forget `NAME` (today's behaviour).
- While `NAME` is a list, check a write target that uses `$NAME` or `${NAME}` once per value, and
  block if any value blocks. Cap the combinations, for example at 64; above the cap, it is unresolved.
- On `done`, forget `NAME`. Bash keeps the last value, so forgetting it fails closed.
- Anything else stays unresolved: `for f in $(ls)`, `for f in *`, `for f; do`, an unknown `$VAR` in
  the list.

`for` is not in `RESERVED_WORDS` today, so `for f in a b` reaches the segment handler as a command
named `for`. The `do …` body segments that follow share `ShellState`, so the list is visible to them.

Test rows for `bash-writes.test.ts`:

```ts
// Move from UNRESOLVED to ALLOWED:
'for f in a b; do sed -i s/x/y/ "$f"; done',
// Add to ALLOWED:
'S=/tmp/s; for c in lint test; do pnpm $c > "$S/check-$c.log" 2>&1; done',
"for n in 91 37; do gh api repos/o/r/issues/$n > /tmp/s/$n.md; done",

// Add to CHAINS_AND_EVASION:
['for f in a .github/x.yml; do echo x > "$f"; done', "github-dir"],
['for f in a CLAUDE.md; do sed -i s/x/y/ "$f"; done', "claude-md"],
['for d in .claude; do echo x > "$d/settings.json"; done', "claude-settings"],

// Keep or add in UNRESOLVED:
'for f in *; do rm "$f"; done',
'for f in $(ls); do rm "$f"; done',
'for f; do rm "$f"; done',
'for f in a b; do :; done; echo x > "$f"',
```

## Change 2: anchor inline-code mentions to the repository

`findMentionedRoot` matches a guarded root anywhere in inline code. Keep that, but skip a mention
whose whole path is outside the project:

- Take the path token that holds the match: the run of characters around it up to whitespace, a
  quote, `(`, `)` or `,`.
- If the token starts with `~/`, replace `~` with `HOME`. If it is then absolute, resolve it and take
  `relativeToRoot(root, …)`. A result starting with `..` is outside the project, so skip the mention.
- A relative token stays a match, as today, because the code's own working directory is unknown.

This is still a text check. A path the code assembles at run time is still not seen, as today.

Test rows:

```ts
// Still blocked (INLINE_CODE), an absolute path inside the project:
[`python3 -c "open('${ROOT}/.claude/settings.json','w')"`, "claude-settings"],

// Allowed:
`python3 - <<'EOF'\ns = "user settings live in ~/.claude/settings.json"\nEOF`,
`python3 -c "print('/tmp/x/.github/a.yml')"`,
```

## Docs

If accepted, the Guard hooks line of CLAUDE.md ("write to a literal path") could add: "or loop over
literal words".
