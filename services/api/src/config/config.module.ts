import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";

import { APP_CONFIG } from "./config.js";
import type { AppConfig } from "./config.js";

@Module({})
export class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      global: true,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
