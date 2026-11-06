import type { INestApplication } from "@nestjs/common";
import { AccountType, EntryType, Prisma, postTransaction } from "@orderflow/db";
import type { PrismaClient } from "@orderflow/db";
import { createTestDatabase, newInstrument, treasuryId, unique } from "@orderflow/db/testing";
import type { TestDatabase } from "@orderflow/db/testing";
import type { Response } from "supertest";
import type { App } from "supertest/types.js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Principal } from "../auth/principal.js";
import { errorResponseSchema } from "../errors/error-response.js";
import { createTestApp, errorBody, testConfig } from "../testing/test-app.js";
import { TestOidc } from "../testing/test-oidc.js";

import {
  LedgerController,
  ledgerPageSchema,
  ledgerQuerySchema,
  toLedgerItem,
} from "./ledger.controller.js";

const database: TestDatabase | undefined = await createTestDatabase();

// At file level, because a throwing afterAll stops the rest of its own suite's hooks: from inside
// the describe, a failed set-up would skip this and leave the database on the server.
afterAll(async () => {
  await database?.drop();
});

interface Item {
  readonly id: string;
  readonly transactionId: string;
  readonly type: string;
  readonly currency: string;
  readonly amount: string;
  readonly createdAt: string;
  readonly fillId: string | null;
}

interface Page {
  readonly items: readonly Item[];
  readonly nextCursor: string | null;
}

const pageOf = (response: Response): Page => response.body as Page;
const idsOf = (response: Response): string[] => pageOf(response).items.map((item) => item.id);

const cursorWithId = (id: string): string =>
  Buffer.from(JSON.stringify({ createdAt: "2026-11-05T10:00:00.000Z", id })).toString("base64url");

const wait = async (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const entryOf = <Entry extends { readonly accountId: string }>(
  entries: readonly Entry[],
  accountId: string,
  matching: (entry: Entry) => boolean = () => true,
): Entry => {
  const entry = entries.find((e) => e.accountId === accountId && matching(e));
  if (entry === undefined) {
    throw new Error("the fixture wrote no such entry");
  }
  return entry;
};

describe("toLedgerItem", () => {
  it("gives a CORRECTION no fillId, which only a human can write", () => {
    const item = toLedgerItem({
      id: "entry",
      transactionId: "transaction",
      currency: "USD",
      amount: new Prisma.Decimal("-1"),
      createdAt: new Date("2026-11-05T10:00:00.000Z"),
      transaction: { type: EntryType.CORRECTION, causeKey: "correct:something" },
    });

    expect(item.type).toBe("CORRECTION");
    expect(item.fillId).toBeNull();
  });
});

describe("the read behind GET /ledger", () => {
  it.each([
    [{ limit: "2" }, 3],
    [{}, 51],
  ])("asks the database for one row past the page, given %j", async (query, take) => {
    const findMany = vi.fn<(args: unknown) => Promise<never[]>>().mockResolvedValue([]);
    const controller = new LedgerController({
      ledgerEntry: { findMany },
    } as unknown as PrismaClient);

    await controller.ledger(ledgerQuerySchema.parse(query), {
      accountId: "the-caller",
    } as Principal);

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take }));
  });
});

describe.skipIf(database === undefined)("GET /ledger", () => {
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

  const getLedger = async (
    subject: string,
    query: Readonly<Record<string, string>> = {},
  ): Promise<Response> =>
    request(app.getHttpServer())
      .get("/ledger")
      .query(query)
      .set("Authorization", `Bearer ${await oidc.sign({ sub: subject })}`);

  /** `fund`, but returning the entries, because the tests assert on their ids. */
  const deposit = async (accountId: string, currency: string, amount: string) => {
    const posted = await postTransaction(client(), {
      type: EntryType.DEPOSIT,
      causeKey: unique("deposit"),
      entries: [
        { accountId: await treasuryId(client()), currency, amount: `-${amount}` },
        { accountId, currency, amount },
      ],
    });
    return entryOf(posted.entries, accountId);
  };

  /** The buyer pays 100 USD to the seller for 1 BTC, under a real Fill's id as the cause key. */
  const trade = async (buyer: string, seller: string) => {
    const fill = await client().fill.create({
      data: { instrumentId: await newInstrument(client()), price: "100", quantity: "1" },
    });
    const { id: transactionId, entries } = await postTransaction(client(), {
      type: EntryType.TRADE,
      causeKey: fill.id,
      entries: [
        { accountId: buyer, currency: "USD", amount: "-100" },
        { accountId: buyer, currency: "BTC", amount: "1" },
        { accountId: seller, currency: "USD", amount: "100" },
        { accountId: seller, currency: "BTC", amount: "-1" },
      ],
    });
    return { fillId: fill.id, transactionId, entries };
  };

  beforeAll(async () => {
    oidc = await TestOidc.start();
    app = await createTestApp(client(), testConfig({ oidc: oidc.config() }));
  });

  afterAll(async () => {
    await app.close();
    await oidc.stop();
  });

  describe("cross-account", () => {
    const twoAccountsThatTraded = async () => {
      const a = await newCaller();
      const b = await newCaller();
      const aDeposit = await deposit(a.accountId, "USD", "100");
      const bDeposit = await deposit(b.accountId, "BTC", "1");
      const { entries } = await trade(a.accountId, b.accountId);
      return { a, b, aDeposit, bDeposit, entries };
    };

    it("returns exactly the caller's entries, and none of the other's or the treasury's", async () => {
      const { a, b, aDeposit, bDeposit, entries } = await twoAccountsThatTraded();

      const response = await getLedger(a.subject);

      expect(response.status).toBe(200);
      const aIds = entries.filter((e) => e.accountId === a.accountId).map((e) => e.id);
      expect([...idsOf(response)].sort()).toEqual([aDeposit.id, ...aIds].sort());
      const bIds = entries.filter((e) => e.accountId === b.accountId).map((e) => e.id);
      for (const id of [bDeposit.id, ...bIds]) {
        expect(idsOf(response)).not.toContain(id);
      }
    });

    it("answers 400 to a request naming another account", async () => {
      const { a, b } = await twoAccountsThatTraded();

      const response = await getLedger(a.subject, { accountId: b.accountId });

      expect(response.status).toBe(400);
      // The exact body, so it can hold none of the second account's data.
      const { correlationId, ...rest } = errorBody(response);
      expect(correlationId).toEqual(expect.any(String));
      expect(rest).toEqual({
        code: "VALIDATION_FAILED",
        message: "Request validation failed.",
        fields: [{ path: "query", message: 'Unrecognized key: "accountId"' }],
      });
    });

    it("scopes another account's cursor to the caller's rows", async () => {
      const { a, b, aDeposit, entries } = await twoAccountsThatTraded();
      await wait(5);
      await deposit(b.accountId, "SOL", "7");
      await wait(5);
      const later = await deposit(b.accountId, "SOL", "8");
      await wait(5);
      // Newer than the cursor below, so the page must leave it out.
      const aNewer = await deposit(a.accountId, "USD", "5");

      const bFirstPage = await getLedger(b.subject, { limit: "1" });
      expect(idsOf(bFirstPage)).toEqual([later.id]);
      const cursor = pageOf(bFirstPage).nextCursor;
      if (cursor === null) {
        throw new Error("the second account has more pages");
      }

      const response = await getLedger(a.subject, { cursor });

      expect(response.status).toBe(200);
      const aIds = entries.filter((e) => e.accountId === a.accountId).map((e) => e.id);
      expect([...idsOf(response)].sort()).toEqual([aDeposit.id, ...aIds].sort());
      expect(idsOf(response)).not.toContain(aNewer.id);
    });
  });

  describe("entries and links", () => {
    it("returns a TRADE as the caller's two entries, linked to the Fill", async () => {
      const buyer = await newCaller();
      const seller = await newCaller();
      await deposit(buyer.accountId, "USD", "100");
      await deposit(seller.accountId, "BTC", "1");
      const { fillId, transactionId, entries } = await trade(buyer.accountId, seller.accountId);

      const response = await getLedger(buyer.subject);

      const items = pageOf(response).items.filter((item) => item.type === "TRADE");
      const usd = entryOf(entries, buyer.accountId, (e) => e.currency === "USD");
      const btc = entryOf(entries, buyer.accountId, (e) => e.currency === "BTC");
      const createdAt = usd.createdAt.toISOString();
      expect([...items].sort((x, y) => x.currency.localeCompare(y.currency))).toEqual([
        {
          id: btc.id,
          transactionId,
          type: "TRADE",
          currency: "BTC",
          amount: "1",
          createdAt,
          fillId,
        },
        {
          id: usd.id,
          transactionId,
          type: "TRADE",
          currency: "USD",
          amount: "-100",
          createdAt,
          fillId,
        },
      ]);
      expect(ledgerPageSchema.safeParse(response.body).success).toBe(true);
    });

    it("returns a DEPOSIT as one entry, with no fillId", async () => {
      const { accountId, subject } = await newCaller();
      const entry = await deposit(accountId, "USD", "250.5");

      const response = await getLedger(subject);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        items: [
          {
            id: entry.id,
            transactionId: entry.transactionId,
            type: "DEPOSIT",
            currency: "USD",
            amount: "250.5",
            createdAt: entry.createdAt.toISOString(),
            fillId: null,
          },
        ],
        nextCursor: null,
      });
    });
  });

  describe("time filter", () => {
    const twoTransactionsApart = async () => {
      const caller = await newCaller();
      const first = await deposit(caller.accountId, "USD", "1");
      await wait(10);
      const second = await deposit(caller.accountId, "USD", "2");
      expect(second.createdAt.getTime() - first.createdAt.getTime()).toBeGreaterThanOrEqual(5);
      return { caller, first, second };
    };

    it("includes from: it keeps the second and leaves out the first", async () => {
      const { caller, second } = await twoTransactionsApart();

      const response = await getLedger(caller.subject, { from: second.createdAt.toISOString() });

      expect(idsOf(response)).toEqual([second.id]);
    });

    it("excludes to: it leaves out the second", async () => {
      const { caller, first, second } = await twoTransactionsApart();

      const response = await getLedger(caller.subject, { to: second.createdAt.toISOString() });

      expect(idsOf(response)).toEqual([first.id]);
    });

    it("takes an offset, sent encoded", async () => {
      const { caller, second } = await twoTransactionsApart();
      // The same instant as the second's createdAt, written at +01:00.
      const atPlusOne = `${new Date(second.createdAt.getTime() + 3_600_000).toISOString().slice(0, -1)}+01:00`;

      const response = await getLedger(caller.subject, { from: atPlusOne });

      expect(response.status).toBe(200);
      expect(idsOf(response)).toEqual([second.id]);
    });

    it("answers 400 at query.to when from is not earlier than to", async () => {
      const { caller, second } = await twoTransactionsApart();
      const instant = second.createdAt.toISOString();

      const response = await getLedger(caller.subject, { from: instant, to: instant });

      expect(response.status).toBe(400);
      expect(errorBody(response).code).toBe("VALIDATION_FAILED");
      expect(errorBody(response).fields?.[0]?.path).toBe("query.to");
    });

    it("answers 400 at query.from, never 500, to an invalid from beside a valid to", async () => {
      const { subject } = await newCaller();

      const response = await getLedger(subject, {
        from: "2026-11-05T10:00:00.1234Z",
        to: "2026-11-05T11:00:00Z",
      });

      expect(response.status).toBe(400);
      expect(errorBody(response).code).toBe("VALIDATION_FAILED");
      expect(errorBody(response).fields?.[0]?.path).toBe("query.from");
    });

    // These reach Postgres unless the schema stops them, and Postgres rejects year 0 with a 500.
    it.each(["0000-01-01T00:00:00Z", "0001-01-01T00:00:00+14:00"])(
      "answers 400, never 500, to the date %s before year 1",
      async (extreme) => {
        const { subject } = await newCaller();

        const from = await getLedger(subject, { from: extreme });
        const to = await getLedger(subject, { to: extreme });
        const cursor = await getLedger(subject, {
          cursor: Buffer.from(
            JSON.stringify({ createdAt: extreme, id: "0193f2c4-7b1e-7c3a-9d2f-5e8a1b4c6d70" }),
          ).toString("base64url"),
        });

        expect(from.status).toBe(400);
        expect(errorBody(from).fields?.[0]?.path).toBe("query.from");
        expect(to.status).toBe(400);
        expect(errorBody(to).fields?.[0]?.path).toBe("query.to");
        expect(cursor.status).toBe(400);
        expect(errorBody(cursor).fields?.[0]?.path).toBe("query.cursor");
      },
    );

    it.each(["0001-01-01T00:00:00Z", "9999-12-31T23:59:59.999Z", "9999-12-31T23:59:59-14:00"])(
      "accepts the date %s at the edge of the range",
      async (edge) => {
        const { subject } = await newCaller();

        expect((await getLedger(subject, { from: edge })).status).toBe(200);
        expect((await getLedger(subject, { to: edge })).status).toBe(200);
      },
    );
  });

  describe("currency filter", () => {
    it("returns only that currency", async () => {
      const { accountId, subject } = await newCaller();
      await deposit(accountId, "USD", "1");
      const btc = await deposit(accountId, "BTC", "1");

      const response = await getLedger(subject, { currency: "BTC" });

      expect(idsOf(response)).toEqual([btc.id]);
    });

    it("returns an empty page for a well-formed currency with no entries", async () => {
      const { accountId, subject } = await newCaller();
      await deposit(accountId, "USD", "1");

      const response = await getLedger(subject, { currency: "DOGE" });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ items: [], nextCursor: null });
    });

    it.each(["usd", "US", "USDTX", "U5D", ""])(
      "answers 400 to the currency %j",
      async (currency) => {
        const { subject } = await newCaller();

        const response = await getLedger(subject, { currency });

        expect(response.status).toBe(400);
        expect(errorBody(response).fields?.[0]?.path).toBe("query.currency");
      },
    );
  });

  describe("paging", () => {
    it("walks every entry once, in order, including a TRADE's tied pair", async () => {
      const buyer = await newCaller();
      const seller = await newCaller();
      const usd = await deposit(buyer.accountId, "USD", "100");
      await deposit(seller.accountId, "BTC", "1");
      await wait(5);
      const { entries } = await trade(buyer.accountId, seller.accountId);
      await wait(5);
      const last = await deposit(buyer.accountId, "ETH", "3");
      const pair = entries.filter((e) => e.accountId === buyer.accountId);
      // The tie this test exists for: both entries of a transaction share a timestamp.
      expect(pair).toHaveLength(2);
      expect(pair[0]?.createdAt).toEqual(pair[1]?.createdAt);
      // Ids can't be known in advance, so this only orders the two `postTransaction` returned. Their
      // uuid v7 ids are lowercase hex with hyphens in the same places, so a code-unit sort here agrees
      // with Postgres's collation on `id desc`.
      const tiedNewestFirst = pair
        .map((e) => e.id)
        .sort()
        .reverse();

      const walked: string[] = [];
      let query: Record<string, string> = { limit: "1" };
      // Four entries, so ten pages means the cursor stopped advancing: fail rather than hang.
      for (let page = 1; ; page += 1) {
        expect(page, "the walk never reached a null nextCursor").toBeLessThanOrEqual(10);
        const response = await getLedger(buyer.subject, query);
        expect(response.status).toBe(200);
        expect(pageOf(response).items).toHaveLength(1);
        walked.push(...idsOf(response));
        const { nextCursor } = pageOf(response);
        if (nextCursor === null) {
          break;
        }
        query = { limit: "1", cursor: nextCursor };
      }

      expect(walked).toEqual([last.id, ...tiedNewestFirst, usd.id]);
    });

    it("neither repeats nor skips when a DEPOSIT lands between pages", async () => {
      const { accountId, subject } = await newCaller();
      const first = await deposit(accountId, "USD", "1");
      await wait(5);
      const second = await deposit(accountId, "USD", "2");

      const page1 = await getLedger(subject, { limit: "1" });
      expect(idsOf(page1)).toEqual([second.id]);
      const cursor = pageOf(page1).nextCursor;
      if (cursor === null) {
        throw new Error("there is a second page");
      }
      await wait(5);
      await deposit(accountId, "USD", "3");

      const page2 = await getLedger(subject, { limit: "1", cursor });

      expect(idsOf(page2)).toEqual([first.id]);
      expect(pageOf(page2).nextCursor).toBeNull();
    });

    it("applies the filters to later pages too", async () => {
      const { accountId, subject } = await newCaller();
      const first = await deposit(accountId, "USD", "1");
      await deposit(accountId, "BTC", "1");
      await wait(5);
      const second = await deposit(accountId, "USD", "2");

      const page1 = await getLedger(subject, { limit: "1", currency: "USD" });
      expect(idsOf(page1)).toEqual([second.id]);
      const cursor = pageOf(page1).nextCursor;
      if (cursor === null) {
        throw new Error("there is a second page");
      }

      const page2 = await getLedger(subject, { limit: "1", currency: "USD", cursor });

      expect(idsOf(page2)).toEqual([first.id]);
    });

    it.each(["0", "201"])("answers 400 at query.limit to limit=%s", async (limit) => {
      const { subject } = await newCaller();

      const response = await getLedger(subject, { limit });

      expect(response.status).toBe(400);
      expect(errorBody(response).fields?.[0]?.path).toBe("query.limit");
    });

    it("accepts limit=200", async () => {
      const { subject } = await newCaller();

      expect((await getLedger(subject, { limit: "200" })).status).toBe(200);
    });

    it.each([
      ["not base64url", "not a cursor!"],
      ["not JSON", "bm90IGpzb24"],
      ["the wrong shape", "eyJhIjoxfQ"],
      ["carrying a NUL, which Postgres rejects", cursorWithId("\u0000")],
    ])("answers 400 at query.cursor to a cursor that is %s", async (_name, cursor) => {
      const { subject } = await newCaller();

      const response = await getLedger(subject, { cursor });

      expect(response.status).toBe(400);
      expect(errorBody(response).code).toBe("VALIDATION_FAILED");
      expect(errorBody(response).fields?.[0]?.path).toBe("query.cursor");
    });

    it("accepts a cursor on an id that is not a uuid, as a hand-written CORRECTION's may be", async () => {
      const { subject } = await newCaller();

      const response = await getLedger(subject, { cursor: cursorWithId("hand-written") });

      expect(response.status).toBe(200);
    });

    it("answers 400 to a repeated parameter", async () => {
      const { subject } = await newCaller();

      const response = await request(app.getHttpServer())
        .get("/ledger?limit=1&limit=2")
        .set("Authorization", `Bearer ${await oidc.sign({ sub: subject })}`);

      expect(response.status).toBe(400);
      expect(errorBody(response).fields?.[0]?.path).toBe("query.limit");
    });
  });

  describe("empty, strings and auth", () => {
    it("answers 200 with an empty page for an account with no entries", async () => {
      const { subject } = await newCaller();

      const response = await getLedger(subject);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ items: [], nextCursor: null });
    });

    it("returns exact amounts, and every value as a JSON string or null", async () => {
      const { accountId, subject } = await newCaller();
      await deposit(accountId, "BTC", "0.00000001");
      await deposit(accountId, "ETH", "0.123456789012345678");

      const response = await getLedger(subject);

      expect(response.status).toBe(200);
      const amounts = pageOf(response).items.map((item) => item.amount);
      expect([...amounts].sort()).toEqual(["0.00000001", "0.123456789012345678"]);
      // The raw body, so a number would still be a number here.
      const { items } = response.body as { items: Record<string, unknown>[] };
      const values = items.flatMap((item) => Object.values(item));
      expect(values).toHaveLength(14);
      for (const value of values) {
        expect(value === null || typeof value === "string").toBe(true);
      }
    });

    it("answers 401 with no token, in the documented error shape", async () => {
      const response = await request(app.getHttpServer()).get("/ledger");

      expect(response.status).toBe(401);
      expect(errorBody(response).code).toBe("UNAUTHENTICATED");
      expect(errorResponseSchema.safeParse(response.body).success).toBe(true);
    });
  });
});
