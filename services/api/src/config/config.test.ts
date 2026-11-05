import { describe, expect, it } from "vitest";

import { ConfigError, parseConfig } from "./config.js";

const valid = {
  DATABASE_URL: "postgresql://user:hunter2@localhost:5432/db",
  OIDC_ISSUER: "https://issuer.example.invalid/",
  OIDC_AUDIENCE: "orderflow-api",
  OIDC_JWKS_URI: "https://issuer.example.invalid/jwks.json",
};

const failure = (env: NodeJS.ProcessEnv): ConfigError => {
  try {
    parseConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected parseConfig to reject this environment");
};

describe("parseConfig", () => {
  it("parses a valid environment and applies the defaults", () => {
    expect(parseConfig(valid)).toEqual({
      databaseUrl: valid.DATABASE_URL,
      oidc: {
        issuer: valid.OIDC_ISSUER,
        audience: valid.OIDC_AUDIENCE,
        jwksUri: valid.OIDC_JWKS_URI,
        jwksCacheTtlSeconds: 600,
        jwksCooldownSeconds: 30,
      },
      rateLimit: { windowSeconds: 60, authenticated: 120, public: 60 },
      port: 3000,
    });
  });

  it.each(["DATABASE_URL", "OIDC_ISSUER", "OIDC_AUDIENCE", "OIDC_JWKS_URI"] as const)(
    "names %s when it is missing",
    (name) => {
      expect(failure({ ...valid, [name]: undefined }).variables).toEqual([name]);
    },
  );

  it("names every invalid variable, not just the first", () => {
    expect(failure({}).variables).toEqual(
      expect.arrayContaining(["DATABASE_URL", "OIDC_ISSUER", "OIDC_AUDIENCE", "OIDC_JWKS_URI"]),
    );
  });

  it("never puts a value in the message, because a value can be a secret", () => {
    const { message } = failure({ ...valid, DATABASE_URL: "not a url hunter2" });

    expect(message).toContain("DATABASE_URL");
    expect(message).not.toContain("hunter2");
  });

  it("refuses a JWKS URI over plain http unless it is loopback", () => {
    expect(
      failure({ ...valid, OIDC_JWKS_URI: "http://issuer.example.invalid/jwks" }).variables,
    ).toEqual(["OIDC_JWKS_URI"]);
    expect(parseConfig({ ...valid, OIDC_JWKS_URI: "http://127.0.0.1:9/jwks" }).oidc.jwksUri).toBe(
      "http://127.0.0.1:9/jwks",
    );
  });

  it("keeps the JWKS cache TTL bounded", () => {
    expect(failure({ ...valid, OIDC_JWKS_CACHE_TTL_SECONDS: "86401" }).variables).toEqual([
      "OIDC_JWKS_CACHE_TTL_SECONDS",
    ]);
    expect(failure({ ...valid, OIDC_JWKS_CACHE_TTL_SECONDS: "0" }).variables).toEqual([
      "OIDC_JWKS_CACHE_TTL_SECONDS",
    ]);
  });

  it("rejects a rate limit that is not a positive integer", () => {
    expect(failure({ ...valid, RATE_LIMIT_PUBLIC: "lots" }).variables).toEqual([
      "RATE_LIMIT_PUBLIC",
    ]);
    expect(failure({ ...valid, RATE_LIMIT_AUTHENTICATED: "0" }).variables).toEqual([
      "RATE_LIMIT_AUTHENTICATED",
    ]);
  });
});
