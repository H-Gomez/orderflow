import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";

import { ConfigModule } from "./config/config.module.js";
import type { AppConfig } from "./config/config.js";
import { DatabaseModule } from "./database/database.module.js";
import { AllExceptionsFilter } from "./errors/all-exceptions.filter.js";

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(config), DatabaseModule],
      providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
    };
  }
}
