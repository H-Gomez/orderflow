import type { INestApplication } from "@nestjs/common";
import { AccountType } from "@orderflow/db";
import { createTestDatabase } from "@orderflow/db/testing";
import type { TestDatabase } from "@orderflow/db/testing";
import type { App } from "supertest/types.js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestApp, errorBody, testConfig } from "../testing/test-app.js";
import { TestOidc } from "../testing/test-oidc.js";

import { meResponseSchema } from "./me.controller.js";

const database: TestDatabase | undefined = await createTestDatabase();

// At file level, because a throwing afterAll stops the rest of its own suite's hooks: from inside
// the describe, a failed set-up would skip this and leave the database on the server.
afterAll(async () => {
  await database?.drop();
});

describe.skipIf(database === undefined)("GET /me", () => {
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
  });

  it("returns exactly the caller's account id, type and creation time", async () => {
    const user = await client().user.create({
      data: { authSubject: "me-subject", account: { create: { type: AccountType.USER } } },
      select: { account: { select: { id: true, createdAt: true } } },
    });

    const response = await request(app.getHttpServer())
      .get("/me")
      .set("Authorization", `Bearer ${await oidc.sign({ sub: "me-subject" })}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      accountId: user.account?.id,
      type: "USER",
      createdAt: user.account?.createdAt.toISOString(),
    });
    expect(meResponseSchema.safeParse(response.body).success).toBe(true);
  });

  it("answers 401 with no token", async () => {
    const response = await request(app.getHttpServer()).get("/me");

    expect(response.status).toBe(401);
    expect(errorBody(response).code).toBe("UNAUTHENTICATED");
  });

  it("answers 403 for a valid token whose subject has no User", async () => {
    const response = await request(app.getHttpServer())
      .get("/me")
      .set("Authorization", `Bearer ${await oidc.sign({ sub: "not-provisioned" })}`);

    expect(response.status).toBe(403);
    expect(errorBody(response).code).toBe("UNKNOWN_SUBJECT");
  });
});
