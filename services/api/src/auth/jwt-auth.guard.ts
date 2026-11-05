import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { ApiError } from "../errors/error-response.js";

import { JwksVerifier } from "./jwks-verifier.js";
import type { AuthenticatedRequest } from "./principal.js";
import { isPublicRoute } from "./public.decorator.js";

const BEARER = /^Bearer (\S+)$/iu;

/** The first guard: no route past it without a verified token, and no database work before it. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly verifier: JwksVerifier,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (isPublicRoute(this.reflector, context)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = BEARER.exec(request.headers.authorization ?? "")?.[1];
    if (token === undefined) {
      throw new ApiError("UNAUTHENTICATED");
    }

    request.tokenSubject = await this.verifier.verify(token);
    return true;
  }
}
