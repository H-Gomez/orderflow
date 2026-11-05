import { Body, Controller, Get, HttpException, Inject, Param, Post, Query } from "@nestjs/common";
import { ExactDecimal, LedgerError, Prisma, balanceOf } from "@orderflow/db";
import type { LedgerErrorCode, PrismaClient } from "@orderflow/db";
import { z } from "zod";

import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import type { Principal } from "../auth/principal.js";
import { Public } from "../auth/public.decorator.js";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { ZodPipe } from "../validation/zod.pipe.js";

/** What a {@link LedgerError} message looks like in life: an id and an amount a client must not see. */
export const LEDGER_MESSAGE = "account acct-0193-secret cannot spend 1234.56";
export const INTERNAL_MESSAGE = "connection to db-internal-host:5432 refused";

const SearchQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100),
  side: z.enum(["BUY", "SELL"]).optional(),
});

const OrderBody = z.strictObject({ quantity: z.string(), note: z.string().optional() });

/**
 * Routes that only tests mount. No real route in this story throws a ledger error, takes a query
 * parameter or returns money, so these stand in for the #36 handlers. Never in the build.
 */
@Controller("probe")
export class ProbeController {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  @Public()
  @Get("money")
  money(): unknown {
    return {
      exact: new ExactDecimal("0.00000001"),
      prisma: new Prisma.Decimal("0.00000001"),
      nested: { list: [new ExactDecimal("1.50"), { deep: new Prisma.Decimal("-2") }] },
      when: new Date("2026-01-02T03:04:05.000Z"),
      text: "untouched",
      nothing: null,
    };
  }

  @Public()
  @Get("balance/:accountId")
  async balance(@Param("accountId") accountId: string): Promise<{ balance: ExactDecimal }> {
    return { balance: await balanceOf(this.prisma, accountId, "USD") };
  }

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

  @Public()
  @Get("search")
  search(@Query(new ZodPipe(SearchQuery)) query: z.output<typeof SearchQuery>): {
    received: z.output<typeof SearchQuery>;
    limitType: string;
  } {
    return { received: query, limitType: typeof query.limit };
  }

  @Public()
  @Get("items/:id")
  item(@Param("id", new ZodPipe(z.uuid())) id: string): { id: string } {
    return { id };
  }

  @Public()
  @Post("orders")
  order(@Body(new ZodPipe(OrderBody)) body: z.output<typeof OrderBody>): unknown {
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
