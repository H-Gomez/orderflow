import { existsSync } from "node:fs";
import { join } from "node:path";

import { defineConfig } from "prisma/config";

// Node loads .env itself, so Prisma needs no dotenv dependency. The file is untracked and
// optional: see .env.example for the local development values.
const envFile = join(import.meta.dirname, ".env");
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

/**
 * The docker-compose database, with its local development credentials. It is a fallback, not
 * a secret: a real environment sets DATABASE_URL, and nothing outside a developer's machine
 * can reach this host and port.
 */
const LOCAL_DATABASE_URL = "postgresql://orderflow:orderflow@localhost:55432/orderflow";

/**
 * Scratch database for `prisma migrate diff --from-migrations`, which replays the migrations
 * somewhere disposable before comparing them with the schema. Prisma creates and drops it
 * itself, and nothing ever reads it.
 */
const LOCAL_SHADOW_DATABASE_URL =
  "postgresql://orderflow:orderflow@localhost:55432/orderflow_shadow";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: process.env["DATABASE_URL"] ?? LOCAL_DATABASE_URL,
    shadowDatabaseUrl: process.env["SHADOW_DATABASE_URL"] ?? LOCAL_SHADOW_DATABASE_URL,
  },
});
