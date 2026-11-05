import { applyDecorators } from "@nestjs/common";
import { ApiResponse } from "@nestjs/swagger";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/** A success response described by a named component from `document.ts`. */
export const ApiOk = (schemaName: string): MethodDecorator =>
  ApiResponse({ status: 200, description: "OK", schema: ref(schemaName) });

const DESCRIPTIONS: Readonly<Record<number, string>> = {
  400: "The request failed validation.",
  401: "The bearer token is missing or invalid.",
  403: "The token is valid, but its subject has no account.",
  429: "Over the rate limit. See the Retry-After header.",
  500: "Something went wrong. The body carries no detail.",
  503: "A dependency is unavailable.",
};

/** The failures a route can answer with, all in the one documented shape. */
export const ApiFailures = (...statuses: readonly number[]): MethodDecorator =>
  applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: DESCRIPTIONS[status] ?? "The request failed.",
        schema: ref("ErrorResponse"),
        ...(status === 429
          ? {
              headers: {
                "Retry-After": {
                  description: "Seconds until the limit resets.",
                  schema: { type: "integer" },
                },
              },
            }
          : {}),
      }),
    ),
  );
