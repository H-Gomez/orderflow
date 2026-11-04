import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountType } from "../generated/prisma/enums.js";

import { createTestDatabase } from "./create-test-database.js";
import { testDatabaseUrl } from "./database-guard.js";

/**
 * One of a pair with isolation-a.test.ts (story #70). Each file makes its own database, writes
 * one row and expects to see only that row, so if the two shared a database, whichever ran second
 * would see two.
 */
const runDatabaseUrl = testDatabaseUrl();

/** Creating a database spawns `prisma migrate deploy`. */
const CREATE_TIMEOUT = 180_000;

type TestDatabase = NonNullable<Awaited<ReturnType<typeof createTestDatabase>>>;

describe.skipIf(runDatabaseUrl === undefined)("database isolation, file B", () => {
  let database: TestDatabase | undefined;
  let rowId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    if (database === undefined) {
      throw new Error("the run has a test database, so createTestDatabase must find its server");
    }
    rowId = (await database.client.account.create({ data: { type: AccountType.USER } })).id;
  }, CREATE_TIMEOUT);

  afterAll(async () => {
    await database?.drop();
  }, CREATE_TIMEOUT);

  it("does not use the run's shared database", () => {
    expect(database?.databaseUrl).not.toBe(runDatabaseUrl);
  });

  it("sees exactly its own row", async () => {
    const client = database?.client;

    expect(await client?.account.count()).toBe(1);
    expect(await client?.account.findMany({ select: { id: true } })).toEqual([{ id: rowId }]);
  });
});
