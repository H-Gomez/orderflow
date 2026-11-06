import { Controller, Get, Inject, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiQuery } from "@nestjs/swagger";
import type { Prisma, PrismaClient } from "@orderflow/db";
import { z } from "zod";

import { PRISMA_CLIENT } from "../database/database.module.js";
import { ApiError } from "../errors/error-response.js";
import { moneySchema } from "../money/money.js";
import { ApiFailures, ApiOk } from "../openapi/responses.js";
import { dateTimeSchema } from "../pagination/pagination.js";
import { ZodPipe } from "../validation/zod.pipe.js";

/** The intervals candles are stored at, as `Candle.interval` holds them. */
export const CANDLE_INTERVALS = ["1m", "1h", "1d"] as const;

export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

export const isCandleInterval = (value: unknown): value is CandleInterval =>
  (CANDLE_INTERVALS as readonly unknown[]).includes(value);

const PERIOD_MS: Readonly<Record<CandleInterval, number>> = {
  "1m": 60_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
};

/** The most candles one request returns. */
export const MAX_CANDLES = 1_000;

/** The interval periods in `[from, to)`, a partial one counting as one. Time, never money. */
export const periodCount = (interval: CandleInterval, from: Date, to: Date): number =>
  Math.ceil((to.getTime() - from.getTime()) / PERIOD_MS[interval]);

export const candlesQuerySchema = z
  .strictObject({
    instrument: z.string().regex(/^[A-Z]{3,4}-[A-Z]{3,4}$/u),
    interval: z.enum(CANDLE_INTERVALS),
    from: dateTimeSchema,
    to: dateTimeSchema,
  })
  .superRefine((query: Readonly<Record<string, unknown>>, context) => {
    // A field that failed its own schema is still its raw value here, because zod runs this anyway.
    const { interval, from, to } = query;
    if (!(from instanceof Date) || !(to instanceof Date)) {
      return;
    }
    if (from.getTime() >= to.getTime()) {
      context.addIssue({ code: "custom", path: ["to"], message: "Must be later than from" });
    } else if (isCandleInterval(interval) && periodCount(interval, from, to) > MAX_CANDLES) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: `At most ${MAX_CANDLES.toString()} interval periods`,
      });
    }
  });

export const candlesResponseSchema = z.object({
  instrument: z.string(),
  interval: z.enum(CANDLE_INTERVALS),
  candles: z.array(
    z.object({
      openTime: z.iso.datetime(),
      open: moneySchema,
      high: moneySchema,
      low: moneySchema,
      close: moneySchema,
      volume: moneySchema,
    }),
  ),
});

const CANDLE_SELECT = {
  openTime: true,
  open: true,
  high: true,
  low: true,
  close: true,
  volume: true,
} satisfies Prisma.CandleSelect;

export interface CandlesResponse {
  readonly instrument: string;
  readonly interval: CandleInterval;
  readonly candles: readonly Prisma.CandleGetPayload<{ select: typeof CANDLE_SELECT }>[];
}

@Controller("candles")
export class CandlesController {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  @Get()
  @ApiBearerAuth()
  @ApiOperation({
    summary: "One instrument's stored candles at one interval, in a time window",
    description: `Market data, with no account data. Returns the candles whose openTime is in [from, to), oldest first, with OHLCV values as stored. The window may span at most ${MAX_CANDLES.toString()} interval periods, a partial period counting as one, so at most ${MAX_CANDLES.toString()} candles come back; a longer window is a 400 at query.to. There is no pagination.`,
  })
  @ApiQuery({
    name: "instrument",
    required: true,
    schema: { type: "string", pattern: "^[A-Z]{3,4}-[A-Z]{3,4}$" },
    description: "An instrument symbol, such as BTC-USD. One with no instrument is a 400.",
  })
  @ApiQuery({
    name: "interval",
    required: true,
    schema: { type: "string", enum: [...CANDLE_INTERVALS] },
  })
  @ApiQuery({
    name: "from",
    required: true,
    schema: { type: "string", format: "date-time" },
    description: "Inclusive, with an offset. At most millisecond precision, from year 1.",
  })
  @ApiQuery({
    name: "to",
    required: true,
    schema: { type: "string", format: "date-time" },
    description: "Exclusive, with an offset, later than from. At most millisecond precision.",
  })
  @ApiOk("CandlesResponse")
  @ApiFailures(400, 401, 403, 429, 500, 503)
  async candles(
    @Query(new ZodPipe(candlesQuerySchema)) query: z.output<typeof candlesQuerySchema>,
  ): Promise<CandlesResponse> {
    const { instrument, interval, from, to } = query;
    const instrumentId = await this.instrumentId(instrument);

    // The period count bounds only candles aligned to the interval, and nothing stores them aligned.
    // So `take` holds the maximum: when more than 1,000 unaligned candles fall in the window, the
    // response holds the oldest 1,000.
    const candles = await this.prisma.candle.findMany({
      where: { instrumentId, interval, openTime: { gte: from, lt: to } },
      orderBy: { openTime: "asc" },
      take: MAX_CANDLES,
      select: CANDLE_SELECT,
    });
    return { instrument, interval, candles };
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
