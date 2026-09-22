import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "./client.js";
import { AccountType, EntryType } from "./generated/prisma/enums.js";
import type { PrismaClient } from "./generated/prisma/client.js";

/**
 * These tests need the compose database (`pnpm db:up && pnpm db:migrate`). Without
 * DATABASE_URL they skip, so `pnpm test` stays green on a machine with no Docker; with it
 * they run for real. A skipped run proves nothing, so the PR says which of the two it was.
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

    const createTransaction = async (accountId: string) =>
      prisma.ledgerTransaction.create({
        data: {
          type: EntryType.DEPOSIT,
          causeKey: `${run}-${Math.random().toString(36).slice(2)}`,
          entries: {
            create: [
              { accountId, currency: "USD", amount: "10000" },
              { accountId, currency: "USD", amount: "-10000" },
            ],
          },
        },
        include: { entries: true },
      });

    it("refuses to update a ledger entry", async () => {
      const account = await createAccount(AccountType.USER);
      const transaction = await createTransaction(account.id);
      const entry = transaction.entries[0];
      expect(entry).toBeDefined();

      await expect(
        prisma.ledgerEntry.update({
          where: { id: entry?.id ?? "" },
          data: { amount: "1" },
        }),
      ).rejects.toThrow(/append-only/u);
    });

    it("refuses to delete a ledger entry", async () => {
      const account = await createAccount(AccountType.USER);
      const transaction = await createTransaction(account.id);
      const entry = transaction.entries[0];

      await expect(prisma.ledgerEntry.delete({ where: { id: entry?.id ?? "" } })).rejects.toThrow(
        /append-only/u,
      );
    });

    it("refuses to update a ledger transaction", async () => {
      const account = await createAccount(AccountType.USER);
      const transaction = await createTransaction(account.id);

      await expect(
        prisma.ledgerTransaction.update({
          where: { id: transaction.id },
          data: { causeKey: `${run}-renamed` },
        }),
      ).rejects.toThrow(/append-only/u);
    });

    it("refuses to delete a ledger transaction", async () => {
      const account = await createAccount(AccountType.USER);
      const transaction = await createTransaction(account.id);

      await expect(
        prisma.ledgerTransaction.delete({ where: { id: transaction.id } }),
      ).rejects.toThrow(/append-only/u);
    });

    it("allows only one treasury account", async () => {
      const existing = await prisma.account.findFirst({
        where: { type: AccountType.TREASURY },
      });
      if (existing === null) {
        await createAccount(AccountType.TREASURY);
      }

      await expect(createAccount(AccountType.TREASURY)).rejects.toThrow(/exactly one TREASURY/u);
    });

    it("stores an amount at full scale without rounding it", async () => {
      const account = await createAccount(AccountType.USER);
      const amount = "0.123456789012345678";
      const transaction = await prisma.ledgerTransaction.create({
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

      const stored = transaction.entries.map((entry) => entry.amount.toString());
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
  },
);
