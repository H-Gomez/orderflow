import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client.js";

/** Options for {@link createPrismaClient}. */
export interface PrismaClientOptions {
  /** Postgres connection string. Defaults to `DATABASE_URL`. */
  readonly connectionString?: string;
}

/**
 * Builds a client for the OrderFlow database.
 *
 * Prisma 7 requires a driver adapter, so the connection string is passed here rather than
 * read from the schema. Nothing in this package holds a module-level singleton: a caller owns
 * its client and disconnects it, which keeps tests independent of each other.
 */
export const createPrismaClient = (options: PrismaClientOptions = {}): PrismaClient => {
  const connectionString = options.connectionString ?? process.env["DATABASE_URL"];
  if (connectionString === undefined || connectionString === "") {
    throw new Error("DATABASE_URL is not set; see packages/db/.env.example");
  }

  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
};
