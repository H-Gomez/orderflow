import { Body, Controller, Get, HttpException, Param, Post } from "@nestjs/common";
import { LedgerError } from "@orderflow/db";
import type { LedgerErrorCode } from "@orderflow/db";

/** What a {@link LedgerError} message looks like in life: an id and an amount a client must not see. */
export const LEDGER_MESSAGE = "account acct-0193-secret cannot spend 1234.56";
export const INTERNAL_MESSAGE = "connection to db-internal-host:5432 refused";

/**
 * Routes that only tests mount. No real route in this story throws a ledger error, takes a query
 * parameter or returns money, so these stand in for the #36 handlers. Never in the build.
 */
@Controller("probe")
export class ProbeController {
  @Get("ledger-error/:code")
  ledgerError(@Param("code") code: string): never {
    throw new LedgerError(code as LedgerErrorCode, LEDGER_MESSAGE);
  }

  @Get("crash")
  crash(): never {
    throw new Error(INTERNAL_MESSAGE);
  }

  @Get("http-error/:status")
  httpError(@Param("status") status: string): never {
    throw new HttpException(INTERNAL_MESSAGE, Number(status));
  }

  @Post("echo")
  echo(@Body() body: unknown): unknown {
    return body;
  }
}
