import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  dateTimeSchema,
  decodeCursor,
  encodeCursor,
  listQuerySchema,
  pageSchema,
} from "./pagination.js";

const keySchema = z.strictObject({ createdAt: dateTimeSchema, id: z.uuid() });
const ID = "0193f2c4-7b1e-7c3a-9d2f-5e8a1b4c6d70";
const key = { createdAt: "2026-11-05T10:00:00.000Z", id: ID };

const querySchema = listQuerySchema(keySchema, { currency: z.string().optional() });

const issuePaths = (query: unknown): string[] => {
  const parsed = querySchema.safeParse(query);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."));
};

const encoded = (text: string): string => Buffer.from(text, "utf8").toString("base64url");

describe("the cursor", () => {
  it("round-trips the sort key", () => {
    expect(decodeCursor(keySchema, encodeCursor(keySchema, key))).toEqual({
      createdAt: new Date("2026-11-05T10:00:00.000Z"),
      id: ID,
    });
  });

  it("is base64url of the JSON key", () => {
    expect(encodeCursor(keySchema, key)).toBe(encoded(JSON.stringify(key)));
    expect(encodeCursor(keySchema, key)).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it.each([
    ["empty", ""],
    ["not base64url", "not a cursor!"],
    ["not JSON", encoded("not json")],
    ["JSON of the wrong type", encoded("42")],
    ["JSON null", encoded("null")],
    ["a missing field", encoded(JSON.stringify({ id: ID }))],
    ["an id that is not a uuid", encoded(JSON.stringify({ ...key, id: "abc" }))],
    ["a NUL in the id", encoded(JSON.stringify({ ...key, id: "\u0000" }))],
    ["a date that is not a date", encoded(JSON.stringify({ ...key, createdAt: "soon" }))],
    ["an extra field", encoded(JSON.stringify({ ...key, accountId: ID }))],
  ])("rejects %s without throwing", (_name, cursor) => {
    expect(decodeCursor(keySchema, cursor)).toBeUndefined();
    expect(issuePaths({ cursor })).toEqual(["cursor"]);
  });
});

describe("the query schema", () => {
  it("defaults limit to 50", () => {
    expect(querySchema.parse({}).limit).toBe(50);
  });

  it.each([
    ["1", 1],
    ["200", 200],
  ])("accepts limit=%s", (limit, expected) => {
    expect(querySchema.parse({ limit }).limit).toBe(expected);
  });

  it.each(["0", "201", "", "-1", "1.5", "1e2", " 5", "abc", "9".repeat(400)])(
    "rejects limit=%s",
    (limit) => {
      expect(issuePaths({ limit })).toEqual(["limit"]);
    },
  );

  it("rejects a repeated parameter", () => {
    expect(issuePaths({ limit: ["5"] })).toEqual(["limit"]);
    expect(issuePaths({ limit: "5", from: ["2026-11-05T10:00:00Z"] })).toEqual(["from"]);
  });

  it("compares from and to as instants, across offsets", () => {
    const parsed = querySchema.parse({
      from: "2026-11-05T11:00:00+02:00",
      to: "2026-11-05T10:00:00Z",
    });

    expect(parsed.from).toEqual(new Date("2026-11-05T09:00:00.000Z"));
    expect(parsed.to).toEqual(new Date("2026-11-05T10:00:00.000Z"));
  });

  it.each([
    ["later", "2026-11-05T10:00:01Z", "2026-11-05T10:00:00Z"],
    ["equal", "2026-11-05T10:00:00Z", "2026-11-05T10:00:00Z"],
    ["the same instant at another offset", "2026-11-05T12:00:00+02:00", "2026-11-05T10:00:00Z"],
  ])("reports from %s than to at the path to", (_name, from, to) => {
    expect(issuePaths({ from, to })).toEqual(["to"]);
  });

  it.each(["2026-11-05", "2026-11-05T10:00:00", "2026-13-01T00:00:00Z", "yesterday"])(
    "rejects %s, which is not a date-time with an offset",
    (from) => {
      expect(issuePaths({ from })).toEqual(["from"]);
    },
  );

  it("rejects precision finer than the stored millisecond", () => {
    expect(issuePaths({ from: "2026-11-05T10:00:00.1234Z" })).toEqual(["from"]);
    expect(issuePaths({ to: "2026-11-05T10:00:00.123Z" })).toEqual([]);
  });

  it("reports an invalid from beside a valid to at from, without throwing", () => {
    expect(issuePaths({ from: "2026-11-05T10:00:00.1234Z", to: "2026-11-05T11:00:00Z" })).toEqual([
      "from",
    ]);
  });

  it("reports an invalid to beside a valid from at to, without throwing", () => {
    expect(issuePaths({ from: "2026-11-05T10:00:00Z", to: "2026-11-05T11:00:00.1234Z" })).toEqual([
      "to",
    ]);
  });

  it("rejects an unknown parameter at the object's own path", () => {
    const parsed = querySchema.safeParse({ accountId: ID });

    expect(parsed.error?.issues).toMatchObject([
      { path: [], message: 'Unrecognized key: "accountId"' },
    ]);
  });

  it("keeps the endpoint's own filters", () => {
    expect(querySchema.parse({ currency: "USD" }).currency).toBe("USD");
  });
});

describe("the page envelope", () => {
  const schema = pageSchema(z.string());

  it("takes a cursor, or null on the last page", () => {
    expect(schema.safeParse({ items: ["a"], nextCursor: "abc" }).success).toBe(true);
    expect(schema.safeParse({ items: [], nextCursor: null }).success).toBe(true);
    expect(schema.safeParse({ items: [] }).success).toBe(false);
  });
});
