import type { Type } from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants.js";
import { RouteParamtypes } from "@nestjs/common/enums/route-paramtypes.enum.js";

import { ZodPipe } from "../validation/zod.pipe.js";

interface RouteArgument {
  readonly pipes?: readonly unknown[];
}

const CHECKED: readonly string[] = [
  String(RouteParamtypes.BODY),
  String(RouteParamtypes.QUERY),
  String(RouteParamtypes.PARAM),
];

/** Each `Controller.method` taking a query, param or body that no {@link ZodPipe} parses. */
export const unparsedInputs = (controller: Type): string[] => {
  const prototype = controller.prototype as object;
  return Object.getOwnPropertyNames(prototype).flatMap((method) => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) as
      Record<string, RouteArgument> | undefined;
    const unparsed = Object.entries(args ?? {}).filter(
      ([key, { pipes }]) =>
        CHECKED.includes(key.split(":")[0] ?? "") &&
        !(pipes ?? []).some((pipe) => pipe instanceof ZodPipe),
    );
    return unparsed.length === 0 ? [] : [`${controller.name}.${method}`];
  });
};
