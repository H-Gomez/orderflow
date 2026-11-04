# @orderflow/db

The OrderFlow database: the Prisma schema, its migrations, and the generated client. This is
the only package that talks to Prisma; everything else reads the database through what this
package exports.

The rules the schema implements are in [ledger.md](../../docs/domain/ledger.md) and
[accounts.md](../../docs/domain/accounts.md). Two of them shape every table:

- **No balance is stored.** A balance is the sum of an account's entries, computed when it is
  read. There is no balance column, cache, snapshot or materialised view, and adding one is
  forbidden (ledger.md §5).
- **Money is `NUMERIC(38, 18)`**, end to end: every amount, price, quantity and OHLCV value.
  Never `Float`, never `Double`, never a JavaScript `number` (ledger.md §7).

The ledger is append-only in the database itself: a trigger rejects `UPDATE` and `DELETE` on
`LedgerEntry` and `LedgerTransaction`, so no application, migration or console session can
rewrite history. A correction is a new transaction (ledger.md §4).

## Bring the database up

From the repository root:

```sh
pnpm install --frozen-lockfile
cp packages/db/.env.example packages/db/.env
pnpm db:up
pnpm db:migrate
```

`pnpm db:up` starts Postgres 18 with pgvector on `localhost:55432`, and `pnpm db:migrate`
applies every migration. `pnpm db:down` stops the container and keeps the data in its volume.

The credentials are development values shared by `docker-compose.yml` and `.env.example`. The
port is bound to `127.0.0.1`, and `.env` is never committed.

## Everyday commands

| Task                   | Command                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Regenerate the client  | `pnpm --filter @orderflow/db run generate`                                                                                              |
| Apply migrations       | `pnpm db:migrate`                                                                                                                       |
| Check for schema drift | `pnpm --filter @orderflow/db exec prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code` |
| Open the data in a UI  | `pnpm --filter @orderflow/db exec prisma studio`                                                                                        |

The drift check replays the migrations into a scratch database named `orderflow_shadow`, which
`prisma.config.ts` points at. Create it once with
`docker compose exec postgres createdb -U orderflow orderflow_shadow`.

The client is generated into `src/generated/`, which is not committed. `prisma generate` runs
as a Turborepo dependency of `build`, `typecheck`, `lint` and `test`, so a fresh clone needs
no extra step.

## Using it

```ts
import { createPrismaClient, AccountType } from "@orderflow/db";

const prisma = createPrismaClient(); // reads DATABASE_URL

const treasury = await prisma.account.findFirst({ where: { type: AccountType.TREASURY } });
```

Prisma 7 requires a driver adapter, which `createPrismaClient` wires up.

There is no module level singleton: a caller owns its client and disconnects it.

A shared client would be built once, at import time, from whatever DATABASE_URL was set then. Each caller building its own lets a test point its client at that run's test database, and no test inherits another's open connection.

## Tests

`pnpm --filter @orderflow/db test` runs two kinds of test:

- Schema-shape tests, which read `schema.prisma` and the migration and need no database. They
  guard the precision, the absence of a balance column and the presence of the triggers.
- Database tests, which prove the append-only triggers, the single-treasury rule and the
  CHECK constraints actually fire.
- Ledger tests in `src/ledger/`, fast-check properties over generated histories: every
  transaction and the whole ledger sum to zero, balances equal their entries, a cause key is
  written once, and concurrent holds and debits never spend the same money twice.

Test files run one at a time: they share one database, and the ledger cannot be truncated
between them. Each ledger test creates its own accounts and asserts on those.

The database tests never touch your dev database. Each run creates `orderflow_test_<run>` on
the same server, migrates it, and drops it in teardown
([src/testing/global-setup.ts](src/testing/global-setup.ts)). The ledger is append-only, so
rows a test writes would otherwise stay forever, and the first test to create a treasury would
take the only slot the rule allows.

`DATABASE_URL` names the _server_ to create that database on; it falls back to the compose
server, so with the container up this needs no configuration:

```sh
pnpm db:up && pnpm --filter @orderflow/db test   # this package only
pnpm db:up && pnpm test                          # the whole repo, as CI runs it
```

Both honour `DATABASE_URL`. The root command goes through Turbo, which runs in strict env mode
and passes a variable to a task only when `turbo.json` names it, so the `test` task declares
`CI` and `DATABASE_URL` there. A variable this package reads from a developer's shell has to be
added to that list or the root command will not see it.

When no server answers, the database tests skip and the suite stays green, which is what
should happen on a machine without Docker. Under `CI` they fail instead, so a pipeline with no
database cannot pass by doing nothing ([src/testing/database-guard.ts](src/testing/database-guard.ts)).

## The ledger API

`src/ledger/` is the only sanctioned way to write the ledger, and the way everything else reads
balances. Everything below is exported from `@orderflow/db`. There is no update or delete of an
entry or a transaction anywhere in it.

```ts
import { EntryType, createPrismaClient, placeHold, postTransaction } from "@orderflow/db";

const db = createPrismaClient();

await postTransaction(db, {
  type: EntryType.DEPOSIT,
  causeKey: `seed:${runId}:${accountId}`,
  entries: [
    { accountId: treasuryId, currency: "USD", amount: "-10000" },
    { accountId, currency: "USD", amount: "10000" },
  ],
});
```

| Function                                                             | What it does                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `postTransaction(db, { type, causeKey, entries })`                   | Writes one transaction and its entries, all or none. Returns it with its entries.    |
| `balanceOf(db, accountId, currency)`                                 | The sum of the account's entries in that currency, computed now (accounts.md §3).    |
| `buyingPowerOf(db, accountId, currency)`                             | Balance minus the account's ACTIVE holds (accounts.md §5). Rejects the treasury.     |
| `placeHold(db, { accountId, orderId, currency, amount })`            | Checks buying power and creates an ACTIVE hold, atomically (accounts.md §4.3).       |
| `DISPLAY_SCALE`, `DEFAULT_DISPLAY_SCALE`, `displayScaleOf(currency)` | Decimal places to show: USD 2, anything else 8. Display only; never on a write path. |

### Money: `ExactDecimal`, never `Prisma.Decimal` arithmetic

An amount goes in as a decimal string, a `bigint` or a `Decimal`, never a JavaScript `number`.
It must fit `NUMERIC(38, 18)` exactly, at most 18 decimal places and 20 integer digits, because
Postgres would otherwise round it without a word (ledger.md §7).

`balanceOf` and `buyingPowerOf` return an `ExactDecimal`. Use it, or `ExactDecimal` itself, for
any arithmetic on money. `Prisma.Decimal` is decimal.js at 20 significant digits, so its
`plus` and `minus` round: `12345678901234567890.123456789012345678` plus `0.000000000000000001`
comes back as `12345678901234567890`.

### Two modes: its own transaction, or yours

Every function takes `db`, either a client or the transaction client you are already inside.

- **A client:** the function opens and commits its own transaction.
- **A transaction client** (inside `db.$transaction(async (tx) => ...)`): it runs in your
  transaction and commits nothing itself. Its writes and yours commit or roll back together, so
  an order and its hold are accepted together or not at all. A rejection rolls your work back
  too.

Caller mode needs READ COMMITTED, Postgres's default, and rejects anything stricter with `UNSUPPORTED_ISOLATION`. Under REPEATABLE READ a writer that waited on a lock would still read its old snapshot, miss the other writer's hold or debit, and spend the same money twice.

### What `postTransaction` enforces

Before it reads anything:

- at least two entries, no zero amount, and each currency summing to zero (ledger.md §2, §3);
- three or four uppercase letters per currency, and amounts that fit `NUMERIC(38, 18)` (§7);
- no `CORRECTION`: in M0 a human with database access writes those (§4).

Then, in the transaction:

- every account exists;
- a `DEPOSIT` is exactly the treasury debited and one other account credited the same amount of
  one currency, and the treasury appears in no other type (ledger.md §6, accounts.md §6);
- no USER or BOT account is taken below its buying power (accounts.md §4.4, §5).

**Idempotency.** A transaction is keyed by its cause (ledger.md §3). Posting a key that already
exists with the same type and entries writes nothing and returns the existing transaction.
Posting it with a different type or different entries is an `IDEMPOTENCY_CONFLICT`: a cause
names one transaction, and silently replaying a different one would hide a caller's bug.
Concurrent posts of one key are serialised by an advisory lock on the key, so the second
replays the first.

### Holds and the buying-power lock

A balance is derived, so there is no row to lock, and a check-then-write under READ COMMITTED
races. `placeHold` and every debit in `postTransaction` take a transaction-scoped advisory lock
on the account and currency before they check buying power. The second writer waits for the
first to commit, then sees its hold or debit, so no two can spend the same money. One call takes
its locks in sorted order, so two single calls do not deadlock each other (short of a hash
collision between two lock keys, which Postgres would report as a deadlock).

In caller mode, locks from several calls accumulate until your transaction ends. Two caller
transactions that lock the same accounts in opposite orders can deadlock, and Postgres then
aborts one of them with a deadlock error. Keep one ledger write per caller transaction where you
can, or make your calls in a consistent order, and retry on a deadlock.

`placeHold` also rejects a hold of zero or less, an order that is not the account's or already has a hold, and the treasury. Releasing and converting
holds belongs to M2.

### Errors

Every rule violation is a `LedgerError` with a `code` from `LedgerErrorCode`, never a Postgres
constraint or trigger message: `TOO_FEW_ENTRIES`, `ZERO_AMOUNT`, `UNBALANCED`,
`INVALID_CURRENCY`, `AMOUNT_NOT_REPRESENTABLE`, `CORRECTION_NOT_ALLOWED`, `ACCOUNT_NOT_FOUND`,
`INVALID_DEPOSIT_SHAPE`, `TREASURY_NOT_ALLOWED`, `IDEMPOTENCY_CONFLICT`, `DUPLICATE_CAUSE_KEY`,
`INSUFFICIENT_BUYING_POWER`, `NON_POSITIVE_HOLD`, `ORDER_NOT_FOUND`, `HOLD_EXISTS`,
`UNSUPPORTED_ISOLATION` and `TREASURY_HAS_NO_BUYING_POWER`.

## What this package does not do

Matching, settlement, hold release and conversion, and order states belong to M2, so `Order`
and `Fill` are inert storage here and carry no status column: those states are
[order-lifecycle.md](../../docs/domain/order-lifecycle.md)'s to define. The `CORRECTION` write
path is ledger.md open question 2.
