import { Logger } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { createPrismaClient } from "@orderflow/db";
import { createTestDatabase } from "@orderflow/db/testing";
import type { TestDatabase } from "@orderflow/db/testing";
import type { App } from "supertest/types.js";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { errorResponseSchema } from "../errors/error-response.js";
import { asPrismaClient, createTestApp, errorBody, stubPrisma } from "../testing/test-app.js";

import { HealthController, READINESS_TIMEOUT_MS } from "./health.controller.js";

const UNREACHABLE = "postgresql://user:password@127.0.0.1:1/unreachable";

describe("with a database that cannot be reached", () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp(createPrismaClient({ connectionString: UNREACHABLE }));
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /health still answers 200, with no token", async () => {
    const response = await request(app.getHttpServer()).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("GET /health/ready answers 503 in the error shape, with no token", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    const response = await request(app.getHttpServer()).get("/health/ready");

    expect(response.status).toBe(503);
    expect(errorBody(response).code).toBe("NOT_READY");
    expect(errorResponseSchema.safeParse(response.body).success).toBe(true);
    expect(response.text).not.toContain("127.0.0.1");
  });
});

describe("with a stubbed client", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("GET /health does not touch the database", async () => {
    const prisma = stubPrisma();
    const app = await createTestApp(asPrismaClient(prisma));

    await request(app.getHttpServer()).get("/health");

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    await app.close();
  });

  it("readiness gives up on a database that never answers", async () => {
    vi.useFakeTimers();
    const prisma = stubPrisma();
    prisma.$queryRaw.mockReturnValue(new Promise(() => undefined));
    const controller = new HealthController(asPrismaClient(prisma));

    const readiness = expect(controller.readiness()).rejects.toMatchObject({ code: "NOT_READY" });
    await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);

    await readiness;
  });
});

const database: TestDatabase | undefined = await createTestDatabase();

describe.skipIf(database === undefined)("with a real database", () => {
  afterAll(async () => {
    await database?.drop();
  });

  it("GET /health/ready answers 200", async () => {
    if (database === undefined) {
      throw new Error("skipped when there is no database");
    }
    const app = await createTestApp(database.client);

    const response = await request(app.getHttpServer()).get("/health/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ready" });
    await app.close();
  });
});
