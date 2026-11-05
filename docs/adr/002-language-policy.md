# ADR-002: Language policy

- Status: Accepted
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

Source: docs/plan.md §3 (stack decisions) and §2 (polyglot judgement)

## Decision

TypeScript is the default for every package and service. Python with FastAPI is allowed only for the
market-data edge, the feed ingestor and the index service, because neither has ledger contact. Any
other non-TypeScript service needs its own ADR.

Rationale, stated plainly: on engineering merit alone, all-TypeScript wins, as the alternatives
below show. Python is chosen because the roles this project targets name Python/FastAPI, and the
market-data edge is the lowest-risk place to demonstrate it: self-contained, no ledger contact, and
disposable if it fails.

## Alternatives considered

- **All TypeScript.** The strongest alternative on engineering merit. One toolchain, one package
  manager, one linter, one test runner, one CI path. The edge services could import
  `packages/contracts` directly, so a tick or index-event schema change is a compile error everywhere
  instead of a runtime mismatch. WebSocket clients and a median calculation are well within Node's
  reach, so nothing at the edge requires Python. Agents working in the repo also need to hold only
  one set of conventions. It loses only on the non-technical goal in the rationale above: it does not
  demonstrate Python/FastAPI.
- **Go for the market-data edge.** The natural "why not Go" question: the edge is long-lived
  WebSocket connections and small, CPU-light aggregation, which suits Go's concurrency model and
  single static binaries. It loses because it adds a third language and toolchain with no shared
  types, for a workload whose rates (TBC, measured in M3) do not obviously need Go's performance, and
  it does not serve the goal of demonstrating Python/FastAPI. Revisit if the ingestor becomes a
  measured bottleneck.
- **Python more widely (for example the Desk Analyst or bots).** Loses because the analyst and bots
  call the API and read user data, which keeps them inside the ledger-adjacent core where the
  TypeScript invariants apply.

## Consequences

- Easier: the ledger, settlement and engine stay in one language under one strict compiler config,
  so the money and typing invariants are enforced in one place.
- Harder: `packages/contracts` (zod) cannot be imported from Python. JSON Schema is generated from
  the zod schemas in `packages/contracts` at build time, the Python services validate against those
  files with pydantic, and one contract test in CI fails if either side drifts.
- Harder: two toolchains in CI and in `/ship`, which must detect a package's language from its
  manifest. Python services use Python 3.13, managed with uv.
- Must stay true: Python code never writes to the ledger or the orders path. If an edge service
  needs that, this ADR is superseded first.
- Must stay true: the money rule applies in Python. Index prices are amounts under that rule: they
  use `decimal.Decimal`, never `float`, with the same scale rules as
  [ledger.md](../domain/ledger.md).
