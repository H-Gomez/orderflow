import { Logger } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { AccountType } from "@orderflow/db";
import { createTestDatabase } from "@orderflow/db/testing";
import type { TestDatabase } from "@orderflow/db/testing";
import type { App } from "supertest/types.js";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { errorResponseSchema } from "../errors/error-response.js";
import {
  asPrismaClient,
  createTestApp,
  errorBody,
  stubPrisma,
  testConfig,
} from "../testing/test-app.js";
import type { StubPrisma } from "../testing/test-app.js";
import { TestOidc } from "../testing/test-oidc.js";

const inThePast = (): number => Math.floor(Date.now() / 1_000) - 60;

describe("authentication, with no database behind it", () => {
  let oidc: TestOidc;
  let prisma: StubPrisma;
  let app: INestApplication<App>;

  beforeAll(async () => {
    oidc = await TestOidc.start();
    prisma = stubPrisma();
    app = await createTestApp(asPrismaClient(prisma), testConfig({ oidc: oidc.config() }));
  });

  beforeEach(() => {
    prisma.user.findUnique.mockReset();
    prisma.user.findUnique.mockResolvedValue(null);
  });

  afterAll(async () => {
    await app.close();
    await oidc.stop();
  });

  const whoami = (token?: string) => {
    const call = request(app.getHttpServer()).get("/probe/whoami");
    return token === undefined ? call : call.set("Authorization", `Bearer ${token}`);
  };

  const rejected: readonly (readonly [string, () => Promise<string>])[] = [
    ["a malformed token", async () => Promise.resolve("not-a-jwt")],
    ["a token of three garbage segments", async () => Promise.resolve("aaa.bbb.ccc")],
    ["a token signed by the wrong key", async () => oidc.sign({ key: await oidc.foreignKey() })],
    ["an expired token", async () => oidc.sign({ expiresAt: inThePast() })],
    ["the wrong issuer", async () => oidc.sign({ issuer: "https://other.test.invalid/" })],
    ["the wrong audience", async () => oidc.sign({ audience: "some-other-api" })],
    ["an unsigned alg:none token", async () => Promise.resolve(oidc.unsigned())],
    ["an HS256 token signed with the public key", async () => oidc.signedWithPublicKeyAsSecret()],
    ["a token with no exp", async () => oidc.sign({ expiresAt: null })],
    ["a token with no sub", async () => oidc.sign({ sub: null })],
    ["a token with an empty sub", async () => oidc.sign({ sub: "" })],
  ];

  it.each(rejected)("answers 401 and does no database work for %s", async (_name, token) => {
    const response = await whoami(await token());

    expect(response.status).toBe(401);
    expect(errorBody(response).code).toBe("UNAUTHENTICATED");
    expect(errorResponseSchema.safeParse(response.body).success).toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("answers 401 and does no database work with no token", async () => {
    const response = await whoami();

    expect(response.status).toBe(401);
    expect(errorBody(response).code).toBe("UNAUTHENTICATED");
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it.each(["Basic abc", "Bearer", "Bearer a b", "abc"])(
    "answers 401 for the header %j",
    async (header) => {
      const response = await request(app.getHttpServer())
        .get("/probe/whoami")
        .set("Authorization", header);

      expect(response.status).toBe(401);
    },
  );

  it("answers 200 and resolves the principal for a correctly signed token", async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: "user-1",
      account: { id: "account-1", type: AccountType.USER, createdAt: new Date() },
    });

    const response = await whoami(await oidc.sign());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ accountId: "account-1" });
  });

  it.each([
    ["no account", { id: "user-1", account: null }],
    ["a BOT account", { id: "user-1", account: { id: "a", type: AccountType.BOT } }],
    ["the TREASURY", { id: "user-1", account: { id: "a", type: AccountType.TREASURY } }],
  ])("answers 403 for a user with %s, because only USER accounts use JWTs", async (_name, user) => {
    prisma.user.findUnique.mockResolvedValue(user);

    const response = await whoami(await oidc.sign());

    expect(response.status).toBe(403);
    expect(errorBody(response).code).toBe("UNKNOWN_SUBJECT");
  });

  it("lets a public route through with no token and no database work", async () => {
    const response = await request(app.getHttpServer()).get("/probe/public");

    expect(response.status).toBe(200);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("answers 503 and not 401 when the JWKS cannot be fetched", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const down = await TestOidc.start();
    const token = await down.sign();
    const config = down.config();
    await down.stop();
    const downApp = await createTestApp(asPrismaClient(stubPrisma()), testConfig({ oidc: config }));

    const response = await request(downApp.getHttpServer())
      .get("/probe/whoami")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(503);
    expect(errorBody(response).code).toBe("AUTH_UNAVAILABLE");

    await downApp.close();
  });
});

const database: TestDatabase | undefined = await createTestDatabase();

describe.skipIf(database === undefined)("authentication against a real database", () => {
  let oidc: TestOidc;
  let app: INestApplication<App>;

  const client = () => {
    if (database === undefined) {
      throw new Error("skipped when there is no database");
    }
    return database.client;
  };

  beforeAll(async () => {
    oidc = await TestOidc.start();
    app = await createTestApp(client(), testConfig({ oidc: oidc.config() }));
  });

  afterAll(async () => {
    await app.close();
    await oidc.stop();
    await database?.drop();
  });

  it("answers 200 with the account of the User whose authSubject is the token's sub", async () => {
    const user = await client().user.create({
      data: { authSubject: "known-subject", account: { create: { type: AccountType.USER } } },
      select: { account: { select: { id: true } } },
    });

    const response = await request(app.getHttpServer())
      .get("/probe/whoami")
      .set("Authorization", `Bearer ${await oidc.sign({ sub: "known-subject" })}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ accountId: user.account?.id });
  });

  it("answers 403 for an unknown subject and writes nothing", async () => {
    const users = await client().user.count();
    const accounts = await client().account.count();

    const response = await request(app.getHttpServer())
      .get("/probe/whoami")
      .set("Authorization", `Bearer ${await oidc.sign({ sub: "nobody-we-know" })}`);

    expect(response.status).toBe(403);
    expect(errorBody(response).code).toBe("UNKNOWN_SUBJECT");
    expect(errorResponseSchema.safeParse(response.body).success).toBe(true);
    await expect(client().user.count()).resolves.toBe(users);
    await expect(client().account.count()).resolves.toBe(accounts);
  });
});
