import { Controller, Get, Inject, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiQuery } from "@nestjs/swagger";
import { OrderSide } from "@orderflow/db";
import type { Prisma, PrismaClient } from "@orderflow/db";
import { z } from "zod";

import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import type { Principal } from "../auth/principal.js";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { ApiError } from "../errors/error-response.js";
import { moneySchema } from "../money/money.js";
import { ApiFailures, ApiOk } from "../openapi/responses.js";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  dateTimeSchema,
  encodeCursor,
  listQuerySchema,
  pageSchema,
} from "../pagination/pagination.js";
import { ZodPipe } from "../validation/zod.pipe.js";

/**
 * Newest first, then by fill id, then `BUY` before `SELL`: a fill whose two orders are both the
 * caller's gives two rows that share the fill's time and id. As on the ledger key, the id takes any
 * TEXT value but a NUL, which Postgres rejects in text.
 */
const tradesKeySchema = z.strictObject({
  filledAt: dateTimeSchema,
  fillId: z.string().refine((id) => !id.includes("\u0000")),
  side: z.enum(OrderSide),
});

type TradesKey = z.output<typeof tradesKeySchema>;

export const tradesQuerySchema = listQuerySchema(tradesKeySchema, {
  instrument: z
    .string()
    .regex(/^[A-Z]{3,4}-[A-Z]{3,4}$/u)
    .optional(),
});

export const tradesPageSchema = pageSchema(
  z.object({
    fillId: z.string(),
    instrument: z.string(),
    side: z.enum(OrderSide),
    price: moneySchema,
    quantity: moneySchema,
    filledAt: z.iso.datetime(),
  }),
);

const FILL_SELECT = {
  id: true,
  price: true,
  quantity: true,
  createdAt: true,
  instrument: { select: { symbol: true } },
  buyOrder: { select: { accountId: true } },
  sellOrder: { select: { accountId: true } },
} satisfies Prisma.FillSelect;

export type FillRow = Prisma.FillGetPayload<{ select: typeof FILL_SELECT }>;

export interface TradeItem {
  readonly fillId: string;
  readonly instrument: string;
  readonly side: OrderSide;
  readonly price: Prisma.Decimal;
  readonly quantity: Prisma.Decimal;
  readonly filledAt: Date;
}

export interface TradesPage {
  readonly items: readonly TradeItem[];
  readonly nextCursor: string | null;
}

/**
 * The caller's rows of one fill, in key order: its buy side if the buy order is the caller's, then
 * its sell side if the sell order is. A fill with neither, including one with no orders, gives none.
 * The order account ids are compared here and never returned.
 */
export const toTradeRows = (fill: FillRow, accountId: string): TradeItem[] => {
  const row = (side: OrderSide): TradeItem => ({
    fillId: fill.id,
    instrument: fill.instrument.symbol,
    side,
    price: fill.price,
    quantity: fill.quantity,
    filledAt: fill.createdAt,
  });
  return [
    ...(fill.buyOrder?.accountId === accountId ? [row(OrderSide.BUY)] : []),
    ...(fill.sellOrder?.accountId === accountId ? [row(OrderSide.SELL)] : []),
  ];
};

/**
 * After a `BUY` cursor the database returns the cursor's own fill again, for its `SELL` row. Its
 * `BUY` row is the one row returned that is not after the cursor, so it is dropped by equality on
 * the whole key. Ids are never ordered here, because JavaScript and Postgres collation can disagree
 * on them. The time is compared too: a hand-written cursor with a real fill id and another time
 * matches that fill through `createdAt < filledAt`, and its BUY row is then after the cursor.
 */
export const afterCursor = (
  rows: readonly TradeItem[],
  cursor: TradesKey | undefined,
): TradeItem[] =>
  cursor?.side === OrderSide.BUY
    ? rows.filter(
        (row) =>
          !(
            row.fillId === cursor.fillId &&
            row.side === OrderSide.BUY &&
            row.filledAt.getTime() === cursor.filledAt.getTime()
          ),
      )
    : [...rows];

@Controller("trades")
export class TradesController {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  @Get()
  @ApiBearerAuth()
  @ApiOperation({
    summary: "The authenticated caller's own fills, one row per side the caller was on",
    description: `Keyset-paginated, sorted by (filledAt desc, fillId desc, side asc), at most ${MAX_LIMIT.toString()} rows a page. filledAt is the trade time, and the time filter applies to it. A fill whose two orders are both the caller's gives a BUY row and a SELL row. price and quantity are as stored. fillId leads to the TRADE entries on GET /ledger, which carry the exact amounts.`,
  })
  @ApiQuery({
    name: "limit",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  })
  @ApiQuery({
    name: "cursor",
    required: false,
    schema: { type: "string" },
    description: "The nextCursor of a previous page.",
  })
  @ApiQuery({
    name: "from",
    required: false,
    schema: { type: "string", format: "date-time" },
    description: "Inclusive, with an offset. At most millisecond precision, from year 1.",
  })
  @ApiQuery({
    name: "to",
    required: false,
    schema: { type: "string", format: "date-time" },
    description: "Exclusive, with an offset. At most millisecond precision, from year 1.",
  })
  @ApiQuery({
    name: "instrument",
    required: false,
    schema: { type: "string", pattern: "^[A-Z]{3,4}-[A-Z]{3,4}$" },
    description: "An instrument symbol, such as BTC-USD. One with no instrument is a 400.",
  })
  @ApiOk("TradesPage")
  @ApiFailures(400, 401, 403, 429, 500, 503)
  async trades(
    @Query(new ZodPipe(tradesQuerySchema)) query: z.output<typeof tradesQuerySchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<TradesPage> {
    const { limit, cursor, from, to, instrument } = query;
    const { accountId } = principal;

    const instrumentId = instrument === undefined ? undefined : await this.instrumentId(instrument);

    // Every fetched fill gives at least one row, except the cursor's own fill after a BUY cursor,
    // which can give none. One fill past the page, plus that one, says whether there is another page.
    const fills = await this.prisma.fill.findMany({
      where: {
        AND: [
          { OR: [{ buyOrder: { is: { accountId } } }, { sellOrder: { is: { accountId } } }] },
          instrumentId === undefined ? {} : { instrumentId },
          {
            createdAt: {
              ...(from === undefined ? {} : { gte: from }),
              ...(to === undefined ? {} : { lt: to }),
            },
          },
          cursor === undefined
            ? {}
            : {
                OR: [
                  { createdAt: { lt: cursor.filledAt } },
                  {
                    createdAt: cursor.filledAt,
                    id:
                      cursor.side === OrderSide.BUY
                        ? { lte: cursor.fillId }
                        : { lt: cursor.fillId },
                  },
                ],
              },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1 + (cursor?.side === OrderSide.BUY ? 1 : 0),
      select: FILL_SELECT,
    });

    const rows = afterCursor(
      fills.flatMap((fill) => toTradeRows(fill, accountId)),
      cursor,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page,
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor(tradesKeySchema, {
              filledAt: last.filledAt.toISOString(),
              fillId: last.fillId,
              side: last.side,
            })
          : null,
    };
  }

  /** A well-formed symbol with no instrument is a 400 at the field, like a malformed one. */
  private async instrumentId(symbol: string): Promise<string> {
    const found = await this.prisma.instrument.findUnique({
      where: { symbol },
      select: { id: true },
    });
    if (found === null) {
      throw new ApiError("VALIDATION_FAILED", [
        { path: "query.instrument", message: "Unknown instrument" },
      ]);
    }
    return found.id;
  }
}
