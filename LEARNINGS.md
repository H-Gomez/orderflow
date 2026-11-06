# Learnings

Things we learned the hard way while building OrderFlow. Add one dated entry per lesson, newest first:
what happened, why, and what we now do differently. Promote a lesson to CLAUDE.md or /docs once it becomes a rule.

## 2026-11-06: the PR review passed and said nothing

**Symptom.** The `invariants and scope` check in `claude-review.yml` went green on a few PRs but posted no comment. Each failed run cost money which is tokens burned. The #81 run also showed 13 permission denials in 42 turns, the action's default models (`claude-sonnet-5`, `claude-haiku-4-5`), and Claude Code 2.1.278, below the 2.1.310 minimum.

**Cause.** Setting `prompt` puts the action in agent mode, which creates no tracking comment. The prompt told the model to write its summary with `update_claude_comment`, but there was no comment to update, so the summary went nowhere. The run still ended in success.

**Fix**
- Action pinned to v1.0.268 (`c0949c5`), which installs Claude Code 2.1.318.
- `track_progress: true`, so the action creates a tracking comment for the model to update.
- `--model claude-sonnet-5-5` in both workflows, and `claude-haiku-5-5` for background work through the `settings` env block.
- A final step fails the job unless a `claude[bot]` comment updated during this run has a status line from `docs/conventions/agent-comments.md`.
  - The time check stops a stale sticky comment from passing.
  - The status-line check is the real test, because the action rewrites the tracking comment at the end of every run.
- `git grep` was not added to the review's tools. `git grep -O<cmd>` runs a command, so allowing it would give the review shell access, and with it a route to an approval. The review uses the Grep tool instead.

**Rule.** A check that can pass with no output is not a control. Every agent check must fail when it produces nothing.

## 2026-11-05

The #72 guard fired for the first time on #10, on a variable-path helper; the agent rewrote to a literal path. Clarify in CLAUDE.md that posting is for a block on story files.

## 2026-11-04

Agent identity is the VM. The gh, SSH and git config on it are orderflow-agent only. The bot is a Write collaborator with no ruleset bypass, so plain `claude` on the VM is correct, and cc-bot is retired. Claude Code on the web runs as the GitHub user who starts it and is never used for story work; PR #64 is the one exception on record.

#57 (PR #64) was 2,295 lines against the guide's 400-line limit. A spec estimating more than 400 lines is now split before it is labelled `agent-ready`.

## 2026-09-16

Local agent sessions run as orderflow-agent via cc-bot. Humans approve and merge.
