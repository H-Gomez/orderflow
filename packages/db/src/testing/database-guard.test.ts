import { describe, expect, it } from "vitest";

import { testDatabaseUrl } from "./database-guard.js";

/** The guard reads an injected environment, so these tests need no database and never skip. */
describe("testDatabaseUrl", () => {
  const url = "postgresql://orderflow:orderflow@localhost:5432/orderflow_test_run";

  it("returns the test database URL when setup created one", () => {
    expect(testDatabaseUrl({ ORDERFLOW_TEST_DATABASE_URL: url })).toBe(url);
  });

  it("returns the test database URL under CI too", () => {
    expect(testDatabaseUrl({ ORDERFLOW_TEST_DATABASE_URL: url, CI: "true" })).toBe(url);
  });

  it("skips locally when no test database was created", () => {
    expect(testDatabaseUrl({})).toBeUndefined();
  });

  it("skips when CI is empty or false", () => {
    expect(testDatabaseUrl({ CI: "" })).toBeUndefined();
    expect(testDatabaseUrl({ CI: "false" })).toBeUndefined();
  });

  it("treats an empty test database URL as absent", () => {
    expect(testDatabaseUrl({ ORDERFLOW_TEST_DATABASE_URL: "" })).toBeUndefined();
  });

  it("fails under CI when no test database was created", () => {
    expect(() => testDatabaseUrl({ CI: "true" })).toThrow(/CI is set/u);
  });

  it("fails under CI even when DATABASE_URL is set but no database was created", () => {
    expect(() =>
      testDatabaseUrl({ CI: "true", DATABASE_URL: "postgresql://localhost:5432/orderflow" }),
    ).toThrow(/no test database was created/u);
  });

  it("names both variables and the compose file in the failure", () => {
    expect(() => testDatabaseUrl({ CI: "true", ORDERFLOW_TEST_DATABASE_URL: "" })).toThrow(
      /CI.*DATABASE_URL.*docker-compose\.yml/su,
    );
  });
});
