import { Controller, Get } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { AccountType } from "@orderflow/db";
import { z } from "zod";

import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import type { Principal } from "../auth/principal.js";
import { ApiFailures, ApiOk } from "../openapi/responses.js";

export const meResponseSchema = z.object({
  accountId: z.string(),
  type: z.enum(AccountType),
  createdAt: z.iso.datetime(),
});

export interface MeResponse {
  readonly accountId: string;
  readonly type: AccountType;
  readonly createdAt: Date;
}

/** Exists so authentication can be proved in this story. It is not a feature. */
@Controller("me")
export class MeController {
  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: "The authenticated caller's account" })
  @ApiOk("MeResponse")
  @ApiFailures(401, 403, 429, 500, 503)
  me(@CurrentPrincipal() principal: Principal): MeResponse {
    return {
      accountId: principal.accountId,
      type: principal.accountType,
      createdAt: principal.accountCreatedAt,
    };
  }
}
