import { Body, Controller, Get, HttpException, Param, Post } from "@nestjs/common";
import { LedgerError } from "@orderflow/db";
import type { LedgerErrorCode } from "@orderflow/db";

import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import type { Principal } from "../auth/principal.js";
import { Public } from "../auth/public.decorator.js";

/** What a {@link LedgerError} message looks like in life: an id and an amount a client must not see. */
export const LEDGER_MESSAGE = "account acct-0193-secret cannot spend 1234.56";
export const INTERNAL_MESSAGE = "connection to db-internal-host:5432 refused";

/**
 * Routes that only tests mount. No real route in this story throws a ledger error, takes a query
 * parameter or returns money, so these stand in for the #36 handlers. Never in the build.
 */
@Controller("probe")
export class ProbeController {
  @Public()
  @Get("ledger-error/:code")
  ledgerError(@Param("code") code: string): never {
    throw new LedgerError(code as LedgerErrorCode, LEDGER_MESSAGE);
  }

  @Public()
  @Get("crash")
  crash(): never {
    throw new Error(INTERNAL_MESSAGE);
  }

  @Public()
  @Get("http-error/:status")
  httpError(@Param("status") status: string): never {
    throw new HttpException(INTERNAL_MESSAGE, Number(status));
  }

  @Public()
  @Post("echo")
  echo(@Body() body: unknown): unknown {
    return body;
  }

  /** Authenticated, as every route is by default. */
  @Get("whoami")
  whoami(@CurrentPrincipal() principal: Principal): { accountId: string } {
    return { accountId: principal.accountId };
  }

  @Public()
  @Get("public")
  isPublic(): { ok: true } {
    return { ok: true };
  }
}
