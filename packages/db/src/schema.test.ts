import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "./client.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import { AccountType, EntryType } from "./generated/prisma/enums.js";
import { testDatabaseUrl } from "./testing/database-guard.js";

/**
 * The rules the database itself enforces, checked against a real one.
 *
 * The database is made for this run and dropped after it (src/testing/global-setup.ts), so
 * these tests never write into a database anyone keeps: the ledger is append-only, and rows
 * written here would outlive the run. When no server answers, the URL is absent: locally every
 * test below skips, which keeps `pnpm test` green on a machine with no Docker, and under CI
 * this file fails instead, so a pipeline without a database cannot pass on skipped tests
 * (src/testing/database-guard.ts).
 *
 * Each rejection is checked twice: that the write was refused, and that the row is exactly as
 * it was afterwards. The second half is the one that matters, because a trigger that raised
 * after changing something would still satisfy the first.
 */
const databaseUrl = testDatabaseUrl();

describe.skipIf(databaseUrl === undefined)("schema rules the database enforces", () => {
  let prisma: PrismaClient;
  /** Unique per run, so a repeated run never collides on a cause key. */
  const run = `test-${Date.now().toString()}-${Math.random().toString(36).slice(2)}`;

  beforeAll(async () => {
    prisma = createPrismaClient({ connectionString: databaseUrl ?? "" });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const createAccount = async (type: AccountType) => prisma.account.create({ data: { type } });

  /** A balanced two-entry DEPOSIT, the smallest transaction the ledger allows. */
  const createTransaction = async (accountId: string, suffix: string) =>
    prisma.ledgerTransaction.create({
      data: {
        type: EntryType.DEPOSIT,
        causeKey: `${run}-${suffix}`,
        entries: {
          create: [
            { accountId, currency: "USD", amount: "10000" },
            { accountId, currency: "USD", amount: "-10000" },
          ],
        },
      },
      include: { entries: true },
    });

  describe("append-only ledger (ledger.md section 4)", () => {
    it("refuses to update a ledger entry, and leaves it untouched", async () => {
      const account = await createAccount(AccountType.USER);
      const { entries } = await createTransaction(account.id, "entry-update");
      const entry = entries[0];
      expect(entry).toBeDefined();
      const id = entry?.id ?? "";

      await expect(
        prisma.ledgerEntry.update({ where: { id }, data: { amount: "1" } }),
      ).rejects.toThrow(/append-only/u);

      const after = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id } });
      expect(after.amount.toString()).toBe(entry?.amount.toString());
    });

    it("refuses to delete a ledger entry, and the entry survives", async () => {
      const account = await createAccount(AccountType.USER);
      const { entries } = await createTransaction(account.id, "entry-delete");
      const id = entries[0]?.id ?? "";

      await expect(prisma.ledgerEntry.delete({ where: { id } })).rejects.toThrow(/append-only/u);

      expect(await prisma.ledgerEntry.count({ where: { id } })).toBe(1);
    });

    it("refuses to update a ledger transaction, and leaves it untouched", async () => {
      const account = await createAccount(AccountType.USER);
      const transaction = await createTransaction(account.id, "tx-update");

      await expect(
        prisma.ledgerTransaction.update({
          where: { id: transaction.id },
          data: { causeKey: `${run}-renamed` },
        }),
      ).rejects.toThrow(/append-only/u);

      const after = await prisma.ledgerTransaction.findUniqueOrThrow({
        where: { id: transaction.id },
      });
      expect(after.causeKey).toBe(transaction.causeKey);
    });

    it("refuses to delete a ledger transaction, and the transaction survives", async () => {
      const account = await createAccount(AccountType.USER);
      const transaction = await createTransaction(account.id, "tx-delete");

      await expect(
        prisma.ledgerTransaction.delete({ where: { id: transaction.id } }),
      ).rejects.toThrow(/append-only/u);

      expect(await prisma.ledgerTransaction.count({ where: { id: transaction.id } })).toBe(1);
    });
  });

  describe("one treasury (accounts.md section 6)", () => {
    it("allows only one treasury account", async () => {
      const existing = await prisma.account.findFirst({ where: { type: AccountType.TREASURY } });
      if (existing === null) {
        await createAccount(AccountType.TREASURY);
      }

      await expect(createAccount(AccountType.TREASURY)).rejects.toThrow(/exactly one TREASURY/u);

      expect(await prisma.account.count({ where: { type: AccountType.TREASURY } })).toBe(1);
    });

    it("refuses to turn a second account into the treasury", async () => {
      const account = await createAccount(AccountType.USER);

      await expect(
        prisma.account.update({
          where: { id: account.id },
          data: { type: AccountType.TREASURY },
        }),
      ).rejects.toThrow(/exactly one TREASURY/u);
    });

    it("holds under two concurrent inserts", async () => {
      // The trigger reads then writes, and those are not one atomic step. Under READ
      // COMMITTED, B's EXISTS query cannot see A's uncommitted row, so without the advisory
      // lock both transactions find no treasury and both commit. With it, B waits for A to
      // commit, then sees A's row and raises.
      //
      // The timing is what makes this deterministic rather than a hopeful race: A inserts
      // and holds its transaction open, B starts while A is still uncommitted. It also has
      // to start from no treasury at all, or the EXISTS check alone rejects both and the
      // test passes whether or not the lock is there.
      await prisma.account.deleteMany({ where: { type: AccountType.TREASURY } });
      expect(await prisma.account.count({ where: { type: AccountType.TREASURY } })).toBe(0);

      const sleep = async (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const HOLD_OPEN_MS = 300;
      const START_LATE_MS = 50;

      const [clientA, clientB] = [
        createPrismaClient({ connectionString: databaseUrl ?? "" }),
        createPrismaClient({ connectionString: databaseUrl ?? "" }),
      ];

      try {
        await Promise.all([clientA.$connect(), clientB.$connect()]);

        const results = await Promise.allSettled([
          // A: insert, stay open long enough for B to arrive, then commit.
          clientA.$transaction(async (tx) => {
            await tx.account.create({ data: { type: AccountType.TREASURY } });
            await sleep(HOLD_OPEN_MS);
          }),
          // B: arrive while A is still uncommitted, then insert.
          clientB.$transaction(async (tx) => {
            await sleep(START_LATE_MS);
            await tx.account.create({ data: { type: AccountType.TREASURY } });
          }),
        ]);

        const fulfilled = results.filter((result) => result.status === "fulfilled");
        const rejected = results.filter((result) => result.status === "rejected");

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(String(rejected[0]?.reason)).toMatch(/exactly one TREASURY/u);

        expect(await prisma.account.count({ where: { type: AccountType.TREASURY } })).toBe(1);
      } finally {
        await Promise.all([clientA.$disconnect(), clientB.$disconnect()]);
      }
    });
  });

  describe("what an entry may hold (ledger.md sections 2 and 7)", () => {
    it("refuses a zero amount", async () => {
      const account = await createAccount(AccountType.USER);

      await expect(
        prisma.ledgerTransaction.create({
          data: {
            type: EntryType.DEPOSIT,
            causeKey: `${run}-zero`,
            entries: {
              create: [
                { accountId: account.id, currency: "USD", amount: "0" },
                { accountId: account.id, currency: "USD", amount: "0" },
              ],
            },
          },
        }),
      ).rejects.toThrow(/LedgerEntry_amount_not_zero/u);

      expect(await prisma.ledgerTransaction.count({ where: { causeKey: `${run}-zero` } })).toBe(0);
    });

    it("refuses a currency that is not a three or four letter uppercase code", async () => {
      const account = await createAccount(AccountType.USER);

      await expect(
        prisma.ledgerTransaction.create({
          data: {
            type: EntryType.DEPOSIT,
            causeKey: `${run}-currency`,
            entries: {
              create: [
                { accountId: account.id, currency: "usd", amount: "1" },
                { accountId: account.id, currency: "usd", amount: "-1" },
              ],
            },
          },
        }),
      ).rejects.toThrow(/LedgerEntry_currency_format/u);

      expect(await prisma.ledgerTransaction.count({ where: { causeKey: `${run}-currency` } })).toBe(
        0,
      );
    });

    it("refuses a malformed currency on a hold", async () => {
      const account = await createAccount(AccountType.USER);
      const instrument = await prisma.instrument.create({
        data: {
          symbol: `BTC-${run.slice(-3).toUpperCase()}`,
          baseCurrency: "BTC",
          quoteCurrency: "USD",
        },
      });
      const order = await prisma.order.create({
        data: {
          accountId: account.id,
          instrumentId: instrument.id,
          side: "BUY",
          type: "LIMIT",
          price: "100",
          quantity: "1",
        },
      });

      await expect(
        prisma.hold.create({
          data: { accountId: account.id, orderId: order.id, currency: "DOLLARS", amount: "100" },
        }),
      ).rejects.toThrow(/Hold_currency_format/u);

      expect(await prisma.hold.count({ where: { orderId: order.id } })).toBe(0);
    });

    it("stores an amount at full scale without rounding it", async () => {
      const account = await createAccount(AccountType.USER);
      // 18 decimal places: the most the ledger's NUMERIC(38, 18) can hold, and more than a
      // binary float could carry without loss.
      const amount = "0.123456789012345678";
      const { entries } = await prisma.ledgerTransaction.create({
        data: {
          type: EntryType.DEPOSIT,
          causeKey: `${run}-scale`,
          entries: {
            create: [
              { accountId: account.id, currency: "USD", amount },
              { accountId: account.id, currency: "USD", amount: `-${amount}` },
            ],
          },
        },
        include: { entries: true },
      });

      const stored = entries.map((entry) => entry.amount.toString());
      expect(stored).toContain(amount);
      expect(stored).toContain(`-${amount}`);
    });
  });

  describe("transactions (ledger.md section 3)", () => {
    it("treats a repeated cause key as a conflict rather than a second transaction", async () => {
      const account = await createAccount(AccountType.USER);
      const causeKey = `${run}-duplicate`;
      const write = async () =>
        prisma.ledgerTransaction.create({
          data: {
            type: EntryType.DEPOSIT,
            causeKey,
            entries: {
              create: [
                { accountId: account.id, currency: "USD", amount: "1" },
                { accountId: account.id, currency: "USD", amount: "-1" },
              ],
            },
          },
        });

      await write();
      await expect(write()).rejects.toThrow();

      expect(await prisma.ledgerTransaction.count({ where: { causeKey } })).toBe(1);
    });

    it("keeps every entry of a rejected transaction out of the ledger", async () => {
      const account = await createAccount(AccountType.USER);
      const causeKey = `${run}-atomic`;
      const before = await prisma.ledgerEntry.count();

      // The second entry names an account that does not exist, so the write fails partway.
      await expect(
        prisma.ledgerTransaction.create({
          data: {
            type: EntryType.DEPOSIT,
            causeKey,
            entries: {
              create: [
                { accountId: account.id, currency: "USD", amount: "5" },
                {
                  accountId: "00000000-0000-0000-0000-000000000000",
                  currency: "USD",
                  amount: "-5",
                },
              ],
            },
          },
        }),
      ).rejects.toThrow();

      expect(await prisma.ledgerEntry.count()).toBe(before);
      expect(await prisma.ledgerTransaction.count({ where: { causeKey } })).toBe(0);
    });
  });

  describe("deletion fails loudly (accounts.md section 7, question 1)", () => {
    it("refuses to delete a user that still has an account", async () => {
      const user = await prisma.user.create({ data: { authSubject: `${run}-subject` } });
      await prisma.account.create({ data: { type: AccountType.USER, userId: user.id } });

      await expect(prisma.user.delete({ where: { id: user.id } })).rejects.toThrow();

      expect(await prisma.user.count({ where: { id: user.id } })).toBe(1);
    });
  });
});
