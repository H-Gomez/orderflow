import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { PrismaClient } from "@orderflow/db";
import type { Response } from "supertest";
import type { App } from "supertest/types.js";
import { vi } from "vitest";

import { AppModule } from "../app.module.js";
import { setupApp } from "../app.setup.js";
import type { AppConfig } from "../config/config.js";
import { DatabaseModule, PRISMA_CLIENT } from "../database/database.module.js";
import type { ErrorResponse } from "../errors/error-response.js";

import { ProbeController } from "./probe.controller.js";

export const testConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  databaseUrl: "postgresql://unused:unused@127.0.0.1:1/unused",
  oidc: {
    issuer: "https://issuer.test.invalid/",
    audience: "orderflow-test-audience",
    jwksUri: "http://127.0.0.1:1/jwks.json",
    jwksCacheTtlSeconds: 600,
    jwksCooldownSeconds: 0,
  },
  rateLimit: { windowSeconds: 60, authenticated: 1_000, public: 1_000 },
  port: 0,
  ...overrides,
});

/** A client that fails a test by being asked for anything it was not given. */
export const stubPrisma = () => ({
  $disconnect: vi.fn<() => Promise<void>>().mockResolvedValue(),
  user: { findUnique: vi.fn<() => Promise<unknown>>().mockResolvedValue(null) },
});

export type StubPrisma = ReturnType<typeof stubPrisma>;

export const asPrismaClient = (stub: StubPrisma): PrismaClient => stub as unknown as PrismaClient;

/** The real application, with the test-only probe routes added and the given database client. */
export const createTestApp = async (
  prisma: PrismaClient,
  config: AppConfig = testConfig(),
): Promise<INestApplication<App>> => {
  const module = await Test.createTestingModule({
    imports: [AppModule.forRoot(config), DatabaseModule],
    controllers: [ProbeController],
  })
    .overrideProvider(PRISMA_CLIENT)
    .useValue(prisma)
    .compile();
  module.useLogger(false);

  const app = module.createNestApplication<INestApplication<App>>();
  setupApp(app);
  await app.init();
  return app;
};

export const errorBody = (response: Response): ErrorResponse => response.body as ErrorResponse;
