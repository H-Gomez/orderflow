import { Test } from "@nestjs/testing";
import type { PrismaClient } from "@orderflow/db";
import { describe, expect, it, vi } from "vitest";

import { ConfigModule } from "../config/config.module.js";
import { parseConfig } from "../config/config.js";

import { DatabaseModule, PRISMA_CLIENT } from "./database.module.js";

const config = parseConfig({
  DATABASE_URL: "postgresql://user:password@127.0.0.1:1/unreachable",
  OIDC_ISSUER: "https://issuer.example.invalid/",
  OIDC_AUDIENCE: "orderflow-api",
  OIDC_JWKS_URI: "https://issuer.example.invalid/jwks.json",
});

const compile = async () =>
  Test.createTestingModule({ imports: [ConfigModule.forRoot(config), DatabaseModule] }).compile();

describe("DatabaseModule", () => {
  it("builds a client without connecting, so an unreachable database does not stop the boot", async () => {
    const module = await compile();
    await module.init();

    expect(module.get(PRISMA_CLIENT)).toBeDefined();

    await module.close();
  });

  it("disconnects the client on shutdown", async () => {
    const module = await compile();
    const prisma = module.get<PrismaClient>(PRISMA_CLIENT);
    const disconnect = vi.spyOn(prisma, "$disconnect");

    await module.close();

    expect(disconnect).toHaveBeenCalledOnce();
  });
});
