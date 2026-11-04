# ADR-002: Language policy

- Status: Proposed
- Date: 2026-11-04
- Decider: H-Gomez (repository owner)
- Issue: #20

## Context

The repository is a pnpm and Turborepo monorepo. The API is NestJS, the database layer is Prisma
(`packages/db`), shared config for TypeScript, ESLint, Prettier and Vitest lives in
`packages/config`, and the planned `packages/contracts` holds zod schemas and TypeScript types for
the messages every service exchanges. CLAUDE.md records the language policy as TBD pending this ADR.

The planned services split into two groups:

- **The core:** API, matching engine, settlement, ledger, bots, WebSocket gateway and the Desk
  Analyst. These touch orders, fills or the ledger, and depend on the money, ledger and strict-typing
  invariants in CLAUDE.md.
- **The market-data edge:** the feed ingestor (Binance, Coinbase and Kraken WebSockets into Redis
  Streams) and the index service (median across venues into index events). These never write to the
  ledger or touch user balances.

The agent workflow guide already plans the edge as Python (feed ingestor as Python/FastAPI, index
service as Python) and notes that Python services use `pytest` and `ruff check` in place of the
TypeScript checks. A policy is needed before those services are scaffolded.

## Decision

TypeScript is the default for every package and service. Python with FastAPI is allowed only for the
market-data edge, the feed ingestor and the index service, because neither has ledger contact. Any
other non-TypeScript service needs its own ADR.

The primary reason for choosing Python at the edge rather than TypeScript is TBC.

## Alternatives considered

- **All TypeScript.** The strongest alternative. One toolchain, one package manager, one linter, one
  test runner, one CI path. The edge services could import `packages/contracts` directly, so a tick
  or index-event schema change is a compile error everywhere instead of a runtime mismatch.
  WebSocket clients and a median calculation are well within Node's reach, so nothing at the edge
  requires Python. Agents working in the repo also need to hold only one set of conventions. It
  loses only if the reason for Python at the edge (TBC) outweighs these costs; if that reason does
  not hold up, this alternative should win.
- **Go for the market-data edge.** The natural "why not Go" question: the edge is long-lived
  WebSocket connections and small, CPU-light aggregation, which suits Go's concurrency model and
  single static binaries. It loses because it adds a third language and toolchain with no shared
  types, for a workload whose rates (TBC) do not obviously need Go's performance, and it offers none
  of whatever Python brings at the edge (TBC). Revisit if the ingestor becomes a measured bottleneck.
- **Python more widely (for example the Desk Analyst or bots).** Loses because the analyst and bots
  call the API and read user data, which keeps them inside the ledger-adjacent core where the
  TypeScript invariants apply.

## Consequences

- Easier: the ledger, settlement and engine stay in one language under one strict compiler config,
  so the money and typing invariants are enforced in one place.
- Harder: `packages/contracts` (zod) cannot be imported from Python. Messages crossing the boundary
  (ticks on Redis Streams, index events) need a second definition; how the two are kept in sync
  (generated JSON Schema, Pydantic models, contract tests) is TBC.
- Harder: two toolchains in CI and in `/ship`, which must detect a package's language from its
  manifest. Python version and dependency manager are TBC.
- Must stay true: Python code never writes to the ledger or the orders path. If an edge service
  needs that, this ADR is superseded first.
- Must stay true: the money rule still applies in Python. Prices and amounts use `decimal.Decimal`,
  never `float`. Whether index prices count as amounts under that rule is TBC.
