import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";

import { ConfigModule } from "./config/config.module.js";
import type { AppConfig } from "./config/config.js";
import { DatabaseModule } from "./database/database.module.js";

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(config), DatabaseModule],
    };
  }
}
