import type { INestApplication } from "@nestjs/common";
import { ExactDecimal, Prisma } from "@orderflow/db";
import { createTestDatabase, fund, newAccount } from "@orderflow/db/testing";
import type { TestDatabase } from "@orderflow/db/testing";
import type { App } from "supertest/types.js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asPrismaClient, createTestApp, stubPrisma } from "../testing/test-app.js";

import { MONEY_PATTERN, moneySchema, serializeMoney } from "./money.js";

const LARGEST = "99999999999999999999.999999999999999999";
const SMALLEST = "0.000000000000000001";

describe("serializeMoney", () => {
  it("shows why toString is not enough: decimal.js renders this with an exponent", () => {
    expect(JSON.stringify(new Prisma.Decimal("0.00000001"))).toBe('"1e-8"');
  });

  it.each([
    ["ExactDecimal", (value: string) => new ExactDecimal(value)],
    ["Prisma.Decimal", (value: string) => new Prisma.Decimal(value)],
  ])("serializes a %s exactly", (_name, decimal) => {
    expect(serializeMoney(decimal("0.00000001"))).toBe("0.00000001");
    expect(serializeMoney(decimal(LARGEST))).toBe(LARGEST);
    expect(serializeMoney(decimal(`-${LARGEST}`))).toBe(`-${LARGEST}`);
    expect(serializeMoney(decimal(SMALLEST))).toBe(SMALLEST);
    expect(serializeMoney(decimal("0"))).toBe("0");
  });

  it("round-trips the largest NUMERIC(38, 18) back to an equal value", () => {
    const text = serializeMoney(new ExactDecimal(LARGEST));

    expect(new ExactDecimal(text as string).equals(new ExactDecimal(LARGEST))).toBe(true);
  });

  it("does not apply a display scale", () => {
    expect(serializeMoney({ usd: new ExactDecimal("1.123456789") })).toEqual({
      usd: "1.123456789",
    });
  });

  it("reaches nested objects and arrays, and leaves everything else alone", () => {
    const when = new Date();

    expect(
      serializeMoney({ a: [{ b: new ExactDecimal("1e-8") }], when, n: 1, s: "x", none: null }),
    ).toEqual({ a: [{ b: "0.00000001" }], when, n: 1, s: "x", none: null });
  });

  it("reaches a Decimal inside a class instance", () => {
    class Row {
      readonly amount = new ExactDecimal("1e-8");
    }

    expect(serializeMoney(new Row())).toEqual({ amount: "0.00000001" });
  });
});

describe("moneySchema", () => {
  it.each([LARGEST, `-${LARGEST}`, SMALLEST, "0", "1.5"])("accepts %s", (value) => {
    expect(moneySchema.safeParse(value).success).toBe(true);
  });

  it.each(["1e-8", "", "1.", ".5", "1,5", "NaN", "Infinity", "1.0000000000000000001"])(
    "rejects %j",
    (value) => {
      expect(moneySchema.safeParse(value).success).toBe(false);
    },
  );

  it("publishes a pattern with no room for an exponent", () => {
    expect(MONEY_PATTERN).not.toContain("e");
  });
});

describe("money in a response", () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp(asPrismaClient(stubPrisma()));
  });

  afterAll(async () => {
    await app.close();
  });

  it("goes out as a string from every handler, through the interceptor", async () => {
    const response = await request(app.getHttpServer()).get("/probe/money");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      exact: "0.00000001",
      prisma: "0.00000001",
      nested: { list: ["1.5", { deep: "-2" }] },
      when: "2026-01-02T03:04:05.000Z",
      text: "untouched",
      nothing: null,
    });
  });
});

const database: TestDatabase | undefined = await createTestDatabase();

// At file level, because a throwing afterAll stops the rest of its own suite's hooks: from inside
// the describe, a failed set-up would skip this and leave the database on the server.
afterAll(async () => {
  await database?.drop();
});

describe.skipIf(database === undefined)("money from the ledger to the response", () => {
  let app: INestApplication<App>;

  const client = () => {
    if (database === undefined) {
      throw new Error("skipped when there is no database");
    }
    return database.client;
  };

  beforeAll(async () => {
    app = await createTestApp(client());
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(["0.00000001", SMALLEST, LARGEST])("keeps %s exact", async (amount) => {
    const accountId = await newAccount(client());
    await fund(client(), accountId, "USD", amount);

    const response = await request(app.getHttpServer()).get(`/probe/balance/${accountId}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ balance: amount });
  });

  it("maps a real LedgerError for an account that does not exist", async () => {
    const response = await request(app.getHttpServer()).get("/probe/balance/no-such-account");

    expect(response.status).toBe(404);
    expect(response.text).not.toContain("no-such-account");
  });
});
