# Ledger

How OrderFlow records money movement. This file and [accounts.md](accounts.md) are the
source the rest of the system is built from: [CLAUDE.md](../../CLAUDE.md) states these rules
as invariants, and this file is where they are defined. Where the two disagree, that is a bug
in one of them, not a licence to choose.

Scope: Milestone 0. Spot paper trading, no actual money, no custody and no withdrawals.
Anything not settled here is listed under [Open questions](#open-questions) with the story
that will settle it, and is never guessed at.

## The model

OrderFlow keeps a double-entry ledger. Value is never created or destroyed by a movement, only
moved between accounts, so every movement is recorded twice: once leaving, once arriving.

### An entry

One entry records one signed amount, in one currency, against one account, as part of one
transaction. It carries:

| Field       | Meaning                                                          |
| ----------- | ---------------------------------------------------------------- |
| transaction | The transaction this entry belongs to. Never null.               |
| account     | The account whose balance this entry moves.                      |
| currency    | The currency of `amount`. See [Currency codes](#currency-codes). |
| amount      | Signed. Negative leaves the account, positive arrives.           |
| type        | The entry type, from [Entry types](#entry-types).                |
| recorded at | When the entry was written. Set once, never changed.             |

**Sign is direction.** A negative amount is a **debit**: value leaving that account. A positive
amount is a **credit**: value arriving. The words name the sign; they are not a separate field
that could disagree with it.

### A transaction

A transaction is the unit of movement. Entries exist only inside one, and a transaction's
entries are written together or not at all. There is no partial transaction and no entry
without one.

A transaction carries its own identity, its cause, and when it happened. The cause is what lets
an answer be traced back later: a `DEPOSIT` names the seeding run, a `TRADE` names the fill it
settles.

## Money representation

Money is never binary floating point. No JavaScript `number`, no Prisma `Float`, no Postgres
`real` and no Postgres `double precision`, anywhere, for any amount, price or quantity — not in
a column, not in a fixture, not in a test. Binary floating point cannot represent `0.1`
exactly, and a ledger that must sum to zero cannot afford a representation that makes
`0.1 + 0.2 != 0.3` true.

**The representation is Postgres `NUMERIC(38, 18)`, surfaced through Prisma as `Decimal`.**

- **Scale 18** — eighteen fractional digits. This is not the precision any single asset needs;
  it is the precision a settled trade needs. Instruments constrain price and quantity to at
  most **8 fractional digits each** (see below), so the product of a price and a quantity has at
  most 16, and is therefore representable exactly. The ledger never rounds a settlement.
- **Precision 38** — twenty integer digits, which is beyond any balance a paper exchange with a
  seeded treasury can reach. It is chosen for headroom, not need.
- **One column type for every currency.** USD at 2 decimal places and BTC at 8 share one
  representation, so no schema branches per currency and no conversion sits between them.

**Rounding.** The ledger does not round. An amount is stored exactly as computed, and any
computation that would need more than 18 fractional digits is an error, not a rounded value:
it means an instrument was configured outside its permitted precision. Rounding exists only at
display, to the currency's display scale, half away from zero. A rounded figure is never
written back.

**Instrument precision.** Each instrument declares the number of fractional digits its price
and its quantity may carry, each at most 8. These are validation rules at the edge of the
system, and they are what keeps the guarantee above true.

### Currency codes

Uppercase, two to ten characters, letters and digits only: `USD`, `BTC`, `ETH`, `SOL`. An
instrument is written `BASE-QUOTE`, as in `BTC-USD`: the base is what is bought and sold, the
quote is what it is priced in. A currency code is an identifier, never a display symbol.

## Append-only

**A ledger entry is never updated and never deleted.** Not to fix a typo, not to reverse a
mistake, not during a migration, and not by a cleanup script. The ledger is the record of what
happened, and what happened does not change.

This is structural, not a convention to be careful about: nothing in the system may offer a way
to mutate an entry.

### Corrections

**A correction is a new entry.** To undo a movement, write a new transaction of type
`CORRECTION` that moves the value back, naming the transaction it corrects. The original stays
exactly as it was written.

The result is that the ledger reads as a history rather than a current state: a wrong entry and
its correction are both visible, in order, with the link between them. That is the point.

## Entries sum to zero

**Every transaction's entries sum to zero, per currency.** Value moved out of one account
arrived in another, so the two cancel. Per currency matters: a trade moves USD one way and BTC
the other, and each side balances independently. A transaction whose entries do not sum to zero
in every currency it touches is rejected before anything is written.

Because every transaction sums to zero, **the whole ledger sums to zero**, per currency, at all
times. This holds for any subset of complete transactions, which is what makes it cheap to
assert: it is a single query, at any moment, with no reconciliation window.

This is the invariant the project is built to advertise. It is property-tested, and asserted
against the live database on a schedule.

## Balances are derived

**An account's balance is the sum of its entries.** There is no balance column, no balance
cache, no denormalised total and no materialised view. Not as an optimisation, not with a
trigger keeping it honest.

A stored balance is a second source of truth for something the ledger already knows, and the
moment the two disagree, the system cannot say which is right. Deriving it means they cannot
disagree. If summing becomes too slow, the answer is an index or a snapshot table that is
explicitly a cache of a derivable value, decided in its own ADR — not a column that code is
trusted to keep in step.

Balance is per account and per currency: an account holds several currencies at once, and each
sums independently.

## Entry types

Milestone 0 needs three:

| Type         | What it records                                                                    |
| ------------ | ---------------------------------------------------------------------------------- |
| `DEPOSIT`    | Funds issued from the treasury to an account. The only way money enters.           |
| `TRADE`      | The settlement of one fill: both counterparties, both currencies, one transaction. |
| `CORRECTION` | A deliberate reversal or adjustment of an earlier transaction, which it names.     |

There is no withdrawal type: OrderFlow holds no actual money and pays none out.

## Holds are not ledger entries

A hold reserves value that an account still owns; it does not move it. Nothing is debited when
an order is placed, so nothing is written to the ledger. A hold is working state, and it lives
in [accounts.md](accounts.md) with the rest of the account model.

The ledger is written when a fill settles, and that transaction is what converts the reserved
value into a movement. So holds change, and the money trail stays append-only.

## Worked examples

**Seeding an account with 100,000 USD.** One transaction, type `DEPOSIT`, two entries:

| Account  | Currency | Amount     |
| -------- | -------- | ---------- |
| treasury | USD      | -100000.00 |
| user     | USD      | +100000.00 |

Sums to zero in USD. The treasury's balance is now more negative by exactly what it issued,
which is how the faucet is supposed to behave — see [accounts.md](accounts.md).

**Settling a fill: 0.5 BTC at 60,000 USD.** One transaction, type `TRADE`, four entries:

| Account | Currency | Amount    |
| ------- | -------- | --------- |
| buyer   | USD      | -30000.00 |
| seller  | USD      | +30000.00 |
| buyer   | BTC      | +0.5      |
| seller  | BTC      | -0.5      |

Sums to zero in USD and, separately, in BTC. Both counterparties move in one transaction,
because a trade where one side settled and the other did not is not a state the ledger is
allowed to be in.

**Correcting the fill above.** A new transaction, type `CORRECTION`, naming the first, with all
four signs reversed. Six entries now exist for this trade and none has been altered.

## Open questions

| Question                                                      | Settled by             |
| ------------------------------------------------------------- | ---------------------- |
| Trading fees: whether M0 charges any, and the entry type.     | TBD, no story yet      |
| Whether an unbalanced transaction is rejected or quarantined. | TBD, no story yet      |
| Per-currency display scales, as a table.                      | TBD, no story yet      |
| How settlement is triggered and made idempotent on fill ID.   | M1, settlement.md      |
| Order states and when a hold is placed or released.           | M1, order-lifecycle.md |
