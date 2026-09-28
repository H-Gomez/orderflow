import type { Prisma, PrismaClient } from "../generated/prisma/client.js";

/**
 * What every ledger function takes: a client, or the transaction client a caller is already
 * inside.
 *
 * Given a client, the function opens and commits its own transaction. Given a transaction
 * client, it runs inside the caller's transaction and commits nothing itself, so its writes and
 * the caller's commit or roll back together. That is how an order and its hold are accepted
 * together or not at all (accounts.md section 4.3), and how M2 will convert a hold, record the
 * fill and write the TRADE as one unit. A rejection in that mode rolls back the caller's work
 * too.
 */
export type LedgerDb = PrismaClient | Prisma.TransactionClient;

/**
 * Generous enough for a writer that queues behind others on the same account's lock, short
 * enough that a stuck transaction does not hold that lock for long.
 */
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

/**
 * A full client has `$connect`; a transaction client does not. `$transaction` cannot tell them
 * apart: Prisma 7 gives a transaction client a `$transaction` too, which nests a savepoint, so a
 * check on it would open a second transaction inside the caller's instead of joining it.
 */
export const ownsTransaction = (db: LedgerDb): db is PrismaClient =>
  typeof (db as Partial<PrismaClient>).$connect === "function";

/** Runs `work` in the caller's transaction, or in a new one when the caller has none. */
export const inTransaction = async <T>(
  db: LedgerDb,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => (ownsTransaction(db) ? db.$transaction(work, TRANSACTION_OPTIONS) : work(db));
