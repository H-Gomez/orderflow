import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { OpenAPIObject } from "@nestjs/swagger";
import { z } from "zod";

import { AppModule } from "../app.module.js";
import type { AppConfig } from "../config/config.js";
import { errorResponseSchema } from "../errors/error-response.js";
import { livenessResponseSchema, readinessResponseSchema } from "../health/health.controller.js";
import { meResponseSchema } from "../me/me.controller.js";
import { moneySchema } from "../money/money.js";

type ComponentSchema = NonNullable<NonNullable<OpenAPIObject["components"]>["schemas"]>[string];

/** zod's JSON Schema type is wider than Swagger's, though the `openapi-3.0` target emits only that. */
const componentSchema = (schema: z.ZodType, description: string): ComponentSchema =>
  ({
    ...z.toJSONSchema(schema, { target: "openapi-3.0" }),
    description,
  }) as ComponentSchema;

/**
 * Named here, in one place, from the zod schemas the service itself uses. No route returns money
 * yet, so `Money` is published for the #36 endpoints to reference.
 */
const COMPONENTS = {
  ErrorResponse: componentSchema(errorResponseSchema, "The shape of every failure."),
  LivenessResponse: componentSchema(livenessResponseSchema, "The process is up."),
  MeResponse: componentSchema(meResponseSchema, "The authenticated caller's account."),
  Money: componentSchema(
    moneySchema,
    "An exact decimal amount as a string, NUMERIC(38, 18). Never a JSON number, so precision survives, and never in exponent notation. It is not rounded to any display scale.",
  ),
  ReadinessResponse: componentSchema(readinessResponseSchema, "The database answered."),
};

/** The OpenAPI document for an application, with the named components added. */
export const createOpenApiDocument = (app: INestApplication): OpenAPIObject => {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle("OrderFlow API")
      .setDescription("Every failure uses the ErrorResponse shape. All money is a Money string.")
      .setVersion("0.0.0")
      .addBearerAuth()
      .build(),
  );
  return {
    ...document,
    components: {
      ...document.components,
      schemas: { ...document.components?.schemas, ...COMPONENTS },
    },
  };
};

/** Never read: `preview` builds the route graph without instantiating a provider. */
const PLACEHOLDER_CONFIG: AppConfig = {
  databaseUrl: "postgresql://placeholder.invalid/placeholder",
  oidc: {
    issuer: "https://issuer.invalid/",
    audience: "placeholder",
    jwksUri: "https://issuer.invalid/jwks.json",
    jwksCacheTtlSeconds: 1,
    jwksCooldownSeconds: 0,
  },
  rateLimit: { windowSeconds: 1, authenticated: 1, public: 1 },
  port: 0,
};

/** The document for the service, with no database, identity provider or environment involved. */
export const buildOpenApiDocument = async (): Promise<OpenAPIObject> => {
  const app = await NestFactory.create(AppModule.forRoot(PLACEHOLDER_CONFIG), {
    preview: true,
    logger: false,
  });
  return createOpenApiDocument(app);
};
