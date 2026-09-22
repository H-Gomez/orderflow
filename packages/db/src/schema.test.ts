import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "./client.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import { AccountType, EntryType } from "./generated/prisma/enums.js";

/**
 * These tests need the compose database (`pnpm db:up && pnpm db:migrate`). Without
 * DATABASE_URL they skip, so `pnpm test` stays green on a machine with no Docker; with it
 * they run for real. A skipped run proves nothing, so the PR says which of the two it was.
 *
 * Each rejection is checked twice: that the write is refused, and that the row is exactly as
 * it was afterwards. The second half is the one that matters, because a trigger that raised
 * after changing something would still satisfy the first.
 */
const databaseUrl = process.env["DATABASE_URL"];

describe.skipIf(databaseUrl === undefined || databaseUrl === "")(
  "schema rules the database enforces",
  () => {
    let prisma: PrismaClient;
    /** Unique per run, so repeated runs against one database never collide. */
    const run = `test-${Date.now().toString()}-${Math.random().toString(36).slice(2)}`;

    beforeAll(async () => {
      prisma = createPrismaClient();
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
        prisma.account.update({ where: { id: account.id }, data: { type: AccountType.TREASURY } }),
      ).rejects.toThrow(/exactly one TREASURY/u);
    });

    it("stores an amount at full scale without rounding it", async () => {
      const account = await createAccount(AccountType.USER);
      // 18 decimal places: the most the ledger's NUMERIC(38, 18) can hold, and more than a
      // double could carry without loss.
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
  },
);
