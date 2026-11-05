import { Controller, Get, Inject } from "@nestjs/common";
import { ApiOperation } from "@nestjs/swagger";
import type { PrismaClient } from "@orderflow/db";
import { z } from "zod";

import { Public } from "../auth/public.decorator.js";
import { PRISMA_CLIENT } from "../database/database.module.js";
import { ApiError } from "../errors/error-response.js";
import { ApiFailures, ApiOk } from "../openapi/responses.js";

export const READINESS_TIMEOUT_MS = 2_000;

export const livenessResponseSchema = z.object({ status: z.literal("ok") });
export const readinessResponseSchema = z.object({ status: z.literal("ready") });

@Public()
@Controller("health")
export class HealthController {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  /** The process is up. It touches nothing, so a database outage cannot make this fail. */
  @Get()
  @ApiOperation({ summary: "Liveness" })
  @ApiOk("LivenessResponse")
  @ApiFailures(429, 500)
  liveness(): z.output<typeof livenessResponseSchema> {
    return { status: "ok" };
  }

  /** The process can reach its database. Bounded, so a host that never answers cannot hang a probe. */
  @Get("ready")
  @ApiOperation({ summary: "Readiness: the database answers" })
  @ApiOk("ReadinessResponse")
  @ApiFailures(429, 500, 503)
  async readiness(): Promise<z.output<typeof readinessResponseSchema>> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`no answer in ${String(READINESS_TIMEOUT_MS)}ms`));
      }, READINESS_TIMEOUT_MS);
    });

    try {
      // The one raw query this service may run.
      await Promise.race([this.prisma.$queryRaw`SELECT 1`, timeout]);
      return { status: "ready" };
    } catch (error) {
      throw new ApiError("NOT_READY", undefined, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }
}
