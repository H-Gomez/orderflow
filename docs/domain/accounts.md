# Accounts

What an account is, what it holds, and how value is reserved before it moves. The companion to
[ledger.md](ledger.md), which owns money representation and the rules for recording movement.
[CLAUDE.md](../../CLAUDE.md) states the invariants both files define.

Scope: Milestone 0. Anything not settled here is listed under
[Open questions](#open-questions) with the story that will settle it, and is never guessed at.

## What an account is

An account is the thing a balance belongs to. It is identified by its own id, it has a type,
and it holds **several currencies at once** — one account, many balances, one per currency.
There is no account-per-currency split.

An account's balance in a currency is the sum of its ledger entries in that currency. It is
never stored. See [Balances are derived](ledger.md#balances-are-derived) for why, which is the
single most load-bearing decision in this system.

## Account types

Three, and they differ in who acts for them and what they are permitted to do.

| Type       | Who acts for it        | Authenticates with | May go negative |
| ---------- | ---------------------- | ------------------ | --------------- |
| `USER`     | A person, in the UI    | An OIDC-issued JWT | No              |
| `BOT`      | A fleet process        | An API key         | No              |
| `TREASURY` | The system, at seeding | Nothing; internal  | Yes, by design  |

**`USER`** — a human who signed up. Identity comes from the auth provider; the account is
OrderFlow's own record, keyed to that identity.

**`BOT`** — a service account belonging to the bot fleet. No person, no login flow, no OIDC. It
authenticates with an API key issued when the account is created, and it trades through the
same public API as a human, against the same rules. Bots exist from Milestone 0, with their
keys, so nothing is retrofitted when the fleet starts trading.

**`TREASURY`** — one account, the faucet. It is the origin of every unit of currency in the
system and the only account permitted a negative balance. Its balance is the negative of
everything ever issued, which makes it a running total of the money supply rather than a
special case to be excluded from checks. It has no credentials and no API access: nothing
authenticates as the treasury, and only seeding moves value out of it.

## Seeding is a transaction

Funding an account is a movement like any other: a `DEPOSIT` transaction debiting the treasury
and crediting the account, in one transaction, summing to zero.

A balance is never assigned. There is no path that sets one, because there is no column to set
— see [ledger.md](ledger.md#balances-are-derived). Seeding that wrote a balance directly would
break the sum-to-zero invariant on the first run, which is why this is spelled out here rather
than left to the seed script to get right.

## Holds

A hold reserves value an account still owns, so it cannot be spent twice while an order is
resting on the book.

Placing a buy order does not move money. The account keeps its balance; what changes is how
much of that balance is **available**. Nothing is written to the ledger, because nothing moved
— see [Holds are not ledger entries](ledger.md#holds-are-not-ledger-entries).

A hold records the account, the currency, the amount reserved, the order that caused it, and
its status.

### Which currency is held

A hold is always on the currency the account would pay with:

- A **buy** of `BASE-QUOTE` holds **quote**: enough to pay for the order at its limit price.
- A **sell** of `BASE-QUOTE` holds **base**: the quantity being offered.

### Lifecycle

A hold is created active, and leaves that state exactly once:

```
                 ┌──────────────► RELEASED   (order cancelled, rejected or expired)
   ACTIVE ───────┤
                 └──────────────► CONVERTED  (order filled; the reserve became a movement)
```

- **Active** — the value is reserved and unavailable. The balance is unchanged.
- **Released** — the reservation ends and nothing moved. The full amount becomes available
  again. Cancelling an order releases its hold.
- **Converted** — the order filled, a `TRADE` transaction settled it, and the reserved value
  genuinely left the account in that transaction. The hold and the ledger entries are written
  together: a converted hold with no settling transaction, or a settlement with a hold left
  active, are both states the system may not be in.

**Partial fills.** A fill for part of an order converts the matching part of the hold and
leaves the rest active. The remainder follows the same lifecycle when the order finishes, so an
order that fills half and is then cancelled converts half and releases half.

**A hold amount is never negative**, and the amount released plus the amount converted always
equals the amount originally held. A hold is working state rather than ledger history, so its
status changes; every conversion, though, is mirrored by a ledger transaction, which does not.

## Available balance and buying power

For an account and a currency:

```
available = balance − sum(active holds in that currency)
```

This is what an order is checked against, and the check happens atomically with placing the
order. Two orders arriving together cannot both pass a check that only one of them can afford:
whatever concurrency mechanism is chosen, the outcome is that the second is rejected, never
that both are accepted and the account goes short.

**Available is never negative for a `USER` or `BOT` account.** An account cannot hold more than
it has. The treasury is exempt: it is expected to be negative, and it places no orders, so it
is never subject to this check.

Note that a balance can be committed without being spent. An account showing 100,000 USD with
80,000 held has 20,000 to trade with, and both numbers are true.

## Open questions

| Question                                                           | Settled by             |
| ------------------------------------------------------------------ | ---------------------- |
| The concurrency mechanism enforcing the atomic check.              | M1, order-lifecycle.md |
| Whether a market buy holds at all, and against what price.         | M1, order-lifecycle.md |
| What releases a hold whose order is abandoned, and after how long. | M1, order-lifecycle.md |
| Whether a user may hold more than one account.                     | TBD, no story yet      |
| Whether bot API keys expire or rotate.                             | TBD, no story yet      |
