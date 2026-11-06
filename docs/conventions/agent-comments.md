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

Each part is its own paragraph. Leave one blank line between the status line, the action line, the review lines and the bullets, so GitHub does not run them together. Blank lines do not count towards the linter's limit.

1. **Status:** one status word, in bold, alone on the first line. One of:
   - `**ACTION NEEDED**`: the human must do something before work continues.
   - `**FYI**`: nothing is waiting on the human.
   - `**BLOCKED**`: the agent cannot continue until something outside its control changes.
   - `**DONE**`: the work is finished.
2. **Action:** what the human must do, in one sentence of at most 20 words. "Nothing." is valid.
3. **PR review summaries only:** two more lines.
   - `Reviewed at <sha>`: the first 7 characters of the head commit reviewed. It ties the review to one version of the PR.
   - `Findings: N high, N medium, N low`, or `No findings.`
4. **Up to 5 bullets:** decisions and risks only, each under 20 words. Review findings use the form in the next section instead. No narration of steps taken.
5. **Everything else** inside `<details><summary>Full notes</summary> ... </details>`: the steps, commands, output and reasoning. Leave a blank line after `<summary>` and before `</details>` so GitHub renders the Markdown inside.

Write commit SHAs and issue numbers bare (`bf0531c`, `#86`), never as Markdown links, and name an issue once. GitHub links both, and expands an issue number into its title.

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

Severity:

- **high:** breaks behaviour, an invariant, security or scope, and must be fixed before merge. Any high finding makes the status `**ACTION NEEDED**`.
- **medium:** wrong but contained, or Contract behaviour that no test covers. It should be fixed.
- **low:** clarity, naming or docs. Optional.

Each finding is one bullet, highest severity first, in this form:

`Severity = **<severity>**: <location> - <problem>`

- **Location:** `path:line` in backticks, or a short subject such as "Scope" when no single line applies.
- **Problem:** one sentence of at most 30 words saying what is wrong and why it matters. The detail goes in the inline comment on that line and in the folded notes.

With more than 5 findings, the 5 most severe are bullets and the rest go in the folded notes.

A review summary's folded notes hold, in order:

1. the detail behind each finding, and what was checked in each file;
2. a line starting `Not checked:` naming anything not read or run, or `Not checked: nothing`;
3. last, a line starting `Files read:` that lists every changed file on that one line, except the generated `services/api/openapi.json` and `pnpm-lock.yaml`.

The `Fail if the review posted no real summary` step in `claude-review.yml` fails a summary that:

- has no `Files read:` line;
- has a `Files read:` line that misses a changed file; or
- has a `Reviewed at` SHA that is not the PR head.

```markdown
**ACTION NEEDED**

Restore the `#` in the ship skill's commit and title templates.

Reviewed at 1578c8f

Findings: 1 high, 0 medium, 1 low

- Severity = **high**: [`.claude/skills/ship/SKILL.md:61`](https://github.com/H-Gomez/orderflow/blob/<head sha>/.claude/skills/ship/SKILL.md#L61) - the template writes a bare `<id>`, so PR titles no longer link their issue.
- Severity = **low**: Scope - #86 has no Touchable files section, so scope was checked against its Change section.

<details><summary>Full notes</summary>

The detail behind each finding, and what was checked in each file.

Not checked: did not run the workflow's bash step.
Files read: `.claude/skills/ship/SKILL.md`, `.github/workflows/claude-review.yml`, `CLAUDE.md`, `services/api/README.md`

</details>
```

## Checking a comment

`pnpm lint:comment` reads a comment body on stdin, exits 0 if it passes, and otherwise exits non-zero
with a one-line reason. It rejects a comment when:

- the first non-blank line is not one of the four status words in bold,
- more than 12 non-blank lines sit outside `<details>`, or
- a `<details>` block is opened and never closed.

```sh
pnpm --silent lint:comment < comment.md
gh pr view <n> --json comments --jq '.comments[-1].body' | pnpm --silent lint:comment
```

The bullet count, the word limits and the finding shape are not checked mechanically; they are for the author and the reviewer.
The linter is not yet a required CI check.
