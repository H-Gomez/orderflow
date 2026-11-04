import { createPrismaClient } from "../client.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { AccountType, EntryType, OrderSide, OrderType } from "../generated/prisma/enums.js";

import { postTransaction } from "./post-transaction.js";

/**
 * Shared set-up for the ledger's database tests. Test support only: nothing exported from the
 * package uses it.
 *
 * The test database is shared by every test file in a run and nothing can be deleted from the
 * ledger, so a test never assumes an empty table. It creates fresh accounts and asserts on those,
 * and reuses the one treasury the database allows.
 */

/** Unique per process, so cause keys and symbols never collide across runs or files. */
export const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let sequence = 0;
/** A cause key, or any other unique name, never used before in this database. */
export const unique = (label: string): string => {
  sequence += 1;
  return `${runId}-${label}-${sequence.toString()}`;
};

export const connect = async (databaseUrl: string): Promise<PrismaClient> => {
  const client = createPrismaClient({ connectionString: databaseUrl });
  await client.$connect();
  return client;
};

/**
 * The treasury's id, creating the treasury if none exists. Looked up on every call rather than
 * cached, because schema.test.ts demotes the treasury in its own concurrency test.
 */
export const treasuryId = async (db: PrismaClient): Promise<string> => {
  const existing = await db.account.findFirst({ where: { type: AccountType.TREASURY } });
  if (existing !== null) {
    return existing.id;
  }
  try {
    return (await db.account.create({ data: { type: AccountType.TREASURY } })).id;
  } catch {
    // Another writer created it first: the trigger allows exactly one.
    return (await db.account.findFirstOrThrow({ where: { type: AccountType.TREASURY } })).id;
  }
};

export const newAccount = async (
  db: PrismaClient,
  type: AccountType = AccountType.USER,
): Promise<string> => (await db.account.create({ data: { type } })).id;

/** Moves `amount` of `currency` from the treasury to the account, as seeding does. */
export const fund = async (
  db: PrismaClient,
  accountId: string,
  currency: string,
  amount: string,
): Promise<void> => {
  const treasury = await treasuryId(db);
  await postTransaction(db, {
    type: EntryType.DEPOSIT,
    causeKey: unique("fund"),
    entries: [
      { accountId: treasury, currency, amount: `-${amount}` },
      { accountId, currency, amount },
    ],
  });
};

/** An instrument for orders to reference. */
export const newInstrument = async (db: PrismaClient): Promise<string> =>
  (
    await db.instrument.create({
      data: { symbol: unique("SYM"), baseCurrency: "BTC", quoteCurrency: "USD" },
    })
  ).id;

/** An order row, which a hold must reference. */
export const newOrder = async (
  db: Pick<PrismaClient, "order">,
  accountId: string,
  instrumentId: string,
): Promise<string> =>
  (
    await db.order.create({
      data: {
        accountId,
        instrumentId,
        side: OrderSide.BUY,
        type: OrderType.LIMIT,
        price: "1",
        quantity: "1",
      },
    })
  ).id;

export const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
