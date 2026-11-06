import type { INestApplication } from "@nestjs/common";
import {
  AccountType,
  EntryType,
  OrderSide,
  OrderType,
  Prisma,
  postTransaction,
} from "@orderflow/db";
import type { PrismaClient } from "@orderflow/db";
import { createTestDatabase, fund, unique } from "@orderflow/db/testing";
import type { TestDatabase } from "@orderflow/db/testing";
import type { Response } from "supertest";
import type { App } from "supertest/types.js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Principal } from "../auth/principal.js";
import { errorResponseSchema } from "../errors/error-response.js";
import { createTestApp, errorBody, testConfig } from "../testing/test-app.js";
import { TestOidc } from "../testing/test-oidc.js";

import type { FillRow, TradeItem } from "./trades.controller.js";
import {
  TradesController,
  afterCursor,
  toTradeRows,
  tradesPageSchema,
  tradesQuerySchema,
} from "./trades.controller.js";

const database: TestDatabase | undefined = await createTestDatabase();

// At file level, so a failed set-up inside the describe still drops the database.
afterAll(async () => {
  await database?.drop();
});

interface Page {
  readonly items: readonly {
    readonly fillId: string;
    readonly side: string;
    readonly instrument: string;
  }[];
  readonly nextCursor: string | null;
}

const pageOf = (response: Response): Page => response.body as Page;
const rowsOf = (response: Response): string[] =>
  pageOf(response).items.map((item) => `${item.fillId}:${item.side}`);

const cursorOf = (key: { filledAt: string; fillId: string; side: OrderSide }): string =>
  Buffer.from(JSON.stringify(key)).toString("base64url");

describe("toTradeRows and afterCursor", () => {
  const fill = (buyer: string | undefined, seller: string | undefined): FillRow => ({
    id: "fill",
    price: new Prisma.Decimal("68000.5"),
    quantity: new Prisma.Decimal("0.25"),
    createdAt: new Date("2026-11-05T10:00:00.000Z"),
    instrument: { symbol: "BTC-USD" },
    buyOrder: buyer === undefined ? null : { accountId: buyer },
    sellOrder: seller === undefined ? null : { accountId: seller },
  });
  const sidesOf = (rows: readonly TradeItem[]): string[] => rows.map((row) => row.side);

  it.each([
    ["the buyer", fill("me", "other"), ["BUY"]],
    ["the seller", fill("other", "me"), ["SELL"]],
    ["both sides, BUY first", fill("me", "me"), ["BUY", "SELL"]],
    ["neither side", fill("other", "another"), []],
    ["a fill with no orders", fill(undefined, undefined), []],
  ])("gives the caller's rows when the caller is %s", (_name, row, sides) => {
    expect(sidesOf(toTradeRows(row, "me"))).toEqual(sides);
  });

  it("drops only the cursor fill's BUY row after a BUY cursor, and nothing otherwise", () => {
    const rows = [...toTradeRows(fill("me", "me"), "me")];
    const key = { filledAt: new Date("2026-11-05T10:00:00.000Z"), fillId: "fill" };

    expect(sidesOf(afterCursor(rows, { ...key, side: OrderSide.BUY }))).toEqual(["SELL"]);
    expect(sidesOf(afterCursor(rows, { ...key, fillId: "other", side: OrderSide.BUY }))).toEqual([
      "BUY",
      "SELL",
    ]);
    expect(sidesOf(afterCursor(rows, { ...key, side: OrderSide.SELL }))).toEqual(["BUY", "SELL"]);
    expect(sidesOf(afterCursor(rows, undefined))).toEqual(["BUY", "SELL"]);
  });
});

describe("the read behind GET /trades", () => {
  const key = { filledAt: "2026-11-05T10:00:00.000Z", fillId: "fill" };

  it.each([
    ["no cursor", {}, 3],
    ["a SELL cursor", { cursor: cursorOf({ ...key, side: OrderSide.SELL }) }, 3],
    // The cursor's own fill comes back for its SELL row and may give none, so one more is fetched.
    ["a BUY cursor", { cursor: cursorOf({ ...key, side: OrderSide.BUY }) }, 4],
  ])("asks for the right number of fills with limit=2 and %s", async (_name, query, take) => {
    const findMany = vi.fn<(args: unknown) => Promise<never[]>>().mockResolvedValue([]);
    const controller = new TradesController({ fill: { findMany } } as unknown as PrismaClient);

    await controller.trades(tradesQuerySchema.parse({ limit: "2", ...query }), {
      accountId: "the-caller",
    } as Principal);

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take }));
  });
});

describe.skipIf(database === undefined)("GET /trades", () => {
  let oidc: TestOidc;
  let app: INestApplication<App>;
  const instruments = new Map<string, string>();

  const client = () => {
    if (database === undefined) {
      throw new Error("skipped when there is no database");
    }
    return database.client;
  };

  /** A USER account a token can resolve to. */
  const newCaller = async (): Promise<{ accountId: string; subject: string }> => {
    const subject = unique("subject");
    const user = await client().user.create({
      data: { authSubject: subject, account: { create: { type: AccountType.USER } } },
      select: { account: { select: { id: true } } },
    });
    if (user.account === null) {
      throw new Error("the account was not created");
    }
    return { accountId: user.account.id, subject };
  };

  const instrumentId = (symbol: string): string => {
    const id = instruments.get(symbol);
    if (id === undefined) {
      throw new Error(`no ${symbol} instrument in the fixture`);
    }
    return id;
  };

  const order = async (accountId: string, symbol: string, side: OrderSide): Promise<string> =>
    (
      await client().order.create({
        data: {
          accountId,
          instrumentId: instrumentId(symbol),
          side,
          type: OrderType.LIMIT,
          price: "1",
          quantity: "1",
        },
      })
    ).id;

  /** A fill between a buyer and a seller, either of which may be absent, at an explicit time. */
  const newFill = async (options: {
    readonly buyer?: string;
    readonly seller?: string;
    readonly createdAt: string | Date;
    readonly id?: string;
    readonly symbol?: string;
    readonly price?: string;
    readonly quantity?: string;
  }): Promise<string> => {
    const symbol = options.symbol ?? "BTC-USD";
    return (
      await client().fill.create({
        data: {
          ...(options.id === undefined ? {} : { id: options.id }),
          instrumentId: instrumentId(symbol),
          price: options.price ?? "68000.5",
          quantity: options.quantity ?? "0.25",
          createdAt: options.createdAt,
          buyOrderId:
            options.buyer === undefined ? null : await order(options.buyer, symbol, OrderSide.BUY),
          sellOrderId:
            options.seller === undefined
              ? null
              : await order(options.seller, symbol, OrderSide.SELL),
        },
      })
    ).id;
  };

  const getTrades = async (
    subject: string,
    query: Readonly<Record<string, string>> = {},
  ): Promise<Response> =>
    request(app.getHttpServer())
      .get("/trades")
      .query(query)
      .set("Authorization", `Bearer ${await oidc.sign({ sub: subject })}`);

  /** Every page with limit=1, failing rather than hanging if the cursor stops advancing. */
  const walk = async (subject: string, pages: number): Promise<string[]> => {
    const walked: string[] = [];
    let query: Record<string, string> = { limit: "1" };
    for (let page = 1; ; page += 1) {
      expect(page, "the walk never reached a null nextCursor").toBeLessThanOrEqual(pages);
      const response = await getTrades(subject, query);
      expect(response.status).toBe(200);
      expect(pageOf(response).items).toHaveLength(1);
      walked.push(...rowsOf(response));
      const { nextCursor } = pageOf(response);
      if (nextCursor === null) {
        return walked;
      }
      query = { limit: "1", cursor: nextCursor };
    }
  };

  beforeAll(async () => {
    oidc = await TestOidc.start();
    app = await createTestApp(client(), testConfig({ oidc: oidc.config() }));
    // Real BASE-QUOTE symbols: this file's database is its own, so they are free.
    for (const [symbol, baseCurrency, quoteCurrency] of [
      ["BTC-USD", "BTC", "USD"],
      ["ETH-USD", "ETH", "USD"],
    ] as const) {
      const created = await client().instrument.create({
        data: { symbol, baseCurrency, quoteCurrency },
      });
      instruments.set(symbol, created.id);
    }
  });

  afterAll(async () => {
    await app.close();
    await oidc.stop();
  });

  describe("sides", () => {
    it("reads the same fill as BUY for the buyer and as SELL for the seller", async () => {
      const buyer = await newCaller();
      const seller = await newCaller();
      const fillId = await newFill({
        buyer: buyer.accountId,
        seller: seller.accountId,
        createdAt: "2026-11-05T10:00:00.000Z",
      });
      const item = {
        fillId,
        instrument: "BTC-USD",
        price: "68000.5",
        quantity: "0.25",
        filledAt: "2026-11-05T10:00:00.000Z",
      };

      const asBuyer = await getTrades(buyer.subject);
      const asSeller = await getTrades(seller.subject);

      expect(asBuyer.body).toEqual({ items: [{ ...item, side: "BUY" }], nextCursor: null });
      expect(asSeller.body).toEqual({ items: [{ ...item, side: "SELL" }], nextCursor: null });
      expect(tradesPageSchema.safeParse(asBuyer.body).success).toBe(true);
    });
  });

  describe("cross-account", () => {
    it("never shows A a fill between B and C", async () => {
      const [a, b, c] = [await newCaller(), await newCaller(), await newCaller()];
      const own = await newFill({
        buyer: a.accountId,
        seller: b.accountId,
        createdAt: "2026-11-05T09:00:00.000Z",
      });
      const theirs = await newFill({
        buyer: b.accountId,
        seller: c.accountId,
        createdAt: "2026-11-05T10:00:00.000Z",
      });

      const response = await getTrades(a.subject);

      expect(response.status).toBe(200);
      expect(rowsOf(response)).toEqual([`${own}:BUY`]);
      expect(JSON.stringify(response.body)).not.toContain(theirs);
    });

    it("never shows anyone a fill whose order references are both null", async () => {
      const [a, b, c] = [await newCaller(), await newCaller(), await newCaller()];
      await newFill({
        buyer: a.accountId,
        seller: b.accountId,
        createdAt: "2026-11-05T09:00:00.000Z",
      });
      await newFill({
        buyer: b.accountId,
        seller: c.accountId,
        createdAt: "2026-11-05T09:30:00.000Z",
      });
      const orphan = await newFill({ createdAt: "2026-11-05T10:00:00.000Z" });

      for (const caller of [a, b, c]) {
        const response = await getTrades(caller.subject);
        expect(response.status).toBe(200);
        expect(JSON.stringify(response.body)).not.toContain(orphan);
      }
    });

    it("answers 400 to a request naming another account", async () => {
      const a = await newCaller();
      const b = await newCaller();
      await newFill({ buyer: b.accountId, createdAt: "2026-11-05T10:00:00.000Z" });

      const response = await getTrades(a.subject, { accountId: b.accountId });

      expect(response.status).toBe(400);
      // The exact body, so it can hold none of B's data.
      const { correlationId, ...rest } = errorBody(response);
      expect(correlationId).toEqual(expect.any(String));
      expect(rest).toEqual({
        code: "VALIDATION_FAILED",
        message: "Request validation failed.",
        fields: [{ path: "query", message: 'Unrecognized key: "accountId"' }],
      });
    });

    it("scopes another account's cursor to the caller's rows", async () => {
      const a = await newCaller();
      const b = await newCaller();
      const other = await newCaller();
      // Newer than B's newest, so a page after B's cursor must leave it out.
      const aNewer = await newFill({
        buyer: a.accountId,
        seller: other.accountId,
        createdAt: "2026-11-05T13:00:00.000Z",
      });
      const bNewest = await newFill({
        buyer: b.accountId,
        seller: other.accountId,
        createdAt: "2026-11-05T12:00:00.000Z",
      });
      const bOlder = await newFill({
        buyer: other.accountId,
        seller: b.accountId,
        createdAt: "2026-11-05T11:00:00.000Z",
      });
      const aOlder = await newFill({
        buyer: other.accountId,
        seller: a.accountId,
        createdAt: "2026-11-05T10:00:00.000Z",
      });

      const bFirstPage = await getTrades(b.subject, { limit: "1" });
      expect(rowsOf(bFirstPage)).toEqual([`${bNewest}:BUY`]);
      const cursor = pageOf(bFirstPage).nextCursor;
      if (cursor === null) {
        throw new Error("B has more pages");
      }

      const response = await getTrades(a.subject, { cursor });

      expect(response.status).toBe(200);
      expect(rowsOf(response)).toEqual([`${aOlder}:SELL`]);
      for (const id of [aNewer, bNewest, bOlder]) {
        expect(JSON.stringify(response.body)).not.toContain(id);
      }
    });
  });

  describe("time filter on the fill time", () => {
    it("filters on Fill.createdAt, never on the TRADE entries' time", async () => {
      const buyer = await newCaller();
      const seller = await newCaller();
      await fund(client(), seller.accountId, "BTC", "1");
      await fund(client(), buyer.accountId, "USD", "100");
      const outside = await newFill({
        buyer: buyer.accountId,
        seller: seller.accountId,
        createdAt: "2020-01-01T00:00:00.000Z",
      });
      const { entries } = await postTransaction(client(), {
        type: EntryType.TRADE,
        causeKey: outside,
        entries: [
          { accountId: buyer.accountId, currency: "USD", amount: "-100" },
          { accountId: buyer.accountId, currency: "BTC", amount: "1" },
          { accountId: seller.accountId, currency: "USD", amount: "100" },
          { accountId: seller.accountId, currency: "BTC", amount: "-1" },
        ],
      });
      const entriesAt = entries[0]?.createdAt;
      if (entriesAt === undefined) {
        throw new Error("the TRADE wrote no entries");
      }
      const inside = await newFill({
        buyer: buyer.accountId,
        seller: seller.accountId,
        createdAt: entriesAt,
      });

      // The outside fill's TRADE entries were written at entriesAt, which is inside the range.
      const response = await getTrades(buyer.subject, { from: entriesAt.toISOString() });

      expect(response.status).toBe(200);
      expect(rowsOf(response)).toEqual([`${inside}:BUY`]);
    });
  });

  describe("instrument filter", () => {
    it("returns only that instrument", async () => {
      const caller = await newCaller();
      await newFill({ buyer: caller.accountId, createdAt: "2026-11-05T11:00:00.000Z" });
      const eth = await newFill({
        buyer: caller.accountId,
        symbol: "ETH-USD",
        createdAt: "2026-11-05T10:00:00.000Z",
      });

      const response = await getTrades(caller.subject, { instrument: "ETH-USD" });

      expect(response.status).toBe(200);
      expect(rowsOf(response)).toEqual([`${eth}:BUY`]);
      expect(pageOf(response).items[0]?.instrument).toBe("ETH-USD");
    });

    it.each([
      ["a well-formed symbol with no instrument", "SOL-EUR"],
      ["a malformed symbol", "btc-usd"],
    ])("answers 400 at query.instrument to %s", async (_name, instrument) => {
      const { subject } = await newCaller();

      const response = await getTrades(subject, { instrument });

      expect(response.status).toBe(400);
      expect(errorBody(response).code).toBe("VALIDATION_FAILED");
      expect(errorBody(response).fields?.[0]?.path).toBe("query.instrument");
    });
  });

  describe("self-trade", () => {
    it("gives two rows, BUY then SELL, on consecutive pages with limit=1", async () => {
      const { accountId, subject } = await newCaller();
      const fillId = await newFill({
        buyer: accountId,
        seller: accountId,
        createdAt: "2026-11-05T10:00:00.000Z",
      });

      const whole = await getTrades(subject);
      const walked = await walk(subject, 3);

      expect(rowsOf(whole)).toEqual([`${fillId}:BUY`, `${fillId}:SELL`]);
      expect(walked).toEqual([`${fillId}:BUY`, `${fillId}:SELL`]);
    });
  });

  describe("paging", () => {
    it("walks every row exactly once, in order, after a fill the caller only bought", async () => {
      const { accountId, subject } = await newCaller();
      const other = await newCaller();
      // A shared prefix and one differing last character, so every collation orders the tie alike.
      const tie = unique("tie");
      const boughtNewest = await newFill({
        buyer: accountId,
        seller: other.accountId,
        createdAt: "2026-11-05T12:00:00.000Z",
      });
      const tiedHigh = await newFill({
        id: `${tie}-2`,
        buyer: other.accountId,
        seller: accountId,
        createdAt: "2026-11-05T11:00:00.000Z",
      });
      const tiedLow = await newFill({
        id: `${tie}-1`,
        buyer: accountId,
        seller: other.accountId,
        createdAt: "2026-11-05T11:00:00.000Z",
      });
      const self = await newFill({
        buyer: accountId,
        seller: accountId,
        createdAt: "2026-11-05T10:00:00.000Z",
      });
      const soldOldest = await newFill({
        buyer: other.accountId,
        seller: accountId,
        createdAt: "2026-11-05T09:00:00.000Z",
      });

      // After a BUY-only fill, the next page refetches that fill and gets no row from it.
      expect(await walk(subject, 8)).toEqual([
        `${boughtNewest}:BUY`,
        `${tiedHigh}:SELL`,
        `${tiedLow}:BUY`,
        `${self}:BUY`,
        `${self}:SELL`,
        `${soldOldest}:SELL`,
      ]);
    });

    it.each(["0", "201"])("answers 400 at query.limit to limit=%s", async (limit) => {
      const { subject } = await newCaller();

      const response = await getTrades(subject, { limit });

      expect(response.status).toBe(400);
      expect(errorBody(response).fields?.[0]?.path).toBe("query.limit");
    });

    it("accepts limit=200", async () => {
      const { subject } = await newCaller();

      expect((await getTrades(subject, { limit: "200" })).status).toBe(200);
    });

    it("answers 400 at query.cursor to a malformed cursor", async () => {
      const { subject } = await newCaller();

      const response = await getTrades(subject, { cursor: "not a cursor!" });

      expect(response.status).toBe(400);
      expect(errorBody(response).code).toBe("VALIDATION_FAILED");
      expect(errorBody(response).fields?.[0]?.path).toBe("query.cursor");
    });
  });

  describe("empty, strings and auth", () => {
    it("answers 200 with an empty page for an account with no fills", async () => {
      const { subject } = await newCaller();

      const response = await getTrades(subject);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ items: [], nextCursor: null });
    });

    it("returns price and quantity as stored, and every value as a JSON string", async () => {
      const { accountId, subject } = await newCaller();
      await newFill({
        buyer: accountId,
        price: "0.00000001",
        quantity: "0.123456789012345678",
        createdAt: "2026-11-05T10:00:00.000Z",
      });

      const response = await getTrades(subject);

      expect(response.status).toBe(200);
      // The raw body, so a number would still be a number here.
      const { items } = response.body as { items: Record<string, unknown>[] };
      expect(items[0]).toMatchObject({ price: "0.00000001", quantity: "0.123456789012345678" });
      const values = items.flatMap((item) => Object.values(item));
      expect(values).toHaveLength(6);
      for (const value of values) {
        expect(typeof value).toBe("string");
      }
    });

    it("answers 401 with no token, in the documented error shape", async () => {
      const response = await request(app.getHttpServer()).get("/trades");

      expect(response.status).toBe(401);
      expect(errorBody(response).code).toBe("UNAUTHENTICATED");
      expect(errorResponseSchema.safeParse(response.body).success).toBe(true);
    });
  });
});
