# Scorecard

Filled by hand. Log a row when a PR merges or closes. Fill the weekly summary at each check-in, calculated from the log.

## Story log

- **Story:** the story ID: the lowercased `STORY-NNN` alias if the issue title has one (e.g. `001d`), otherwise the issue number (`#NN`), as for every story from 2026-09-21. `chore` marks a PR with no story issue.
- **Spec'd / Closed:** dates (YYYY-MM-DD). Cycle time is Closed minus Spec'd. A chore's Spec'd is the date its PR was opened.
- **Author:** `agent`, `human` or `mixed`.
- **Plan edits:** corrections made to the agent's plan before approval.
- **Review rounds:** 1 means merged after the first review. 0 means merged without a review.
- **Restarts:** sessions restarted under the two-strike rule.
- **Outcome:** `merged` or `rejected`.
- **Spec-debt PRs:** doc fixes this story triggered.
- **Notes:** one line. Add bug links here if a defect later traces to this story.
- `?` means unknown. `-` means the column doesn't apply, as for chores.

| Story | PR  | Spec'd     | Closed     | Author | Plan edits | Review rounds | Restarts | Outcome | Spec-debt PRs | Notes                                                                     |
| ----- | --- | ---------- | ---------- | ------ | ---------- | ------------- | -------- | ------- | ------------- | ------------------------------------------------------------------------- |
| 001a  | #2  | 2026-09-16 | 2026-09-16 | human  | ?          | ?             | ?        | merged  | 0             | 2,040 lines, 1,762 of them pnpm-lock.yaml                                 |
| 001b  | #22 | 2026-09-16 | 2026-09-16 | mixed  | ?          | ?             | ?        | merged  | 1 (#35)       | Agent scaffolded /docs; 4 human commits on CLAUDE.md and scorecard        |
| 001c  | #24 | 2026-09-16 | 2026-09-16 | agent  | ?          | ?             | ?        | merged  | 0             | 979 lines (735 excl. fixtures), over the ~400 guide                       |
| chore | #23 | 2026-09-16 | 2026-09-16 | agent  | -          | 1             | -        | merged  | -             | Chore: agent identity smoke test; LEARNINGS.md entry                      |
| chore | #25 | 2026-09-16 | 2026-09-16 | human  | -          | 0             | -        | merged  | -             | Chore: hand edit to scorecard; unformatted, broke format:check (#27)      |
| chore | #27 | 2026-09-16 | 2026-09-16 | agent  | -          | 1             | -        | merged  | -             | Chore: Prettier fix for #25; unblocked /ship finish on #26                |
| chore | #28 | 2026-09-16 | 2026-09-16 | agent  | -          | 1             | -        | merged  | -             | Chore: scorecard table header separator row, follow-up to #27             |
| 001d  | #26 | 2026-09-16 | 2026-09-18 | agent  | ?          | 1             | ?        | merged  | 0             | 242 lines, 5 files; open 2 days awaiting tech-lead fresh-session check    |
| #32   | #35 | 2026-09-18 | 2026-09-18 | human  | ?          | 1             | ?        | merged  | 0             | Spec debt from 001b: ADR filename pattern is three digits                 |
| 002a  | #42 | 2026-09-18 | 2026-09-19 | agent  | ?          | 1             | ?        | merged  | 1 (#40)       | 80 lines, 4 files; unblocked by chore #43                                 |
| #39   | #40 | 2026-09-19 | 2026-09-19 | agent  | ?          | 1             | ?        | merged  | 0             | Spec debt from 002a: story-creation-format.md                             |
| chore | #43 | 2026-09-19 | 2026-09-19 | agent  | -          | 2             | -        | merged  | -             | Chore: /ship file-type gate allows CODEOWNERS; unblocked 002a             |
| 002b  | #41 | 2026-09-18 | 2026-09-20 | agent  | ?          | 1             | ?        | merged  | 0             | 111 lines, 3 files; 2 defects fixed in #45, 2 more in #47                 |
| chore | #45 | 2026-09-20 | 2026-09-20 | agent  | -          | 1             | -        | merged  | -             | Chore: fixes 2 claude.yml defects from 002b's first run; Node 20 warnings |
| #48   | #49 | 2026-09-21 | 2026-09-21 | agent  | ?          | 1             | ?        | merged  | 0             | 337 lines, 11 files; review job ran out of turns on it (fixed in #50)     |
| chore | #50 | 2026-09-21 | 2026-09-21 | human  | -          | 0             | -        | merged  | -             | Chore: workflow guide in repo; story ID = issue no.; review turns 40      |
| chore | #52 | 2026-09-21 | 2026-09-21 | human  | -          | 0             | -        | merged  | -             | Chore: correct MCP tool name for Claude to post PR comments               |
| chore | #53 | 2026-09-21 | 2026-09-21 | human  | -          | 0             | -        | merged  | -             | Chore: clarify Claude review prompt output and inline comments            |
| #8    | #55 | 2026-09-19 | 2026-09-21 | human  | 1          | 1             | -        | merged  | -             | story: add domain docs for ledger accounts                                |

## Weekly summary

- **Scope:** story rows only. Chore rows are logged but not counted.
- **Agent-authored:** `agent` rows divided by merged rows, as a percentage.
- **Rework rate:** rows with more than 1 review round or any restart, divided by closed rows.
- **Defect escapes:** bugs found this week that trace to a merged story, counted per bug.

| Week of    | Stories merged | Median cycle time (days) | Agent-authored | Rework rate | Rejected | Defect escapes | Spec-debt fixes |
| ---------- | -------------- | ------------------------ | -------------- | ----------- | -------- | -------------- | --------------- |
| 2026-09-14 | 8              | 0                        | 63%            | ?           | 0        | 2              | 2               |
| 2026-09-21 | 1              | 0                        | 100%           | ?           | 0        | 2              | 0               |
