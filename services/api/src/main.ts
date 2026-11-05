import "reflect-metadata";

import { NestFactory } from "@nestjs/core";

import { AppModule } from "./app.module.js";
import { setupApp } from "./app.setup.js";
import type { AppConfig } from "./config/config.js";
import { run } from "./run.js";

const start = async (config: AppConfig): Promise<void> => {
  const app = await NestFactory.create(AppModule.forRoot(config));
  setupApp(app);
  await app.listen(config.port);
};

process.exitCode = await run(process.env, start, (message) => {
  process.stderr.write(`${message}\n`);
});
