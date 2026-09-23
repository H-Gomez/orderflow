import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { Client } from "pg";

/**
 * Gives the database tests their own database, created for the run and dropped after it.
 *
 * The ledger is append-only, so a test that writes into a long-lived database leaves those
 * rows there forever, and one that creates a TREASURY takes the single slot the rule allows.
 * Pointed at a developer's dev database, the suite would poison it on the first run and fail
 * on the second. ledger.md section 4 draws the line exactly here: append-only "applies to any
 * ledger that has ever been a source of truth, so a disposable test database is not one".
 *
 * Dropping this database is not the destructive operation CLAUDE.md forbids. It is created by
 * this file, named for this run, never a source of truth, and reachable by nothing else.
 */

/** Where the tests read the URL of the database this file made. */
const TEST_DATABASE_URL = "ORDERFLOW_TEST_DATABASE_URL";

/** The compose server from docker-compose.yml, used when DATABASE_URL says nothing. */
const LOCAL_SERVER_URL = "postgresql://orderflow:orderflow@localhost:55432/orderflow";

/** Long enough to fail on a stopped container, short enough not to stall a Docker-less run. */
const CONNECT_TIMEOUT_MS = 3_000;
const MIGRATE_TIMEOUT_MS = 120_000;

const packageDir = join(import.meta.dirname, "..", "..");

/** Held between setup and teardown: the admin connection and what it has to clean up. */
let admin: Client | null = null;
let createdDatabase: string | null = null;

/** `orderflow_test_<run>`, unique per run so two runs never share one. */
const testDatabaseName = (): string =>
  `orderflow_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/** An identifier is interpolated into SQL, so it may hold letters, digits and underscores only. */
const quoteIdentifier = (name: string): string => {
  if (!/^[a-z0-9_]+$/u.test(name)) {
    throw new Error(`refusing to use ${name} as a database name`);
  }
  return `"${name}"`;
};

const withDatabase = (serverUrl: string, database: string): string => {
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  return url.toString();
};

/** Opens an admin connection, or returns null when no server answers. */
const connectToServer = async (serverUrl: string): Promise<Client | null> => {
  const client = new Client({
    connectionString: serverUrl,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  try {
    await client.connect();
    return client;
  } catch {
    await client.end().catch(() => undefined);
    return null;
  }
};

export const setup = async (): Promise<void> => {
  const serverUrl = process.env["DATABASE_URL"] ?? LOCAL_SERVER_URL;
  admin = await connectToServer(serverUrl);

  if (admin === null) {
    // No server answered, so the tests see no URL and skip themselves. That is what should
    // happen on a machine with no Docker.
    return;
  }

  const database = testDatabaseName();
  const databaseUrl = withDatabase(serverUrl, database);
  await admin.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
  createdDatabase = database;

  const migrate = spawnSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd: packageDir,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
    timeout: MIGRATE_TIMEOUT_MS,
  });

  if (migrate.status !== 0) {
    throw new Error(`could not migrate the test database:\n${migrate.stderr || migrate.stdout}`);
  }

  process.env[TEST_DATABASE_URL] = databaseUrl;
};

export const teardown = async (): Promise<void> => {
  Reflect.deleteProperty(process.env, TEST_DATABASE_URL);

  if (admin !== null && createdDatabase !== null) {
    // Connections the tests left open would block the drop, so they are closed first.
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [createdDatabase],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(createdDatabase)}`);
  }

  await admin?.end();
  admin = null;
  createdDatabase = null;
};
