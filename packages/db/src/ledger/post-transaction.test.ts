import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient } from "../generated/prisma/client.js";
import { AccountType, EntryType } from "../generated/prisma/enums.js";
import { testDatabaseUrl } from "../testing/database-guard.js";

import { balanceOf } from "./balances.js";
import { LedgerError, LedgerErrorCode } from "./errors.js";
import { connect, fund, newAccount, sleep, treasuryId, unique } from "./fixtures.js";
import { postTransaction, type LedgerEntryInput } from "./post-transaction.js";

/**
 * postTransaction against a real database (ledger.md sections 2 to 7).
 *
 * The database is this run's own (src/testing/global-setup.ts), and shared by every test file,
 * and the ledger cannot be truncated. So every property works on accounts it creates itself,
 * and only the whole-ledger property reads beyond them. Locally with no server these skip; in
 * CI they fail instead (src/testing/database-guard.ts).
 *
 * Money in the generators is bigint units of 1e-18, the independent oracle: expected balances
 * are integer sums, compared against what the database computed.
 */
const databaseUrl = testDatabaseUrl();

const CURRENCIES = ["USD", "BTC", "ETH"] as const;
const SCALE = 10n ** 18n;
const PROPERTY_TIMEOUT = 180_000;

/** Units of 1e-18 as the decimal string the API takes. */
const fromUnits = (units: bigint): string => {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = (abs / SCALE).toString();
  const fraction = (abs % SCALE).toString().padStart(18, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
};

/** A decimal string back to units of 1e-18. */
const toUnits = (amount: string): bigint => {
  const negative = amount.startsWith("-");
  const [whole = "0", fraction = ""] = amount.replace("-", "").split(".");
  const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, "0"));
  return negative ? -units : units;
};

/** A positive amount up to one million, at full 18-place scale. */
const amountUnits = fc.bigInt({ min: 1n, max: 10n ** 24n });

/**
 * A history: deposits from the treasury first, then transfers and two-currency swaps between
 * the run's accounts. Each debit is a share (in thousandths) of the payer's balance at that
 * point, so no USER account is ever taken below zero and every generated history is one the
 * buying-power guard accepts.
 */
const historyArb = fc.record({
  accounts: fc.integer({ min: 2, max: 4 }),
  deposits: fc.array(
    fc.record({ to: fc.nat(), currency: fc.constantFrom(...CURRENCIES), units: amountUnits }),
    { minLength: 1, maxLength: 6 },
  ),
  moves: fc.array(
    fc.record({
      swap: fc.boolean(),
      from: fc.nat(),
      to: fc.nat(),
      currency: fc.constantFrom(...CURRENCIES),
      other: fc.constantFrom(...CURRENCIES),
      share: fc.integer({ min: 1, max: 1000 }),
      otherShare: fc.integer({ min: 1, max: 1000 }),
    }),
    { maxLength: 6 },
  ),
});

type HistoryValue = typeof historyArb extends fc.Arbitrary<infer T> ? T : never;

interface Played {
  readonly accounts: readonly string[];
  readonly transactionIds: readonly string[];
  /** Expected balance of `${accountId}:${currency}`, in units. */
  readonly expected: ReadonlyMap<string, bigint>;
}

describe.skipIf(databaseUrl === undefined)("postTransaction (ledger.md)", () => {
  let db: PrismaClient;
  let other: PrismaClient;

  beforeAll(async () => {
    db = await connect(databaseUrl ?? "");
    other = await connect(databaseUrl ?? "");
  });

  afterAll(async () => {
    await Promise.all([db.$disconnect(), other.$disconnect()]);
  });

  /** Posts a generated history and returns what it should have produced. */
  const play = async (history: HistoryValue): Promise<Played> => {
    const treasury = await treasuryId(db);
    const accounts: string[] = [];
    for (let i = 0; i < history.accounts; i += 1) {
      accounts.push(await newAccount(db));
    }
    const at = (index: number): string => accounts[index % accounts.length] ?? "";
    const expected = new Map<string, bigint>();
    const balance = (account: string, currency: string): bigint =>
      expected.get(`${account}:${currency}`) ?? 0n;
    const add = (account: string, currency: string, units: bigint): void => {
      expected.set(`${account}:${currency}`, balance(account, currency) + units);
    };
    const transactionIds: string[] = [];
    const post = async (type: EntryType, entries: LedgerEntryInput[]): Promise<void> => {
      const posted = await postTransaction(db, { type, causeKey: unique("history"), entries });
      transactionIds.push(posted.id);
    };

    for (const { to, currency, units } of history.deposits) {
      await post(EntryType.DEPOSIT, [
        { accountId: treasury, currency, amount: fromUnits(-units) },
        { accountId: at(to), currency, amount: fromUnits(units) },
      ]);
      add(at(to), currency, units);
    }

    for (const move of history.moves) {
      const from = at(move.from);
      const to = at(move.to);
      const units = (balance(from, move.currency) * BigInt(move.share)) / 1000n;
      if (from === to || units === 0n) {
        continue;
      }
      const entries: LedgerEntryInput[] = [
        { accountId: from, currency: move.currency, amount: fromUnits(-units) },
        { accountId: to, currency: move.currency, amount: fromUnits(units) },
      ];
      const back = (balance(to, move.other) * BigInt(move.otherShare)) / 1000n;
      const swaps = move.swap && move.other !== move.currency && back > 0n;
      if (swaps) {
        entries.push(
          { accountId: to, currency: move.other, amount: fromUnits(-back) },
          { accountId: from, currency: move.other, amount: fromUnits(back) },
        );
      }
      await post(EntryType.TRADE, entries);
      add(from, move.currency, -units);
      add(to, move.currency, units);
      if (swaps) {
        add(to, move.other, -back);
        add(from, move.other, back);
      }
    }

    return { accounts, transactionIds, expected };
  };

  it(
    "property 1: every transaction it accepts sums to zero for each currency",
    async () => {
      await fc.assert(
        fc.asyncProperty(historyArb, async (history) => {
          const { transactionIds } = await play(history);
          const sums = await db.ledgerEntry.groupBy({
            by: ["transactionId", "currency"],
            where: { transactionId: { in: [...transactionIds] } },
            _sum: { amount: true },
          });
          expect(sums.length).toBeGreaterThan(0);
          for (const { _sum } of sums) {
            expect(_sum.amount?.isZero()).toBe(true);
          }
        }),
        { numRuns: 20 },
      );
    },
    PROPERTY_TIMEOUT,
  );

  it(
    "property 2: rejects each broken set with its own error, and writes nothing",
    async () => {
      const kinds = [
        "unbalanced",
        "zero",
        "one entry",
        "malformed currency",
        "correction",
        "not representable",
        "unknown account",
        "deposit between users",
        "deposit crediting the treasury",
        "treasury in a trade",
        "over buying power",
      ] as const;

      await fc.assert(
        fc.asyncProperty(fc.constantFrom(...kinds), amountUnits, async (kind, units) => {
          const treasury = await treasuryId(db);
          const [a, b] = [await newAccount(db), await newAccount(db)];
          await fund(db, a, "USD", fromUnits(units));
          const x = fromUnits(units);
          const minus = fromUnits(-units);
          const trade = (entries: LedgerEntryInput[]) => ({ type: EntryType.TRADE, entries });

          const cases = {
            unbalanced: [
              LedgerErrorCode.UNBALANCED,
              trade([
                { accountId: a, currency: "USD", amount: minus },
                { accountId: b, currency: "USD", amount: fromUnits(units + 1n) },
              ]),
            ],
            zero: [
              LedgerErrorCode.ZERO_AMOUNT,
              trade([
                { accountId: a, currency: "USD", amount: "0" },
                { accountId: b, currency: "USD", amount: "0" },
              ]),
            ],
            "one entry": [
              LedgerErrorCode.TOO_FEW_ENTRIES,
              trade([{ accountId: a, currency: "USD", amount: minus }]),
            ],
            "malformed currency": [
              LedgerErrorCode.INVALID_CURRENCY,
              trade([
                { accountId: a, currency: "usd", amount: minus },
                { accountId: b, currency: "usd", amount: x },
              ]),
            ],
            correction: [
              LedgerErrorCode.CORRECTION_NOT_ALLOWED,
              {
                type: EntryType.CORRECTION,
                entries: [
                  { accountId: treasury, currency: "USD", amount: x },
                  { accountId: a, currency: "USD", amount: minus },
                ],
              },
            ],
            "not representable": [
              LedgerErrorCode.AMOUNT_NOT_REPRESENTABLE,
              trade([
                { accountId: a, currency: "USD", amount: `${minus}1` },
                { accountId: b, currency: "USD", amount: `${x}1` },
              ]),
            ],
            "unknown account": [
              LedgerErrorCode.ACCOUNT_NOT_FOUND,
              trade([
                { accountId: a, currency: "USD", amount: minus },
                { accountId: "00000000-0000-0000-0000-000000000000", currency: "USD", amount: x },
              ]),
            ],
            "deposit between users": [
              LedgerErrorCode.INVALID_DEPOSIT_SHAPE,
              {
                type: EntryType.DEPOSIT,
                entries: [
                  { accountId: a, currency: "USD", amount: minus },
                  { accountId: b, currency: "USD", amount: x },
                ],
              },
            ],
            "deposit crediting the treasury": [
              LedgerErrorCode.INVALID_DEPOSIT_SHAPE,
              {
                type: EntryType.DEPOSIT,
                entries: [
                  { accountId: a, currency: "USD", amount: minus },
                  { accountId: treasury, currency: "USD", amount: x },
                ],
              },
            ],
            "treasury in a trade": [
              LedgerErrorCode.TREASURY_NOT_ALLOWED,
              trade([
                { accountId: treasury, currency: "USD", amount: minus },
                { accountId: b, currency: "USD", amount: x },
              ]),
            ],
            "over buying power": [
              LedgerErrorCode.INSUFFICIENT_BUYING_POWER,
              trade([
                { accountId: a, currency: "USD", amount: fromUnits(-units - 1n) },
                { accountId: b, currency: "USD", amount: fromUnits(units + 1n) },
              ]),
            ],
          } as const;

          const [code, input] = cases[kind];
          const causeKey = unique("reject");
          const entriesBefore = await db.ledgerEntry.count({
            where: { accountId: { in: [a, b] } },
          });

          const error: unknown = await postTransaction(db, { ...input, causeKey }).then(
            () => null,
            (reason: unknown) => reason,
          );

          expect(error).toBeInstanceOf(LedgerError);
          expect((error as LedgerError).code).toBe(code);
          expect((error as LedgerError).message).not.toMatch(
            /constraint|violates|append-only|P2\d{3}|Prisma/iu,
          );
          expect(await db.ledgerTransaction.count({ where: { causeKey } })).toBe(0);
          expect(await db.ledgerEntry.count({ where: { accountId: { in: [a, b] } } })).toBe(
            entriesBefore,
          );
        }),
        { numRuns: 60 },
      );
    },
    PROPERTY_TIMEOUT,
  );

  describe("property 3: a cause key is written once (ledger.md section 3)", () => {
    const depositTo = async (units: bigint) => {
      const treasury = await treasuryId(db);
      const account = await newAccount(db);
      return {
        account,
        input: {
          type: EntryType.DEPOSIT,
          causeKey: unique("idem"),
          entries: [
            { accountId: treasury, currency: "USD", amount: fromUnits(-units) },
            { accountId: account, currency: "USD", amount: fromUnits(units) },
          ],
        },
      };
    };

    it(
      "posted twice, in sequence or concurrently, in either mode: one transaction, both succeed",
      async () => {
        await fc.assert(
          fc.asyncProperty(
            amountUnits,
            fc.constantFrom("sequential", "concurrent", "concurrent in callers"),
            async (units, how) => {
              const { account, input } = await depositTo(units);

              const results =
                how === "sequential"
                  ? [await postTransaction(db, input), await postTransaction(db, input)]
                  : how === "concurrent"
                    ? await Promise.all([postTransaction(db, input), postTransaction(other, input)])
                    : await Promise.all([
                        db.$transaction(async (tx) => postTransaction(tx, input)),
                        other.$transaction(async (tx) => postTransaction(tx, input)),
                      ]);

              expect(results[0]?.id).toBeDefined();
              expect(results[1]?.id).toBe(results[0]?.id);
              expect(
                await db.ledgerTransaction.count({ where: { causeKey: input.causeKey } }),
              ).toBe(1);
              expect(await db.ledgerEntry.count({ where: { accountId: account } })).toBe(1);
              expect(toUnits((await balanceOf(db, account, "USD")).toFixed(18))).toBe(units);
            },
          ),
          { numRuns: 30 },
        );
      },
      PROPERTY_TIMEOUT,
    );

    it(
      "the same key with different entries is a conflict, and changes nothing",
      async () => {
        await fc.assert(
          fc.asyncProperty(amountUnits, fc.boolean(), async (units, otherAccount) => {
            const { account, input } = await depositTo(units);
            const first = await postTransaction(db, input);
            const target = otherAccount ? await newAccount(db) : account;
            const changed = otherAccount ? units : units + 1n;
            const treasury = await treasuryId(db);

            const error: unknown = await postTransaction(db, {
              ...input,
              entries: [
                { accountId: treasury, currency: "USD", amount: fromUnits(-changed) },
                { accountId: target, currency: "USD", amount: fromUnits(changed) },
              ],
            }).then(
              () => null,
              (reason: unknown) => reason,
            );

            expect(error).toBeInstanceOf(LedgerError);
            expect((error as LedgerError).code).toBe(LedgerErrorCode.IDEMPOTENCY_CONFLICT);
            const written = await db.ledgerTransaction.findMany({
              where: { causeKey: input.causeKey },
              include: { entries: true },
            });
            expect(written.map((t) => t.id)).toEqual([first.id]);
            expect(written[0]?.entries).toHaveLength(2);
          }),
          { numRuns: 20 },
        );
      },
      PROPERTY_TIMEOUT,
    );

    it("serialises twins on the cause lock: the second replays instead of colliding", async () => {
      // Deterministic, not a hopeful race. Caller A posts and holds its transaction open; B
      // posts the same key only after A's post has returned. With the lock B waits for A to
      // commit, then finds A's transaction and replays it. Without it B finds nothing, its
      // insert waits on the unique index, and fails as DUPLICATE_CAUSE_KEY once A commits.
      const { input } = await depositTo(5n * SCALE);
      let posted!: () => void;
      const aPosted = new Promise<void>((resolve) => {
        posted = resolve;
      });

      const [a, b] = await Promise.allSettled([
        db.$transaction(async (tx) => {
          const result = await postTransaction(tx, input);
          posted();
          await sleep(200);
          return result;
        }),
        aPosted.then(async () => other.$transaction(async (tx) => postTransaction(tx, input))),
      ]);

      expect(a.status).toBe("fulfilled");
      expect(b.status === "rejected" ? String(b.reason) : "fulfilled").toBe("fulfilled");
      if (a.status === "fulfilled" && b.status === "fulfilled") {
        expect(b.value.id).toBe(a.value.id);
      }
      expect(await db.ledgerTransaction.count({ where: { causeKey: input.causeKey } })).toBe(1);
    });
  });

  it(
    "property 4: for any history, the whole ledger sums to zero per currency, treasury included",
    async () => {
      await fc.assert(
        fc.asyncProperty(historyArb, async (history) => {
          await play(history);
          const sums = await db.ledgerEntry.groupBy({
            by: ["currency"],
            _sum: { amount: true },
          });
          expect(sums.map((row) => row.currency)).toEqual(
            expect.arrayContaining(history.deposits.map((d) => d.currency)),
          );
          for (const { currency, _sum } of sums) {
            expect({ currency, sum: _sum.amount?.toFixed() }).toEqual({ currency, sum: "0" });
          }
        }),
        { numRuns: 20 },
      );
    },
    PROPERTY_TIMEOUT,
  );

  it(
    "property 5: for any history, balanceOf is the sum of that account's entries",
    async () => {
      await fc.assert(
        fc.asyncProperty(historyArb, async (history) => {
          const { accounts, expected } = await play(history);
          for (const account of accounts) {
            for (const currency of CURRENCIES) {
              const balance = await balanceOf(db, account, currency);
              expect(toUnits(balance.toFixed(18))).toBe(
                expected.get(`${account}:${currency}`) ?? 0n,
              );
              // No USER balance a history produced is negative (accounts.md section 6).
              expect(balance.isNegative()).toBe(false);
            }
          }
        }),
        { numRuns: 20 },
      );
    },
    PROPERTY_TIMEOUT,
  );

  it("keeps full 18-place precision on a 20-digit balance", async () => {
    const account = await newAccount(db);
    await fund(db, account, "USD", "12345678901234567890.123456789012345678");
    await fund(db, account, "USD", "0.000000000000000001");

    expect((await balanceOf(db, account, "USD")).toFixed()).toBe(
      "12345678901234567890.123456789012345679",
    );
  });

  it("rejects balanceOf for an account that does not exist", async () => {
    await expect(
      balanceOf(db, "00000000-0000-0000-0000-000000000000", "USD"),
    ).rejects.toMatchObject({ code: LedgerErrorCode.ACCOUNT_NOT_FOUND });
  });

  it("rejects balanceOf for a malformed currency", async () => {
    const account = await newAccount(db);
    await expect(balanceOf(db, account, "usd")).rejects.toMatchObject({
      code: LedgerErrorCode.INVALID_CURRENCY,
    });
  });

  describe("inside a caller's transaction", () => {
    it("writes nothing when the caller rolls back", async () => {
      const account = await newAccount(db);
      const treasury = await treasuryId(db);
      const causeKey = unique("rollback");

      await expect(
        db.$transaction(async (tx) => {
          await postTransaction(tx, {
            type: EntryType.DEPOSIT,
            causeKey,
            entries: [
              { accountId: treasury, currency: "USD", amount: "-10" },
              { accountId: account, currency: "USD", amount: "10" },
            ],
          });
          throw new Error("the caller changed its mind");
        }),
      ).rejects.toThrow(/changed its mind/u);

      expect(await db.ledgerTransaction.count({ where: { causeKey } })).toBe(0);
      expect(await db.ledgerEntry.count({ where: { accountId: account } })).toBe(0);
    });

    it("rolls back the caller's own work when it rejects", async () => {
      const payer = await newAccount(db);
      let created = "";

      await expect(
        db.$transaction(async (tx) => {
          created = (await tx.account.create({ data: { type: AccountType.USER } })).id;
          await postTransaction(tx, {
            type: EntryType.TRADE,
            causeKey: unique("caller-reject"),
            entries: [
              { accountId: payer, currency: "USD", amount: "-1" },
              { accountId: created, currency: "USD", amount: "1" },
            ],
          });
        }),
      ).rejects.toMatchObject({ code: LedgerErrorCode.INSUFFICIENT_BUYING_POWER });

      expect(created).not.toBe("");
      expect(await db.account.count({ where: { id: created } })).toBe(0);
    });
  });
});
