import { createPrismaClient } from "../client.js";
import type { PrismaClient } from "../generated/prisma/client.js";

import { testDatabaseUrl } from "./database-guard.js";
import {
  connectToServer,
  createDatabase,
  dropDatabase,
  migrateDatabase,
  serverUrlFrom,
  testDatabaseName,
  withDatabase,
} from "./test-database.js";

export interface TestDatabase {
  /** Connected to this database. `drop` disconnects it. */
  readonly client: PrismaClient;
  readonly databaseUrl: string;
  /** Disconnects the client, then drops the database. Safe to call twice. */
  readonly drop: () => Promise<void>;
}

/** Opens its own admin connection, so a test file holds none between creating and dropping. */
const dropOnServer = async (serverUrl: string, database: string): Promise<void> => {
  const admin = await connectToServer(serverUrl);
  if (admin === null) {
    throw new Error(`no server answered, so test database ${database} was not dropped`);
  }
  try {
    await dropDatabase(admin, database);
  } finally {
    await admin.end();
  }
};

/**
 * A fresh, migrated database of the caller's own, on the server `DATABASE_URL` names or the compose
 * server. Unlike the one `global-setup.ts` makes for a whole run, nothing else writes to it.
 *
 * With no server, the same rules as `global-setup.ts` and `database-guard.ts` apply: it resolves
 * `undefined` so a test file can skip on a machine with no Docker, and throws under `CI` so a
 * pipeline with no database cannot pass by doing nothing.
 *
 * @param env where `DATABASE_URL` and `CI` are read from, and what the migration runs with.
 */
export const createTestDatabase = async (
  env: NodeJS.ProcessEnv = process.env,
): Promise<TestDatabase | undefined> => {
  const serverUrl = serverUrlFrom(env);
  const admin = await connectToServer(serverUrl);

  if (admin === null) {
    // Only CI is passed: a run's own database URL in `env` says nothing about this server.
    testDatabaseUrl({ CI: env["CI"] });
    return undefined;
  }

  const database = testDatabaseName();
  try {
    await createDatabase(admin, database);
  } finally {
    await admin.end();
  }

  const databaseUrl = withDatabase(serverUrl, database);
  let client: PrismaClient;
  try {
    migrateDatabase(databaseUrl, env);
    client = createPrismaClient({ connectionString: databaseUrl });
    await client.$connect();
  } catch (error) {
    // The caller never gets a `drop`, so this database would sit on the server forever.
    await dropOnServer(serverUrl, database);
    throw error;
  }

  let dropping: Promise<void> | undefined;
  const drop = async (): Promise<void> => {
    dropping ??= client.$disconnect().then(async () => dropOnServer(serverUrl, database));
    return dropping;
  };

  return { client, databaseUrl, drop };
};
