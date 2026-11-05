import type { INestApplication } from "@nestjs/common";
import { SwaggerModule } from "@nestjs/swagger";

import { correlationId } from "./errors/correlation-id.middleware.js";
import { createOpenApiDocument } from "./openapi/document.js";

/** What the running server and the tests' application share. */
export const setupApp = (app: INestApplication): void => {
  app.enableShutdownHooks();
  app.use(correlationId);
  SwaggerModule.setup("docs", app, () => createOpenApiDocument(app));
};
