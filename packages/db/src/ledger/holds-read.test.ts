import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient } from "../generated/prisma/client.js";
import { HoldState } from "../generated/prisma/enums.js";
import { heldOf as heldOfFromPackage } from "../index.js";
import { testDatabaseUrl } from "../testing/database-guard.js";

import { balanceOf, buyingPowerOf } from "./balances.js";
import { LedgerError, LedgerErrorCode } from "./errors.js";
import { connect, fund, newAccount, newInstrument, newOrder, treasuryId } from "./fixtures.js";
import { heldOf } from "./holds-read.js";
import { placeHold } from "./holds.js";
import { heldOf as heldOfFromLedger } from "./index.js";
import { ExactDecimal } from "./money.js";

/**
 * heldOf against a real database (story #70): the sum of an account's ACTIVE holds in a currency,
 * computed by Postgres. Amounts are compared as strings, so nothing here passes through a
 * JavaScript number.
 */
const databaseUrl = testDatabaseUrl();

const UNKNOWN_ACCOUNT = "00000000-0000-0000-0000-000000000000";

describe.skipIf(databaseUrl === undefined)("heldOf", () => {
  let db: PrismaClient;
  let instrument: string;

  beforeAll(async () => {
    db = await connect(databaseUrl ?? "");
    instrument = await newInstrument(db);
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  const hold = async (accountId: string, currency: string, amount: string): Promise<void> => {
    const orderId = await newOrder(db, accountId, instrument);
    await placeHold(db, { accountId, orderId, currency, amount });
  };

  /** Written directly: releasing and converting holds is M2's, not this package's yet. */
  const settledHold = async (
    accountId: string,
    amount: string,
    state: HoldState,
  ): Promise<void> => {
    await db.hold.create({
      data: {
        accountId,
        orderId: await newOrder(db, accountId, instrument),
        currency: "USD",
        amount,
        state,
      },
    });
  };

  describe("with two ACTIVE holds and one RELEASED", () => {
    let account: string;

    beforeAll(async () => {
      account = await newAccount(db);
      await fund(db, account, "USD", "100");
      await hold(account, "USD", "10.5");
      await hold(account, "USD", "4.25");
      await settledHold(account, "30", HoldState.RELEASED);
    });

    it("equals the sum of the two active holds", async () => {
      expect((await heldOf(db, account, "USD")).toFixed()).toBe("14.75");
    });

    it("equals balanceOf minus buyingPowerOf", async () => {
      const balance = await balanceOf(db, account, "USD");
      const buyingPower = await buyingPowerOf(db, account, "USD");

      expect((await heldOf(db, account, "USD")).toFixed()).toBe(
        balance.minus(buyingPower).toFixed(),
      );
    });
  });

  it("counts only ACTIVE holds, so a CONVERTED hold is left out too", async () => {
    const account = await newAccount(db);
    await fund(db, account, "USD", "100");
    await hold(account, "USD", "7");
    await settledHold(account, "30", HoldState.CONVERTED);

    expect((await heldOf(db, account, "USD")).toFixed()).toBe("7");
  });

  it("counts only the named account and currency", async () => {
    const [account, stranger] = [await newAccount(db), await newAccount(db)];
    await fund(db, account, "USD", "100");
    await fund(db, account, "BTC", "100");
    await fund(db, stranger, "USD", "100");
    await hold(account, "USD", "1");
    await hold(account, "BTC", "2");
    await hold(stranger, "USD", "4");

    expect((await heldOf(db, account, "USD")).toFixed()).toBe("1");
    expect((await heldOf(db, account, "BTC")).toFixed()).toBe("2");
    expect((await heldOf(db, stranger, "USD")).toFixed()).toBe("4");
  });

  it("is zero with no holds", async () => {
    const account = await newAccount(db);
    expect((await heldOf(db, account, "USD")).toFixed()).toBe("0");

    await fund(db, account, "USD", "100");
    expect((await heldOf(db, account, "USD")).toFixed()).toBe("0");
  });

  it("returns 0 for the treasury", async () => {
    expect((await heldOf(db, await treasuryId(db), "USD")).toFixed()).toBe("0");
  });

  it("rejects an unknown account with ACCOUNT_NOT_FOUND", async () => {
    const attempt = heldOf(db, UNKNOWN_ACCOUNT, "USD");

    await expect(attempt).rejects.toBeInstanceOf(LedgerError);
    await expect(attempt).rejects.toMatchObject({ code: LedgerErrorCode.ACCOUNT_NOT_FOUND });
  });

  it("rejects a bad currency with INVALID_CURRENCY", async () => {
    const account = await newAccount(db);
    const attempt = heldOf(db, account, "usd");

    await expect(attempt).rejects.toBeInstanceOf(LedgerError);
    await expect(attempt).rejects.toMatchObject({ code: LedgerErrorCode.INVALID_CURRENCY });
  });

  it("checks the currency before the account, as balanceOf does", async () => {
    await expect(heldOf(db, UNKNOWN_ACCOUNT, "usd")).rejects.toMatchObject({
      code: LedgerErrorCode.INVALID_CURRENCY,
    });
    await expect(balanceOf(db, UNKNOWN_ACCOUNT, "usd")).rejects.toMatchObject({
      code: LedgerErrorCode.INVALID_CURRENCY,
    });
  });

  describe("18-decimal amounts", () => {
    it("keeps every digit of a sum at the full width of NUMERIC(38, 18)", async () => {
      const account = await newAccount(db);
      await fund(db, account, "USD", "20000000000000000000.000000000000000003");
      await hold(account, "USD", "12345678901234567890.123456789012345678");
      await hold(account, "USD", "0.000000000000000001");

      const held = await heldOf(db, account, "USD");
      const balance = await balanceOf(db, account, "USD");
      const buyingPower = await buyingPowerOf(db, account, "USD");

      expect(held.toFixed()).toBe("12345678901234567890.123456789012345679");
      expect(held.toFixed()).toBe(balance.minus(buyingPower).toFixed());
    });

    it("carries across the 18th decimal place", async () => {
      const account = await newAccount(db);
      await fund(db, account, "USD", "2");
      await hold(account, "USD", "0.999999999999999999");
      await hold(account, "USD", "0.000000000000000001");

      expect((await heldOf(db, account, "USD")).toFixed()).toBe("1");
    });

    it("returns a value whose own arithmetic stays exact, as fromPrisma's does", async () => {
      const account = await newAccount(db);
      await fund(db, account, "USD", "20000000000000000000");
      await hold(account, "USD", "12345678901234567890.123456789012345678");

      const held = await heldOf(db, account, "USD");

      // Prisma's own Decimal has 20 significant digits and would round this sum.
      expect(held.plus(new ExactDecimal("0.000000000000000002")).toFixed()).toBe(
        "12345678901234567890.12345678901234568",
      );
    });
  });

  it("reads holds only through aggregate, so nothing is summed in JavaScript", async () => {
    const account = await newAccount(db);
    await fund(db, account, "USD", "100");
    await hold(account, "USD", "1");

    const holdMethods: string[] = [];
    const watched = new Proxy(db, {
      get: (client, property) =>
        property === "hold"
          ? new Proxy(client.hold, {
              get: (delegate, method) => {
                holdMethods.push(String(method));
                return Reflect.get(delegate, method, delegate) as unknown;
              },
            })
          : (Reflect.get(client, property, client) as unknown),
    });

    expect((await heldOf(watched, account, "USD")).toFixed()).toBe("1");
    expect(holdMethods).toEqual(["aggregate"]);
  });

  it("runs inside a caller's transaction, as every ledger read does", async () => {
    const account = await newAccount(db);
    await fund(db, account, "USD", "100");
    await hold(account, "USD", "3");

    const held = await db.$transaction(async (tx) => heldOf(tx, account, "USD"));

    expect(held.toFixed()).toBe("3");
  });
});

describe("heldOf exports", () => {
  it("is exported from src/ledger/index.ts and src/index.ts", () => {
    expect(heldOfFromLedger).toBe(heldOf);
    expect(heldOfFromPackage).toBe(heldOf);
  });
});
