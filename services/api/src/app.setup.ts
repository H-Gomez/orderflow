import type { INestApplication } from "@nestjs/common";

import { correlationId } from "./errors/correlation-id.middleware.js";

/** What the running server and the tests' application share. */
export const setupApp = (app: INestApplication): void => {
  app.enableShutdownHooks();
  app.use(correlationId);
};
