import type { INestApplication } from "@nestjs/common";
import { AccountType, EntryType, placeHold, postTransaction } from "@orderflow/db";
import {
  createTestDatabase,
  fund,
  newAccount,
  newInstrument,
  newOrder,
  unique,
} from "@orderflow/db/testing";
import type { TestDatabase } from "@orderflow/db/testing";
import type { Response } from "supertest";
import type { App } from "supertest/types.js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { errorResponseSchema } from "../errors/error-response.js";
import { createTestApp, errorBody, testConfig } from "../testing/test-app.js";
import { TestOidc } from "../testing/test-oidc.js";

import { portfolioResponseSchema } from "./portfolio.controller.js";

const database: TestDatabase | undefined = await createTestDatabase();

// At file level, because a throwing afterAll stops the rest of its own suite's hooks: from inside
// the describe, a failed set-up would skip this and leave the database on the server.
afterAll(async () => {
  await database?.drop();
});

describe.skipIf(database === undefined)("GET /portfolio", () => {
  let oidc: TestOidc;
  let app: INestApplication<App>;

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

  const getPortfolio = async (subject: string, query = ""): Promise<Response> =>
    request(app.getHttpServer())
      .get(`/portfolio${query}`)
      .set("Authorization", `Bearer ${await oidc.sign({ sub: subject })}`);

  beforeAll(async () => {
    oidc = await TestOidc.start();
    app = await createTestApp(client(), testConfig({ oidc: oidc.config() }));
  });

  afterAll(async () => {
    await app.close();
    await oidc.stop();
  });

  it("returns balance, held and buying power per currency, ordered by code", async () => {
    const { accountId, subject } = await newCaller();
    await fund(client(), accountId, "USD", "1000");
    await fund(client(), accountId, "BTC", "0.5");
    const orderId = await newOrder(client(), accountId, await newInstrument(client()));
    await placeHold(client(), { accountId, orderId, currency: "USD", amount: "250" });

    const response = await getPortfolio(subject);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      currencies: [
        { currency: "BTC", balance: "0.5", held: "0", buyingPower: "0.5" },
        { currency: "USD", balance: "1000", held: "250", buyingPower: "750" },
      ],
    });
    expect(portfolioResponseSchema.safeParse(response.body).success).toBe(true);
  });

  it("omits a currency whose balance is zero", async () => {
    const { accountId: seller, subject } = await newCaller();
    const buyer = await newAccount(client());
    await fund(client(), seller, "ETH", "2");
    await fund(client(), buyer, "USD", "300");
    await postTransaction(client(), {
      type: EntryType.TRADE,
      causeKey: unique("trade"),
      entries: [
        { accountId: buyer, currency: "USD", amount: "-300" },
        { accountId: buyer, currency: "ETH", amount: "2" },
        { accountId: seller, currency: "USD", amount: "300" },
        { accountId: seller, currency: "ETH", amount: "-2" },
      ],
    });

    const response = await getPortfolio(subject);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      currencies: [{ currency: "USD", balance: "300", held: "0", buyingPower: "300" }],
    });
  });

  describe("cross-account", () => {
    /**
     * After a partial trade both accounts would hold both currencies, so the first swaps everything
     * it has for everything the second has in BTC. They then share no currency and no amount, and
     * the second also holds SOL, which the first never touched.
     */
    const twoAccountsThatTraded = async (): Promise<{ subject: string; second: string }> => {
      const { accountId: first, subject } = await newCaller();
      const second = await newAccount(client());
      await fund(client(), first, "USD", "100");
      await fund(client(), second, "BTC", "1");
      await fund(client(), second, "SOL", "7");
      await postTransaction(client(), {
        type: EntryType.TRADE,
        causeKey: unique("trade"),
        entries: [
          { accountId: first, currency: "USD", amount: "-100" },
          { accountId: first, currency: "BTC", amount: "1" },
          { accountId: second, currency: "USD", amount: "100" },
          { accountId: second, currency: "BTC", amount: "-1" },
        ],
      });
      return { subject, second };
    };

    const expectNoneOfTheSecondAccount = (response: Response, second: string): void => {
      const body = JSON.stringify(response.body);
      for (const secret of [second, "USD", "SOL", "100", "7"]) {
        expect(body).not.toContain(secret);
      }
    };

    it("returns only the caller's currencies and amounts", async () => {
      const { subject, second } = await twoAccountsThatTraded();

      const response = await getPortfolio(subject);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        currencies: [{ currency: "BTC", balance: "1", held: "0", buyingPower: "1" }],
      });
      expectNoneOfTheSecondAccount(response, second);
    });

    it("answers 400 to a request naming another account", async () => {
      const { subject, second } = await twoAccountsThatTraded();

      const response = await getPortfolio(subject, `?accountId=${second}`);

      expect(response.status).toBe(400);
      expect(errorBody(response).code).toBe("VALIDATION_FAILED");
      expect(errorBody(response).fields?.[0]?.path).toBe("query");
      expect(errorBody(response).fields?.[0]?.message).toContain("accountId");
      expect(JSON.stringify(response.body)).not.toContain(second);
      expect(JSON.stringify(response.body)).not.toContain("USD");
      expect(JSON.stringify(response.body)).not.toContain("SOL");
    });
  });

  it("answers 200 with no rows for an account with no entries", async () => {
    const { subject } = await newCaller();

    const response = await getPortfolio(subject);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ currencies: [] });
  });

  it("returns exact amounts, and every value as a JSON string", async () => {
    const { accountId, subject } = await newCaller();
    await fund(client(), accountId, "BTC", "0.00000001");

    const response = await getPortfolio(subject);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      currencies: [
        { currency: "BTC", balance: "0.00000001", held: "0", buyingPower: "0.00000001" },
      ],
    });
    const { currencies } = portfolioResponseSchema.parse(response.body);
    for (const value of currencies.flatMap((row) => Object.values(row))) {
      expect(typeof value).toBe("string");
    }
  });

  it("answers 401 with no token, in the documented error shape", async () => {
    const response = await request(app.getHttpServer()).get("/portfolio");

    expect(response.status).toBe(401);
    expect(errorBody(response).code).toBe("UNAUTHENTICATED");
    expect(errorResponseSchema.safeParse(response.body).success).toBe(true);
  });
});
