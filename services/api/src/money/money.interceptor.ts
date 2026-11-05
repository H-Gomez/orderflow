import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import type { Observable } from "rxjs";
import { map } from "rxjs";

import { serializeMoney } from "./money.js";

/** Runs on every response, so no handler can send money any other way. */
@Injectable()
export class MoneyInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map(serializeMoney));
  }
}
