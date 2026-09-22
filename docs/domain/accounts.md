# Accounts

An account is anything that can hold money. This file states the account types M0 needs, how an account is identified, how its balance and buying power are derived, how a hold works from placement to release or conversion, and how seeding works. The rules for entries themselves are in [ledger.md](./ledger.md). The schema is #9, the seed script is #11.

Read with [ledger.md](./ledger.md) and the Invariants block in [CLAUDE.md](../../CLAUDE.md). Where a rule appears in both places, CLAUDE.md wins.

Rules marked **Decision (#8)** were taken deliberately in this story. Everything else traces to plan v4.1 §4.1 or CLAUDE.md. Anything undecided is in the open questions table at the end.

## 1. Account types

| Type | Who | How it authenticates | Notes |
|---|---|---|---|
| `USER` | A human who signed up | Through the auth provider (OIDC); the API validates the JWT | Seeded with virtual USD on creation (§6) |
| `BOT` | A member of the bot fleet | An API key issued by the seed script | Trades through the same public API as a user |
| `TREASURY` | The one account the system itself owns | Not a login; only the seed script and a human operator act as it | The source of every `DEPOSIT` (§6). The only account permitted to go negative (§6) |

The ledger cannot tell them apart. Account type lives on the account, never on an entry. A trade between a user and a bot writes exactly the same entries as a trade between two users.

**Decision (#8).** One account holds every currency. Currency lives on the entry (ledger.md §1), not the account. There is no account per currency.

## 2. Identity

An account is identified by a single immutable id assigned at creation and never reused. Entries and holds reference that id and nothing else: not the email, not the auth subject, not the API key, all of which may change or rotate without the account changing.

**Decision (#8).** One account per user and per bot in M0. Whether a user may hold more than one is open question 6.

## 3. Balance is derived

An account's balance in a currency is the sum of that account's entries in that currency, computed when it is read (ledger.md §5). It is never stored in any form. Any API response, dashboard or assistant answer that shows a balance obtained it by summing entries at that moment.

An account's portfolio is the set of currencies in which the sum of its entries is non-zero.

## 4. Holds

A hold stops an account committing the same money to two open orders. Without one, an account could place an order for 60% of its balance, then before it fills place another for 50%; if both fill, it has spent 110%.

**Decision (#8). A hold is not a ledger entry.** Placing an order moves nothing, so nothing is written to the ledger. A hold is its own record with a state, created when an order is placed and checked against buying power at that moment. It is the only money-related record that changes state in place. The ledger stays append-only; holds do not need to be.

### 4.1 What is held

- A **buy** order holds the quote currency: price × quantity for a limit order.
- A **sell** order holds the base currency: the quantity being sold.
- A **market buy** has no price at placement. Its hold amount is open question 8.
- A hold amount uses the ledger's money representation (ledger.md §7) and is never rounded.

### 4.2 Lifecycle

States: `active`, `released`, `converted`. Placement creates an active hold.

```
active ──▶ released    order cancelled by owner, rejected by engine, or expired
active ──▶ converted   order filled; the hold becomes a TRADE transaction
```

- A partial fill converts the filled portion and the remainder stays `active`, so one hold may shrink through several conversions before its last one.
- `released` and `converted` are terminal. There is no path back to `active`. A re-placed order is a new order with a new hold.

### 4.3 Atomicity

At placement, the buying-power check (§5) and the creation of the hold happen in one database transaction. Either the order is accepted and the hold exists, or neither. Two orders racing for the same balance cannot both pass, because the second sees the first's hold.

At conversion, the hold's state change, the fill record and the `TRADE` ledger transaction (ledger.md §6) happen in one database transaction, for both counterparties, keyed by the fill id. A redelivered settlement message finds the fill already recorded and does nothing. This is CLAUDE.md's "consumers are idempotent on event ID" applied to the hold lifecycle.

### 4.4 Invariant

The sum of an account's active holds in a currency never exceeds its balance in that currency. It follows from §4.3 and §5 and is stated here so #9 can test it.

## 5. Buying power

Buying power in a currency = balance in that currency (§3) − sum of active holds in that currency (§4).

Every input is computed; the result is computed and never stored. It may reach zero. It is never negative for a `USER` or `BOT`, because an order is only accepted if its hold fits within buying power at placement (§4.3). A negative user or bot balance is a bug: it means a hold check failed. The treasury places no orders and has no buying power.

## 6. Seeding

Money never enters the system. Seeding moves it from the treasury to another account. Creating a user or bot account writes one `DEPOSIT` transaction (ledger.md §6): the treasury is debited the seed amount in the quote currency and the new account is credited the same amount. The pair sums to zero. Nothing else writes a balance into existence.

Without the treasury, seeding would be a one-sided entry, which breaks sum-to-zero. That is why the treasury exists. In a production exchange it would be a clearing account representing the firm's bank or custody balance, reconciled against it; in OrderFlow it represents virtual money and has nothing to reconcile against.

**Decision (#8).** There is exactly one treasury, and it is the only account whose balance may be negative. Its negative balance is the total ever seeded. A `USER` or `BOT` balance is never negative; it may reach zero.

The seeding check: in any currency, the sum of all account balances, treasury included, equals zero. This is the whole-ledger invariant (ledger.md §5) read per currency, and it proves seeding never wrote a one-sided entry.

The seed script also writes synthetic fill history as `TRADE` transactions so that the Desk Analyst (#13) has ground truth before the matching engine exists in M2. Those fills follow the same rules as live ones.

## 7. What this file does not decide

| # | Open question | Decided by |
|---|---|---|
| 1 | Account deletion or anonymisation. Entries are never deleted; the account would be anonymised instead | No owning story; not before there are production users |
| 6 | Whether a user may hold more than one account | No owning story; not in M0 |
| 7 | Whether bot API keys rotate, and how | No owning story; not before M4 |
| 8 | Hold amount for a market buy: a slippage-bounded amount, or the full quote balance | M2 matching story |

Numbers are shared with the table in ledger.md §8.