import type { INestApplication } from "@nestjs/common";

/** What the running server and the tests' application share. */
export const setupApp = (app: INestApplication): void => {
  app.enableShutdownHooks();
};
