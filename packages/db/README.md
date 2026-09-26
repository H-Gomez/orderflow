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

## What this package does not do

Writing and reading the ledger — `postTransaction`, `balanceOf`, buying power and holds — is
[#57](https://github.com/H-Gomez/orderflow/issues/57), and lands in `src/ledger/`. Matching,
settlement and order states belong to M2, so `Order` and `Fill` are inert storage here and
carry no status column: those states are
[order-lifecycle.md](../../docs/domain/order-lifecycle.md)'s to define.
