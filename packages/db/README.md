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

| Task                   | Command                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Regenerate the client  | `pnpm --filter @orderflow/db run generate`                                                                                                                                    |
| Apply migrations       | `pnpm db:migrate`                                                                                                                                                             |
| Check for schema drift | `pnpm --filter @orderflow/db exec prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --shadow-database-url "$DATABASE_URL" --exit-code` |
| Open the data in a UI  | `pnpm --filter @orderflow/db exec prisma studio`                                                                                                                              |

The client is generated into `src/generated/`, which is not committed. `prisma generate` runs
as a Turborepo dependency of `build`, `typecheck`, `lint` and `test`, so a fresh clone needs
no extra step.

## Using it

```ts
import { createPrismaClient, AccountType } from "@orderflow/db";

const prisma = createPrismaClient(); // reads DATABASE_URL

const treasury = await prisma.account.findFirst({ where: { type: AccountType.TREASURY } });
```

Prisma 7 requires a driver adapter, which `createPrismaClient` wires up. There is no
module-level singleton: a caller owns its client and disconnects it.

## Tests

`pnpm --filter @orderflow/db test` runs two kinds of test:

- Schema-shape tests, which read `schema.prisma` and the migration and need no database. They
  are the ones that guard the precision and the absence of a balance column.
- Database tests, which need the compose database and **skip when `DATABASE_URL` is unset**,
  so the suite stays green on a machine without Docker. They prove the append-only triggers
  and the single-treasury rule actually fire.

Run the second kind with the database up:

```sh
pnpm db:up && pnpm db:migrate && pnpm --filter @orderflow/db test
```

## What this package does not do

Writing and reading the ledger — `postTransaction`, `balanceOf`, buying power and holds — is
[#57](https://github.com/H-Gomez/orderflow/issues/57), and lands in `src/ledger/`. Matching,
settlement and order states belong to M2, so `Order` and `Fill` are inert storage here and
carry no status column: those states are
[order-lifecycle.md](../../docs/domain/order-lifecycle.md)'s to define.
