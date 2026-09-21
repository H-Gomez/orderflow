# Working With an Agent Fleet: Decomposition & Workflow Guide

How to break work into agent-sized stories, run multiple Claude Code instances like a team you lead, and get compounding output instead of compounding mess. Written for the OrderFlow build, applicable to any repo.

> **v3 (21 Sep 2026):** issue numbers are now the story ID (§11.4). `agent-ready` is a state, not a trigger: CI runs start only from an `@claude` comment (§9.1, §10.2). Agents never edit `.github/workflows/` (§10.4). `/ship` is two-phase, `start` and `finish`, invoked only by the human; the agent executes the steps (§5.1). Agent comments follow `/docs/conventions/agent-comments.md` (§5.5). The em-dashes in older sections predate the no-em-dash rule and are left alone to avoid churn.
>
> **v2 (16 Sep 2026):** aligned with `senior-skillup-plan-v4.1.md`, which is canonical for milestones, story numbering, labels and board columns. Stories live only as GitHub issues. Added the visibility protocol (§5.1, §9.1), the actor check in `claude.yml`, per-language verification, and the M1 limited-access rule.

---

## 1. The mental model

You are not "using a coding assistant." You are the **tech lead of a team whose engineers are brilliant, fast, tireless — and have no memory between tasks and no accountability**. Every practice in this guide follows from those two deficits:

1. **No memory between tasks** → all context must live in _files_ (CLAUDE.md, `/docs`, story specs), never in your head or in a chat history you'll lose.
2. **No accountability** → verification must be _mechanical_ (tests, types, lint, invariant checks), never "looks right to me." An agent with a feedback loop it can run itself is 10× the agent without one.

The corollary that changes everything: **your job shifts from writing code to writing specifications and reviewing diffs.** The quality ceiling of agent output is the quality of the spec plus the strength of the feedback loop. Vague in, slop out.

---

## 2. What makes a good agent story

Adapt INVEST for agents. A story is agent-ready when it is:

| Property             | Meaning for agents                                                                                                 | Smell when violated                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| **Independent**      | Touches one package/service; parallelisable without merge conflicts                                                | Two sessions editing the same files                          |
| **Negotiable-_not_** | Unlike human stories, agents shouldn't improvise scope — the contract is fixed, the _implementation_ is theirs     | "Improve the settlement flow"                                |
| **Verifiable**       | Has a command that proves done: `pnpm test --filter settlement` passes, a property holds, an E2E scenario is green | "Done" = the agent says so                                   |
| **Small**            | One session's context window; one reviewable PR (< ~400 lines diff); roughly 1–4 focused human-hours of work       | Plan mode produces 15+ steps                                 |
| **Explicit**         | States invariants, non-goals, and files it may touch                                                               | Agent "helpfully" refactors the ledger while adding a button |
| **Self-contained**   | Links every doc the agent needs (`/docs/domain/settlement.md`, event catalogue entry, ADR)                         | Agent invents domain rules                                   |

**Sizing heuristics — split the story if:**

- Plan mode's plan exceeds ~10 steps, or you can't predict the diff's shape
- It spans more than one service _and_ one shared package
- The verification can't be expressed as runnable commands
- You'd be nervous reviewing it as a single PR from a mid-level human

**Merge the story if:** the diff would be < ~30 lines and it has no independent verification — micro-tasks waste your review bandwidth and the session-startup context cost.

---

## 3. Anatomy of a story spec (the template)

Stories are GitHub issues created from `.github/ISSUE_TEMPLATE/story.md`, which carries exactly these fields. One artefact, agent-readable, trigger-attached (§9.1). There is no `/docs/stories/` directory. Agents read issues; interviewers will too.

```markdown
# Settlement consumer: apply fills to the ledger

<!-- title carries no STORY number; the issue number is the ID (§11.4).
     STORY-019 below is the v4 planning alias, recorded in the epic's task list. -->

## Context (why)

Fills published on `trade-events` must become double-entry ledger pairs.
Read first: /docs/domain/settlement.md, /docs/events.md#fill-event, ADR-005.

## Contract (what)

- Consume `settlement.fifo` (MessageGroupId = accountId).
- For each FillEvent: release the hold, write DEBIT/CREDIT pairs for BOTH
  counterparties in ONE Postgres transaction, keyed by fillId.
- Emit `settlement-completed` via the outbox.

## Invariants (never violate)

- Ledger entries always sum to zero.
- Re-delivered/duplicate fillId ⇒ no-op (idempotent), logged at debug.
- Never UPDATE a balance row; balances are derived.

## Out of scope (do NOT touch)

- Matching engine, API service, frontend.
- No schema changes beyond migration 012 (already merged).

## Verification (definition of done)

- `pnpm test --filter @orderflow/settlement` green, including NEW property
  tests: duplicate delivery, out-of-order delivery, crash-mid-batch replay.
- `pnpm typecheck && pnpm lint` clean.
  (Python services use `pytest` and `ruff check` here instead; `/ship` detects
  the package's language from its manifest.)
- Update /docs/events.md consumer table.

## Touchable files

services/settlement/**, packages/ledger/** (read-only elsewhere)
```

Five minutes writing this saves an hour of review-and-redo. The **Invariants** and **Out of scope** sections do the most work — they are the difference between a surgical diff and a 40-file "improvement."

---

## 4. How to decompose an epic (worked method)

Take the M2 epic — _"Orders flow through SQS into the engine, fills settle to the ledger"_ (EPIC-1 in v4 §6.2) — and run this five-step method. Story numbers below are the v4 numbers; STORY-001 to 013 are the M0 harness and applicant slice.

**Step 1 — Contracts first, always.** The first stories define _interfaces, types, and docs_, not behaviour:

- `STORY-014`: Write `/docs/events.md` — every message on every queue, schema, ordering + delivery guarantees. (Agent drafts from architecture doc; you edit hard — this is the spine.)
- `STORY-015`: `packages/contracts` — zod schemas + TS types for OrderCommand, FillEvent, LedgerEntry; published to all services.

Once contracts are merged, everything downstream can run **in parallel** because agents code against types, not against each other.

**Step 2 — Draw the dependency DAG, then find the lanes.**

```
014 events.md ─▶ 015 contracts ─┬▶ 016 orders.fifo producer (API)      ─┐
                                ├▶ 017 engine: consume + match          ─┼▶ 022 E2E: order→fill→ledger
                                ├▶ 018 outbox + SNS publisher           ─┤
                                ├▶ 019 settlement consumer + ledger     ─┘
                                ├▶ 020 property-test harness (fast-check setup)
                                └▶ 021 bots v0: service accounts trade via API
(seed script + treasury are STORY-006, already merged in M0)
```

Lanes 016–021 are independent packages → up to six parallel worktree sessions. In practice run **2–3**; your review bandwidth, not agent capacity, is the bottleneck.

**Step 3 — Make tests their own stories where correctness is the point.** For the matching engine, write `STORY-020: property tests for matching (no fill worse than limit; deterministic replay)` _before_ or _alongside_ the implementation story — then the implementation story's definition of done is "the property suite passes." Spec-by-test is the strongest contract an agent can receive.

**Step 4 — One story = one branch = one PR = one fresh session.** Never let a session drift into a second story; context pollution is the top cause of quality decay. Finish, PR, `/clear` or new session.

**Step 5 — Close the loop into the repo, not the chat.** When an agent stumbles on something ambiguous (it will), the fix is a _documentation PR_ — update `/docs/domain/*.md` or CLAUDE.md — not a longer chat explanation. Teach the repo, not the session. This is how the fleet gets smarter every week.

---

## 5. Running the fleet: session mechanics that maximise throughput

### 5.1 The per-story loop

1. **Prime:** open a fresh session (via `cc-bot`, so it runs as `orderflow-agent`) in the story's worktree. First message: "Read issue #NN and the linked docs. Enter plan mode and propose your approach. Do not write code yet."
   Once the plan is approved, **you** type `/ship start NN`. That is the **visibility protocol**: the skill loads and the agent executes it, so the agent checks the issue is open and labelled `story` and `agent-ready`, assigns the issue to itself, adds `in-progress`, creates the branch (`story-<id>-<slug>`), comments the branch name, and opens a **draft PR** whose body is the story's Verification section as a checklist. The assignee and PR author are orderflow-agent. The skill has `disable-model-invocation: true`, so only a human can start it; the agent executes the steps but never decides to. Outside the skill the agent never assigns, branches, opens PRs or changes labels; if no one has run `/ship start`, it stops and says so. Boxes are ticked only with evidence. This is how you see what every agent is doing from the Project board or GitHub mobile, and CI-triggered runs follow the same protocol (§9.1).
2. **Plan review (your highest-leverage minutes):** edit the plan like a design review — cut steps, flag invariants it missed, correct wrong assumptions. A 2-minute plan correction prevents a 40-minute wrong implementation. If the plan is confused, the *spec* was — fix the spec and restart.
3. **Execute:** approve; let hooks auto-run format/typecheck on edits so the agent self-corrects continuously.
4. **Verify:** agent runs the story's verification commands until green, then you type `/ship finish` and the agent executes it: format, typecheck, lint, test, build; every changed file checked against Touchable files and the allowed file types; evidence pasted into the PR; checklist items ticked only where evidence exists; PR marked ready, `in-progress` removed, `agent-authored` added. No changelog step (changelogs conflict across parallel PRs; a nightly job owns them, §9.1). `finish` refuses after any red check or out-of-scope file, and never merges.
5. **Review the diff, not the summary.** Agents write persuasive summaries of code that doesn't do what the summary says. Read the diff. Ask questions in PR comments — with the GitHub Action wired, `@claude` addresses them in-place.
6. **Merge, log, clear.** If you request changes, add `rework`; if you throw the work away, close the PR with `rejected` and keep it (receipts for §7). Note anything reusable (a gotcha, a convention) → CLAUDE.md or `/docs`. New session for the next story.

### 5.2 Parallelism rules

- **2–3 concurrent sessions max** (review bandwidth is the constraint). Ownership boundaries per lane = package boundaries; two sessions must never share touchable files.
- Stagger starts so PRs arrive staggered; batch your review passes (e.g. top of each hour) instead of context-switching per notification.
- Use **agent teams / subagents** when work is read-heavy and parallel _within_ one story (e.g. "audit all consumers for idempotency" fans out nicely); use **worktrees** when work is write-heavy and parallel _across_ stories.
- Long-running background sessions (soak tests, bulk refactors) run headless (`claude -p`) or as background agents; they open draft PRs you triage later.
- **Limited-access periods (v4 M1):** only stories with no ledger or matching-engine contact run unattended; merges are batched to days you can read a full diff. A story that is fully spec'd but held back stays in `Spec'd` without the `agent-ready` label.

### 5.3 When an agent flails: the two-strike rule

If two corrective nudges haven't fixed the direction, **stop**. Do not argue with it — a polluted context rarely recovers, and a long argument teaches the session, which evaporates. Instead: extract the lesson (missing doc? ambiguous invariant? wrong-sized story?), fix the artefact, split the story if needed, restart fresh. Restarting with a better spec is nearly always faster than steering a confused session — and each restart permanently improves the repo.

### 5.4 Context hygiene

- Fresh session per story; `/clear` between unrelated tasks; `/compact` only mid-story when you must preserve state.
- Keep CLAUDE.md **short and imperative** (commands, invariants, conventions, pointers into `/docs`). It's loaded every session — bloat here taxes every task. Depth lives in `/docs`, loaded on demand.
- Prune stale docs ruthlessly: an agent confidently following an outdated event schema is worse than one with no schema.

### 5.5 Agent comments: the human reads five lines

Agent comments on issues and PRs follow `/docs/conventions/agent-comments.md` (story in progress at v3). The shape: line 1 a bold status word (`ACTION NEEDED`, `FYI`, `BLOCKED`, `DONE`); line 2 what the human must do; up to five short bullets of decisions and risks; everything else folded inside `<details>`. Nothing is deleted, only folded, so the audit trail survives. `tools/comment-lint` checks a comment body on stdin. The rule exists because reviewer bandwidth is the bottleneck (§5.2): a comment the human cannot read in ten seconds costs more than it saves.

---

## 6. Anti-patterns (each maps to a real failure mode)

| Anti-pattern                                       | What happens                                               | Fix                                                                               |
| -------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| The mega-prompt ("build the settlement system")    | Plausible 30-file PR with subtle invariant violations      | Decompose per §4; contracts first                                                 |
| Chat-as-spec (requirements live in conversation)   | Next session knows nothing; you re-explain forever         | Story files + `/docs`; teach the repo                                             |
| Vibe-verification ("looks good, merge")            | Defects surface two stories later, 5× costlier             | Runnable definition of done, always                                               |
| Arguing with a lost session                        | 45 minutes of mutual confusion                             | Two-strike rule; restart with better spec                                         |
| Letting agents write their own acceptance criteria | The test asserts what the code does, not what it should do | You (or a spec-by-test story) own the criteria                                    |
| Unlimited blast radius                             | "While I was there I refactored…" 600-line diffs           | `Out of scope` + `Touchable files` in every story; PreToolUse hooks as hard walls |
| Review by summary                                  | Persuasive prose over wrong code                           | Read diffs; ask the agent to justify specific lines                               |
| One eternal session for everything                 | Quality decays as context fills with noise                 | One story, one session                                                            |

---

## 7. Measure the workflow (and mine it for interviews)

Track a tiny weekly scorecard (a markdown table in the repo is fine):

- **Stories merged / week** and median **spec→merge cycle time**
- **% agent-authored** (by PR and by diff lines)
- **Rework rate:** PRs needing >1 review round; stories restarted under the two-strike rule
- **Defect escapes:** bugs found after merge, traced to which story/spec
- **Spec debt fixed:** doc PRs created because an agent got confused (this number going up early is _good_)

Two payoffs: the numbers tell you where the process leaks (high rework in one package usually means its `/docs` are weak), and the scorecard becomes the centrepiece of your "how I lead an agentic workflow" interview answer — metrics, receipts, and examples of rejected work beat any claim of "I'm proficient with AI tools."

---

## 8. Quick-reference: the lead's daily rhythm

**Morning (30 min):** triage overnight headless/background PRs → pick today's 2–3 stories from the DAG → sharpen their specs.
**During the day:** prime sessions → review plans hard → let them run → batched diff reviews on the hour → merge, log lessons to repo.
**End of day (15 min):** update the DAG and scorecard → queue a nightly headless audit (`claude -p "audit today's diffs against /docs invariants; file issues"`) → optionally kick off one long-running background task.

The compounding effect is the point: every story makes the docs sharper, the skills richer, and the next story faster. By M3 of OrderFlow the fleet should be visibly quicker than in M0 — screenshot the scorecard trend, because that graph _is_ the portfolio piece.

---

## 9. The autonomous pipeline: PRs, reviews, and bug hunters

Everything so far is interactive — you priming sessions. The next maturity level is a repo that **generates, reviews, and hunts its own work** while you sleep, with you as the only merge authority. Three lanes:

### 9.1 Automated PR creation (issue → PR without a session)

- **Comment-driven implementation:** on an issue labelled `agent-ready` (i.e. it meets the §3 story spec), you comment `@claude implement this per the story spec` and the Claude Code GitHub Action picks it up. The label is a state (spec complete, may be claimed); the comment is the trigger. It used to be both, which meant labelling from a phone could start a paid run and a local session at the same time; v3 separated them. The agent works in CI and follows the same visibility protocol as a local session (§5.1): `in-progress` label, draft PR with checklist, ready-for-review on completion.
- **Background agents** for long tasks (bulk refactors, dependency upgrades) run in worktrees and finish by committing, pushing, and opening a **draft PR** for your triage.
- **Nightly headless jobs** (`claude -p` in a scheduled workflow): housekeeping PRs — changelog updates, doc-drift fixes ("compare /docs/events.md against the actual publisher/consumer code; PR any drift"), dead-code sweeps.
- **Hard rule:** automation opens PRs; **only a human merges.** Enforce with branch protection (required review + status checks), not good intentions.

### 9.2 Automated code review (layered, human-last)

- **Layer 1 — deterministic:** typecheck, lint, tests, coverage gates as required status checks. Cheap, instant, non-negotiable.
- **Layer 2 — agent review on every PR:** a review workflow prompting against _your_ checklist: CLAUDE.md invariants, event-catalogue conformance, idempotency of any new consumer, "does the diff match the linked story's scope?", missed edge cases. Post findings as PR comments; author-agent responds to `@claude` follow-ups in-thread.
- **Layer 3 — security:** the Claude Code security-review action on every PR (injection, authz gaps, secrets); findings must be resolved or explicitly waived.
- **Layer 4 — you.** Read the diff (§5.1 still applies). Agent review raises the floor and catches drudgery; it does not replace the merge decision.
- **Bias note:** have a _fresh_ agent context review — never the session that wrote the code. Self-review inherits the author's blind spots; a clean context reviewing against the spec does not.

### 9.3 Bug hunters and finders (scheduled adversaries)

Give each hunter one job, a schedule, and one output: **a well-formed issue with a reproduction** (which then enters the `agent-ready` queue — the loop closes itself).

| Hunter                   | Schedule         | What it does                                                                                                                                                       |
| ------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Invariant auditor**    | Nightly          | Runs ledger-sums-to-zero + holds-never-negative checks against staging DB (read-only MCP); on breach, files a P1 with the offending entries and suspect fill IDs   |
| **Property fuzzer**      | Nightly          | fast-check suites at 50–100× normal iterations with fresh random seeds; counterexamples filed with the exact seed for deterministic reproduction                   |
| **DLQ & log triager**    | Every few hours  | Reads DLQ messages + error logs, clusters by signature, files one issue per cluster with a hypothesis and the offending payloads (redacted)                        |
| **Chaos runner**         | Weekly           | Executes the kill-the-engine / kill-settlement scenarios in staging under bot-fleet load; agent triages the run, files regressions, attaches the Grafana snapshots |
| **Flaky-test detective** | On CI retry-pass | Any test that failed-then-passed gets an investigation issue; agent attempts to reproduce with `--repeat` and bisects recent commits                               |
| **E2E prowler**          | Nightly          | Playwright-MCP exploratory session against staging with a persona brief ("aggressively cancel/replace orders mid-fill"); files UX and state-inconsistency findings |
| **Dependency triager**   | On advisory      | Dependabot alert → agent assesses actual exposure (is the vulnerable path reachable?), files a fix PR or a reasoned wontfix note                                   |

**Guardrails for the whole pipeline:** staging only, read-only credentials wherever possible, per-workflow token/budget caps, rate-limit on issue creation (a broken hunter filing 400 issues at 3am is its own incident), and a weekly 10-minute audit of hunter signal-to-noise — retire or re-prompt any hunter below ~50% useful findings.

**Why this matters for hiring:** "my repo reviews its own PRs, fuzzes itself nightly, triages its own dead-letter queues, and files reproducible bug reports that agents then fix" — with the issue history to prove it — is a demonstration of engineering-org design, not tool usage. Put the hunter configs in `.github/workflows/` where interviewers can read them.

---

## 10. Concrete setup: wiring the pipeline with GitHub Actions

Verify exact syntax against the docs when you build (https://code.claude.com/docs/en/github-actions and github.com/anthropics/claude-code-action) — but as of mid-2026 the shape is:

### 10.1 One-time setup (10 minutes)

1. Repo on GitHub, you have admin. Claude Code installed locally (`npm install -g @anthropic-ai/claude-code`).
2. In the repo, run `claude` then **`/install-github-app`** — it walks you through installing the Claude GitHub App, creating the secret, and opening a PR with a starter workflow.
3. Auth secret (Settings → Secrets and variables → Actions): either `ANTHROPIC_API_KEY`, or — if you're on a Pro/Max plan — `CLAUDE_CODE_OAUTH_TOKEN` generated locally with `claude setup-token`.
4. Repo hygiene that makes the pipeline safe: **branch protection** on `main` (require 1 human review, require status checks: test/typecheck/lint/security, no force-push), CODEOWNERS = you, labels created: `epic`, `story`, `bug`, `spike`, `hunter-finding` (work-item types) and `agent-ready`, `in-progress`, `agent-authored`, `rework`, `rejected` (pipeline states, which also feed the §7 scorecard). Use a branch **ruleset** rather than legacy branch protection; add yourself to the bypass list for pull requests only so your own PRs can merge without a second human.

### 10.2 The four workflows (`.github/workflows/`)

**`claude.yml` — interactive assistant + issue implementation** (this is the comment-driven PR-creation lane from §9.1):

```yaml
name: Claude
on:
  issue_comment: { types: [created] }
  pull_request_review_comment: { types: [created] }
jobs:
  claude:
    # only run for the repo owner's comments; on a public repo anyone can
    # type @claude, and without the actor check that is a paid run on your account.
    # No label trigger: agent-ready is a state, not a command (§9.1).
    if: >-
      github.actor == github.repository_owner &&
      contains(github.event.comment.body, '@claude')
    runs-on: ubuntu-latest
    permissions: { contents: write, pull-requests: write, issues: write, id-token: write }
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          claude_args: "--max-turns 30"
```

Comment `@claude implement this per the story spec` on an `agent-ready` issue → Claude works in the runner → opens a PR referencing the issue. Prompts in both workflows point the agent at `/docs/conventions/agent-comments.md`, and `claude-review.yml` sets `use_sticky_comment: true` so each PR carries one review comment updated in place (human-applied follow-up to the comment-format story).

**`claude-review.yml` — automated first-pass review on every PR:**

```yaml
name: Claude Review
on:
  pull_request: { types: [opened, synchronize] }
jobs:
  review:
    runs-on: ubuntu-latest
    permissions: { contents: read, pull-requests: write, id-token: write }
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Review this PR against CLAUDE.md invariants and /docs/events.md.
            Check: idempotency of any new consumer; ledger invariants; diff
            stays within the linked story's Touchable files; missed edge cases.
            Post findings as review comments. Do not approve or merge.
```

**`security.yml`** — add the separate `anthropics/claude-code-security-review` action on `pull_request` (injection, authz gaps, secrets).

**`nightly.yml` — headless audits & hunters (§9.3):**

```yaml
name: Nightly Audit
on:
  schedule: [{ cron: "0 3 * * *" }]
jobs:
  audit:
    runs-on: ubuntu-latest
    permissions: { contents: read, issues: write, id-token: write }
    steps:
      - uses: actions/checkout@v4
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          prompt: |
            Audit the last 24h of commits against /docs invariants and the
            event catalogue. Run the invariant checks (pnpm audit:invariants).
            File one issue per confirmed finding, labelled hunter-finding,
            with reproduction steps. Max 5 issues per run.
          claude_args: "--max-turns 15"
```

Clone this pattern per hunter (fuzzer, DLQ triager, chaos triager) with different crons, prompts, and — critically — the issue-rate cap in the prompt.

### 10.3 Guardrails that keep CI agents cheap and safe

- `--max-turns` on every workflow; job-level `timeout-minutes`; a billing alert on the Anthropic console.
- Fork safety: `pull_request` (not `pull_request_target`) so secrets never reach fork PRs — matters once the repo is public.
- `permissions:` blocks stay minimal per workflow (the review job needs no `contents: write`).
- Everything above opens PRs/issues only; branch protection makes human merge structurally unavoidable.

### 10.4 Agents never edit the workflows that govern them

Nothing under `.github/workflows/` is ever in a story's Touchable files; every story lists `.github/` under Out of scope with the human as owner. The threat is not malice but an agent loosening a failing check or widening a `permissions:` block to finish a task. The CI path cannot push workflow files anyway (the App token lacks the `workflow` scope); the local path matches it by rule, and a `PreToolUse` hook denying writes to `.github/workflows/**` turns the rule into a wall (add it when the hooks are next touched). Cost: workflow changes are your job, including the M2 hunter clones. Say it this way in interviews: "agents cannot edit the CI that governs agents."

---

## 11. Task tracking: tooling decision and work-item hierarchy

### 11.1 Tooling: GitHub Issues + Projects — not Notion, not Obsidian

The §9 pipeline _runs on GitHub events_: labels trigger implementation, PRs trigger review, issues are what hunters file. Tracking anywhere else severs tasks from their triggers. So:

- **GitHub Issues** = the work items. **GitHub Projects** (one board: `Backlog → Spec'd → Agent-ready → In progress → In review → Merged`) = the view. `Spec'd` and `Agent-ready` are separate on purpose: a complete spec can be held back from agents (see §5.2, limited-access periods). Milestones = v4's M0 to M6.
- **The repo `/docs`** = the knowledge base (this was already the rule: teach the repo). Story specs can live as issue bodies using an issue template containing the §3 fields — one artefact, agent-readable, trigger-attached.
- **Notion**: fine for private career/interview material (you already use it), but putting specs or tasks there splits the source of truth and agents in CI can't be triggered by it. Don't.
- **Obsidian**: local-first personal notes — invisible to CI agents entirely. Use it for thinking if you like it; nothing the fleet needs may live there.
- One legitimate Notion/MCP exception: if you want to _demo_ MCP breadth, a read-only weekly digest pushed to a Notion page is a nice flourish — but it's a mirror, never the master.

### 11.2 Hierarchy: keep two levels + milestones (solo + agents ≠ enterprise ceremony)

Formal Feature > Epic > Story > Task ladders exist to coordinate multiple teams. You have one human and a fleet, so:

| Level         | What it is here                                                                    | GitHub representation                                                                                           | Sizing rule               |
| ------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **Milestone** | A phase with an outcome ("Correctness core")                                       | Milestone                                                                                                       | 1–3 weeks (v4 §6)         |
| **Epic**      | A shippable capability; a checklist of stories; _never_ given to an agent directly | Issue labelled `epic` with a task-list of story links                                                           | 3–9 stories               |
| **Story**     | One agent-sized unit per §2–§3: one spec, one session, one PR                      | Issue labelled `story`, becomes `agent-ready` when the spec is complete; identified by its issue number (§11.4) | ≤ 1 day, ≤ ~400-line diff |
| **Task**      | A step inside a story                                                              | Checklist item in the story body                                                                                | not tracked separately    |

"Feature" and "Epic" are the same thing at this scale — use the word Epic and move on. Two extra types earn their keep: **`bug`** (hunter or human finding, with reproduction — becomes `agent-ready` once triaged) and **`spike`** (timeboxed investigation whose deliverable is a _document_, usually an ADR, never code).

### 11.3 Worked example: OrderFlow, M2–M3 (numbers per v4)

```
Milestone: M2 — Correctness core            (014–015 drafted during M1, agent-implemented, you edit hard)
└─ EPIC-1  Orders flow end-to-end: API → orders.fifo → engine → outbox → settled ledger
   ├─ STORY-014  Event catalogue (/docs/events.md)             [spec first, you edit hard]
   ├─ STORY-015  packages/contracts: zod schemas + types       [unblocks all lanes]
   ├─ STORY-016  API: order submission → orders.fifo producer
   ├─ STORY-017  Engine: consume, match (limit/market), partial fills
   ├─ STORY-018  Outbox table + SNS publisher
   ├─ STORY-019  Settlement consumer → double-entry ledger + holds
   ├─ STORY-020  Property-test harness (fast-check) + matching invariants
   ├─ STORY-021  Bots v0: service accounts placing orders via the public API
   ├─ STORY-022  E2E: seeded bot order → fill → both ledgers move
   └─ SPIKE-001  Agent-teams mode for parallel consumers (1 day → ADR-007)

Milestone: M3 — Live data & real-time
└─ EPIC-2  Index price + live UI
   ├─ STORY-023  Feed ingestor (Python/FastAPI): Binance/Coinbase/Kraken WS → Redis Streams   [skeleton PR lands in M1 unattended; completion in M3]
   ├─ STORY-024  Index service (Python): median across venues → index events
   ├─ STORY-025  WS gateway: pub/sub fan-out + sequence-number resume
   ├─ STORY-026  UI: live order book + candles + index-vs-venue spread
   └─ STORY-027  Bots v1: market-maker + noise strategies from bots.yaml

(from the hunters, later)
BUG-031  [hunter-finding] Duplicate fill on settlement redelivery when
         hold released early — repro: seed 42, STORY-020 suite iteration 3181
```

Litmus tests: if you'd hand it to an agent session, it's a **story**; if it needs several sessions, it's an **epic** (split it); if the output is a decision rather than a diff, it's a **spike**; if it arrived with a reproduction, it's a **bug**.

### 11.4 Identity: the issue number is the ID (v3)

Hand-allocated `STORY-NNN` numbers drifted within a week of M0 (`T01`, `005a/b`, `008a/b` appeared). GitHub already gives every issue a unique number that is never reused, so from 21 Sep 2026:

- **Identity = issue number.** `#47` is the story. Branch `story-47-<slug>`, PR body `Closes #47`, scorecard rows keyed on `#47`. Titles carry no `STORY-` prefix.
- **Type = label** (`story`, `epic`, `bug`, `spike`, `hunter-finding`). The old prefix carried type information the label already carries.
- **Order = the DAG**, held in the epic issue's task list and a `Blocked by: #NN` line in each story's Context. Never in the number.
- **Legacy aliases.** STORY-001 to 013 (and their splits) exist as GitHub issues with the old titles; leave them. 014 to 030 exist only in v4 and this guide as planning aliases; when they are created in M1 they get plain titles, and the epic issue's task list is the mapping from alias to real number. References like "STORY-019" in §3, §4 and §11.3 are aliases in that sense.
- **ADRs keep sequential numbers.** They are filenames, low volume, and you allocate them. v4 reserves 003 to 007; the next free is 008 (Vitest over Jest).
- **Not done:** no counter file in the repo (parallel sessions race on it), no rename-on-create workflow, and `/plan-epic` never picks numbers.

---

## 12. Frameworks & managers: adopt, spike, or just know about

The 2026 landscape splits into three tiers — and one honest warning up front: this category churns violently (Crystal was deprecated and became Nimbalyst; Vibe Kanban's company shut down in April 2026 and the tool went community-OSS within a year of launch). Learn the _patterns_ (worktree/container isolation per agent, review surfaces, task queues); hold the tools lightly.

### 12.1 ADOPT — go deep on native Claude Code orchestration first

This is both the deepest harness in the field and the thing London JDs name. Master, in order:

1. **Subagents** (`.claude/agents/`) — in-session fan-out with isolated contexts (already in §5).
2. **Agent Teams** — experimental multi-instance mode: one lead session coordinating teammates with a shared task list, dependency tracking, peer messaging, and file locking. Enable via `"env": {"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"}` in settings.json (v2.1.32+), then describe the team in natural language. This is SPIKE-001 in M2 — write ADR-007 on where it beat/lost to manual worktrees.
3. **Background agents + Routines** (cron and GitHub triggers) — Routines can replace some of §10's raw workflow YAML for scheduled hunters; try both, keep the simpler one.
4. **Dynamic Workflows** — large-scale parallel subagent orchestration within one session; worth one experiment on a bulk task (e.g. the test-coverage sweep) for the write-up.

### 12.2 SPIKE — one local fleet manager, timeboxed to a day

These sit one layer above the agents: session visibility, worktree-per-agent isolation, diff review, resume. Pick ONE:

- **Conductor** (Mac) — parallel Claude Code/Codex agents, each in its own worktree, visual dashboard + diff-first review. The default choice if you're on macOS.
- **Claude Squad** (terminal, tmux-based) — the maintained terminal-native option for Linux/solo use; note AGPL licence.
- Others in the same lane if curiosity strikes: Nimbalyst, Vibe Kanban (community OSS since the company closed), Gas Town, cmux. Default: spike Conductor on macOS, otherwise Claude Squad; one day, one ADR, before writing any `/dispatch` skill of your own.
  Spike output = an ADR: "manual worktrees vs [tool] — what it bought, what it cost." For a 2–3-agent solo workflow, the honest answer may be "not needed yet" — knowing _where the threshold is_ (roughly 5+ concurrent agents / multiple repos) is the senior take.

### 12.3 USE FOR THE BACKLOG — cloud/async agents (Tier 3)

Assign an issue, walk away, return to a PR: **Claude Code on the web** (claude.ai/code — GitHub-connected, Anthropic-managed VMs, steerable mid-run) and **GitHub Copilot coding agent** (issue → PR inside Actions). These complement §9's label pipeline for low-risk housekeeping stories. Also know **GitHub Agent HQ** — GitHub's "mission control" for multiple agents with branch-scoped permissions and audit — governance of agent fleets is becoming an interview topic in its own right.

### 12.4 KNOW FOR INTERVIEWS — the competitor field and the in-product frameworks

- **Coding-agent field:** OpenAI Codex (leaner on tokens; clean async queue UX), Cursor (cloud agents), Devin (most autonomous, VM-per-agent), Google Antigravity, OpenCode (open-source). The concept that ties them together — the _harness_ (same model, different scaffolding, very different results) — is a great interview riff you can speak to from direct experience.
- **In-product agent frameworks** (for the v4 §9 AI-in-OrderFlow work): **Claude Agent SDK** (your LLM-driven bot — closest to what you already know), **LangGraph** (the orchestration framework London JDs actually name), **Vercel AI SDK** (the pragmatic TS choice for the Desk Analyst's streaming UI). Evals: **promptfoo** or Braintrust in CI. LLM observability: **Langfuse** or OTel GenAI conventions on your existing Grafana stack. One of each layer, wired end-to-end, beats surface familiarity with ten frameworks.

### 12.5 The economics warning (say this in interviews too)

Parallel agents multiply tokens roughly linearly-plus — a 3-agent team can burn ~7× a single session, and unattended large runs have produced four- and five-figure bills. Multi-agent is the wrong tool for most tasks; the §5 rule stands: your review bandwidth, not agent capacity, is the constraint. Caps, budgets, and knowing when _not_ to fan out are the senior signals.
