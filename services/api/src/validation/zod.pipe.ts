import type { ArgumentMetadata, PipeTransform } from "@nestjs/common";
import type { z } from "zod";

import { ApiError } from "../errors/error-response.js";

/**
 * Parses one handler input, so the handler receives parsed, typed values or never runs. Applied
 * per parameter because a global pipe cannot know each route's schema; `validation.test.ts` fails
 * on any `@Query`, `@Param` or `@Body` without one. Use `z.strictObject` for a whole query or body,
 * so a field nobody asked for is rejected and not ignored.
 */
export class ZodPipe<Schema extends z.ZodType> implements PipeTransform<unknown, z.output<Schema>> {
  constructor(private readonly schema: Schema) {}

  transform(value: unknown, metadata: ArgumentMetadata): z.output<Schema> {
    const parsed = this.schema.safeParse(value);
    if (parsed.success) {
      return parsed.data;
    }

    const root = metadata.data === undefined ? metadata.type : `${metadata.type}.${metadata.data}`;
    throw new ApiError(
      "VALIDATION_FAILED",
      parsed.error.issues.map((issue) => ({
        path: [root, ...issue.path.map(String)].join("."),
        message: issue.message,
      })),
    );
  }
}
