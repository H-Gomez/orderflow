---
name: ship
description: Start or finish an OrderFlow story. `/ship start <issue>` claims an agent-ready story issue, creates its branch and opens a draft PR with the Verification checklist. `/ship finish` runs every check, verifies the diff stays inside the story's Touchable files, ticks only evidenced checklist items, and marks the PR ready. Never merges.
argument-hint: "start <issue> [slug] | finish"
disable-model-invocation: true
---

# /ship

Arguments: `$ARGUMENTS`

The first word is the mode, `start` or `finish`. For anything else, print the usage from `argument-hint` and stop.

Run every command from the repository root (`git rev-parse --show-toplevel`). `H` below is `${CLAUDE_SKILL_DIR}/scripts/story.mjs`, a helper that reads the issue with `gh` and prints plain text. Exit code 0 means OK, 1 means a check found a problem, 2 means the helper could not run. Treat 2 as a stop.

## Never

- Merge, approve, push to `main`, or force-push (`--force`, `-f`, `--force-with-lease`).
- Edit the issue's body or title. That includes "fixing" scope by adding files to Touchable files.
- Tick a checklist item unless its evidence is pasted in the PR.
- Mark the PR ready after any red check, any file outside Touchable files, or any unsupported language.

When a step says **stop**, report what failed and why, leave the PR as it is (still draft), and end the skill.

Pass multi-line or long text to `gh` and `git` as files (`--body-file`, `git commit -F`). The Bash guard blocks any command whose text mentions a denied phrase, even inside a PR body.

## Mode: `start <issue> [slug]`

1. **Preconditions.** Stop if any of these fails:
   - `gh issue view <issue> --json state,labels,title`: the issue is open and labelled both `story` and `agent-ready`.
   - `git status --porcelain` is empty.
2. **Claim the issue:** `gh issue edit <issue> --add-assignee @me --add-label in-progress`.
3. **Branch.**
   - Name: `story-<id>-<slug>`. If a slug was given, use it with the id from the title. Otherwise use the output of `node H branch <issue>`.
   - `git fetch origin`. If a branch matching `story-<id>-*` already exists locally or on `origin`, switch to it and say which one you're using.
   - Otherwise: `git switch -c <branch> origin/main`.
4. **Empty commit** (skip it if the branch already has commits ahead of `origin/main`): `git commit --allow-empty -F <file>`. The message is `chore: start STORY-<id>` plus any commit trailer this session requires.
5. **Push:** `git push -u origin <branch>`.
6. **Draft PR.**
   - If a PR already exists for the branch (`gh pr view <branch>`), reuse it.
   - Otherwise write `node H pr-body <issue>` to a temp file and run `gh pr create --draft --base main --head <branch> --title "<type>: <summary> (STORY-<id>)" --body-file <file>`.
   - `<type>` is the Conventional Commit type that fits the story (`feat`, `docs`, `chore`, ...). Append any PR footer this session requires to the body file.
   - The body must start with `Closes #<issue>`.
7. **Comment on the issue:** `gh issue comment <issue> --body "Branch: \`<branch>\` · Draft PR: <url>"`.
8. **Report:** the branch, PR URL, assignee and labels. Also show `node H touchable <issue>`, so the working session knows its scope.

## Mode: `finish`

1. **Find the PR.**
   - Stop if the current branch is `main`.
   - `gh pr view --json number,url,isDraft,body,headRefName`. Stop if there is no PR.
   - The issue number comes from the `Closes #<n>` line at the top of the body. Stop if it's missing.
2. **Pushed state.**
   - Stop if `git status --porcelain` is not empty.
   - `git fetch origin`. Stop if `git rev-parse HEAD` differs from `git rev-parse @{u}`. The evidence must describe the pushed code.
3. **Language:** `node H languages`. Stop on exit 1, naming the file and manifest, with "language not supported yet".
4. **Scope:** `node H scope <issue>`.
   - Stop on exit 1, listing every `OUTSIDE` file.
   - For each `CHECK` line, read that file's diff (`git diff origin/main... -- <file>`) and confirm the change respects the note, e.g. "Workflow section only". Stop if it doesn't, or if you can't tell.
   - Also stop if a changed file matches anything under the issue's "Out of scope" section.
5. **Checks.**
   - Run each in order and record its exit code and the last lines of its output: `pnpm format:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.
   - Run all five even if one fails, so the report is complete. Then stop if any failed.
   - If `pnpm` is not on `PATH`, use `corepack enable --install-directory <scratch>/bin pnpm` and prepend that directory to `PATH` for these commands. Don't change global setup.
6. **Evidence and ticks.**
   - Under `## Evidence` in the PR body, add or update a "Checks" entry: the commit SHA, each command with its exit code, and the tail of its output. Add a "Scope" entry with the `scope` output.
   - Then, for each `- [ ]` item in `## Verification`, tick it (`- [x]`) only if the PR body (or a PR comment) holds evidence for that exact item: command output, a link, or a pasted transcript. An item that only a human can run stays unticked.
   - List every unticked item in your report.
   - Write the body back with `gh pr edit <number> --body-file <file>`.
7. **Ready.**
   - `gh pr ready <number>`
   - `gh issue edit <issue> --remove-label in-progress`
   - `gh pr edit <number> --add-label agent-authored`
8. **Report:** the PR URL, the check results, the scope result, and which checklist items are ticked and which still need a human.
