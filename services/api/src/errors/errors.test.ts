import type { INestApplication } from "@nestjs/common";
import { Logger } from "@nestjs/common";
import { LedgerErrorCode } from "@orderflow/db";
import type { App } from "supertest/types.js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { INTERNAL_MESSAGE, LEDGER_MESSAGE } from "../testing/probe.controller.js";
import { asPrismaClient, createTestApp, errorBody, stubPrisma } from "../testing/test-app.js";

import { errorResponseSchema } from "./error-response.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

describe("the error shape", () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp(asPrismaClient(stubPrisma()));
  });

  afterAll(async () => {
    await app.close();
  });

  const get = async (path: string) => request(app.getHttpServer()).get(path);

  it.each([
    [LedgerErrorCode.ACCOUNT_NOT_FOUND, 404],
    [LedgerErrorCode.INVALID_CURRENCY, 400],
    [LedgerErrorCode.TREASURY_HAS_NO_BUYING_POWER, 403],
  ])("maps LedgerError %s to %i, with the code and without the message", async (code, status) => {
    const response = await get(`/probe/ledger-error/${code}`);

    expect(response.status).toBe(status);
    expect(errorBody(response).code).toBe(code);
    expect(response.text).not.toContain("acct-0193-secret");
    expect(response.text).not.toContain("1234.56");
    expect(response.text).not.toContain(LEDGER_MESSAGE);
  });

  const unmapped = Object.values(LedgerErrorCode).filter(
    (code) =>
      code !== LedgerErrorCode.ACCOUNT_NOT_FOUND &&
      code !== LedgerErrorCode.INVALID_CURRENCY &&
      code !== LedgerErrorCode.TREASURY_HAS_NO_BUYING_POWER,
  );

  it.each(unmapped)("answers an unmapped LedgerError %s with a 500 and no detail", async (code) => {
    const response = await get(`/probe/ledger-error/${code}`);

    expect(response.status).toBe(500);
    expect(errorBody(response).code).toBe("INTERNAL_ERROR");
    expect(response.text).not.toContain(code);
    expect(response.text).not.toContain("acct-0193-secret");
  });

  it("answers an unexpected error with a 500 and no detail, logging it against the id", async () => {
    const log = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    const response = await get("/probe/crash");

    expect(response.status).toBe(500);
    expect(errorBody(response).code).toBe("INTERNAL_ERROR");
    expect(response.text).not.toContain("db-internal-host");
    const logged = log.mock.calls.flat().join(" ");
    expect(logged).toContain(errorBody(response).correlationId);
    expect(logged).toContain(INTERNAL_MESSAGE);
  });

  it("does not repeat an HttpException's text", async () => {
    const response = await get("/probe/http-error/405");

    expect(response.status).toBe(405);
    expect(errorBody(response).code).toBe("REQUEST_REJECTED");
    expect(response.text).not.toContain("db-internal-host");
  });

  it("does not let a 5xx HttpException carry its text either", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    const response = await get("/probe/http-error/502");

    expect(response.status).toBe(500);
    expect(errorBody(response).code).toBe("INTERNAL_ERROR");
    expect(response.text).not.toContain("db-internal-host");
  });

  it("uses the shape for a route that does not exist", async () => {
    const response = await get("/no-such-route");

    expect(response.status).toBe(404);
    expect(errorBody(response).code).toBe("NOT_FOUND");
    expect(response.text).not.toContain("no-such-route");
  });

  it("uses the shape for a body that is not JSON", async () => {
    const response = await request(app.getHttpServer())
      .post("/probe/echo")
      .set("Content-Type", "application/json")
      .send("{not json");

    expect(response.status).toBe(400);
    expect(errorBody(response).code).toBe("BAD_REQUEST");
    expect(errorResponseSchema.safeParse(response.body).success).toBe(true);
  });

  it("matches the documented schema, with the id in the body and the header", async () => {
    const response = await get("/probe/crash");

    expect(errorResponseSchema.safeParse(response.body).success).toBe(true);
    expect(errorBody(response).correlationId).toMatch(UUID);
    expect(response.headers["x-correlation-id"]).toBe(errorBody(response).correlationId);
  });

  it("ignores a correlation id the client sends", async () => {
    const response = await request(app.getHttpServer())
      .get("/probe/crash")
      .set("X-Correlation-Id", "client-supplied");

    expect(errorBody(response).correlationId).toMatch(UUID);
    expect(response.text).not.toContain("client-supplied");
  });

  it("gives each request its own id", async () => {
    const [first, second] = await Promise.all([get("/no-such-route"), get("/no-such-route")]);

    expect(errorBody(first).correlationId).not.toBe(errorBody(second).correlationId);
  });
});
