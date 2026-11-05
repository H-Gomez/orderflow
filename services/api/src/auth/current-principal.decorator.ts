import type { ExecutionContext } from "@nestjs/common";
import { createParamDecorator } from "@nestjs/common";

import type { AuthenticatedRequest, Principal } from "./principal.js";

/** The authenticated caller. Throwing here means a public route asked for one, which is a bug. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const { principal } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (principal === undefined) {
      throw new Error("CurrentPrincipal used on a route with no authenticated principal");
    }
    return principal;
  },
);
