# Ledger

The ledger is the only record of money in OrderFlow. Every balance in the system is computed from it and from nothing else. This file states the rules. The schema that implements them is #9, and the seed script that first writes to it is #11.

Read with [accounts.md](./accounts.md) for account types, holds and buying power, and the Invariants block in [CLAUDE.md](../../CLAUDE.md) for the rules shared with the rest of the repo. Where a rule appears in both places, CLAUDE.md wins and this file is changed to match, never the reverse.

Rules marked **Decision (#8)** were taken deliberately in this story. Everything else traces to plan v4.1 §4.1 or CLAUDE.md. Anything undecided is in the open questions table at the end, with the story that will decide it.

## 1. The model

Money moves only as a set of entries that balance. An entry records that one account's holding of one currency changed by one amount. An entry never exists on its own: it belongs to a transaction, and a transaction's entries sum to zero per currency.

Money never enters or leaves the system. Seeding moves money from the treasury to another account (accounts.md §6), and the treasury's negative balance is the total ever seeded. In a production exchange the treasury would be a clearing account reconciled against a bank; here it represents virtual money and has nothing to reconcile against.

An entry carries at minimum:

- its own id
- the transaction it belongs to
- the account
- the currency
- the amount, signed (§2)
- the entry type (§6); all entries in a transaction share the same type
- when it was written
- a reference to its cause: a fill id, a seed run id, or the transaction being corrected

An entry carries no running balance, no "balance after" field, and no link to a stored balance. There is nothing of that kind to link to.

## 2. Sign is direction

**Decision (#8).** An entry's amount is signed. A negative amount left the account; a positive amount arrived. There is no separate direction field. Where CLAUDE.md or the plan says "a DEBIT/CREDIT pair", a debit is an entry with a negative amount, a credit is an entry with a positive amount, and the pair is two entries of equal magnitude and opposite sign in the same currency.

**Decision (#8).** An amount is never zero. A transaction that would write a zero entry is rejected. A zero entry can only come from a bug, such as a fill or seed that computed to nothing, and rejecting it makes that bug loud at write time instead of silent and permanent.

## 3. Transactions

A transaction is the unit of change. It groups two or more entries and is written atomically: every entry commits or none does.

- A transaction has at least two entries. There is no exception. Seeding is two entries: a deduction from the treasury and an addition to the destination account.
- Within a transaction, the entries sum to zero for each currency present. A transaction that does not is rejected before it commits; it is never written and flagged later.
- A transaction may touch more than one currency. A trade does: the base currency moves one way and the quote currency the other, and each currency balances on its own.
- A transaction is keyed by its cause (the fill id for a trade, the seed run and account for a deposit). Writing a transaction whose key already exists is a no-op that succeeds. This is how CLAUDE.md's "consumers are idempotent on event ID" reaches the ledger; the hold side of it is in accounts.md §4.

## 4. Append-only

The ledger is append-only, always. No entry is ever updated or deleted: not by the application, not by a migration, not by an admin, not by a cleanup script. A mistake is corrected by writing more history, never by editing it.

Two things this rule does not forbid: a schema migration may change how an entry is stored, never what it says; and append-only applies to any ledger that has ever been a source of truth, so a disposable test database is not one.

### Corrections

A correction is a transaction of type `CORRECTION`, not a single entry. Its entries mirror every entry of the wrong transaction: equal magnitude, opposite sign, same currency, same accounts. The wrong transaction and the correction together sum to zero per currency. The correction references the wrong transaction's id. A correction never reverses part of a transaction, because that would break sum-to-zero. The wrong transaction stays visible forever. If a right version is needed, it follows as a separate new transaction.

```
T1  DEPOSIT      Treasury  -10000 USD   Alice  +10000 USD   (the mistake, stays forever)
T2  CORRECTION   Treasury  +10000 USD   Alice  -10000 USD   (mirrors T1, references T1)
T3  DEPOSIT      Treasury   -1000 USD   Alice   +1000 USD   (the right one)
```

**Decision (#8).** A `CORRECTION` is written by a human, deliberately, never automatically. In M0 no code path writes one; it is done by a human with database access. An admin endpoint for corrections is open question 2.

## 5. Sum to zero, and why balances are never stored

The same rule at two levels:

- Within any transaction, the entries sum to zero per currency. Enforced at write (§3).
- Across the whole ledger, all entries sum to zero per currency. This follows from the first rule plus append-only: a sum of zero-sum groups is zero, and no group can be altered after the fact. It is not separately enforced; it is checked, by a property test in #9 and later by a scheduled job, and a failure means one of the two underlying rules was violated.

An account's balance in a currency is the sum of that account's entries in that currency, computed when it is read. A balance is never held in a field of its own. Balances are always derived.

A stored balance is a second source of truth for the same fact. A bug, crash or partial write can let it drift from the ledger while the ledger itself still sums to zero, and then there is no way to tell which is right. The only defence is that a balance can come from one place: the entries.

A materialised view, a cache, a "balance after" column on an entry, or a snapshot table is a stored balance under another name and is forbidden by the same rule.

**Decision (#8).** If summing entries ever becomes too slow, the remedy is an ADR, not a column. No cache exists until an ADR is accepted, and that ADR must show the cache is derived, disposable, rebuildable from the ledger alone, and never read by anything that writes to the ledger.

## 6. Entry types

**Decision (#8).** M0 has three entry types and no others.

| Type | Written by | Entries |
|---|---|---|
| `DEPOSIT` | The seed script (#11), when an account is created or topped up | Treasury −X quote currency; destination account +X quote currency |
| `TRADE` | A settled fill. In M0 the seed writes synthetic fills as proper pairs; from M2 the settlement worker writes them | Buyer −quote, buyer +base; seller +quote, seller −base. Four entries, two currencies, each currency sums to zero |
| `CORRECTION` | A human, deliberately (§4) | Mirror of every entry in the transaction being reversed, referencing it |

A `TRADE` writes the quote leg as price × quantity exactly (§7). Fees are not modelled in M0 (open question 4).

## 7. Money representation

**Decision (#8).** This is the decision CLAUDE.md defers to this story.

- Every amount, price and quantity is stored as Postgres `NUMERIC(38, 18)` and handled in TypeScript as Prisma's `Decimal`. No other type is allowed for money.
- Binary floating point is never used for an amount: no `float`, `real` or `double precision` column, and no JavaScript `number` for money in code or in any example. An amount is never converted to a JavaScript `number` on any path that writes, compares or sums.
- Instruments cap both price and quantity at 8 decimal places. A trade's quote leg is price × quantity, so it has at most 16 fractional digits, and scale 18 holds that exactly with margin. Precision 38 leaves 20 integer digits, more than any balance will reach.
- The ledger never rounds. Every stored amount is the exact computed value. Rounding is permitted only at display (USD to 2 dp, crypto to 8 dp) and, if fees are introduced, at fee calculation before the fee entry is written. Mode: round half to even, because it does not bias totals over many operations.
- A currency is identified by an uppercase ticker of three or four letters: `USD`, `BTC`, `ETH`. Fiat codes follow ISO 4217; crypto codes follow market convention and are not ISO codes. The code is the identity. There is no separate numeric currency id, and the same code always means the same asset.

The 8 dp cap on price and quantity is the assumption everything above rests on. If it is ever raised, scale 18 stops being enough and the no-rounding guarantee goes with it. That change needs an ADR.

## 8. What this file does not decide

| # | Open question | Decided by |
|---|---|---|
| 2 | Admin endpoint for writing a `CORRECTION` | No owning story yet |
| 3 | Balance read performance; any cache is an ADR | No owning story; not before it is measured slow |
| 4 | Trading fees: whether they exist, who pays, entry type, rounding point | No owning story; not before M2 |
| 5 | Per-currency display scale beyond USD 2 and crypto 8 | #9 records it; UI story enforces it |
| 9 | Whether the production sum-to-zero check alerts or halts settlement on breach | M5 |

Numbers are shared with the table in accounts.md §7.
