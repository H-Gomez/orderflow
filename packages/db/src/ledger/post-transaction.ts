import { Prisma } from "../generated/prisma/client.js";
import { AccountType, EntryType } from "../generated/prisma/enums.js";

import { buyingPowerIn } from "./balances.js";
import { LedgerError, LedgerErrorCode } from "./errors.js";
import { lockBuyingPower, lockCause } from "./locks.js";
import {
  assertCurrency,
  fromPrisma,
  sumExact,
  toExact,
  type AmountInput,
  type ExactDecimal,
} from "./money.js";
import {
  assertReadCommitted,
  inTransaction,
  ownsTransaction,
  type LedgerDb,
} from "./transaction.js";

/** One account's holding of one currency changing by a signed amount (ledger.md section 2). */
export interface LedgerEntryInput {
  readonly accountId: string;
  readonly currency: string;
  /** Signed: negative left the account, positive arrived. Never zero. */
  readonly amount: AmountInput;
}

export interface PostTransactionInput {
  readonly type: EntryType;
  /** The transaction's cause: the fill id for a trade, the seed run and account for a deposit. */
  readonly causeKey: string;
  readonly entries: readonly LedgerEntryInput[];
}

/** A transaction as written, with its entries. */
export type PostedTransaction = Prisma.LedgerTransactionGetPayload<{ include: { entries: true } }>;

interface ExactEntry {
  readonly accountId: string;
  readonly currency: string;
  readonly amount: ExactDecimal;
}

/** Every rule that needs no database, checked before anything is read or written. */
const validate = ({ type, entries }: PostTransactionInput): ExactEntry[] => {
  if (type === EntryType.CORRECTION) {
    throw new LedgerError(
      LedgerErrorCode.CORRECTION_NOT_ALLOWED,
      "in M0 a CORRECTION is written only by a human with database access (ledger.md section 4)",
    );
  }
  if (entries.length < 2) {
    throw new LedgerError(
      LedgerErrorCode.TOO_FEW_ENTRIES,
      `a transaction has at least two entries, got ${entries.length.toString()} (ledger.md section 3)`,
    );
  }

  const exact = entries.map(({ accountId, currency, amount }) => {
    const parsed = toExact(amount);
    if (parsed.isZero()) {
      throw new LedgerError(
        LedgerErrorCode.ZERO_AMOUNT,
        "an entry's amount is never zero (ledger.md section 2)",
      );
    }
    return { accountId, currency: assertCurrency(currency), amount: parsed };
  });

  for (const [currency, amounts] of groupBy(exact, (entry) => entry.currency)) {
    const sum = sumExact(amounts.map((entry) => entry.amount));
    if (!sum.isZero()) {
      throw new LedgerError(
        LedgerErrorCode.UNBALANCED,
        `the ${currency} entries sum to ${sum.toFixed()}, not zero (ledger.md section 3)`,
      );
    }
  }

  return exact;
};

const groupBy = <T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group === undefined) {
      groups.set(key(item), [item]);
    } else {
      group.push(item);
    }
  }
  return groups;
};

/** Loads each entry's account type, rejecting an id that names no account. */
const accountTypes = async (
  tx: Prisma.TransactionClient,
  entries: readonly ExactEntry[],
): Promise<Map<string, AccountType>> => {
  const ids = [...new Set(entries.map((entry) => entry.accountId))];
  const accounts = await tx.account.findMany({
    where: { id: { in: ids } },
    select: { id: true, type: true },
  });
  const types = new Map(accounts.map((account) => [account.id, account.type]));
  const missing = ids.filter((id) => !types.has(id));
  if (missing.length > 0) {
    throw new LedgerError(
      LedgerErrorCode.ACCOUNT_NOT_FOUND,
      `no account ${missing.join(", ")} (accounts.md section 2)`,
    );
  }
  return types;
};

/**
 * The treasury is the source of every DEPOSIT and appears nowhere else (ledger.md section 6,
 * accounts.md section 6). A DEPOSIT is exactly the treasury debited and one other account
 * credited the same amount of one currency. The shape of a TRADE is left to #11's spec.
 */
const assertShape = (
  type: EntryType,
  entries: readonly ExactEntry[],
  types: ReadonlyMap<string, AccountType>,
): void => {
  const isTreasury = (entry: ExactEntry) => types.get(entry.accountId) === AccountType.TREASURY;

  if (type !== EntryType.DEPOSIT) {
    if (entries.some(isTreasury)) {
      throw new LedgerError(
        LedgerErrorCode.TREASURY_NOT_ALLOWED,
        `the treasury appears only in a DEPOSIT, not a ${type} (accounts.md section 6)`,
      );
    }
    return;
  }

  const [first, second] = entries;
  const debit = [first, second].find((entry) => entry !== undefined && isTreasury(entry));
  const credit = [first, second].find((entry) => entry !== undefined && !isTreasury(entry));
  if (
    entries.length !== 2 ||
    debit === undefined ||
    credit === undefined ||
    !debit.amount.isNegative() ||
    !credit.amount.isPositive()
  ) {
    throw new LedgerError(
      LedgerErrorCode.INVALID_DEPOSIT_SHAPE,
      "a DEPOSIT is two entries in one currency: the treasury debited, and one other account credited the same amount (ledger.md section 6)",
    );
  }
};

/** An entry as a comparable string, amount at full scale so equal values compare equal. */
const entryKey = (accountId: string, currency: string, amount: ExactDecimal): string =>
  `${accountId}|${currency}|${amount.toFixed(18)}`;

/**
 * The transaction already written under this cause key, or null. A replay must be the same
 * transaction: a different type or a different set of entries under one cause is a bug in the
 * caller, and replaying the first one silently would hide it.
 */
const findReplay = async (
  tx: Prisma.TransactionClient,
  input: PostTransactionInput,
  entries: readonly ExactEntry[],
): Promise<PostedTransaction | null> => {
  const existing = await tx.ledgerTransaction.findUnique({
    where: { causeKey: input.causeKey },
    include: { entries: true },
  });
  if (existing === null) {
    return null;
  }

  const wanted = entries.map((e) => entryKey(e.accountId, e.currency, e.amount)).sort();
  const written = existing.entries
    .map((e) => entryKey(e.accountId, e.currency, fromPrisma(e.amount)))
    .sort();
  if (existing.type !== input.type || wanted.join("\n") !== written.join("\n")) {
    throw new LedgerError(
      LedgerErrorCode.IDEMPOTENCY_CONFLICT,
      `cause key ${input.causeKey} already names a different transaction (ledger.md section 3)`,
    );
  }
  return existing;
};

/**
 * No USER or BOT account spends more than its buying power (accounts.md sections 4.4 and 5).
 * Each account and currency this transaction takes money from is locked, the same lock
 * `placeHold` takes, and checked with the debit applied.
 */
const assertBuyingPower = async (
  tx: Prisma.TransactionClient,
  entries: readonly ExactEntry[],
  types: ReadonlyMap<string, AccountType>,
): Promise<void> => {
  const spenders = entries.filter((entry) => types.get(entry.accountId) !== AccountType.TREASURY);
  const debits = [...groupBy(spenders, (entry) => `${entry.accountId}:${entry.currency}`).values()]
    .map((group) => ({
      accountId: group[0]?.accountId ?? "",
      currency: group[0]?.currency ?? "",
      net: sumExact(group.map((entry) => entry.amount)),
    }))
    .filter(({ net }) => net.isNegative());

  await lockBuyingPower(tx, debits);

  for (const { accountId, currency, net } of debits) {
    const available = await buyingPowerIn(tx, accountId, currency);
    if (available.plus(net).isNegative()) {
      throw new LedgerError(
        LedgerErrorCode.INSUFFICIENT_BUYING_POWER,
        `account ${accountId} has ${available.toFixed()} ${currency} of buying power and this takes ${net.negated().toFixed()} (accounts.md section 5)`,
      );
    }
  }
};

const write = async (
  tx: Prisma.TransactionClient,
  input: PostTransactionInput,
  entries: readonly ExactEntry[],
): Promise<PostedTransaction> => {
  await assertReadCommitted(tx);
  await lockCause(tx, input.causeKey);
  const types = await accountTypes(tx, entries);

  // Before the shape rules, so a re-post under a different type is reported as the conflict it
  // is rather than as whichever shape rule the new type happens to break.
  const replay = await findReplay(tx, input, entries);
  if (replay !== null) {
    return replay;
  }

  assertShape(input.type, entries, types);

  await assertBuyingPower(tx, entries, types);

  return tx.ledgerTransaction.create({
    data: {
      type: input.type,
      causeKey: input.causeKey,
      entries: {
        create: entries.map(({ accountId, currency, amount }) => ({
          accountId,
          currency,
          amount: amount.toFixed(),
        })),
      },
    },
    include: { entries: true },
  });
};

const isDuplicateCauseKey = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/**
 * Writes one ledger transaction and its entries, all or none. The only sanctioned way to write
 * the ledger; nothing in this package updates or deletes an entry or a transaction.
 *
 * Every rule that needs no database is checked first: at least two entries, no zero amount,
 * each currency summing to zero, well-formed currencies, amounts NUMERIC(38, 18) holds exactly,
 * and no CORRECTION (ledger.md sections 2 to 4 and 7). Then, under a lock on the cause key: the
 * accounts exist, the treasury appears only as the source of a DEPOSIT, and no USER or BOT
 * account is taken below its buying power.
 *
 * A cause key already written with the same type and entries is a no-op that returns the
 * existing transaction (ledger.md section 3); with anything else it is an
 * `IDEMPOTENCY_CONFLICT`.
 *
 * Given a client it runs in its own transaction; given a transaction client, inside the
 * caller's, so a rejection rolls the caller's work back too (see {@link LedgerDb}).
 */
export const postTransaction = async (
  db: LedgerDb,
  input: PostTransactionInput,
): Promise<PostedTransaction> => {
  const entries = validate(input);

  try {
    return await inTransaction(db, async (tx) => write(tx, input, entries));
  } catch (error) {
    if (!isDuplicateCauseKey(error)) {
      throw error;
    }
    // Only reachable when the key was written without the cause lock, outside this API. In the
    // caller's transaction the failed insert has already aborted it, so the caller has to know.
    if (!ownsTransaction(db)) {
      throw new LedgerError(
        LedgerErrorCode.DUPLICATE_CAUSE_KEY,
        `cause key ${input.causeKey} was written concurrently; the caller's transaction is aborted (ledger.md section 3)`,
      );
    }
    const replay = await inTransaction(db, async (tx) => findReplay(tx, input, entries));
    if (replay === null) {
      throw error;
    }
    return replay;
  }
};
