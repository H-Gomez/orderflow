# Agent comment format

Reviewer bandwidth is the bottleneck of an agent fleet, so a comment's first job is to say what the
human has to do. Everything else is kept for the audit trail, folded away. Nothing is deleted.

## Applies to

- Issue comments.
- PR comments.
- PR review summaries.
- The prose part of PR bodies. A PR body's structure is not prose and stays as `/ship` writes it: the
  `Closes #<issue>` first line that `CLAUDE.md` requires, the `## Verification` checklist (unchanged
  in content and position) and the `## Evidence` section. The format governs the text around them.

## The format

1. **Line 1:** one status word, in bold, alone on the line. One of:
   - `**ACTION NEEDED**` — the human must do something before work continues.
   - `**FYI**` — nothing is waiting on the human.
   - `**BLOCKED**` — the agent cannot continue until something outside its control changes.
   - `**DONE**` — the work is finished.
2. **Line 2:** what the human must do, in one sentence. "Nothing." is valid.
3. **Up to 5 bullets**, each under 20 words. Decisions and risks only. No narration of steps taken.
4. **Everything else** inside `<details><summary>Full notes</summary> ... </details>`: the steps,
   commands, output, reasoning. Leave a blank line after `<summary>` and before `</details>` so GitHub
   renders the Markdown inside.

Never put a secret, token, key or environment value in a comment, folded or not.

### Example

```markdown
**ACTION NEEDED**
Tick the two human-only Verification items, then merge.

- Kept `number` out of the fee path; amounts stay `Decimal` end to end.
- Risk: the settlement test depends on wall-clock time and may flake in CI.

<details><summary>Full notes</summary>

Every step, every command, every output.

</details>
```

## Review findings

One line per finding: `path:line`, severity (`high`, `medium` or `low`), then the problem. A finding
always names a file and a line. The detail belongs in the inline comment on that line, not in the
summary.

```markdown
- `packages/ledger/src/post.ts:42` — high — balance stored in a column; CLAUDE.md says compute it.
- `packages/ledger/src/post.ts:88` — low — magic number for the fee rate.
```

## Checking a comment

`pnpm lint:comment` reads a comment body on stdin, exits 0 if it passes, and otherwise exits non-zero
with a one-line reason. It rejects a comment when:

- line 1 is not one of the four status words in bold,
- more than 12 non-blank lines sit outside `<details>`, or
- a `<details>` block is opened and never closed.

```sh
pnpm --silent lint:comment < comment.md
gh pr view <n> --json comments --jq '.comments[-1].body' | pnpm --silent lint:comment
```

The bullet count, the 20-word limit and the finding line shape are not checked mechanically; they are
for the author and the reviewer. The linter is not yet a required CI check.
