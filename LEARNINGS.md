# Learnings

Things we learned the hard way while building OrderFlow. Add one dated entry per lesson, newest first:
what happened, why, and what we now do differently. Promote a lesson to CLAUDE.md or /docs once it becomes a rule.

## 2026-11-06: the PR review passed and said nothing, then could push

**Symptom 1 (#81).** The `invariants and scope` check in `claude-review.yml` went green on a few PRs but posted no comment. Each run still burned tokens. The #81 run also showed 13 permission denials in 42 turns, the action's default models (`claude-sonnet-5`, `claude-haiku-4-5`), and Claude Code 2.1.278, below the 2.1.310 minimum.

**Cause.** Setting `prompt` puts the action in agent mode, which creates no tracking comment. The summary written with `update_claude_comment` had nowhere to go, and the run still ended in success.

**First fix (#83, `e0e22c5`)**

- Action pinned to v1.0.268 (`c0949c5`), which installs Claude Code 2.1.318.
- `track_progress: true`, so the action creates a tracking comment. This also forces tag mode, which turned out to add `git add`, `git commit`, `git rm`, a push script and `acceptEdits` under the Claude App token, which has `contents: write` whatever the workflow's `permissions:` say. Found on #82. Only a sentence in the prompt stopped the reviewer pushing to the PR it reviewed.
- `--model claude-sonnet-5-5` in both workflows.
- A final step that fails the job unless a fresh comment has a status line from `docs/conventions/agent-comments.md`.
- `git grep` kept out of the review's tools: `git grep -O<cmd>` runs a command.

**Symptom 2 (#82).** The reviewer took 6 turns in 29 seconds on a 1,000-line diff and restated orderflow-agent's report as its summary, with no `path:line` findings. The final check passed because the copy had a valid status line. Cause: tag mode puts the PR body and comments into the prompt, and the agent's report is already in the summary format.

**Second fix**

- `github_token: ${{ github.token }}`. The action then never mints an App token; comments, MCP tools and git all use the workflow token, so `contents: read` makes GitHub refuse any push. Comments now come from `github-actions[bot]`. Log proof: `Using provided GITHUB_TOKEN for authentication`.
- Permissions: `issues: read` added (the reviewer reads the story), `id-token: write` removed (only the App-token exchange used it).
- `use_sticky_comment` removed. Its lookup matches any bot whose login contains "claude", so under the workflow token it would overwrite `claude.yml` replies, and the comment would keep the `claude[bot]` author.
- `--disallowedTools` for edit and git write tools. Deny rules beat tag mode's allow list.
- `exclude_comments_by_actor: orderflow-agent`. The PR body cannot be excluded, so the prompt says the body and comments are claims to verify, and every finding cites `path:line`.
- The summary carries `Reviewed at <head SHA>`. The final check requires a `github-actions[bot]` comment updated this run with the status line, that SHA, and a `path:line` finding or a `Files read:` line.
- Background model fixed to `claude-haiku-5-5`.
- Approval wall: the repository setting "Allow GitHub Actions to create and approve pull requests" is off, checked with `gh api repos/H-Gomez/orderflow/actions/permissions/workflow`.

**Trade-off.** With a provided token the action skips the App-token exchange, and with it the "workflow differs from main" refusal. A same-repo branch that edits a review workflow now runs that edit. The walls are the fail-closed hook, the deny rule, and orderflow-agent's token lacking the `workflow` scope (`gh auth status` on the VM).

**Rules.**

- A check that can pass with no output is not a control. Every agent check must fail when it produces nothing.
- A control written in a prompt is not a control; the token must make the action impossible.

## 2026-11-05

The #72 guard fired for the first time on #10, on a variable-path helper; the agent rewrote to a literal path. Clarify in CLAUDE.md that posting is for a block on story files.

## 2026-11-04

Agent identity is the VM. The gh, SSH and git config on it are orderflow-agent only. The bot is a Write collaborator with no ruleset bypass, so plain `claude` on the VM is correct, and cc-bot is retired. Claude Code on the web runs as the GitHub user who starts it and is never used for story work; PR #64 is the one exception on record.

#57 (PR #64) was 2,295 lines against the guide's 400-line limit. A spec estimating more than 400 lines is now split before it is labelled `agent-ready`.

## 2026-09-16

Local agent sessions run as orderflow-agent via cc-bot. Humans approve and merge.
