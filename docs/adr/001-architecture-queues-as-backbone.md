# ADR-001: Architecture: queues as the backbone

- Status: Accepted
- Date: 2026-11-04
- Decider: H-Gomez (repository owner)
- Issue: #19

## Context

OrderFlow moves four kinds of traffic, and they want different things from transport:

1. **Order commands** (API to matching engine). Per-instrument order matters: two orders on the same
   book must reach the engine in the order they were accepted, or price-time priority is wrong.
2. **Fills and settlement** (engine to settlement and the ledger). Must not be lost and must not be
   applied twice. The ledger is append-only and every transaction sums to zero per currency
   ([ledger.md](../domain/ledger.md)), so a duplicated or dropped fill is a correctness bug, not a
   glitch.
3. **External ticks** (Binance, Coinbase and Kraken feeds into the index service). High rate,
   short-lived, and useful to replay for a short window after a consumer restarts. No ledger contact.
4. **UI updates** (order book, trades and index price to browsers). Latency matters more than
   durability; a browser that misses a message resyncs from a snapshot.

CLAUDE.md already fixes three invariants this decision has to serve: every consumer is idempotent on
event ID, the engine publishes only via the outbox, and the ledger is never updated or deleted.
`docs/architecture.md` is a stub owned by this ADR, and the M2 stories (orders.fifo producer, engine
consumer, outbox and SNS publisher, settlement consumer) cannot be specified until the transport is
chosen.

The published load targets are 500 RPS of sustained order placement, bursts of 200 orders/s, and
10,000 concurrent WebSocket clients. Tick rates are whatever the three venues send and are measured
in M3.

Source: docs/plan.md §3 (architecture, queue table, targets)

## Decision

Use a different transport for each traffic class rather than one bus:

- **SQS FIFO** for order commands (`orders.fifo`) and for settlement input (`settlement.fifo`).
- **Transactional outbox to SNS** for everything the matching engine emits. The engine writes its
  state change and the outgoing event in one Postgres transaction; a relay publishes outbox rows to
  the SNS FIFO topic `trade-events.fifo`, which fans out to subscriber queues including
  `settlement.fifo`. The topic is FIFO because a standard SNS topic cannot deliver to FIFO queues.
- **Message group = instrument, end to end:** on `orders.fifo`, on `trade-events.fifo` and on
  `settlement.fifo`. Ordering holds per book, and unrelated books proceed in parallel. Per-account
  ordering is not required for settlement: each fill is self-contained, the hold already reserved the
  funds, and the ledger API is idempotent on fill ID and locks per account and currency. This
  supersedes any earlier "group = account" wording for settlement.
- **Redis Streams** for external ticks from the feed ingestor to the index service, trimmed to a
  bounded length.
- **Redis pub/sub** for the UI latency path into the WebSocket gateway, with sequence numbers so a
  client that detects a gap resyncs from a snapshot.

## Alternatives considered

- **Direct publish from the engine (no outbox).** The engine commits its state, then calls SNS or
  SQS. This is simpler: no outbox table, no relay process, one less hop of latency. It loses because
  it is a dual write. If the process dies between the database commit and the publish, a fill exists
  in the engine's state and never reaches settlement; if it publishes first and the commit fails,
  settlement books a fill the engine does not have. Either way the ledger diverges from the book.
  Retrying the publish narrows the window but does not close it. The outbox closes it at the cost of
  at-least-once delivery, which the idempotent-consumer invariant already absorbs.
- **A single Kafka topic (or one Kafka cluster) for everything.** This is the strongest alternative
  and the industry-standard shape for an exchange event log. One technology covers commands, fills,
  ticks and UI fan-out. Partitions give per-key ordering, retention gives replay of the full history
  (useful for rebuilding the book or auditing settlement), and consumer groups give fan-out without
  an SNS layer. It loses here on cost and operational weight for a paper-trading project of this
  size: a managed cluster has a standing monthly cost and brokers, partitions and consumer-group
  rebalancing to operate (figures TBC), against SQS and SNS, which are pay-per-request and have
  nothing to run. The project budgets about £1 to 3 a month for SQS and SNS; a managed Kafka cluster
  has a standing cost an order of magnitude above that, to be verified in ADR-003. Kafka also does
  not remove the outbox: a database write plus a Kafka produce is still a dual write. A single topic
  would also mix traffic with very different needs (durable fills next to disposable ticks). Revisit
  if replay of the full event history becomes a requirement or SQS FIFO throughput limits are reached
  (limits TBC).
- **Redis for everything.** Already present for ticks and UI. Loses for orders and settlement
  because Redis is never the system of record, and it is not where we want the only copy of a fill.
- **SQS for ticks and UI as well.** Loses on latency and per-message cost at tick rates, and SQS has
  no cheap broadcast to many WebSocket nodes.

## Consequences

- Easier: each path gets the guarantee it needs and no more. Ordering and deduplication for orders
  come from SQS FIFO; fill delivery survives engine crashes; ticks and UI stay fast and cheap.
- Easier: no cluster to run. SQS and SNS are managed and billed per request.
- Harder: four transports to learn, provision, monitor and test locally. Local emulation is owned by
  ADR-003; the default is LocalStack for SQS and SNS plus Redis, both in `docker-compose.yml`. Each
  transport needs its own section in `docs/events.md`.
- Harder: no single replayable log of everything. Rebuilding state means replaying from Postgres
  (outbox and ledger), not from the bus.
- Redis Streams retention is TBD, owned by the feed-ingestor story. The default when it is specified
  is the last 60 minutes per venue.
- Must stay true: the engine never calls SNS or SQS directly; only the outbox relay publishes.
- Must stay true: every consumer deduplicates on event ID, because the outbox and SQS both deliver at
  least once. SQS FIFO deduplicates for 5 minutes only, and that is not a substitute for consumer
  idempotency.
- Must stay true: Redis persistence is not relied on. Redis is never the system of record, for
  Streams or pub/sub. A UI client that misses a sequence number must be able to resync from a
  snapshot.
- Ordering holds only within a message group, that is, within one instrument. Anything that needs
  order across instruments must not rely on the queue for it.
