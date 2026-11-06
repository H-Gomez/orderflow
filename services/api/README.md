# @orderflow/api

The OrderFlow HTTP API: a NestJS service, native ESM, built with `tsc`. It verifies OIDC JWTs itself and is read-only in M0.

## Running it

From the repository root, with the database up (see [packages/db](../../packages/db/README.md)):

```sh
pnpm build
cp services/api/.env.example services/api/.env   # then fill in the OIDC values
pnpm --filter @orderflow/api start
```

The API docs are at `/docs`, with the JSON at `/docs-json`.

## Configuration

Every variable is validated at boot. Invalid config exits 1 and names the variables, never their values, and nothing else in the service reads `process.env`.

| Variable                      | Required | Default | Meaning                                                                       |
| ----------------------------- | -------- | ------- | ----------------------------------------------------------------------------- |
| `DATABASE_URL`                | Yes      |         | Postgres connection string.                                                   |
| `OIDC_ISSUER`                 | Yes      |         | The `iss` every token must carry.                                             |
| `OIDC_AUDIENCE`               | Yes      |         | The `aud` every token must carry.                                             |
| `OIDC_JWKS_URI`               | Yes      |         | The issuer's key set. Must be https, or http on a loopback address.           |
| `OIDC_JWKS_CACHE_TTL_SECONDS` | No       | 600     | How long fetched keys are trusted. At most 86400.                             |
| `OIDC_JWKS_COOLDOWN_SECONDS`  | No       | 30      | The shortest gap between refetches an unknown key id can trigger. At least 1. |
| `RATE_LIMIT_WINDOW_SECONDS`   | No       | 60      | The rate limit window.                                                        |
| `RATE_LIMIT_AUTHENTICATED`    | No       | 120     | Requests per window for each authenticated subject.                           |
| `RATE_LIMIT_PUBLIC`           | No       | 60      | Requests per window for each IP on public routes. Health probes count here.   |
| `PORT`                        | No       | 3000    | The listening port.                                                           |

`OIDC_JWKS_COOLDOWN_SECONDS` is an addition beyond the #10 contract. It bounds how often unknown key ids can make the service refetch the JWKS, so it also sets how quickly a rotated key is picked up, and the rotation test needs it set low.

## Request pipeline

Every route needs a token unless it is marked `@Public()`. Global guards run in this order, registered in [app.module.ts](src/app.module.ts):

1. `JwtAuthGuard` verifies the token, with no database work: signature, issuer, audience and expiry, RS256 or ES256 only, and `sub` and `exp` required. Any fault in the token is a 401. If the keys cannot be fetched it is a 503, because that is not the caller's fault.
2. `PrincipalThrottlerGuard` limits by verified subject, or by IP on public routes. Each caller has one budget across routes. Over the limit is a 429 with `Retry-After`.
3. `AccountGuard` resolves `sub` to `User.authSubject` and that User's USER account. No match is a 403 `UNKNOWN_SUBJECT`, and nothing is written.

Handlers read the caller with `@CurrentPrincipal()`, and take input through a `ZodPipe` on each `@Query`, `@Param` or `@Body`. [validation.test.ts](src/validation/validation.test.ts) fails on any input without one.

## Errors

Every failure has this shape, and the same id is in the `X-Correlation-Id` header:

```json
{
  "code": "VALIDATION_FAILED",
  "message": "Request validation failed.",
  "correlationId": "0193f2c4-7b1e-7c3a-9d2f-5e8a1b4c6d70",
  "fields": [{ "path": "query.limit", "message": "Invalid input" }]
}
```

`fields` appears only on validation failures. `message` comes from a fixed table in [error-response.ts](src/errors/error-response.ts) and never from an exception. The detail of a 5xx goes only to the server log, under the correlation id.

A `LedgerError` is mapped by its code. Its message is never sent, because it holds account ids and amounts.

| `LedgerError` code             | Status | Body `code`                    |
| ------------------------------ | ------ | ------------------------------ |
| `ACCOUNT_NOT_FOUND`            | 404    | `ACCOUNT_NOT_FOUND`            |
| `INVALID_CURRENCY`             | 400    | `INVALID_CURRENCY`             |
| `TREASURY_HAS_NO_BUYING_POWER` | 403    | `TREASURY_HAS_NO_BUYING_POWER` |
| Anything else                  | 500    | `INTERNAL_ERROR`               |

## Money

A global interceptor turns every `ExactDecimal` and `Prisma.Decimal` in a response into a string with `toFixed()`: exact, unrounded and never in exponent notation. A handler returns the Decimal and does nothing else. The API does no money arithmetic and never applies `DISPLAY_SCALE`. Figures come from `balanceOf`, `heldOf` and `buyingPowerOf`.

In OpenAPI, reference the `Money` component for any amount.

## Pagination

Every list endpoint uses one scheme, from [src/pagination/](src/pagination/pagination.ts). It is keyset, never offset, so a row written after a page was read never makes the next page repeat or skip a row. A walk is still not a snapshot: `createdAt` is set when a transaction starts, so a row whose transaction started before a page was read and committed after it can be missed. M0 has no concurrent API writer, and M2's consumers read the outbox, not these endpoints.

| Parameter | Meaning                                                                                      |
| --------- | -------------------------------------------------------------------------------------------- |
| `limit`   | An integer from 1 to 200. Default 50.                                                        |
| `cursor`  | Opaque: the `nextCursor` of a previous page.                                                 |
| `from`    | Inclusive. An ISO 8601 date-time with an offset, at most millisecond precision, from year 1. |
| `to`      | Exclusive, in the same format. `from` must be earlier, or it is a 400 at `query.to`.         |

Send a `+` in an offset as `%2B`. A bare `+` in a query string decodes to a space, which is a 400.

The response is `{ "items": [...], "nextCursor": "..." }`, and `nextCursor` is `null` on the last page.

Rows are ordered newest first by a sort key each endpoint defines and its OpenAPI description states. Every key ends in fields that make it unique, because ties on time are certain: a transaction's entries all share one timestamp, and a fill whose two orders are both the caller's gives two rows. `/ledger`'s key is `(createdAt, id)`; `/trades`'s is `(filledAt, fillId, side)`. The next page is the rows strictly after the last row's key.

A cursor is base64url of the JSON sort key, validated on the way in. A cursor that fails to decode or validate is a 400 `VALIDATION_FAILED` at `query.cursor`. It carries no account id and grants nothing: scoping always comes from the principal, so another account's cursor returns only the caller's rows.

OpenAPI 3.0 has no generics, so each list endpoint has its own named page component, such as `LedgerPage`.

## OpenAPI

[openapi.json](openapi.json) is committed so the contract is reviewable in a diff. After changing a route or a schema, run `pnpm openapi` from the root. A test fails when the file differs from what the code generates.

## Tests

`pnpm --filter @orderflow/api test`, with `pnpm db:up` running. Tests that need a database get a disposable one from `@orderflow/db/testing`. They skip when no server answers, and fail under `CI`.

Authentication tests use [test-oidc.ts](src/testing/test-oidc.ts): a real JWKS server on a loopback port, with keys generated when the test runs. [probe.controller.ts](src/testing/probe.controller.ts) adds test-only routes for behaviour no real route has yet, such as a query parameter or a money response. `src/testing/` is not in the build.

Tests compile with SWC through `decoratorMetadataVitestConfig` from `@orderflow/config/vitest` ([ADR-008](../../docs/adr/008-test-runner-vitest-over-jest.md)). Vite's default transform also emits decorator metadata when `tsconfig.json` asks for it, so [decorator-metadata.test.ts](src/decorator-metadata.test.ts) also asserts that the SWC plugin is the one running.

## Not done here

Limits are held in memory per process and `trust proxy` is off, so behind a load balancer every client shares one IP. Invalid tokens are not rate limited. `/docs` sits outside the guards. Deployment (#17) has to settle these.
