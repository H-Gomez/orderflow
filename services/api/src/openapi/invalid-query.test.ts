import { readFile } from "node:fs/promises";

import type { INestApplication } from "@nestjs/common";
import { AccountType } from "@orderflow/db";
import type { App } from "supertest/types.js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  asPrismaClient,
  createTestApp,
  errorBody,
  stubPrisma,
  testConfig,
} from "../testing/test-app.js";
import { TestOidc } from "../testing/test-oidc.js";

import { OPENAPI_PATH } from "./render.js";

/**
 * Every documented query parameter, sent a value its documented schema refuses, is a 400 at that
 * parameter and never a 5xx. Cases come from the committed `openapi.json`, so a new route or
 * parameter is covered without editing this file. Validation runs before any read, so the stub
 * database answers only the account lookup; a value that wrongly passes reaches a missing stub
 * method and fails here as a 500.
 */

interface ParameterSchema {
  readonly type?: string;
  readonly format?: string;
  readonly pattern?: string;
  readonly enum?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
}

interface Parameter {
  readonly in: string;
  readonly name: string;
  readonly required?: boolean;
  readonly schema: ParameterSchema;
}

/** Every operation is walked, not only GET, so a query on a future POST is covered too. */
const METHODS = ["get", "post", "put", "patch", "delete"] as const;
type Method = (typeof METHODS)[number];

interface Document {
  readonly paths: Record<
    string,
    Partial<Record<Method, { readonly parameters?: readonly Parameter[] }>>
  >;
}

/** A value each parameter name accepts, for the parameters a case leaves alone. */
const VALID: Readonly<Record<string, string>> = {
  currency: "USD",
  instrument: "BTC-USD",
  interval: "1h",
  from: "2026-01-01T00:00:00.000Z",
  to: "2026-01-02T00:00:00.000Z",
  limit: "50",
};

/**
 * Refused values for parameters whose documented schema is a bare string, so it names nothing to
 * refuse. A cursor is refused when it is not base64url, or is base64url of JSON that is no sort key.
 */
const INVALID_BY_NAME: Readonly<Record<string, readonly string[]>> = {
  cursor: ["!!!", Buffer.from("{}", "utf8").toString("base64url")],
};

/** Values the documented schema refuses, by the schema's own constraints, else by name. */
const invalidValues = (route: string, parameter: Parameter): readonly string[] => {
  const { name, schema } = parameter;
  if (schema.format === "date-time") {
    return [
      "yesterday",
      "2026-11-05T10:00:00",
      "2026-11-05T10:00:00.1234Z",
      "0000-01-01T00:00:00.000Z",
    ];
  }
  if (schema.enum !== undefined) {
    return ["not-an-enum-value", ""];
  }
  if (schema.pattern !== undefined) {
    const pattern = new RegExp(schema.pattern, "u");
    return ["not valid!", "", `${VALID[name] ?? "X"}X`.toLowerCase()].filter(
      (value) => !pattern.test(value),
    );
  }
  if (schema.type === "integer") {
    return [
      ...(schema.minimum === undefined ? [] : [String(schema.minimum - 1)]),
      ...(schema.maximum === undefined ? [] : [String(schema.maximum + 1)]),
      "1.5",
      "ten",
    ];
  }
  const named = INVALID_BY_NAME[name];
  if (named === undefined) {
    throw new Error(`Add refused values to INVALID_BY_NAME for ${route} parameter "${name}"`);
  }
  return named;
};

interface Case {
  readonly method: Method;
  readonly route: string;
  readonly label: string;
  readonly query: string;
  readonly expectedPath: string;
}

const casesFor = (method: Method, route: string, parameters: readonly Parameter[]): Case[] => {
  const query = parameters.filter((parameter) => parameter.in === "query");
  if (query.length === 0) {
    return [];
  }

  // Every parameter with a sample, not only the required ones: a bad value must be refused next to
  // valid neighbours, because cross-field checks (from < to) only run when the neighbour is there.
  const base = query.flatMap((parameter): [string, string][] => {
    const value = VALID[parameter.name];
    if (value === undefined && parameter.required === true) {
      throw new Error(`Add a valid sample for required ${route} parameter "${parameter.name}"`);
    }
    return value === undefined ? [] : [[parameter.name, value]];
  });
  const withValue = (name: string, pairs: readonly [string, string][]): string =>
    new URLSearchParams([...base.filter(([key]) => key !== name), ...pairs]).toString();

  const cases = query.flatMap((parameter): Case[] => {
    const { name } = parameter;
    const expectedPath = `query.${name}`;
    const sample = VALID[name];
    return [
      ...invalidValues(route, parameter).map((value) => ({
        method,
        route,
        label: `${name}=${JSON.stringify(value)}`,
        query: withValue(name, [[name, value]]),
        expectedPath,
      })),
      // Twice a valid value, so the repetition alone is what is refused.
      ...(sample === undefined
        ? []
        : [
            {
              method,
              route,
              label: `${name} given twice`,
              query: withValue(name, [
                [name, sample],
                [name, sample],
              ]),
              expectedPath,
            },
          ]),
    ];
  });

  return [
    ...cases,
    {
      method,
      route,
      label: "an undocumented parameter",
      query: withValue("", [["undocumentedParameter", "1"]]),
      expectedPath: "query",
    },
  ];
};

const document = JSON.parse(await readFile(OPENAPI_PATH, "utf8")) as Document;
const operations = Object.entries(document.paths).flatMap(([route, item]) =>
  METHODS.flatMap((method) => {
    const operation = item[method];
    return operation === undefined
      ? []
      : [{ method, route, parameters: operation.parameters ?? [] }];
  }),
);
const cases = operations.flatMap(({ method, route, parameters }) =>
  casesFor(method, route, parameters),
);

describe("an invalid query parameter on any documented route", () => {
  let oidc: TestOidc;
  let app: INestApplication<App>;
  let token: string;

  beforeAll(async () => {
    const stub = stubPrisma();
    stub.user.findUnique.mockResolvedValue({
      id: "user",
      account: { id: "account", type: AccountType.USER, createdAt: new Date() },
    });
    oidc = await TestOidc.start();
    app = await createTestApp(asPrismaClient(stub), testConfig({ oidc: oidc.config() }));
    token = await oidc.sign({ sub: "subject" });
  });

  afterAll(async () => {
    await app.close();
    await oidc.stop();
  });

  it("has cases for every operation that documents a query parameter", () => {
    const key = ({ method, route }: { method: Method; route: string }) => `${method} ${route}`;

    expect([...new Set(cases.map(key))].sort()).toEqual(
      operations
        .filter(({ parameters }) => parameters.some(({ in: where }) => where === "query"))
        .map(key)
        .sort(),
    );
  });

  it.each(cases)("$method $route with $label is a 400 at $expectedPath", async (testCase) => {
    const response = await request(app.getHttpServer())
      [testCase.method](`${testCase.route}?${testCase.query}`)
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(400);
    const paths = (errorBody(response).fields ?? []).map((field) => field.path);
    // Another field may fail as a consequence, e.g. a year-0 `from` makes the candles window too long.
    expect(paths).toContain(testCase.expectedPath);
  });
});
