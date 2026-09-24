/**
 * Decides whether the database tests run, skip or fail.
 *
 * `global-setup.ts` sets `ORDERFLOW_TEST_DATABASE_URL` only once it has created and migrated a
 * database for the run. Without it the database tests cannot run. On a developer machine with
 * no Docker that is expected, and they skip so `pnpm test` stays green. In CI it means the
 * pipeline is misconfigured: a test that skips there passes by doing nothing, so it fails
 * instead.
 *
 * The check is on the database setup actually produced, not on `DATABASE_URL` alone, so a CI
 * job whose `DATABASE_URL` points at a server that never came up fails too rather than skipping.
 *
 * Every database test file calls this rather than reading the variable itself, so the
 * condition lives in one place.
 */

/** Where `global-setup.ts` leaves the URL of the database it made for this run. */
const TEST_DATABASE_URL = "ORDERFLOW_TEST_DATABASE_URL";

/** GitHub Actions and most CI providers set `CI=true`; `false` or empty means not CI. */
const isCi = (env: NodeJS.ProcessEnv): boolean => {
  const ci = env["CI"];
  return ci !== undefined && ci !== "" && ci.toLowerCase() !== "false";
};

/**
 * The URL of this run's test database, or `undefined` when the database tests should skip.
 *
 * @throws when `CI` is set and no test database was created, so CI never passes on skipped
 *   database tests.
 */
export const testDatabaseUrl = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const url = env[TEST_DATABASE_URL];
  if (url !== undefined && url !== "") {
    return url;
  }

  if (isCi(env)) {
    throw new Error(
      "CI is set but no test database was created, so the database tests cannot run. " +
        "Set DATABASE_URL to a reachable Postgres on the image and credentials in " +
        "docker-compose.yml, and apply the migrations first (see packages/db/README.md). " +
        "In CI the database tests fail rather than skip.",
    );
  }

  return undefined;
};
