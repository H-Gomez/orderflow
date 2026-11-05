import { z } from "zod";

/**
 * Every code the API can answer with. `message` is the only text a client ever sees: it is fixed
 * here, never copied from an exception, because a `LedgerError` message holds account ids and
 * amounts and a 5xx must not carry internal detail.
 */
export const ERROR_CODES = {
  BAD_REQUEST: { status: 400, message: "The request could not be understood." },
  VALIDATION_FAILED: { status: 400, message: "Request validation failed." },
  INVALID_CURRENCY: { status: 400, message: "The currency is not valid." },
  UNAUTHENTICATED: { status: 401, message: "A valid bearer token is required." },
  FORBIDDEN: { status: 403, message: "This request is not allowed." },
  UNKNOWN_SUBJECT: { status: 403, message: "This identity has no account." },
  TREASURY_HAS_NO_BUYING_POWER: { status: 403, message: "This account has no buying power." },
  NOT_FOUND: { status: 404, message: "Not found." },
  ACCOUNT_NOT_FOUND: { status: 404, message: "The account was not found." },
  REQUEST_REJECTED: { status: 400, message: "The request was rejected." },
  RATE_LIMITED: { status: 429, message: "Too many requests." },
  INTERNAL_ERROR: { status: 500, message: "Something went wrong." },
  AUTH_UNAVAILABLE: { status: 503, message: "Authentication is temporarily unavailable." },
  NOT_READY: { status: 503, message: "The service is not ready." },
} as const;

export type ApiErrorCode = keyof typeof ERROR_CODES;

export interface FieldError {
  /** Where the problem is, such as `query.limit`. */
  readonly path: string;
  readonly message: string;
}

/** The one shape of every failure this API returns. */
export const errorResponseSchema = z.object({
  code: z.enum(Object.keys(ERROR_CODES) as [ApiErrorCode, ...ApiErrorCode[]]),
  message: z.string(),
  correlationId: z.uuid(),
  fields: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/** A failure this service raises on purpose. Its status and message come from {@link ERROR_CODES}. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly fields: readonly FieldError[] | undefined;

  constructor(code: ApiErrorCode, fields?: readonly FieldError[], options?: ErrorOptions) {
    super(code, options);
    this.name = "ApiError";
    this.code = code;
    this.fields = fields;
  }
}
