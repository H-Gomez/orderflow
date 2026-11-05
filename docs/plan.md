## Master plan, product and architecture sections.

Source of truth is the project plan; this copy exists so ADRs and stories can cite it.

# OrderFlow master plan: product and architecture

Source of truth is the project plan (v4.2, 4 November 2026 in ClaudeAI) kept
outside the repo. This copy holds the sections that ADRs and story specs cite: why the
product exists, what it must prove, the architecture, the accounts model and the AI in the
product. Milestones, calendar, harness inventory, budget and career material stay outside.
Update this file when the plan's corresponding sections change; the plan version is the
line above.

## 1. Why this project

**The app:** _OrderFlow_, a crypto **paper-trading exchange**. Users sign up, get seeded virtual USD, and trade 5 to 8 pairs (BTC-USD, ETH-USD, SOL-USD, ...) against a **real order-matching engine** you build. The UI shows a live order book, candles, portfolio P&L, and the signature feature: **two prices per instrument**, the external **index price** (computed from real Binance/Coinbase/Kraken feeds) and **your venue's last-traded price** (emerging from your own book). A fleet of bot accounts keeps the market alive and tethered to the index. A **Desk Analyst** assistant answers questions over the user's own data, grounded in the database through tool calls, with a published eval scorecard.

**Why crypto, why this clone:**

1. **Free, real, unlimited data.** Public crypto exchange WebSocket feeds are free and real-time with no licensing headaches, unlike equities (limited free tiers) or commodities (exchange-licensed, expensive). £0/month, and load-relevant volume 24/7.
2. **It compounds your OTC background.** Venue price vs. reference/index price is exactly the mechanic of the commodities platform you just built; this extends your domain story instead of diluting it. Real derivatives venues maintain an index price across external exchanges alongside their own last trade. You're building the same shape.
3. **It forces every senior competency at once:** strict correctness under concurrency (matching, holds, double-entry settlement), event-driven architecture on real message queues, real-time fan-out, caching, idempotency, observability, and load you can _prove_.
4. **The bot fleet is a built-in load generator.** Dummy accounts trading against each other means your load tests exercise the true hot path (order → match → settle → fan-out), not just HTTP endpoints.
5. **It is a natural host for AI in the product.** Portfolio questions, order explanations and docs search are real use cases for tool use and RAG, and the ledger gives you ground truth to eval against.

**Scope discipline (senior signal #1):** no real money, no KYC, no custody, no withdrawals. Spot trading only, limit + market orders. Cut features ruthlessly; the goal is depth on the hard 20%.

---

## 2. What must be visible in the final artifact

This project must therefore prove:

| Competency                          | Proven by                                                                                                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System design & trade-off judgement | Written ADRs (Architecture Decision Records) in the repo                                                                                                             |
| Correctness under concurrency       | Matching + ledger property tests, holds/settlement lifecycle, idempotency end-to-end                                                                                 |
| Event-driven architecture           | Queue-backboned design: FIFO ordering, dedup, outbox, DLQs, backpressure, measured not asserted                                                                      |
| Relational depth                    | Prisma schema and migrations in the repo, append-only ledger, pgvector on the same Postgres                                                                          |
| Scale & performance                 | k6 + bot-fleet load reports, Grafana dashboards committed to the repo                                                                                                |
| Infrastructure as code              | Entire environment reproducible via `pulumi up` from a clean AWS account                                                                                             |
| Operations maturity                 | Alerts, runbook, chaos tests (kill workers mid-load, show zero lost orders/fills)                                                                                    |
| Modern React                        | React 19 + Next.js App Router, Server Components, streaming, real-time client state                                                                                  |
| AI in the product                   | Desk Analyst with tool use and RAG, evals gating CI, LLM observability and cost routing, an MCP server                                                               |
| Agentic engineering                 | Public `.claude/` directory (CLAUDE.md, skills, subagents, fail-closed hooks), agent-authored PRs with your review trail, CI agents, a scorecard with cost per story |
| AI governance                       | Agent identity separated at the machine level, agents cannot edit the CI that governs them, no AI approval counts towards a merge, guard hooks that fail closed      |
| Polyglot judgement                  | One Python/FastAPI service at the market-data edge with an ADR on when to mix languages                                                                              |
| Communication                       | Public write-up in three parts (assistant + evals · agent fleet with metrics · queues, backpressure, chaos)                                                          |

**Rule for the whole project:** you are the _tech lead_; Claude Code instances are your team. You review every PR. The repo's PR history _is_ your leadership evidence.

---

## 3. Architecture: queues as the backbone

```
   Binance WS   Coinbase WS   Kraken WS        (free public feeds)
        └────────────┼────────────┘
                     ▼
           ┌───────────────────┐    ticks     ┌──────────────────┐
           │  Feed Ingestor    │─────────────▶│  Redis Streams    │──▶ Index Price Service
           │  (Python/FastAPI) │  (hot path)  └──────────────────┘    (Python; median across venues,
           └───────────────────┘                                       published as events)
 Users ──▶ Next.js (React 19) ──▶ ALB ──▶ API service (NestJS/TS, Prisma)
 Bots ──▶ (same public API) ─────────────────┐
                                             ▼
                              ┌──────────────────────────────┐
                              │  SQS FIFO: orders.fifo        │  MessageGroupId = instrument
                              │  (dedup by client-order-id)   │  → strict per-instrument order
                              └──────────────┬───────────────┘  → parallel across instruments
                                             ▼
                              ┌──────────────────────────────┐
                              │  Matching Engine              │  single writer per instrument
                              │  (price-time priority)        │  transactional OUTBOX table
                              └──────────────┬───────────────┘
                                             ▼ outbox publisher
                              ┌──────────────────────────────┐
                              │  SNS topic: trade-events      │  fan-out to SQS per consumer:
                              └──┬──────────┬──────────┬─────┘
                                 ▼          ▼          ▼
                          settlement.fifo  candles   notifications   (+ DLQ on every queue)
                                 │          │          │
                                 ▼          ▼          ▼
                    Settlement/Ledger    Candle/OHLCV   Lambda (SQS-triggered)
                    worker (Postgres:    aggregator     + API Gateway webhook
                    double-entry, holds)

   Redis pub/sub (latency path) ──▶ WebSocket Gateway ──▶ browsers (book deltas, index+venue price, fills)

   Desk Analyst (Claude API, tool use) ──▶ API service tools + pgvector search_docs ──▶ streaming chat panel
   promptfoo evals in CI ──▶ scorecard in repo    OTel GenAI spans ──▶ Grafana LLM panel
```

**Where a queue sits on every async path (and why):**

| Path                   | Transport                                                       | Key design point                                                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Order ingestion        | **SQS FIFO** `orders.fifo`                                      | `MessageGroupId=instrument` gives strict per-instrument ordering with parallelism across instruments; `MessageDeduplicationId=clientOrderId` gives broker-level idempotency; DLQ + redrive |
| Engine → world         | **Transactional outbox → SNS → SQS fan-out**                    | Engine never publishes directly; outbox row commits atomically with the fill, publisher relays. Exactly-once _effect_ via idempotent consumers                                             |
| Settlement             | **SQS FIFO** `settlement.fifo` (group = account)                | Per-account ordering for holds/credits; consumer is idempotent on fill ID                                                                                                                  |
| Candles                | Standard SQS, ECS consumer                                      | Independent scaling, independent failure                                                                                                                                                   |
| Notifications          | Standard SQS → **Lambda**; inbound webhooks via **API Gateway** | Same fan-out, serverless consumer. Gives an honest Lambda + API Gateway story alongside the container one                                                                                  |
| External ticks → index | **Redis Streams** + consumer groups                             | Hot path: high volume, replayable, cheap; ADR: Streams vs Kinesis vs Kafka/MSK and what scale triggers migration                                                                           |
| Real-time UI fan-out   | Redis pub/sub → WS gateway                                      | Latency path where at-most-once is acceptable (UI reconciles via REST snapshot + sequence numbers)                                                                                         |

That last row is the interview gold: you can articulate **which paths need durability + ordering (queues) vs. which need latency (pub/sub)**, and you chose deliberately, per path.

**Stack decisions (each gets an ADR):**

- **TypeScript by default; Python at the market-data edge.** Next.js 15+/React 19, Tailwind, TanStack Query, `lightweight-charts`, Zustand (ADR: vs MobX, you can argue both). The feed ingestor and index price service are **Python/FastAPI**: small, self-contained, no ledger contact, and the honest answer to "do you work outside TypeScript?" ADR-002 covers the language policy.
- **NestJS services on ECS Fargate** (ADR: why containers over the serverless functions you used at the fintech: long-lived WS, steady consumers, no cold starts; argue both sides). NestJS over Fastify because that's the name on the specs; Nest can run on the Fastify adapter if you want the throughput.
- **Matching engine:** in-memory price-time priority book, single writer per instrument, consuming `orders.fifo`. Small, correct, heavily tested. The crown jewel.
- **Postgres (RDS) via Prisma:** users, orders, **append-only double-entry ledger**, holds, outbox, assistant conversations. Migrations committed. **pgvector** on the same instance for docs embeddings. **Redis (ElastiCache/Upstash):** book snapshots, streams, pub/sub, rate limits.
- **Pulumi (TypeScript) on AWS**, deliberately porting your Azure Pulumi skills to AWS (multi-cloud story; London specs skew AWS). All queues/topics/DLQs/Lambdas are Pulumi resources. **ADR-005 Fargate vs EKS**; optional one-service EKS deploy in M4.
- **Auth:** Clerk or Auth0 for humans over **OIDC**; the API validates JWTs directly and says so. **Bot accounts are service accounts with API keys** created by the seed script (no OAuth flow).
- **Observability:** OpenTelemetry traces across API → SQS → engine → SNS → settlement; Grafana Cloud dashboards including **queue depth, oldest-message age, consumer lag, DLQ depth**; alerts on all four. LLM calls carry OTel GenAI spans into the same stack. The GenAI semantic conventions are still at Development status, so the schema version is pinned in code and bumped deliberately. Claude Code's own OTel export (including its `safety_event` for blocked tool calls) lands in the same Grafana stack from M0.
- **AI:** Claude API with tool use for the Desk Analyst; **Vercel AI SDK 7** (Node 22, ESM, spans via `@ai-sdk/otel`) for streaming into React; **promptfoo** for evals in GitHub Actions (no vendor account needed); Agent SDK for the stretch LLM bot; an OrderFlow **MCP server** in M6. **Models:** Haiku 5.5 for lookups and routing, Sonnet 5.5 for reasoning, Opus 5.5 only where planning quality pays for it. No story, eval config or workflow pins Sonnet 4.5, which retires from the API on 30 Nov 2026.

**Performance/correctness targets to publish (SLO-setting is itself senior):**

- Order placement API: **p99 < 200ms at 500 RPS sustained**
- Order → match → settle → WebSocket fill confirmation: **p99 < 500ms** at steady state; **burst 200 orders/sec absorbed by queues with full recovery < 60s** (the backpressure demo)
- **10,000 concurrent WebSocket clients**, index + venue prices < 1s stale
- **Zero lost or duplicated orders/fills** while killing the engine _and_ the settlement worker mid-load (chaos tests)
- Ledger invariant: **sum of all entries = 0, always** (property-tested and asserted in prod via a scheduled check)
- Desk Analyst: **every number traceable to a tool call**; eval pass rate published; p95 under concurrent users measured in M5
- Cold start: full environment from empty AWS account via `pulumi up` in < 30 minutes

---

## 4. Accounts, treasury seeding, and the bot fleet

### 4.1 Real capital movement via double-entry ledger

The ledger, accounts, holds and settlement rules are owned by `docs/domain/ledger.md`,
`accounts.md` and `settlement.md`, which are the only source for them. The plan's intent,
in one line each, so the architecture reads on its own:

- Every balance is derived from ledger entries; there is no balance column anywhere.
- Seeding is a real `DEPOSIT` transaction from the treasury, from M0 onwards, so nothing is
  retrofitted later; the seed script writes synthetic fill history as proper ledger pairs.
- Holds reserve buying power; each fill converts holds into debit/credit pairs for both
  counterparties in one transaction, idempotent on fill ID. This lifecycle under concurrency
  is the hardest and most interview-valuable code in the project.
- The ledger API in `packages/db` (`postTransaction`, `placeHold`, `balanceOf`,
  `buyingPowerOf`, `heldOf`, `LedgerError`) is the only way code touches the ledger.

Where this file and the domain docs disagree, the domain docs win and this file is wrong.

### 4.2 Bot fleet (dummy accounts trading each other)

- **Market-maker bots:** quote a spread around the **index price**, refresh on index moves. This is what tethers your venue price to reality _emergently_, with no hard-coding.
- **Noise/taker bots:** randomly cross the spread with market orders (parameterised aggression), creating fills, P&L movement, and realistic book churn.
- Bots **consume market events from the same streams and trade through the same public API** as humans: dogfooding your own contract, and doubling as the domain-level load generator (scale the fleet = scale the load).
- Config-driven fleet (`bots.yaml`: count, strategy, order rate); runs as one ECS service you can scale for load tests.
- **Stretch (M6):** one bot driven by Claude via the Agent SDK under hard guardrails. See §9.3.

---

## 9. AI in the product

(Section numbers follow the plan; 5 to 8 are milestones, harness and budget and are not copied here.)

The agentic harness (`.claude/`, CLAUDE.md, the workflow guide in docs/) proves AI-native **development**. The specs also want AI running **in production**: agent orchestration, evaluation, guardrails, observability for AI systems. OrderFlow is a natural host. §9.1 and §9.4 are M0; §9.2 is M6; §9.3 is the M6 stretch.

### 9.1 "Desk Analyst" assistant (M0)

A chat panel in the app answering questions over the user's own data: "why is my P&L down today?", "summarise BTC activity in the last hour", "what's my exposure vs. the index?", and, via RAG, "why is settlement idempotent?"

- Claude API with **tool use**: `get_portfolio`, `get_trades`, `get_candles`, `get_ledger`, `search_docs`; later `get_order_status`, `explain_fill`, `get_index_history`. The model calls your services; numbers come from the DB, never from the model's head.
- Streaming responses into React via Vercel AI SDK 7; per-user conversation state in Postgres. Haiku 5.5 routes and looks up; Sonnet 5.5 reasons.
- **Proves:** LLM integration, function calling, RAG, streaming UX, grounding answers in system-of-record data.

### 9.2 OrderFlow MCP server (M6)

Expose the exchange as an MCP server (`get_book`, `get_portfolio`, `place_paper_order`, `cancel_order`) so anyone can trade your paper exchange _from Claude_.

- Prompt-injection-aware: hard order-size and rate limits server-side, explicit confirmation for order placement, all model-originated input treated as untrusted. An agent that can move (paper) money is the ideal stage for demonstrating AI security thinking.
- **Proves:** building MCP, not just consuming it, plus API design and AI threat modelling.

### 9.3 LLM-driven bot strategy (M6 stretch)

One bot in the fleet driven by Claude via the **Agent SDK**: reads market events from the stream, reasons about book/index divergence, trades through the same public API as everyone else, under hard guardrails (max position, max order rate, drawdown kill-switch, budget cap). The SDK's per-tool `permission_policy` (`always_deny` on anything that is not a paper order through the public API) and `verbatim_prompts` (market text never expands into commands) are the first two guardrails; the rest are in your code.

- Log every decision with its reasoning; chart its P&L against the dumb bots on a public dashboard (it will probably lose; that's a better story: "here's what the eval data told me about where LLM judgement breaks down").
- **Proves:** autonomous agent design, tool orchestration, guardrails and failure handling in a live system.

### 9.4 Cross-cutting: evals + AI observability (M0, extended every milestone)

- **Evals in CI (promptfoo):** golden-question suite covering tool-call correctness, numeric accuracy checked against DB truth, refusal behaviour on out-of-scope asks, RAG retrieval hit rate. Runs on every prompt, tool, model or docs change; scorecard published in the repo. Configs name Haiku 5.5 and Sonnet 5.5, never a retired model.
- **AI observability & cost engineering:** OpenTelemetry spans on every LLM call; Grafana panels for token spend, latency, error rate per model; **model routing** (cheap model for simple queries, escalate on complexity) with the saving measured on the dashboard.

---
