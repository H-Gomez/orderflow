import type { INestApplication } from "@nestjs/common";
import { AccountType } from "@orderflow/db";
import type { PrismaClient } from "@orderflow/db";
import { createTestDatabase, unique } from "@orderflow/db/testing";
import type { TestDatabase } from "@orderflow/db/testing";
import type { Response } from "supertest";
import type { App } from "supertest/types.js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { errorResponseSchema } from "../errors/error-response.js";
import {
  asPrismaClient,
  createTestApp,
  errorBody,
  stubPrisma,
  testConfig,
} from "../testing/test-app.js";
import { TestOidc } from "../testing/test-oidc.js";

import type { CandleInterval } from "./candles.controller.js";
import {
  CandlesController,
  candlesQuerySchema,
  candlesResponseSchema,
  periodCount,
} from "./candles.controller.js";

const database: TestDatabase | undefined = await createTestDatabase();

// At file level, so a failed set-up inside the describe still drops the database.
afterAll(async () => {
  await database?.drop();
});

const PERIOD: Readonly<Record<CandleInterval, number>> = {
  "1m": 60_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
};

const at = (start: string, milliseconds: number): string =>
  new Date(new Date(start).getTime() + milliseconds).toISOString();

describe("the window check", () => {
  const from = "2026-01-01T00:00:00.000Z";
  const query = (interval: CandleInterval, to: string) =>
    candlesQuerySchema.safeParse({ instrument: "BTC-USD", interval, from, to });

  it.each(["1m", "1h", "1d"] as const)(
    "accepts 1,000 %s periods and refuses 1,001 at to",
    (interval) => {
      expect(query(interval, at(from, 1_000 * PERIOD[interval])).success).toBe(true);

      const refused = query(interval, at(from, 1_001 * PERIOD[interval]));
      expect(refused.success).toBe(false);
      expect(refused.error?.issues.map((issue) => issue.path)).toEqual([["to"]]);
    },
  );

  it("counts a partial period as one", () => {
    const to = at(from, 1_000 * PERIOD["1h"] + 1);

    expect(periodCount("1h", new Date(from), new Date(to))).toBe(1_001);
    expect(query("1h", to).success).toBe(false);
  });
});

describe("a 1,001-period window through the app", () => {
  it("answers 400 at query.to before any instrument or candle query", async () => {
    const stub = {
      ...stubPrisma(),
      instrument: { findUnique: vi.fn() },
      candle: { findMany: vi.fn() },
    };
    stub.user.findUnique.mockResolvedValue({
      id: "user",
      account: { id: "account", type: AccountType.USER, createdAt: new Date() },
    });
    const oidc = await TestOidc.start();
    const app = await createTestApp(asPrismaClient(stub), testConfig({ oidc: oidc.config() }));

    try {
      const from = "2026-01-01T00:00:00.000Z";
      const response = await request(app.getHttpServer())
        .get("/candles")
        .query({ instrument: "BTC-USD", interval: "1m", from, to: at(from, 1_001 * PERIOD["1m"]) })
        .set("Authorization", `Bearer ${await oidc.sign({ sub: "subject" })}`);

      expect(response.status).toBe(400);
      expect(errorBody(response).fields?.map((field) => field.path)).toEqual(["query.to"]);
      expect(stub.user.findUnique).toHaveBeenCalled();
      expect(stub.instrument.findUnique).not.toHaveBeenCalled();
      expect(stub.candle.findMany).not.toHaveBeenCalled();
    } finally {
      await app.close();
      await oidc.stop();
    }
  });
});

describe("the read behind GET /candles", () => {
  it("never asks for more than 1,000 candles, so unaligned rows stay bounded", async () => {
    const findUnique = vi.fn<(args: unknown) => Promise<{ id: string }>>();
    findUnique.mockResolvedValue({ id: "btc" });
    const findMany = vi.fn<(args: unknown) => Promise<never[]>>().mockResolvedValue([]);
    const controller = new CandlesController({
      instrument: { findUnique },
      candle: { findMany },
    } as unknown as PrismaClient);

    await controller.candles(
      candlesQuerySchema.parse({
        instrument: "BTC-USD",
        interval: "1h",
        from: "2026-11-05T00:00:00.000Z",
        to: "2026-11-06T00:00:00.000Z",
      }),
    );

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1_000 }));
  });
});

describe.skipIf(database === undefined)("GET /candles", () => {
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
  const newCaller = async (): Promise<string> => {
    const subject = unique("subject");
    await client().user.create({
      data: { authSubject: subject, account: { create: { type: AccountType.USER } } },
    });
    return subject;
  };

  const newCandle = async (options: {
    readonly openTime: string;
    readonly interval: string;
    readonly symbol?: string;
    readonly open?: string;
  }): Promise<void> => {
    const instrumentId = instruments.get(options.symbol ?? "BTC-USD");
    if (instrumentId === undefined) {
      throw new Error("no such instrument in the fixture");
    }
    await client().candle.create({
      data: {
        instrumentId,
        interval: options.interval,
        openTime: options.openTime,
        open: options.open ?? "68000",
        high: "68250.5",
        low: "67900",
        close: "68100",
        volume: "12.5",
      },
    });
  };

  const getCandles = async (query: Readonly<Record<string, string>>): Promise<Response> =>
    request(app.getHttpServer())
      .get("/candles")
      .query(query)
      .set("Authorization", `Bearer ${await oidc.sign({ sub: await newCaller() })}`);

  interface Body {
    readonly candles: readonly Record<string, unknown>[];
  }
  const openTimesOf = (response: Response): unknown[] =>
    (response.body as Body).candles.map((candle) => candle["openTime"]);

  // Every case has its own window, and no window overlaps another's fixtures.
  const EMPTY_WINDOW = { from: "2026-07-01T00:00:00.000Z", to: "2026-07-02T00:00:00.000Z" };
  const STRINGS_WINDOW = { from: "2026-08-01T00:00:00.000Z", to: "2026-08-01T01:00:00.000Z" };

  beforeAll(async () => {
    oidc = await TestOidc.start();
    app = await createTestApp(client(), testConfig({ oidc: oidc.config() }));
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

  describe("window and interval", () => {
    it.each([
      [
        "1m",
        "1h",
        "2026-11-01T00:00:00.000Z",
        "2026-11-01T00:05:00.000Z",
        "2026-11-01T00:10:00.000Z",
      ],
      [
        "1h",
        "1d",
        "2026-11-02T00:00:00.000Z",
        "2026-11-02T05:00:00.000Z",
        "2026-11-02T10:00:00.000Z",
      ],
      [
        "1d",
        "1m",
        "2026-09-01T00:00:00.000Z",
        "2026-09-05T00:00:00.000Z",
        "2026-09-11T00:00:00.000Z",
      ],
    ] as const)(
      "returns only BTC-USD %s candles in [from, to), oldest first",
      async (interval, otherInterval, from, mid, to) => {
        // Inserted newest first, so the ascending order comes from the query.
        await newCandle({ openTime: to, interval });
        await newCandle({ openTime: mid, interval });
        await newCandle({ openTime: mid, interval: otherInterval });
        await newCandle({ openTime: mid, interval, symbol: "ETH-USD" });
        await newCandle({ openTime: from, interval });

        const response = await getCandles({ instrument: "BTC-USD", interval, from, to });

        expect(response.status).toBe(200);
        expect(openTimesOf(response)).toEqual([from, mid]);
        expect(response.body).toMatchObject({ instrument: "BTC-USD", interval });
        expect(candlesResponseSchema.safeParse(response.body).success).toBe(true);
      },
    );
  });

  describe("errors", () => {
    it.each([
      ["an unknown instrument", { instrument: "SOL-EUR" }, "query.instrument"],
      ["a malformed symbol", { instrument: "btc-usd" }, "query.instrument"],
      ["an unknown interval", { interval: "5m" }, "query.interval"],
      ["from not earlier than to", { to: EMPTY_WINDOW.from }, "query.to"],
    ])("answers 400 to %s, naming the field", async (_name, override, path) => {
      const response = await getCandles({
        instrument: "BTC-USD",
        interval: "1h",
        ...EMPTY_WINDOW,
        ...override,
      });

      expect(response.status).toBe(400);
      expect(errorResponseSchema.safeParse(response.body).success).toBe(true);
      expect(errorBody(response).code).toBe("VALIDATION_FAILED");
      expect(errorBody(response).fields?.map((field) => field.path)).toEqual([path]);
    });
  });

  describe("empty, strings and auth", () => {
    it("answers 200 with no candles for EMPTY_WINDOW", async () => {
      const response = await getCandles({ instrument: "BTC-USD", interval: "1h", ...EMPTY_WINDOW });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ instrument: "BTC-USD", interval: "1h", candles: [] });
    });

    it("returns values as stored, and every value as a JSON string, in STRINGS_WINDOW", async () => {
      await newCandle({ openTime: STRINGS_WINDOW.from, interval: "1h", open: "0.00000001" });

      const response = await getCandles({
        instrument: "BTC-USD",
        interval: "1h",
        ...STRINGS_WINDOW,
      });

      expect(response.status).toBe(200);
      // The raw body, so a number would still be a number here.
      const { candles } = response.body as Body;
      expect(candles).toEqual([
        {
          openTime: STRINGS_WINDOW.from,
          open: "0.00000001",
          high: "68250.5",
          low: "67900",
          close: "68100",
          volume: "12.5",
        },
      ]);
      const values = candles.flatMap((candle) => Object.values(candle));
      expect(values).toHaveLength(6);
      for (const value of values) {
        expect(typeof value).toBe("string");
      }
    });

    it("answers 401 with no token, in the documented error shape", async () => {
      const response = await request(app.getHttpServer()).get("/candles");

      expect(response.status).toBe(401);
      expect(errorBody(response).code).toBe("UNAUTHENTICATED");
      expect(errorResponseSchema.safeParse(response.body).success).toBe(true);
    });
  });
});
