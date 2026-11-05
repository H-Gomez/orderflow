import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";

import { Logger } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import { createPrismaClient } from "@orderflow/db";
import { createTestDatabase } from "@orderflow/db/testing";
import type { TestDatabase } from "@orderflow/db/testing";
import type { App } from "supertest/types.js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { errorResponseSchema } from "../errors/error-response.js";
import { asPrismaClient, createTestApp, errorBody, stubPrisma } from "../testing/test-app.js";

import { READINESS_TIMEOUT_MS } from "./health.controller.js";

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

describe("with a stubbed client that offers no query at all", () => {
  it("GET /health answers without touching the database", async () => {
    const app = await createTestApp(asPrismaClient(stubPrisma()));

    const response = await request(app.getHttpServer()).get("/health");

    expect(response.status).toBe(200);
    await app.close();
  });
});

describe("with a database host that accepts connections and never answers", () => {
  const sockets = new Set<Socket>();
  const silent = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
  });
  let app: INestApplication<App>;

  beforeAll(async () => {
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = silent.address() as AddressInfo;
    app = await createTestApp(
      createPrismaClient({
        connectionString: `postgresql://user:password@127.0.0.1:${String(port)}/silent`,
      }),
    );
  });

  afterAll(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await app.close();
    await new Promise((resolve) => silent.close(resolve));
  });

  it("GET /health/ready gives up at the timeout rather than hanging the probe", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const startedAt = Date.now();

    const response = await request(app.getHttpServer()).get("/health/ready");

    expect(response.status).toBe(503);
    expect(errorBody(response).code).toBe("NOT_READY");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(READINESS_TIMEOUT_MS - 50);
    expect(Date.now() - startedAt).toBeLessThan(READINESS_TIMEOUT_MS + 1_500);
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
