import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccountType } from "../generated/prisma/enums.js";

import { createTestDatabase } from "./create-test-database.js";
import { testDatabaseUrl } from "./database-guard.js";

/**
 * createTestDatabase (story #70). The database cases skip locally when the run has no server and
 * fail under CI (database-guard.ts). The no-server cases inject an environment naming a server
 * nothing listens on, so they need no database and never skip.
 */
const runDatabaseUrl = testDatabaseUrl();

/** Creating a database spawns `prisma migrate deploy`. */
const DATABASE_TIMEOUT = 180_000;

/** Port 1 refuses at once, but a slow machine should not fail on the default five seconds. */
const NO_SERVER_TIMEOUT = 30_000;

const UNREACHABLE_SERVER = "postgresql://x:x@127.0.0.1:1/x";

type TestDatabase = NonNullable<Awaited<ReturnType<typeof createTestDatabase>>>;

const databaseNameOf = (databaseUrl: string): string => new URL(databaseUrl).pathname.slice(1);

describe.skipIf(runDatabaseUrl === undefined)("createTestDatabase with a server", () => {
  /** A separate connection on the server, so what it reports does not rest on the code under test. */
  let admin: Client;
  const opened: TestDatabase[] = [];

  beforeAll(async () => {
    admin = new Client({ connectionString: runDatabaseUrl ?? "" });
    await admin.connect();
  }, DATABASE_TIMEOUT);

  afterAll(async () => {
    await Promise.allSettled(opened.map(async (database) => database.drop()));
    await admin.end();
  }, DATABASE_TIMEOUT);

  const open = async (): Promise<TestDatabase> => {
    const database = await createTestDatabase();
    if (database === undefined) {
      throw new Error("the run has a test database, so createTestDatabase must find its server");
    }
    opened.push(database);
    return database;
  };

  const isListed = async (name: string): Promise<boolean> => {
    const { rows } = await admin.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname = $1",
      [name],
    );
    return rows.length === 1;
  };

  it(
    "returns a connected client on a fresh migrated database, its URL and drop",
    async () => {
      const { client, databaseUrl, drop } = await open();

      expect(typeof drop).toBe("function");
      expect(await isListed(databaseNameOf(databaseUrl))).toBe(true);
      expect(databaseUrl).not.toBe(runDatabaseUrl);
      // A migrated table answers, and nothing has been written to it yet.
      expect(await client.account.count()).toBe(0);
      expect(await client.hold.count()).toBe(0);
    },
    DATABASE_TIMEOUT,
  );

  it(
    "returns a client connected to the database its URL names",
    async () => {
      const { client, databaseUrl } = await open();

      const rows = await client.$queryRaw<{ name: string }[]>`
        SELECT current_database() AS name`;

      expect(rows).toEqual([{ name: databaseNameOf(databaseUrl) }]);
    },
    DATABASE_TIMEOUT,
  );

  it(
    "gives two open databases different URLs, and neither sees the other's rows",
    async () => {
      const first = await open();
      const second = await open();

      const firstRow = await first.client.account.create({ data: { type: AccountType.USER } });
      const secondRow = await second.client.account.create({ data: { type: AccountType.USER } });

      expect(first.databaseUrl).not.toBe(second.databaseUrl);
      expect(await first.client.account.findMany({ select: { id: true } })).toEqual([
        { id: firstRow.id },
      ]);
      expect(await second.client.account.findMany({ select: { id: true } })).toEqual([
        { id: secondRow.id },
      ]);
    },
    DATABASE_TIMEOUT,
  );

  it(
    "drop() removes the database from the server",
    async () => {
      const { databaseUrl, drop } = await open();
      const name = databaseNameOf(databaseUrl);
      expect(await isListed(name)).toBe(true);

      await drop();

      expect(await isListed(name)).toBe(false);
    },
    DATABASE_TIMEOUT,
  );

  it(
    "drop() is safe to call twice",
    async () => {
      const { databaseUrl, drop } = await open();

      await drop();
      await expect(drop()).resolves.toBeUndefined();

      expect(await isListed(databaseNameOf(databaseUrl))).toBe(false);
    },
    DATABASE_TIMEOUT,
  );

  it(
    "drop() removes the database even while another connection is open on it",
    async () => {
      const { databaseUrl, drop } = await open();
      const other = new Client({ connectionString: databaseUrl });
      // Terminating the connection arrives as an error event, which would otherwise be uncaught.
      other.on("error", () => undefined);
      await other.connect();

      try {
        await drop();
        expect(await isListed(databaseNameOf(databaseUrl))).toBe(false);
      } finally {
        await other.end().catch(() => undefined);
      }
    },
    DATABASE_TIMEOUT,
  );

  it(
    "drops the database before throwing when the migration fails",
    async () => {
      const testDatabases = async (): Promise<string[]> => {
        const { rows } = await admin.query<{ datname: string }>(
          "SELECT datname FROM pg_database WHERE datname LIKE 'orderflow_test_%' ORDER BY datname",
        );
        return rows.map((row) => row.datname);
      };
      const before = await testDatabases();

      // An empty PATH means the migration cannot even start, after the database has been created.
      await expect(createTestDatabase({ ...process.env, PATH: "" })).rejects.toThrow(
        "could not migrate the test database",
      );

      expect(await testDatabases()).toEqual(before);
    },
    DATABASE_TIMEOUT,
  );
});

describe("createTestDatabase with no server answering", () => {
  it(
    "resolves undefined without CI, so a test file can skip",
    async () => {
      await expect(
        createTestDatabase({ DATABASE_URL: UNREACHABLE_SERVER }),
      ).resolves.toBeUndefined();
    },
    NO_SERVER_TIMEOUT,
  );

  it(
    "rejects under CI, so CI cannot pass by skipping",
    async () => {
      await expect(
        createTestDatabase({ DATABASE_URL: UNREACHABLE_SERVER, CI: "true" }),
      ).rejects.toThrow();
    },
    NO_SERVER_TIMEOUT,
  );
});
