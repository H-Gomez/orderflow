import { randomUUID } from "node:crypto";

import { Body, Controller, Get, Param, Query } from "@nestjs/common";
import type { INestApplication } from "@nestjs/common";
import type { App } from "supertest/types.js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { errorResponseSchema } from "../errors/error-response.js";
import { asPrismaClient, createTestApp, errorBody, stubPrisma } from "../testing/test-app.js";
import { unparsedInputs } from "../testing/unparsed-inputs.js";

import { ZodPipe } from "./zod.pipe.js";

describe("zod at the boundary", () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await createTestApp(asPrismaClient(stubPrisma()));
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => request(app.getHttpServer());

  it("hands the handler parsed, typed input", async () => {
    const response = await server().get("/probe/search?limit=5&side=BUY");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      received: { limit: 5, side: "BUY" },
      limitType: "number",
    });
  });

  it.each([
    ["not a number", "limit=abc", "query.limit"],
    ["out of range", "limit=1000", "query.limit"],
    ["missing", "", "query.limit"],
    ["a bad enum value", "limit=5&side=SIDEWAYS", "query.side"],
  ])("answers 400 naming the field for a query parameter that is %s", async (_name, qs, path) => {
    const response = await server().get(`/probe/search?${qs}`);

    expect(response.status).toBe(400);
    expect(errorBody(response).code).toBe("VALIDATION_FAILED");
    expect(errorBody(response).fields?.map((field) => field.path)).toContain(path);
    expect(errorResponseSchema.safeParse(response.body).success).toBe(true);
  });

  it("rejects a query parameter nobody asked for", async () => {
    const response = await server().get("/probe/search?limit=5&admin=true");

    expect(response.status).toBe(400);
    expect(errorBody(response).code).toBe("VALIDATION_FAILED");
  });

  it("parses a path parameter", async () => {
    const id = randomUUID();

    expect((await server().get(`/probe/items/${id}`)).body).toEqual({ id });
  });

  it("answers 400 naming a bad path parameter", async () => {
    const response = await server().get("/probe/items/not-a-uuid");

    expect(response.status).toBe(400);
    expect(errorBody(response).fields?.[0]?.path).toBe("param.id");
  });

  it("answers 400 naming a bad body field", async () => {
    const response = await server().post("/probe/orders").send({ quantity: 5 });

    expect(response.status).toBe(400);
    expect(errorBody(response).fields?.[0]?.path).toBe("body.quantity");
  });

  it("rejects a body field nobody asked for", async () => {
    const response = await server().post("/probe/orders").send({ quantity: "5", extra: true });

    expect(response.status).toBe(400);
  });
});

describe("unparsedInputs", () => {
  @Controller()
  class Careless {
    @Get("a")
    query(@Query() query: unknown): unknown {
      return query;
    }

    @Get("b/:id")
    param(@Param("id") id: string): string {
      return id;
    }

    @Get("c")
    body(@Body() body: unknown): unknown {
      return body;
    }

    @Get("d")
    careful(@Query(new ZodPipe(z.strictObject({}))) query: unknown): unknown {
      return query;
    }

    @Get("e")
    noInput(): string {
      return "nothing";
    }
  }

  it("catches every kind of input without a ZodPipe, and only those", () => {
    expect(unparsedInputs(Careless).sort()).toEqual([
      "Careless.body",
      "Careless.param",
      "Careless.query",
    ]);
  });
});
