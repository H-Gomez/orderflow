# OrderFlow

OrderFlow is a crypto paper-trading exchange. Users sign up, get seeded virtual USD, and trade 5 to 8 pairs (BTC-USD, ETH-USD, SOL-USD, ...) against a real order-matching engine we build. The UI shows a live order book, candles, portfolio P&L, and the signature feature: two prices per instrument, the external index price (computed from real Binance/Coinbase/Kraken feeds) and this venue's last-traded price (emerging from your own book). A fleet of bot accounts keeps the market alive and tethered to the index. A Desk Analyst assistant answers questions over the user's own data, grounded in the database through tool calls, with a published eval scorecard.
It serves this through a NestJS API and a Desk Analyst LLM assistant that answers questions from the data and these docs.
It is a pnpm + Turborepo monorepo. Architecture: [docs/architecture.md](docs/architecture.md).

## Commands

Needs Node 24.21.0 ([.nvmrc](.nvmrc)) and pnpm 12.4.2 on `PATH` (`corepack enable pnpm`). Run from the repo root.

| Task      | Command                          |
| --------- | -------------------------------- |
| Install   | `pnpm install --frozen-lockfile` |
| Build     | `pnpm build`                     |
| Test      | `pnpm test`                      |
| Typecheck | `pnpm typecheck`                 |
| Lint      | `pnpm lint`                      |

## Invariants (non-negotiable)

- **Ledger:** never update or delete a ledger entry. The ledger is append-only, and a correction is a new entry.
  Every transaction's entries sum to zero per currency, so the ledger does too. Details: [docs/domain/ledger.md](docs/domain/ledger.md).
- Balances should not be stored, for example no column in DB. Instead they are computed.
- Read [docs/domain/](docs/domain/) before implementing domain behaviour. Settlement rules live in
  [docs/domain/settlement.md](docs/domain/settlement.md), matching rules in [matching.md](docs/domain/matching.md),
  and order states in [order-lifecycle.md](docs/domain/order-lifecycle.md).
  If a doc is still a stub, stop and ask. Never invent domain rules.
- TypeScript stays strict: `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on.
  Never weaken [tsconfig.base.json](packages/config/tsconfig.base.json) or add `@ts-ignore`.
- No default exports. Only `*.config.*` files are exempt, because their tools require a default export.
- Tests use Vitest. Never add Jest, ts-jest or Babel.
- Only touch the files listed in the story's "Touchable files". Anything else is out of scope.
- Never commit secrets or `.env` files.
- Destructive operations are forbidden such as `pulumi destroy`, `DROP TABLE`, queue purges. If you need these to be run please ask for approval.
- - Money is never binary floating point: no JS `number`, Prisma `Float`, or Postgres `real`/`double precision` for amounts. Representation: STORY-003.
- Every consumer is idempotent on event ID
- The engine publishes only via the outbox
- The assistant never states a number it didn't get from a tool

## Conventions

- Layout: `apps/` (UIs), `services/` (deployables), `packages/` (shared libraries). Packages are named `@orderflow/<name>`.
- Shared tsconfig, ESLint, Prettier and Vitest config live in [packages/config](packages/config). Extend them rather than copying them.
- Formatting: Prettier. Check with `pnpm format:check` and fix with `pnpm format`.
- Tests sit next to the code as `*.test.ts`.
- Commits use Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`).
- Language policy: TBD ([ADR-002](docs/adr/README.md)). Architecture beyond the layout above: TBD (ADR-001).
- Agent comments on issues and PRs, review summaries and PR-body prose follow [docs/conventions/agent-comments.md](docs/conventions/agent-comments.md).
  Check a body with `pnpm lint:comment`.
- Decisions are recorded as ADRs in [docs/adr/](docs/adr/README.md). Lessons go in [LEARNINGS.md](LEARNINGS.md).

## Definition of done

- Every item in the story's Verification section passes, and the PR description pastes the evidence.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` are green from a fresh clone.
- The diff stays inside the story's Touchable files. Nothing listed under "Out of scope" was changed.
- Docs are updated in the same PR when behaviour or a convention changes.

## Workflow

- One story, one branch, one PR. Branch name: `story-<id>-<slug>` (e.g. `story-001b-claude-md-docs-skeleton`).
- A story is a GitHub issue labelled `story`, with Context, Contract, Invariants, Out of scope, Verification
  and Touchable files. Agents only pick up issues labelled `agent-ready`.
- The PR body starts with `Closes #<issue>`.
- Run a story with `/ship start <issue>` and `/ship finish` ([.claude/skills/ship/SKILL.md](.claude/skills/ship/SKILL.md)).
- Agents open PRs. They never merge, approve, push to `main` or force-push.
- Agent tokens lack the `read:org` scope, so use `gh api` REST or GraphQL for labels, PR bodies and ready state rather than `gh pr ready` or `gh issue edit --add-label`.
- If the spec is ambiguous or conflicts with this file, stop and ask on the issue. Don't guess.
