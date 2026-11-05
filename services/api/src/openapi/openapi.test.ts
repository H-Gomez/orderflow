import { readFile } from "node:fs/promises";

import type { INestApplication } from "@nestjs/common";
import type { App } from "supertest/types.js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MONEY_PATTERN } from "../money/money.js";
import { asPrismaClient, createTestApp, stubPrisma } from "../testing/test-app.js";

import { OPENAPI_PATH, renderOpenApi } from "./render.js";

interface Operation {
  readonly security?: readonly unknown[];
  readonly responses: Record<string, { readonly content?: unknown } | undefined>;
}

interface Document {
  readonly paths: Record<string, { readonly get?: Operation } | undefined>;
  readonly components: {
    readonly schemas: Record<string, { readonly type?: string; readonly pattern?: string }>;
  };
}

describe("the committed OpenAPI document", () => {
  it("is exactly what the code generates: run `pnpm openapi` if this fails", async () => {
    expect(await renderOpenApi()).toBe(await readFile(OPENAPI_PATH, "utf8"));
  });

  const committed = async (): Promise<Document> =>
    JSON.parse(await readFile(OPENAPI_PATH, "utf8")) as Document;

  it("describes money as a string with a decimal pattern", async () => {
    const { components } = await committed();

    expect(components.schemas["Money"]).toMatchObject({ type: "string", pattern: MONEY_PATTERN });
  });

  it("has the routes of this story and no test-only route", async () => {
    const { paths } = await committed();

    expect(Object.keys(paths).sort()).toEqual(["/health", "/health/ready", "/me"]);
  });

  it("marks /me as needing a bearer token and the health routes as not", async () => {
    const { paths } = await committed();

    expect(paths["/me"]?.get?.security).toEqual([{ bearer: [] }]);
    expect(paths["/health"]?.get?.security).toBeUndefined();
    expect(paths["/health/ready"]?.get?.security).toBeUndefined();
  });

  it("documents the failures in the error shape", async () => {
    const { paths } = await committed();
    const errorShape = {
      "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } },
    };

    for (const status of ["401", "403", "429", "500"]) {
      expect(paths["/me"]?.get?.responses[status]?.content).toEqual(errorShape);
    }
    expect(paths["/health/ready"]?.get?.responses["503"]?.content).toEqual(errorShape);
  });
});

describe("the served document", () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp(asPrismaClient(stubPrisma()));
  });

  afterAll(async () => {
    await app.close();
  });

  it("is served as JSON with no token", async () => {
    const response = await request(app.getHttpServer()).get("/docs-json");

    expect(response.status).toBe(200);
    expect((response.body as Document).components.schemas["Money"]).toBeDefined();
  });

  it("serves the UI with no token", async () => {
    expect((await request(app.getHttpServer()).get("/docs")).status).toBe(200);
  });
});
