# Story creation format

Every OrderFlow story is a GitHub issue labelled `story`, and every one has the same six
sections in the same order. This file is the short version, and it is what the issue template
in `.github/ISSUE_TEMPLATE/` is generated from.

The long version, with the reasoning and a worked example, is `agent-workflow-guide.md` §2 and
§3. Where this file and the guide disagree, the guide is right and this file is stale.

## The six sections

Copy these headings verbatim. An issue that renames one is not in the format, and the tooling
that reads issue bodies relies on them.

```markdown
## Context (why)

Why this work exists now, and what the agent must read before starting.

## Contract (what)

What must be true when this is done. Fixed scope; the implementation is the agent's.

## Invariants (never violate)

The rules this work must not break, including the ones it would be tempting to break.

## Out of scope (do NOT touch)

Files, systems and decisions this story must leave alone, and who owns them instead.

## Verification (definition of done)

The commands and checks that prove it, each producing evidence to paste in the PR.

## Touchable files

The only paths this story may change. Anything else is out of scope.
```

## What each section is for

**Context (why)** carries the reason and the reading list. Link every document the agent needs
— a domain doc, an ADR, the guide section — because an agent that has to guess at context will
guess. Name the stories this one depends on, and say plainly what to do if they have not merged
yet: stop, usually.

**Contract (what)** is the fixed part. Agents should not improvise scope, so state the outcome
precisely and leave the implementation open. "Improve the settlement flow" is not a contract.

**Invariants (never violate)** and **Out of scope (do NOT touch)** do the most work in the whole
format. They are the difference between a surgical diff and a forty-file "while I was in
there". Write the invariants that are tempting to break, not the obvious ones, and in Out of
scope name the story that owns each excluded thing so the boundary reads as a handover rather
than a refusal.

**Verification (definition of done)** must be mechanical. Every item is a command someone can
run or an artefact someone can paste. An item that cannot be proved by a command is a defect in
the story, not a judgement call to leave to the reviewer — rewrite it or cut it. Where a step
is yours rather than the agent's, mark it as such so the agent does not tick it.

**Touchable files** is the blast radius, and `/ship finish` enforces it: a diff touching
anything not listed here does not ship. Narrow it with a parenthetical where only part of a
file is in play, as in `CLAUDE.md (Workflow section only)`.

## When it is agent-ready

A written story is not automatically an agent-ready one. It is ready when it is:

- **Independent** — one package or service, so two sessions never share touchable files.
- **Fixed** — the contract is settled; only the implementation is open.
- **Verifiable** — a command proves it, not an opinion.
- **Small** — one session, one reviewable PR, roughly one to four focused hours.
- **Explicit** — invariants, non-goals and touchable files all stated.
- **Self-contained** — every document it needs is linked from Context.

Adding the `agent-ready` label is a separate, deliberate act. A complete spec may be held back,
and during limited-access periods it usually should be.

## Sizing

**Split it** when plan mode produces more than about ten steps, when it spans more than one
service and a shared package, when the verification cannot be written as runnable commands, or
when you would be uneasy reviewing it as a single PR from a mid-level engineer.

**Merge it** into a neighbouring story when the diff would be under about thirty lines and it
has no verification of its own. Micro-stories cost more in review and session setup than they
save.

When a story splits, suffix the id rather than renumbering: `STORY-005` becomes `STORY-005a`
and `STORY-005b`, and the plan's numbering survives.

## Worked examples

These are in the format and worth reading before writing a new one:

- [#6](https://github.com/H-Gomez/orderflow/issues/6) — skills and subagents; a good example of
  Invariants carrying most of the weight.
- [#33](https://github.com/H-Gomez/orderflow/issues/33) — CI checks; a good example of
  Verification that is entirely mechanical, including the deliberate failure case.
- [#8](https://github.com/H-Gomez/orderflow/issues/8) — domain docs; a good example of a story
  whose output is prose, and of marking work that is the tech lead's rather than an agent's.
