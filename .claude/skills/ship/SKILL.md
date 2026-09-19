---
name: ship
description: Start or finish an OrderFlow story. `/ship start <issue>` claims an agent-ready story issue, creates its branch and opens a draft PR with the Verification checklist. `/ship finish` runs every check, verifies the diff stays inside the story's Touchable files, ticks only evidenced checklist items, and marks the PR ready. Never merges.
argument-hint: "start <issue> [--base <branch>] | finish"
disable-model-invocation: true
---

# /ship

Arguments: `$ARGUMENTS`

The first word is the mode, `start` or `finish`. For anything else, print the usage from `argument-hint` and stop. Run every command from the repository root (`git rev-parse --show-toplevel`), using `gh` and `git` directly.

## Never

- Merge, approve, push to `main`, or force-push (`--force`, `-f`, `--force-with-lease`).
- Edit the issue's body or title. That includes "fixing" scope by adding files to Touchable files.
- Tick a checklist item unless its evidence is pasted in the PR.
- Mark the PR ready after any red check, any file outside Touchable files, or any unsupported file type.
- Add a changelog step.

When a step says **stop**, report what failed and why, leave the PR as it is (still draft), and end the skill.

## Writing PR bodies and comments

- One line per paragraph or bullet. Never hard-wrap.
- Put `<placeholders>` and `@handles` in backticks, so GitHub doesn't swallow them as HTML or turn them into mentions.
- Pass text to `gh` and `git` as files (`--body-file`, `git commit -F`). The Bash guard blocks any command whose text mentions a denied phrase, even inside a PR body.

## Labels and ready state

`gh pr ready`, `gh pr edit` (including `--body-file`) and `gh issue edit --add-label` run a GraphQL query needing the `read:org` scope, which an agent token doesn't have. Use the REST and GraphQL calls instead, with `<repo>` as `<owner>/<name>`:

- Edit a PR body: `gh api -X PATCH repos/<repo>/pulls/<number> -F body=@<file>`

- Add a label: `gh api repos/<repo>/issues/<number>/labels -f "labels[]=<label>"`
- Remove a label: `gh api -X DELETE repos/<repo>/issues/<number>/labels/<label>`
- Mark a PR ready: take `node_id` from `gh api repos/<repo>/pulls/<number>`, then `gh api graphql -f query='mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}' -f id="<node_id>"`

A PR's labels live on its issue number, so the label calls above work for both.

## Mode: `start <issue> [--base <branch>]`

`<base>` is the `--base` value, or `main` if none was given.

1. **Preconditions.** Stop if any of these fails:
   - `gh issue view <issue> --json state,labels,title,body`: the issue is open and labelled both `story` and `agent-ready`.
   - `git status --porcelain` is empty.
   - `git fetch origin` succeeds, and `origin/<base>` exists.
2. **Claim the issue:** `gh issue edit <issue> --add-assignee @me`, then add the label the API way (see "Labels and ready state").
3. **Branch name:** `story-<id>-<slug>`.
   - `<id>` comes from a title starting `STORY-<id>`, lowercased (`STORY-001d: …` → `001d`). If the title has no such prefix, use the issue number.
   - `<slug>` is 2–4 lowercase, hyphenated words from the rest of the title, without filler words like "and", "the" or "for".
4. **Create or confirm the branch.**
   - If a branch matching `story-<id>-*` already exists locally or on `origin`, switch to it and say which one you're using.
   - Otherwise: `git switch --no-track -c <branch> origin/<base>` (that flag order; `-c --no-track` is rejected). Without `--no-track` the branch tracks the base branch, and `finish`'s pushed-state check then compares against the wrong ref.
5. **Empty commit.** Only if `git rev-list --count origin/<base>..HEAD` is `0`: `git commit --allow-empty -F <file>`. The message is `chore: start STORY-<id>` plus any commit trailer this session requires.
6. **Push:** `git push -u origin <branch>`.
7. **Draft PR.** If `gh pr view <branch>` finds a PR, reuse it. Otherwise:
   1. Write the body to a temp file:
      - The first line is `Closes #<issue>`.
      - Then `## Verification`, holding the issue's Verification section. Each bullet becomes `- [ ] <text>`, with wrapped continuation lines joined into one line. Non-bullet lines, such as "Run by the agent…", stay as plain text.
      - Then an empty `## Evidence` heading.
      - Then any PR footer this session requires.
   2. Run `gh pr create --draft --base <base> --head <branch> --title "<type>: <summary> (STORY-<id>)" --body-file <file>`. `<type>` is the Conventional Commit type that fits the story (`feat`, `docs`, `chore`, ...).
8. **Comment on the issue:** `Branch: <branch in backticks> · Draft PR: <url>`, via `gh issue comment <issue> --body-file <file>`.
9. **Report:** the branch, base, PR URL, assignee and labels, plus the issue's Touchable files so the working session knows its scope.

## Mode: `finish`

1. **Find the PR.**
   - Stop if the current branch is `main`.
   - `gh pr view --json number,url,isDraft,body,baseRefName,headRefName`. Stop if there is no PR.
   - `<base>` is `baseRefName`.
   - The issue number comes from the `Closes #<n>` line at the top of the body. Stop if it's missing.
   - Read the issue with `gh issue view <n> --json body`.
2. **Pushed state.**
   - Stop if `git status --porcelain` is not empty.
   - `git fetch origin`. Stop if `git rev-parse HEAD` differs from `git rev-parse @{u}`. The evidence must describe the pushed code.
3. **Changed files:** `git diff --name-only origin/<base>...HEAD`.
4. **File types.** Stop, naming the file, if any changed file is something other than the list below. For a source file in a language this repo doesn't support yet, say "language not supported yet", adding "(Python support arrives with STORY-023)" for `.py`. Otherwise say why the file isn't allowed. These are filename rules, not path rules, so a directory such as `.github/` grants nothing on its own.
   - TypeScript: `.ts`, `.tsx`, `.mts`, `.cts`
   - Markdown: `.md`
   - Config:
     - `.json`, `.yaml`, `.yml`
     - `*.config.js`, `*.config.mjs`, `*.config.cjs`
     - repo dotfiles such as `.gitignore`, `.npmrc`, `.nvmrc`, `.prettierignore`
   - GitHub metadata: the extensionless `CODEOWNERS`, and only at `CODEOWNERS`, `.github/CODEOWNERS` or `docs/CODEOWNERS`, never in a subdirectory of those — the three paths GitHub reads it from
5. **Scope.**
   - Every changed file must match an entry in the issue's Touchable files. Entries are globs, with `**` matching any depth. Stop and list every file that matches none.
   - If the matching entry has a restriction in parentheses (e.g. "Workflow section only"), read `git diff origin/<base>...HEAD -- <file>` and confirm the change respects it. Stop if it doesn't, or if you can't tell.
   - Also stop if a changed file falls under anything in the issue's "Out of scope" section.
6. **Checks.**
   - Run each in order, and record its exit code and the last lines of its output: `pnpm format:check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.
   - Run all five even if one fails, so the report is complete. Then stop if any failed.
   - If `pnpm` is not on `PATH`, use `corepack enable --install-directory <scratch>/bin pnpm` and prepend that directory to `PATH` for these commands. Don't change global setup.
7. **Evidence and ticks.**
   - Under `## Evidence`, add or update a "Checks" entry (the commit SHA, then each command with its exit code and output tail) and a "Scope" entry (the changed files, each with the Touchable entry it matched).
   - Then, for each `- [ ]` item under `## Verification`, tick it (`- [x]`) only if the PR body or a PR comment holds evidence for that exact item: command output, a link, or a pasted transcript. Items only a human can run stay unticked.
   - Write the body back the API way (see "Labels and ready state").
8. **Ready.** All three go through the API (see "Labels and ready state"): mark the PR ready, remove `in-progress` from the issue, add `agent-authored` to the PR.
9. **Report:** the PR URL, the check results, the scope result, and which checklist items are ticked and which still need a human.
