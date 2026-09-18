---
name: write-adr
description: Draft an OrderFlow Architecture Decision Record from a GitHub issue or the current discussion. Copies docs/adr/0000-template.md to docs/adr/NNN-<slug>.md (three digits) with Status Proposed, and adds or updates its row in the docs/adr/README.md index. Use when asked to write, draft or propose an ADR.
argument-hint: "[issue-number]"
---

# /write-adr

Arguments: `$ARGUMENTS` (an issue number, or empty to draft from the current discussion).

## Rules

- **Status is always `Proposed`.** Never write `Accepted`: the tech lead decides.
- **Never edit an ADR whose status is `Accepted`.** To change a decision, draft a new ADR that supersedes it: say so in its Context, and name the ADR it replaces. Updating the old ADR's status is left to the tech lead; report that it's needed.
- **Invent nothing.** Every statement must come from the issue (body and comments) or the current discussion. Where the source is silent, write `TBD`. Don't fill gaps from general knowledge, other ADRs or guesses.
- **At least two alternatives.** List every alternative the source names. If it names fewer than two, add `TBD` entries until there are two.
- **Only two files change:** the new ADR and `docs/adr/README.md`. Don't commit, push or comment. Leave that to the calling session.

## Steps

1. **Source.**
   - If `$ARGUMENTS` is an issue number, read it with `gh issue view <n> --json number,title,body,comments`.
   - Otherwise use the current discussion. If the discussion names no decision to record, ask what the ADR should decide and stop.
2. **Read** `docs/adr/0000-template.md`, `docs/adr/README.md`, and the list of files in `docs/adr/`.
3. **Number.**
   - **If the issue or discussion names an ADR number** (e.g. "ADR-008"; issue #21 is ADR-008), use it.
   - **Otherwise:** use the lowest number ≥ 009 that has no row in the index and no `NNN-*.md` file. Numbers 001 to 008 are reserved, whether or not they have a row yet.
   - **If a file for that number already exists,** stop and report it. Never overwrite an ADR.
4. **File name:** `docs/adr/NNN-<slug>.md`, where:
   - `NNN` is the number zero-padded to three digits.
   - `<slug>` is 2–5 lowercase, hyphenated words from the decision's title.
5. **Write the file.** Copy the template exactly, keeping every heading in order, and fill it in:
   - **Title line:** `# ADR-NNN: <Title>`.
   - **Status:** `Proposed`.
   - **Date:** today, from `date +%F`.
   - **Issue:** `#<n>`, or `TBD` when drafting from a discussion.
   - **Context:** the forces and constraints the source states, and why a decision is needed now.
   - **Decision:** the option the source proposes, in one or two sentences, or `TBD` if it proposes none.
   - **Alternatives considered:** one bullet per option, each with why it lost as the source puts it, or `TBD`.
   - **Consequences:** what the source says becomes easier, harder, or must stay true. Otherwise `TBD`.
   - Replace the template's guidance sentences. Don't leave them in.
6. **Update the index** in `docs/adr/README.md`.
   - If the number already has a row (e.g. 008, `Not yet written`), set only that row's Title to `[<Title>](NNN-<slug>.md)` and its Status to `Proposed`.
   - Otherwise add a row in numeric order: three-digit number, linked title, `Proposed`, and `#<n>` (or `TBD`).
   - Keep the table's existing format.
7. **Report:** the file path, the index row, and every field left as `TBD`, so the author can fill it in.
