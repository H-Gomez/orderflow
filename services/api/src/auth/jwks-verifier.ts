import { Inject, Injectable, Logger } from "@nestjs/common";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";

import { APP_CONFIG } from "../config/config.js";
import type { AppConfig } from "../config/config.js";
import { ApiError } from "../errors/error-response.js";

/** Asymmetric only: a symmetric algorithm here would let the public key forge tokens. */
const ALGORITHMS = ["RS256", "ES256"];

/** `jwtVerify` accepts a token with no `exp` unless told otherwise. */
const REQUIRED_CLAIMS = ["sub", "exp"];

const TOKEN_FAULTS = [
  errors.JWTExpired,
  errors.JWTClaimValidationFailed,
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
];

/** Verifies OIDC JWTs locally against the issuer's JWKS. It never asks the issuer about a token. */
@Injectable()
export class JwksVerifier {
  private readonly logger = new Logger("JwksVerifier");
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.issuer = config.oidc.issuer;
    this.audience = config.oidc.audience;
    this.jwks = createRemoteJWKSet(new URL(config.oidc.jwksUri), {
      cacheMaxAge: config.oidc.jwksCacheTtlSeconds * 1_000,
      cooldownDuration: config.oidc.jwksCooldownSeconds * 1_000,
    });
  }

  /**
   * Resolves the token's subject. Rejects with `UNAUTHENTICATED` for any fault in the token, and
   * `AUTH_UNAVAILABLE` when the keys cannot be fetched: refused either way, but only one of those
   * is the caller's fault.
   */
  async verify(token: string): Promise<string> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ALGORITHMS,
        requiredClaims: REQUIRED_CLAIMS,
      });
      // jose checks `sub` is present, not that it is a string.
      if (typeof payload.sub !== "string" || payload.sub === "") {
        throw new ApiError("UNAUTHENTICATED");
      }
      return payload.sub;
    } catch (error) {
      if (error instanceof ApiError || TOKEN_FAULTS.some((fault) => error instanceof fault)) {
        throw new ApiError("UNAUTHENTICATED");
      }
      this.logger.error("Could not fetch the JWKS", error instanceof Error ? error.stack : error);
      throw new ApiError("AUTH_UNAVAILABLE");
    }
  }
}
