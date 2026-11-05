import type { OnApplicationShutdown } from "@nestjs/common";
import { Inject, Injectable, Module } from "@nestjs/common";
import { createPrismaClient } from "@orderflow/db";
import type { PrismaClient } from "@orderflow/db";

import { APP_CONFIG } from "../config/config.js";
import type { AppConfig } from "../config/config.js";

/** The injection token for the service's one database client. */
export const PRISMA_CLIENT = Symbol("PRISMA_CLIENT");

@Injectable()
export class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

/**
 * Owns the one client this service builds. It does not connect at boot: the client connects on its
 * first query, so a database that is down leaves the service up and `/health/ready` reports it.
 */
@Module({
  providers: [
    {
      provide: PRISMA_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): PrismaClient =>
        createPrismaClient({ connectionString: config.databaseUrl }),
    },
    DatabaseLifecycle,
  ],
  exports: [PRISMA_CLIENT],
})
export class DatabaseModule {}
