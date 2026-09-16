# Scorecard

Filled by hand. Log a row when a PR merges or closes. Fill the weekly summary at each check-in, calculated from the log.

## Story log

- **Spec'd / Closed:** dates (YYYY-MM-DD). Cycle time is Closed minus Spec'd.
- **Author:** `agent`, `human` or `mixed`.
- **Plan edits:** corrections made to the agent's plan before approval.
- **Review rounds:** 1 means merged after the first review.
- **Restarts:** sessions restarted under the two-strike rule.
- **Outcome:** `merged` or `rejected`.
- **Spec-debt PRs:** doc fixes this story triggered.
- **Notes:** one line. Add bug links here if a defect later traces to this story.

| Story | PR | Spec'd | Closed | Author | Plan edits | Review rounds | Restarts | Outcome | Spec-debt PRs | Notes |
| 001a | #2 | 2026-09-16 | 2026-09-16 | human | ? | ? | ? | merged | 0 | 2,040 lines, 1,762 of them pnpm-lock.yaml |
| 001b | #22 | 2026-09-16 | 2026-09-16 | mixed | ? | ? | ? | merged | 0 | Agent scaffolded /docs; 4 human commits on CLAUDE.md and scorecard |
| 001c | #24 | 2026-09-16 | 2026-09-16 | agent | ? | ? | ? | merged | 0 | 979 lines (735 excl. fixtures), over the ~400 guide |

## Weekly summary

- **Agent-authored:** `agent` rows divided by merged rows, as a percentage.
- **Rework rate:** rows with more than 1 review round or any restart, divided by closed rows.
- **Defect escapes:** bugs found this week that trace to a merged story.

| Week of | Stories merged | Median cycle time (days) | Agent-authored | Rework rate | Rejected | Defect escapes | Spec-debt fixes |
| ------- | -------------- | ------------------------ | -------------- | ----------- | -------- | -------------- | --------------- |
