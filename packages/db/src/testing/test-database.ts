import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Client } from "pg";

/**
 * The rules every disposable test database follows, shared by `global-setup.ts` (one per run) and
 * `create-test-database.ts` (one per caller).
 *
 * The ledger is append-only, so a test that writes into a long-lived database leaves those rows
 * there forever, and one that creates a TREASURY takes the single slot the rule allows. ledger.md
 * section 4 draws the line exactly here: append-only "applies to any ledger that has ever been a
 * source of truth, so a disposable test database is not one".
 *
 * Dropping one of these is not the destructive operation CLAUDE.md forbids. It is created by this
 * code, uniquely named, never a source of truth, and reachable by nothing else.
 */

/** The compose server from docker-compose.yml, used when DATABASE_URL says nothing. */
const LOCAL_SERVER_URL = "postgresql://orderflow:orderflow@localhost:55432/orderflow";

/** Long enough to fail on a stopped container, short enough not to stall a Docker-less run. */
const CONNECT_TIMEOUT_MS = 3_000;
const MIGRATE_TIMEOUT_MS = 120_000;

const PACKAGE_NAME = "@orderflow/db";

/**
 * Walks up from this file to the package that owns the migrations, so the answer is the same from
 * `src/testing` and from `dist/testing`.
 */
const findPackageDir = (start: string): string => {
  let dir = start;
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
      if (name === PACKAGE_NAME) {
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`no ${PACKAGE_NAME} package.json above ${start}`);
    }
    dir = parent;
  }
};

/** `orderflow_test_<unique>`, so two databases never share a name. */
export const testDatabaseName = (): string =>
  `orderflow_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/** An identifier is interpolated into SQL, so it may hold letters, digits and underscores only. */
const quoteIdentifier = (name: string): string => {
  if (!/^[a-z0-9_]+$/u.test(name)) {
    throw new Error(`refusing to use ${name} as a database name`);
  }
  return `"${name}"`;
};

/**
 * The Postgres server the tests should use: `DATABASE_URL`, or the compose server.
 *
 * An empty `DATABASE_URL` means the same as an unset one. A workflow that sets the variable
 * conditionally leaves it empty on the legs that do not want it, and `??` alone would take
 * that empty string as the server URL and fail to connect to nothing.
 */
export const serverUrlFrom = (env: NodeJS.ProcessEnv): string => {
  const configured = env["DATABASE_URL"];
  return configured === undefined || configured === "" ? LOCAL_SERVER_URL : configured;
};

export const withDatabase = (serverUrl: string, database: string): string => {
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  return url.toString();
};

/** Opens an admin connection, or returns null when no server answers. */
export const connectToServer = async (serverUrl: string): Promise<Client | null> => {
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

export const createDatabase = async (admin: Client, database: string): Promise<void> => {
  await admin.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
};

/**
 * Applies every migration to the database at `databaseUrl`.
 *
 * @throws when the migration fails. The caller owns the database and drops it: nothing else would.
 */
export const migrateDatabase = (databaseUrl: string, env: NodeJS.ProcessEnv): void => {
  const migrate = spawnSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd: findPackageDir(import.meta.dirname),
    env: { ...env, DATABASE_URL: databaseUrl },
    encoding: "utf8",
    timeout: MIGRATE_TIMEOUT_MS,
  });

  if (migrate.status !== 0) {
    const detail = migrate.stderr || migrate.stdout || migrate.error?.message;
    throw new Error(`could not migrate the test database:\n${detail ?? "no output"}`);
  }
};

export const dropDatabase = async (admin: Client, database: string): Promise<void> => {
  // Connections the tests left open would block the drop, so they are closed first.
  await admin.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    [database],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`);
};
