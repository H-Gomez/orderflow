import type { Client } from "pg";

import {
  connectToServer,
  createDatabase,
  dropDatabase,
  migrateDatabase,
  serverUrlFrom,
  testDatabaseName,
  withDatabase,
} from "./test-database.js";

export { serverUrlFrom } from "./test-database.js";

/**
 * Gives the database tests their own database, created for the run and dropped after it. The rules
 * every such database follows, and why dropping one is allowed, are in `test-database.ts`.
 *
 * Pointed at a developer's dev database, the suite would poison it on the first run and fail on the
 * second.
 */

/** Where the tests read the URL of the database this file made. */
const TEST_DATABASE_URL = "ORDERFLOW_TEST_DATABASE_URL";

/** Held between setup and teardown: the admin connection and what it has to clean up. */
let admin: Client | null = null;
let createdDatabase: string | null = null;

export const setup = async (): Promise<void> => {
  const serverUrl = serverUrlFrom(process.env);
  admin = await connectToServer(serverUrl);

  if (admin === null) {
    // No server answered, so the tests see no URL and skip themselves. That is what should
    // happen on a machine with no Docker.
    return;
  }

  const database = testDatabaseName();
  const databaseUrl = withDatabase(serverUrl, database);
  await createDatabase(admin, database);
  createdDatabase = database;

  try {
    migrateDatabase(databaseUrl, process.env);
  } catch (error) {
    // Teardown does not run when setup throws, so this database would sit on the server
    // forever, one per failed run. It is dropped here instead, and the migration error is
    // what reaches the caller.
    await teardown();
    throw error;
  }

  process.env[TEST_DATABASE_URL] = databaseUrl;
};

export const teardown = async (): Promise<void> => {
  Reflect.deleteProperty(process.env, TEST_DATABASE_URL);

  if (admin !== null && createdDatabase !== null) {
    await dropDatabase(admin, createdDatabase);
  }

  await admin?.end();
  admin = null;
  createdDatabase = null;
};
