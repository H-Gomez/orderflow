import type { CustomDecorator, ExecutionContext } from "@nestjs/common";
import { SetMetadata } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";

const IS_PUBLIC = "orderflow:isPublic";

/** Marks a route as needing no token. Every route without it is authenticated. */
export const Public = (): CustomDecorator => SetMetadata(IS_PUBLIC, true);

export const isPublicRoute = (reflector: Reflector, context: ExecutionContext): boolean =>
  reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
    context.getHandler(),
    context.getClass(),
  ]) === true;
