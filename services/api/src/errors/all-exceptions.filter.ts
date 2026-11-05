import { randomUUID } from "node:crypto";

import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import { Catch, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { LedgerError } from "@orderflow/db";
import type { Response } from "express";

import { CORRELATION_HEADER } from "./correlation-id.middleware.js";
import type { RequestWithCorrelationId } from "./correlation-id.middleware.js";
import { ApiError, ERROR_CODES } from "./error-response.js";
import type { ApiErrorCode, ErrorResponse, FieldError } from "./error-response.js";
import { apiCodeForLedgerError } from "./ledger-error-map.js";

interface Failure {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly fields?: readonly FieldError[] | undefined;
}

const fromCode = (code: ApiErrorCode, fields?: readonly FieldError[]): Failure => ({
  status: ERROR_CODES[code].status,
  code,
  fields,
});

const HTTP_STATUS_CODES: Partial<Record<number, ApiErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: "BAD_REQUEST",
  [HttpStatus.UNAUTHORIZED]: "UNAUTHENTICATED",
  [HttpStatus.FORBIDDEN]: "FORBIDDEN",
  [HttpStatus.NOT_FOUND]: "NOT_FOUND",
  [HttpStatus.TOO_MANY_REQUESTS]: "RATE_LIMITED",
};

const fromHttpStatus = (status: number): Failure => {
  const code = HTTP_STATUS_CODES[status];
  if (code !== undefined) {
    return fromCode(code);
  }
  // The status survives (a 405 stays a 405), but the framework's text for it does not.
  return status < 500 ? { status, code: "REQUEST_REJECTED" } : fromCode("INTERNAL_ERROR");
};

const toFailure = (exception: unknown): Failure => {
  if (exception instanceof ApiError) {
    return fromCode(exception.code, exception.fields);
  }
  if (exception instanceof LedgerError) {
    return fromCode(apiCodeForLedgerError(exception.code));
  }
  if (exception instanceof HttpException) {
    return fromHttpStatus(exception.getStatus());
  }
  return fromCode("INTERNAL_ERROR");
};

/** Turns every failure into the one documented shape. The detail goes only to the server log. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("AllExceptionsFilter");

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestWithCorrelationId>();
    const response = http.getResponse<Response>();

    const correlationId = request.correlationId ?? randomUUID();
    const { status, code, fields } = toFailure(exception);

    if (status >= 500) {
      // The path and not the URL: a query string is the caller's data.
      this.logger.error(
        `${correlationId} ${request.method} ${request.path} answered ${String(status)} ${code}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ErrorResponse = {
      code,
      message: ERROR_CODES[code].message,
      correlationId,
      ...(fields === undefined ? {} : { fields: [...fields] }),
    };
    response.setHeader(CORRELATION_HEADER, correlationId);
    response.status(status).json(body);
  }
}
