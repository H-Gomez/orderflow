import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";

import { AccountGuard } from "./auth/account.guard.js";
import { AuthModule } from "./auth/auth.module.js";
import { JwtAuthGuard } from "./auth/jwt-auth.guard.js";
import { ConfigModule } from "./config/config.module.js";
import type { AppConfig } from "./config/config.js";
import { DatabaseModule } from "./database/database.module.js";
import { AllExceptionsFilter } from "./errors/all-exceptions.filter.js";

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(config), DatabaseModule, AuthModule],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        // Global guards run in this order, so a request without a valid token never reaches the database.
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: AccountGuard },
      ],
    };
  }
}
