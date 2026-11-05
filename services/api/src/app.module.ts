import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";

import { AccountGuard } from "./auth/account.guard.js";
import { AuthModule } from "./auth/auth.module.js";
import { JwtAuthGuard } from "./auth/jwt-auth.guard.js";
import { ConfigModule } from "./config/config.module.js";
import type { AppConfig } from "./config/config.js";
import { DatabaseModule } from "./database/database.module.js";
import { AllExceptionsFilter } from "./errors/all-exceptions.filter.js";
import { MoneyInterceptor } from "./money/money.interceptor.js";
import { PrincipalThrottlerGuard } from "./rate-limit/principal-throttler.guard.js";
import { RateLimitModule } from "./rate-limit/rate-limit.module.js";

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(config), DatabaseModule, AuthModule, RateLimitModule],
      providers: [
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_INTERCEPTOR, useClass: MoneyInterceptor },
        // Global guards run in this order. No valid token never reaches the database, and neither does
        // a caller over its limit.
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: PrincipalThrottlerGuard },
        { provide: APP_GUARD, useClass: AccountGuard },
      ],
    };
  }
}
