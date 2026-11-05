# Learnings

Things we learned the hard way while building OrderFlow. Add one dated entry per lesson, newest first:
what happened, why, and what we now do differently. Promote a lesson to CLAUDE.md or /docs once it becomes a rule.

## 2026-11-05

The #72 guard fired for the first time on #10, on a variable-path helper; the agent rewrote to a literal path. Clarify in CLAUDE.md that posting is for a block on story files.

## 2026-11-04

Agent identity is the VM. The gh, SSH and git config on it are orderflow-agent only. The bot is a Write collaborator with no ruleset bypass, so plain `claude` on the VM is correct, and cc-bot is retired. Claude Code on the web runs as the GitHub user who starts it and is never used for story work; PR #64 is the one exception on record.

#57 (PR #64) was 2,295 lines against the guide's 400-line limit. A spec estimating more than 400 lines is now split before it is labelled `agent-ready`.

## 2026-09-16

Local agent sessions run as orderflow-agent via cc-bot. Humans approve and merge.
