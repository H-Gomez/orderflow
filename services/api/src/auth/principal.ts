import type { AccountType } from "@orderflow/db";
import type { Request } from "express";

/** The caller, once its token has been verified and its subject resolved to a USER account. */
export interface Principal {
  /** The token's `sub`, which is `User.authSubject`. */
  readonly subject: string;
  readonly userId: string;
  readonly accountId: string;
  readonly accountType: AccountType;
  readonly accountCreatedAt: Date;
}

export interface AuthenticatedRequest extends Request {
  /** Set once the token verifies, before any database work. */
  tokenSubject?: string;
  /** Set once the subject resolves to an account. */
  principal?: Principal;
}
