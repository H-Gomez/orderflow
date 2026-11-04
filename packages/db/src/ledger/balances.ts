import { AccountType, HoldState } from "../generated/prisma/enums.js";

import { LedgerError, LedgerErrorCode } from "./errors.js";
import { assertCurrency, fromPrisma, type ExactDecimal } from "./money.js";
import type { LedgerDb } from "./transaction.js";

/** Loads an account's type, or rejects an id that names no account. */
export const accountTypeOf = async (db: LedgerDb, accountId: string): Promise<AccountType> => {
  const account = await db.account.findUnique({ where: { id: accountId }, select: { type: true } });
  if (account === null) {
    throw new LedgerError(
      LedgerErrorCode.ACCOUNT_NOT_FOUND,
      `no account ${accountId} (accounts.md section 2)`,
    );
  }
  return account.type;
};

/** The sum of an account's entries in a currency. Postgres sums NUMERIC exactly. */
export const balanceIn = async (
  db: LedgerDb,
  accountId: string,
  currency: string,
): Promise<ExactDecimal> => {
  const { _sum } = await db.ledgerEntry.aggregate({
    where: { accountId, currency },
    _sum: { amount: true },
  });
  return fromPrisma(_sum.amount);
};

/** Balance minus ACTIVE holds (accounts.md section 5), with no check on the account type. */
export const buyingPowerIn = async (
  db: LedgerDb,
  accountId: string,
  currency: string,
): Promise<ExactDecimal> => {
  const balance = await balanceIn(db, accountId, currency);
  const { _sum } = await db.hold.aggregate({
    where: { accountId, currency, state: HoldState.ACTIVE },
    _sum: { amount: true },
  });
  return balance.minus(fromPrisma(_sum.amount));
};

/**
 * An account's balance in a currency: the sum of its entries, computed now (accounts.md
 * section 3, ledger.md section 5). Nothing is stored or cached.
 *
 * Returns an {@link ExactDecimal}, so arithmetic on the result stays exact.
 */
export const balanceOf = async (
  db: LedgerDb,
  accountId: string,
  currency: string,
): Promise<ExactDecimal> => {
  assertCurrency(currency);
  await accountTypeOf(db, accountId);
  return balanceIn(db, accountId, currency);
};

/**
 * Balance minus the account's ACTIVE holds in the currency (accounts.md section 5).
 *
 * Rejects the treasury, which places no orders and has no buying power. Read outside a writer's
 * lock, the figure is a snapshot: a concurrent hold or debit may change it a moment later.
 */
export const buyingPowerOf = async (
  db: LedgerDb,
  accountId: string,
  currency: string,
): Promise<ExactDecimal> => {
  assertCurrency(currency);
  if ((await accountTypeOf(db, accountId)) === AccountType.TREASURY) {
    throw new LedgerError(
      LedgerErrorCode.TREASURY_HAS_NO_BUYING_POWER,
      "the treasury places no orders and has no buying power (accounts.md section 5)",
    );
  }
  return buyingPowerIn(db, accountId, currency);
};
