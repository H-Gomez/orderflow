import { randomUUID } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

export const CORRELATION_HEADER = "X-Correlation-Id";

export interface RequestWithCorrelationId extends Request {
  correlationId?: string;
}

/**
 * Gives every request an id, returned as a header and in any error body. It is always generated
 * here, and an inbound value is ignored, so a client cannot put its own text in the logs.
 */
export const correlationId = (
  request: RequestWithCorrelationId,
  response: Response,
  next: NextFunction,
): void => {
  request.correlationId = randomUUID();
  response.setHeader(CORRELATION_HEADER, request.correlationId);
  next();
};
