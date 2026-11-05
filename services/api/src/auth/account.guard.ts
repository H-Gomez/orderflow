import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AccountType } from "@orderflow/db";
import type { PrismaClient } from "@orderflow/db";

import { PRISMA_CLIENT } from "../database/database.module.js";
import { ApiError } from "../errors/error-response.js";

import type { AuthenticatedRequest } from "./principal.js";
import { isPublicRoute } from "./public.decorator.js";

/**
 * Resolves a verified subject to its User and USER account. A subject with neither is a 403, and
 * nothing is written: signup provisioning is not this story's. Only USER accounts authenticate by
 * JWT, so a subject attached to any other account type is refused the same way.
 */
@Injectable()
export class AccountGuard implements CanActivate {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (isPublicRoute(this.reflector, context)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const subject = request.tokenSubject;
    if (subject === undefined) {
      throw new ApiError("UNAUTHENTICATED");
    }

    const user = await this.prisma.user.findUnique({
      where: { authSubject: subject },
      select: { id: true, account: { select: { id: true, type: true, createdAt: true } } },
    });
    if (user?.account?.type !== AccountType.USER) {
      throw new ApiError("UNKNOWN_SUBJECT");
    }

    request.principal = {
      subject,
      userId: user.id,
      accountId: user.account.id,
      accountType: user.account.type,
      accountCreatedAt: user.account.createdAt,
    };
    return true;
  }
}
