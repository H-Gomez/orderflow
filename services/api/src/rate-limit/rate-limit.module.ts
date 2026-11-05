import type { ExecutionContext } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";

import { isPublicRoute } from "../auth/public.decorator.js";
import { APP_CONFIG } from "../config/config.js";
import type { AppConfig } from "../config/config.js";

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: ({ rateLimit }: AppConfig) => {
        const reflector = new Reflector();
        return [
          {
            ttl: rateLimit.windowSeconds * 1_000,
            limit: (context: ExecutionContext) =>
              isPublicRoute(reflector, context) ? rateLimit.public : rateLimit.authenticated,
          },
        ];
      },
    }),
  ],
  exports: [ThrottlerModule],
})
export class RateLimitModule {}
