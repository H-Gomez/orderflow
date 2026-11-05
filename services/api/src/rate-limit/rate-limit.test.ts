import type { INestApplication } from "@nestjs/common";
import { AccountType } from "@orderflow/db";
import type { App } from "supertest/types.js";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

describe("rate limiting", () => {
  let oidc: TestOidc;
  let prisma: StubPrisma;
  let app: INestApplication<App>;

  beforeEach(async () => {
    oidc = await TestOidc.start();
    prisma = stubPrisma();
    prisma.user.findUnique.mockResolvedValue({
      id: "user-1",
      account: { id: "account-1", type: AccountType.USER, createdAt: new Date() },
    });
    app = await createTestApp(
      asPrismaClient(prisma),
      testConfig({
        oidc: oidc.config(),
        rateLimit: { windowSeconds: 60, authenticated: 3, public: 2 },
      }),
    );
  });

  afterEach(async () => {
    await app.close();
    await oidc.stop();
  });

  const publicCall = async () => request(app.getHttpServer()).get("/probe/public");
  const authenticatedCall = async (sub: string) =>
    request(app.getHttpServer())
      .get("/probe/whoami")
      .set("Authorization", `Bearer ${await oidc.sign({ sub })}`);

  it("answers 429 with Retry-After in the error shape past the public limit", async () => {
    await publicCall();
    await publicCall();

    const response = await publicCall();

    expect(response.status).toBe(429);
    expect(errorBody(response).code).toBe("RATE_LIMITED");
    expect(errorResponseSchema.safeParse(response.body).success).toBe(true);
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("gives an authenticated caller its own, separately configured, limit", async () => {
    await authenticatedCall("alice");
    await authenticatedCall("alice");
    const third = await authenticatedCall("alice");
    const fourth = await authenticatedCall("alice");

    expect(third.status).toBe(200);
    expect(fourth.status).toBe(429);
    expect(Number(fourth.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("limits per principal: one caller's traffic does not use another's budget", async () => {
    await authenticatedCall("alice");
    await authenticatedCall("alice");
    await authenticatedCall("alice");

    expect((await authenticatedCall("alice")).status).toBe(429);
    expect((await authenticatedCall("bob")).status).toBe(200);
  });

  it("does not let an authenticated caller spend the IP's public budget", async () => {
    await authenticatedCall("alice");
    await authenticatedCall("alice");
    await authenticatedCall("alice");

    expect((await publicCall()).status).toBe(200);
  });

  it("shares one budget across a caller's routes", async () => {
    await publicCall();
    await request(app.getHttpServer()).post("/probe/echo").send({});

    expect((await publicCall()).status).toBe(429);
  });

  it("stops a caller over its limit before the database", async () => {
    await authenticatedCall("alice");
    await authenticatedCall("alice");
    await authenticatedCall("alice");
    prisma.user.findUnique.mockClear();

    await authenticatedCall("alice");

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("answers 401 rather than 429 for a bad token, whatever the count", async () => {
    for (let call = 0; call < 5; call += 1) {
      const response = await request(app.getHttpServer())
        .get("/probe/whoami")
        .set("Authorization", "Bearer not-a-jwt");
      expect(response.status).toBe(401);
    }
  });
});
