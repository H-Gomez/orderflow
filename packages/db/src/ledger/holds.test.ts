import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { AccountType, EntryType, HoldState } from "../generated/prisma/enums.js";
import { testDatabaseUrl } from "../testing/database-guard.js";

import { balanceOf, buyingPowerOf } from "./balances.js";
import { LedgerError, LedgerErrorCode } from "./errors.js";
import {
  connect,
  fund,
  newAccount,
  newInstrument,
  newOrder,
  sleep,
  treasuryId,
  unique,
} from "./fixtures.js";
import { placeHold } from "./holds.js";
import { ExactDecimal } from "./money.js";
import { postTransaction } from "./post-transaction.js";
import { ownsTransaction, type LedgerDb } from "./transaction.js";

/**
 * Holds and buying power against a real database (accounts.md sections 4 and 5).
 *
 * What these guard is a race: a derived balance has no row to lock, so without the advisory
 * lock two writers each read the same buying power and both spend it. The properties run
 * generated operations concurrently across several clients, and the deterministic tests hold
 * one writer's transaction open while the other arrives, so they fail every time the lock is
 * missing rather than only when the scheduler happens to interleave them.
 */
const databaseUrl = testDatabaseUrl();

const PROPERTY_TIMEOUT = 180_000;
const CLIENTS = 4;

const rejection = (result: PromiseSettledResult<unknown>): LedgerErrorCode | undefined =>
  result.status === "rejected" && result.reason instanceof LedgerError
    ? result.reason.code
    : undefined;

describe.skipIf(databaseUrl === undefined)("holds and buying power (accounts.md)", () => {
  let clients: PrismaClient[] = [];
  let db: PrismaClient;
  let instrument: string;

  beforeAll(async () => {
    db = await connect(databaseUrl ?? "");
    clients = [
      db,
      ...(await Promise.all(
        Array.from({ length: CLIENTS - 1 }, async () => connect(databaseUrl ?? "")),
      )),
    ];
    instrument = await newInstrument(db);
  });

  afterAll(async () => {
    await Promise.all(clients.map(async (client) => client.$disconnect()));
  });

  const client = (index: number): PrismaClient => clients[index % CLIENTS] ?? db;

  /** Sum of the account's ACTIVE holds in a currency, and its balance, read now. */
  const exposure = async (accountId: string, currency: string) => {
    const { _sum } = await db.hold.aggregate({
      where: { accountId, currency, state: HoldState.ACTIVE },
      _sum: { amount: true },
    });
    return {
      held: new ExactDecimal(_sum.amount?.toFixed() ?? "0"),
      balance: await balanceOf(db, accountId, currency),
    };
  };

  /** Moves `amount` out of `from` in a TRADE, the debit that competes with holds. */
  const debit = async (via: LedgerDb, from: string, to: string, amount: string) =>
    postTransaction(via, {
      type: EntryType.TRADE,
      causeKey: unique("debit"),
      entries: [
        { accountId: from, currency: "USD", amount: `-${amount}` },
        { accountId: to, currency: "USD", amount },
      ],
    });

  /** A generated operation: a hold or a debit of some thousandths of the account's funding. */
  const operation = fc.record({
    debit: fc.boolean(),
    share: fc.integer({ min: 1, max: 1000 }),
    /** Runs alongside the previous operation rather than after it. */
    concurrent: fc.boolean(),
  });

  it(
    "property 6: under concurrent holds and debits, ACTIVE holds never exceed the balance",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 1000n, max: 10n ** 12n }),
          fc.array(operation, { minLength: 1, maxLength: 12 }),
          async (funding, operations) => {
            const account = await newAccount(db);
            const sink = await newAccount(db);
            await fund(db, account, "USD", funding.toString());

            const batches: (typeof operations)[] = [];
            for (const op of operations) {
              const last = batches.at(-1);
              if (op.concurrent && last !== undefined && last.length < CLIENTS) {
                last.push(op);
              } else {
                batches.push([op]);
              }
            }

            for (const batch of batches) {
              const orders = await Promise.all(
                batch.map(async () => newOrder(db, account, instrument)),
              );
              const results = await Promise.allSettled(
                batch.map(async (op, index) => {
                  const amount = ((funding * BigInt(op.share)) / 1000n).toString();
                  return op.debit
                    ? debit(client(index), account, sink, amount)
                    : placeHold(client(index), {
                        accountId: account,
                        orderId: orders[index] ?? "",
                        currency: "USD",
                        amount,
                      });
                }),
              );

              for (const result of results) {
                if (result.status === "rejected") {
                  expect(rejection(result)).toBe(LedgerErrorCode.INSUFFICIENT_BUYING_POWER);
                }
              }
              const { held, balance } = await exposure(account, "USD");
              expect(held.lte(balance)).toBe(true);
            }
          },
        ),
        { numRuns: 30 },
      );
    },
    PROPERTY_TIMEOUT,
  );

  it(
    "property 7: no USER or BOT balance created in the run is ever negative",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.bigInt({ min: 1n, max: 10n ** 9n }), { minLength: 2, maxLength: 4 }),
          fc.array(
            fc.record({
              from: fc.nat(),
              to: fc.nat(),
              share: fc.integer({ min: 1, max: 1500 }),
            }),
            { minLength: 1, maxLength: 12 },
          ),
          async (fundings, transfers) => {
            const accounts: string[] = [];
            for (const [index, funding] of fundings.entries()) {
              const id = await newAccount(db, index % 2 === 0 ? AccountType.USER : AccountType.BOT);
              await fund(db, id, "USD", funding.toString());
              accounts.push(id);
            }
            const at = (i: number): string => accounts[i % accounts.length] ?? "";
            const fundingOf = (i: number): bigint => fundings[i % fundings.length] ?? 0n;

            // Every transfer at once: the shares add up to far more than any account holds.
            const results = await Promise.allSettled(
              transfers
                .filter(({ from, to }) => at(from) !== at(to))
                .map(async ({ from, to, share }, index) => {
                  const amount = (fundingOf(from) * BigInt(share)) / 1000n;
                  return amount === 0n
                    ? null
                    : debit(client(index), at(from), at(to), amount.toString());
                }),
            );

            for (const result of results) {
              if (result.status === "rejected") {
                expect(rejection(result)).toBe(LedgerErrorCode.INSUFFICIENT_BUYING_POWER);
              }
            }
            for (const account of accounts) {
              expect((await balanceOf(db, account, "USD")).isNegative()).toBe(false);
            }
          },
        ),
        { numRuns: 30 },
      );
    },
    PROPERTY_TIMEOUT,
  );

  describe("the lock, proved deterministically", () => {
    /**
     * Writer A runs inside a caller's transaction and holds it open after spending; B starts
     * only once A has spent. With the lock B waits for A's commit and then sees A's spend.
     * Without it B reads the buying power from before A and spends the same money again.
     */
    const race = async (
      first: (tx: Prisma.TransactionClient) => Promise<unknown>,
      second: (via: PrismaClient) => Promise<unknown>,
    ) => {
      let spent!: () => void;
      const aSpent = new Promise<void>((resolve) => {
        spent = resolve;
      });
      return Promise.allSettled([
        client(0).$transaction(async (tx) => {
          await first(tx);
          spent();
          await sleep(200);
        }),
        aSpent.then(async () => second(client(1))),
      ]);
    };

    it("a second hold waits for the first and is refused", async () => {
      const account = await newAccount(db);
      await fund(db, account, "USD", "100");
      const [orderA, orderB] = [
        await newOrder(db, account, instrument),
        await newOrder(db, account, instrument),
      ];

      const [a, b] = await race(
        async (tx) =>
          placeHold(tx, { accountId: account, orderId: orderA, currency: "USD", amount: "60" }),
        async (via) =>
          placeHold(via, { accountId: account, orderId: orderB, currency: "USD", amount: "60" }),
      );

      expect(a.status).toBe("fulfilled");
      expect(rejection(b)).toBe(LedgerErrorCode.INSUFFICIENT_BUYING_POWER);
      expect((await exposure(account, "USD")).held.toFixed()).toBe("60");
    });

    it("a debit waits for a hold and is refused", async () => {
      const [account, sink] = [await newAccount(db), await newAccount(db)];
      await fund(db, account, "USD", "100");
      const order = await newOrder(db, account, instrument);

      const [a, b] = await race(
        async (tx) =>
          placeHold(tx, { accountId: account, orderId: order, currency: "USD", amount: "60" }),
        async (via) => debit(via, account, sink, "60"),
      );

      expect(a.status).toBe("fulfilled");
      expect(rejection(b)).toBe(LedgerErrorCode.INSUFFICIENT_BUYING_POWER);
      expect((await balanceOf(db, account, "USD")).toFixed()).toBe("100");
    });

    it("a hold waits for a debit and is refused", async () => {
      const [account, sink] = [await newAccount(db), await newAccount(db)];
      await fund(db, account, "USD", "100");
      const order = await newOrder(db, account, instrument);

      const [a, b] = await race(
        async (tx) => debit(tx, account, sink, "60"),
        async (via) =>
          placeHold(via, { accountId: account, orderId: order, currency: "USD", amount: "60" }),
      );

      expect(a.status).toBe("fulfilled");
      expect(rejection(b)).toBe(LedgerErrorCode.INSUFFICIENT_BUYING_POWER);
      expect((await exposure(account, "USD")).held.toFixed()).toBe("0");
      expect((await balanceOf(db, account, "USD")).toFixed()).toBe("40");
    });

    it("twenty concurrent holds of 60 against a balance of 100: exactly one", async () => {
      const account = await newAccount(db);
      await fund(db, account, "USD", "100");
      const orders = await Promise.all(
        Array.from({ length: 20 }, async () => newOrder(db, account, instrument)),
      );

      const results = await Promise.allSettled(
        orders.map(async (orderId, index) =>
          placeHold(client(index), { accountId: account, orderId, currency: "USD", amount: "60" }),
        ),
      );

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        results.filter((r) => rejection(r) === LedgerErrorCode.INSUFFICIENT_BUYING_POWER),
      ).toHaveLength(19);
      expect((await exposure(account, "USD")).held.toFixed()).toBe("60");
    });
  });

  describe("buyingPowerOf (accounts.md section 5)", () => {
    it("is the balance minus ACTIVE holds", async () => {
      const account = await newAccount(db);
      await fund(db, account, "USD", "100.5");
      const order = await newOrder(db, account, instrument);
      await placeHold(db, { accountId: account, orderId: order, currency: "USD", amount: "0.25" });

      expect((await buyingPowerOf(db, account, "USD")).toFixed()).toBe("100.25");
      expect((await buyingPowerOf(db, account, "BTC")).toFixed()).toBe("0");
    });

    it("ignores RELEASED and CONVERTED holds", async () => {
      const account = await newAccount(db);
      await fund(db, account, "USD", "100");
      for (const state of [HoldState.RELEASED, HoldState.CONVERTED]) {
        // Written directly: releasing and converting holds is M2's, not this package's yet.
        await db.hold.create({
          data: {
            accountId: account,
            orderId: await newOrder(db, account, instrument),
            currency: "USD",
            amount: "30",
            state,
          },
        });
      }

      expect((await buyingPowerOf(db, account, "USD")).toFixed()).toBe("100");
    });

    it("rejects the treasury, which has no buying power", async () => {
      await expect(buyingPowerOf(db, await treasuryId(db), "USD")).rejects.toMatchObject({
        code: LedgerErrorCode.TREASURY_HAS_NO_BUYING_POWER,
      });
    });

    it("rejects an account that does not exist", async () => {
      await expect(
        buyingPowerOf(db, "00000000-0000-0000-0000-000000000000", "USD"),
      ).rejects.toMatchObject({ code: LedgerErrorCode.ACCOUNT_NOT_FOUND });
    });
  });

  describe("placeHold rejections, each with its own error and no hold written", () => {
    const attempt = async (
      accountId: string,
      currency: string,
      amount: string,
    ): Promise<{ code: unknown; holds: number }> => {
      const orderId = await newOrder(db, accountId, instrument);
      const code = await placeHold(db, { accountId, orderId, currency, amount }).then(
        () => null,
        (error: unknown) => (error instanceof LedgerError ? error.code : error),
      );
      return { code, holds: await db.hold.count({ where: { orderId } }) };
    };

    it("rejects a hold of zero or less", async () => {
      const account = await newAccount(db);
      await fund(db, account, "USD", "10");
      for (const amount of ["0", "-1", "-0.000000000000000001"]) {
        expect(await attempt(account, "USD", amount)).toEqual({
          code: LedgerErrorCode.NON_POSITIVE_HOLD,
          holds: 0,
        });
      }
    });

    it("rejects a malformed currency and an unrepresentable amount", async () => {
      const account = await newAccount(db);
      await fund(db, account, "USD", "10");
      expect(await attempt(account, "usd", "1")).toEqual({
        code: LedgerErrorCode.INVALID_CURRENCY,
        holds: 0,
      });
      expect(await attempt(account, "USD", "0.0000000000000000001")).toEqual({
        code: LedgerErrorCode.AMOUNT_NOT_REPRESENTABLE,
        holds: 0,
      });
    });

    it("rejects the treasury, and a hold over buying power", async () => {
      const account = await newAccount(db);
      await fund(db, account, "USD", "10");
      expect(await attempt(await treasuryId(db), "USD", "1")).toEqual({
        code: LedgerErrorCode.TREASURY_HAS_NO_BUYING_POWER,
        holds: 0,
      });
      expect(await attempt(account, "USD", "10.000000000000000001")).toEqual({
        code: LedgerErrorCode.INSUFFICIENT_BUYING_POWER,
        holds: 0,
      });
      expect(await attempt(account, "USD", "10")).toEqual({ code: null, holds: 1 });
    });

    it("rejects an unknown account, an order that is not the account's, and a second hold", async () => {
      const [account, stranger] = [await newAccount(db), await newAccount(db)];
      await fund(db, account, "USD", "10");
      await fund(db, stranger, "USD", "10");
      const place = async (accountId: string, orderId: string) =>
        placeHold(db, { accountId, orderId, currency: "USD", amount: "1" }).then(
          () => null,
          (error: unknown) => (error instanceof LedgerError ? error.code : error),
        );

      const order = await newOrder(db, account, instrument);
      expect(await place("00000000-0000-0000-0000-000000000000", order)).toBe(
        LedgerErrorCode.ACCOUNT_NOT_FOUND,
      );
      expect(await place(account, "00000000-0000-0000-0000-000000000000")).toBe(
        LedgerErrorCode.ORDER_NOT_FOUND,
      );
      expect(await place(stranger, order)).toBe(LedgerErrorCode.ORDER_NOT_FOUND);
      expect(await db.hold.count({ where: { orderId: order } })).toBe(0);

      expect(await place(account, order)).toBeNull();
      expect(await place(account, order)).toBe(LedgerErrorCode.HOLD_EXISTS);
      expect(await db.hold.count({ where: { orderId: order } })).toBe(1);
    });

    it("in a caller's transaction, a rejection rolls back the caller's order too", async () => {
      const account = await newAccount(db);
      await fund(db, account, "USD", "10");
      let orderId = "";

      await expect(
        db.$transaction(async (tx) => {
          orderId = await newOrder(tx, account, instrument);
          await placeHold(tx, { accountId: account, orderId, currency: "USD", amount: "11" });
        }),
      ).rejects.toMatchObject({ code: LedgerErrorCode.INSUFFICIENT_BUYING_POWER });

      expect(orderId).not.toBe("");
      expect(await db.order.count({ where: { id: orderId } })).toBe(0);
    });

    it("in a caller's transaction, an order and its hold commit together", async () => {
      const account = await newAccount(db);
      await fund(db, account, "USD", "10");

      const hold = await db.$transaction(async (tx) => {
        const orderId = await newOrder(tx, account, instrument);
        return placeHold(tx, { accountId: account, orderId, currency: "USD", amount: "10" });
      });

      expect(await db.order.count({ where: { id: hold.orderId } })).toBe(1);
      expect(hold.state).toBe(HoldState.ACTIVE);
    });
  });

  it("tells a client from a transaction client", async () => {
    expect(ownsTransaction(db)).toBe(true);
    expect(await db.$transaction((tx) => Promise.resolve(ownsTransaction(tx)))).toBe(false);
  });
});
