import { z } from "zod";

/**
 * The one keyset pagination scheme every list endpoint shares, documented in the service README.
 * It holds no endpoint logic: each endpoint defines its sort key, its query and its page component.
 */

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** Stored timestamps have millisecond precision, and a `Date` would silently truncate anything finer. */
const FINER_THAN_A_MILLISECOND = /\.\d{4,}/u;

/**
 * An ISO 8601 date-time with an offset, as a `Date`. Query parameters and sort keys both use it.
 * A `Date` can hold year 0, but the database rejects it, which would otherwise be a 500.
 */
export const dateTimeSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => !FINER_THAN_A_MILLISECOND.test(value), "At most millisecond precision")
  .transform((value) => new Date(value))
  .refine((date) => date.getUTCFullYear() >= 1, "Out of range");

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

/** A cursor is base64url of the JSON sort key. It carries no account id and grants nothing. */
export const encodeCursor = <Key extends z.ZodType>(_keySchema: Key, key: z.input<Key>): string =>
  Buffer.from(JSON.stringify(key), "utf8").toString("base64url");

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** The sort key, or `undefined` for anything that does not decode and validate. It never throws. */
export const decodeCursor = <Key extends z.ZodType>(
  keySchema: Key,
  cursor: string,
): z.output<Key> | undefined => {
  if (!BASE64URL.test(cursor)) {
    return undefined;
  }
  const parsed = keySchema.safeParse(parseJson(Buffer.from(cursor, "base64url").toString("utf8")));
  return parsed.success ? parsed.data : undefined;
};

const limitSchema = z
  .string()
  .regex(/^\d+$/u)
  .transform(Number)
  .pipe(z.int().min(1).max(MAX_LIMIT))
  .default(DEFAULT_LIMIT);

interface TimeWindow {
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
}

/**
 * A list endpoint's whole query: `limit`, `cursor`, `from` and `to`, plus the endpoint's own filters.
 * A factory because the cursor decodes to the endpoint's sort key. `cursor` comes out as that key, and
 * a bad one fails here, so `ZodPipe` reports it at `query.cursor`.
 */
export const listQuerySchema = <Key extends z.ZodType, Filters extends z.ZodRawShape>(
  keySchema: Key,
  filters: Filters,
) =>
  z
    .strictObject({
      limit: limitSchema,
      cursor: z
        .string()
        .transform((cursor, context): z.output<Key> => {
          const key = decodeCursor(keySchema, cursor);
          if (key === undefined) {
            context.addIssue({ code: "custom", message: "Invalid cursor" });
            return z.NEVER;
          }
          return key;
        })
        .optional(),
      from: dateTimeSchema.optional(),
      to: dateTimeSchema.optional(),
      ...filters,
    })
    .superRefine((query, context) => {
      const { from, to } = query as TimeWindow;
      if (from !== undefined && to !== undefined && from.getTime() >= to.getTime()) {
        context.addIssue({ code: "custom", path: ["to"], message: "Must be later than from" });
      }
    });

/** The response envelope. `nextCursor` is `null` on the last page. */
export const pageSchema = <Item extends z.ZodType>(item: Item) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
