import { Controller, Get, Inject, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { balanceOf, buyingPowerOf, heldOf } from "@orderflow/db";
import type { ExactDecimal, PrismaClient } from "@orderflow/db";
import { z } from "zod";

import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import type { Principal } from "../auth/principal.js";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { moneySchema } from "../money/money.js";
import { ApiFailures, ApiOk } from "../openapi/responses.js";
import { ZodPipe } from "../validation/zod.pipe.js";

/** No parameters: the account comes only from the token, so naming one is a 400. */
export const portfolioQuerySchema = z.strictObject({});

export const portfolioResponseSchema = z.object({
  currencies: z.array(
    z.object({
      currency: z.string(),
      balance: moneySchema,
      held: moneySchema,
      buyingPower: moneySchema,
    }),
  ),
});

export interface PortfolioCurrency {
  readonly currency: string;
  readonly balance: ExactDecimal;
  readonly held: ExactDecimal;
  readonly buyingPower: ExactDecimal;
}

export interface PortfolioResponse {
  readonly currencies: readonly PortfolioCurrency[];
}

@Controller("portfolio")
export class PortfolioController {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  @Get()
  @ApiBearerAuth()
  @ApiOperation({
    summary: "The authenticated caller's balances, holds and buying power",
    description:
      "One row per currency with a non-zero balance, ordered by currency code. Each figure is a separate read, not one snapshot, so a concurrent write can make them disagree. M0 has no API write path, so this is accepted.",
  })
  @ApiOk("PortfolioResponse")
  @ApiFailures(400, 401, 403, 429, 500, 503)
  async portfolio(
    // Declared only so the pipe runs and rejects any parameter. The value is always empty.
    @Query(new ZodPipe(portfolioQuerySchema)) _query: z.output<typeof portfolioQuerySchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<PortfolioResponse> {
    const { accountId } = principal;
    const entryCurrencies = await this.prisma.ledgerEntry.groupBy({
      by: ["currency"],
      where: { accountId },
      orderBy: { currency: "asc" },
    });

    const rows = await Promise.all(
      entryCurrencies.map(async ({ currency }): Promise<PortfolioCurrency | undefined> => {
        const balance = await balanceOf(this.prisma, accountId, currency);
        if (balance.isZero()) {
          return undefined;
        }
        return {
          currency,
          balance,
          held: await heldOf(this.prisma, accountId, currency),
          buyingPower: await buyingPowerOf(this.prisma, accountId, currency),
        };
      }),
    );

    return { currencies: rows.filter((row) => row !== undefined) };
  }
}
