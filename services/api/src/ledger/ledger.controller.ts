import { Controller, Get, Inject, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiQuery } from "@nestjs/swagger";
import { EntryType } from "@orderflow/db";
import type { Prisma, PrismaClient } from "@orderflow/db";
import { z } from "zod";

import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import type { Principal } from "../auth/principal.js";
import { PRISMA_CLIENT } from "../database/database.module.js";
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
 * Newest first. Every entry of a transaction shares its timestamp, so `id` breaks the ties. The id
 * accepts any value the TEXT column can hold, so every stored row yields a cursor this route takes
 * back: the uuid default is applied by the Prisma client, not by the database. Only a NUL is
 * refused, because Postgres rejects it in text, which would be a 500.
 */
const ledgerKeySchema = z.strictObject({
  createdAt: dateTimeSchema,
  id: z.string().refine((id) => !id.includes("\u0000")),
});

export const ledgerQuerySchema = listQuerySchema(ledgerKeySchema, {
  currency: z
    .string()
    .regex(/^[A-Z]{3,4}$/u)
    .optional(),
});

export const ledgerPageSchema = pageSchema(
  z.object({
    id: z.string(),
    transactionId: z.string(),
    type: z.enum(EntryType),
    currency: z.string(),
    amount: moneySchema,
    createdAt: z.iso.datetime(),
    fillId: z.string().nullable(),
  }),
);

const ROW_SELECT = {
  id: true,
  transactionId: true,
  currency: true,
  amount: true,
  createdAt: true,
  transaction: { select: { type: true, causeKey: true } },
} satisfies Prisma.LedgerEntrySelect;

type LedgerRow = Prisma.LedgerEntryGetPayload<{ select: typeof ROW_SELECT }>;

export interface LedgerItem {
  readonly id: string;
  readonly transactionId: string;
  readonly type: EntryType;
  readonly currency: string;
  readonly amount: Prisma.Decimal;
  readonly createdAt: Date;
  readonly fillId: string | null;
}

export interface LedgerPage {
  readonly items: readonly LedgerItem[];
  readonly nextCursor: string | null;
}

/** A TRADE's cause key is its fill id (ledger.md section 3). No other type's cause key leaves here. */
export const toLedgerItem = ({ transaction, ...entry }: LedgerRow): LedgerItem => ({
  ...entry,
  type: transaction.type,
  fillId: transaction.type === EntryType.TRADE ? transaction.causeKey : null,
});

@Controller("ledger")
export class LedgerController {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  @Get()
  @ApiBearerAuth()
  @ApiOperation({
    summary: "The authenticated caller's own ledger entries",
    description: `Keyset-paginated, sorted by (createdAt desc, id desc), at most ${MAX_LIMIT.toString()} entries a page. createdAt is when the entry was written, and the time filter applies to it: for a seeded trade that is the seed-run time, not the trade time. fillId leads from a TRADE entry to its trade.`,
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
    name: "currency",
    required: false,
    schema: { type: "string", pattern: "^[A-Z]{3,4}$" },
  })
  @ApiOk("LedgerPage")
  @ApiFailures(400, 401, 403, 429, 500, 503)
  async ledger(
    @Query(new ZodPipe(ledgerQuerySchema)) query: z.output<typeof ledgerQuerySchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<LedgerPage> {
    const { limit, cursor, from, to, currency } = query;

    // One row past the page says whether there is another page, with no count.
    const rows = await this.prisma.ledgerEntry.findMany({
      where: {
        accountId: principal.accountId,
        ...(currency === undefined ? {} : { currency }),
        createdAt: {
          ...(from === undefined ? {} : { gte: from }),
          ...(to === undefined ? {} : { lt: to }),
        },
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: ROW_SELECT,
    });

    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toLedgerItem),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor(ledgerKeySchema, {
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            })
          : null,
    };
  }
}
