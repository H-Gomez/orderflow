import type { ExecutionContext } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

import type { AuthenticatedRequest } from "../auth/principal.js";

/**
 * Limits a verified caller by its subject and anyone else by IP. It runs after the token check,
 * which is what makes the subject trustworthy, and before the account lookup, so a flood of valid
 * tokens is stopped before it reaches the database.
 */
@Injectable()
export class PrincipalThrottlerGuard extends ThrottlerGuard {
  protected override getTracker(request: AuthenticatedRequest): Promise<string> {
    return Promise.resolve(
      request.tokenSubject === undefined
        ? `ip:${request.ip ?? "unknown"}`
        : `subject:${request.tokenSubject}`,
    );
  }

  /** One budget per caller, shared across routes, rather than the library's one per handler. */
  protected override generateKey(
    _context: ExecutionContext,
    tracker: string,
    throttlerName: string,
  ): string {
    return `${throttlerName}:${tracker}`;
  }
}
