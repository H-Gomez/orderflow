blank for now

## Governance

[`.github/workflows/claude.yml`](.github/workflows/claude.yml) implements a story issue end to end and opens a draft pull request for it, and only the repository owner can trigger it, by commenting `@claude` or by applying the `agent-ready` label.

[`.github/workflows/claude-review.yml`](.github/workflows/claude-review.yml) posts review comments on every pull request as it is opened and updated, triggered by the pull request itself rather than by a person, and it can comment but never approve, so a human review is still required to merge.
