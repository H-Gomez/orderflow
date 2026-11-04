import type { Prisma } from "../generated/prisma/client.js";

/**
 * Transaction-scoped advisory locks, the same mechanism as the single-treasury trigger in the
 * initial migration. Each is released at COMMIT or ROLLBACK, so there is no unlock to forget.
 *
 * Both use the two-key form, `pg_advisory_xact_lock(int, int)`, whose lock space is separate
 * from the one-key lock the treasury trigger takes. The first key names the purpose, so the two
 * kinds never collide with each other either. A hash collision between two different keys only
 * serialises two writers that did not need it; it never lets two through that should wait.
 *
 * Every statement is a tagged template, so each key travels as a bind parameter.
 */

/**
 * Serialises writers of one cause key.
 *
 * Without it, two twins in READ COMMITTED both look the key up, both find nothing, and the
 * second fails on the unique index. With it, the second waits for the first to commit, then
 * finds its transaction and replays it (ledger.md section 3).
 */
export const lockCause = async (tx: Prisma.TransactionClient, causeKey: string): Promise<void> => {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('orderflow_cause'), hashtext(${causeKey}))`;
};

/** One account's holding of one currency. */
export interface BuyingPowerKey {
  readonly accountId: string;
  readonly currency: string;
}

/**
 * Serialises everything that spends one account's buying power in one currency: placing a hold
 * and posting a debit.
 *
 * A balance is derived, so there is no row to lock, and a Prisma interactive transaction is
 * READ COMMITTED: a check-then-write races unless something serialises it. With this lock the
 * second writer waits for the first to commit, then reads a balance and holds that include it
 * (accounts.md section 4.3).
 *
 * The keys are de-duplicated and taken in sorted order, so two writers that need the same pair
 * of keys always take them in the same order and cannot deadlock.
 */
export const lockBuyingPower = async (
  tx: Prisma.TransactionClient,
  keys: Iterable<BuyingPowerKey>,
): Promise<void> => {
  const sorted = [
    ...new Set([...keys].map(({ accountId, currency }) => `${accountId}:${currency}`)),
  ].sort();
  for (const key of sorted) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('orderflow_hold'), hashtext(${key}))`;
  }
};
