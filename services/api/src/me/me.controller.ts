import { Controller, Get } from "@nestjs/common";
import { AccountType } from "@orderflow/db";
import { z } from "zod";

import { CurrentPrincipal } from "../auth/current-principal.decorator.js";
import type { Principal } from "../auth/principal.js";

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
  me(@CurrentPrincipal() principal: Principal): MeResponse {
    return {
      accountId: principal.accountId,
      type: principal.accountType,
      createdAt: principal.accountCreatedAt,
    };
  }
}
