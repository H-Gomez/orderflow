import { z } from "zod";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const isHttpsOrLoopback = (value: string): boolean => {
  const url = new URL(value);
  return (
    url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
  );
};

const positiveInt = (fallback: number) => z.coerce.number().int().min(1).default(fallback);

const environmentSchema = z.object({
  DATABASE_URL: z.url(),
  OIDC_ISSUER: z.string().min(1),
  OIDC_AUDIENCE: z.string().min(1),
  OIDC_JWKS_URI: z.url().refine(isHttpsOrLoopback, "must be https, or http on a loopback address"),
  /** A key the issuer has withdrawn stops working at most this long after it is withdrawn. */
  OIDC_JWKS_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(86_400).default(600),
  /** The shortest gap between refetches that a token with an unknown key id can trigger. */
  OIDC_JWKS_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(3_600).default(30),
  RATE_LIMIT_WINDOW_SECONDS: positiveInt(60),
  RATE_LIMIT_AUTHENTICATED: positiveInt(120),
  RATE_LIMIT_PUBLIC: positiveInt(60),
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
});

/** The service's configuration. Nothing else in the service reads `process.env`. */
export interface AppConfig {
  readonly databaseUrl: string;
  readonly oidc: {
    readonly issuer: string;
    readonly audience: string;
    readonly jwksUri: string;
    readonly jwksCacheTtlSeconds: number;
    readonly jwksCooldownSeconds: number;
  };
  readonly rateLimit: {
    readonly windowSeconds: number;
    readonly authenticated: number;
    readonly public: number;
  };
  readonly port: number;
}

/** The injection token for {@link AppConfig}. */
export const APP_CONFIG = Symbol("APP_CONFIG");

/** The environment failed validation. The message names variables and never holds a value. */
export class ConfigError extends Error {
  readonly variables: readonly string[];

  constructor(problems: readonly { readonly variable: string; readonly problem: string }[]) {
    super(problems.map(({ variable, problem }) => `${variable}: ${problem}`).join("\n"));
    this.name = "ConfigError";
    this.variables = problems.map(({ variable }) => variable);
  }
}

/** Validates the environment, or throws a {@link ConfigError} naming every bad variable. */
export const parseConfig = (env: NodeJS.ProcessEnv): AppConfig => {
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => ({
        variable: String(issue.path[0]),
        problem: issue.message,
      })),
    );
  }

  const { data } = parsed;
  return {
    databaseUrl: data.DATABASE_URL,
    oidc: {
      issuer: data.OIDC_ISSUER,
      audience: data.OIDC_AUDIENCE,
      jwksUri: data.OIDC_JWKS_URI,
      jwksCacheTtlSeconds: data.OIDC_JWKS_CACHE_TTL_SECONDS,
      jwksCooldownSeconds: data.OIDC_JWKS_COOLDOWN_SECONDS,
    },
    rateLimit: {
      windowSeconds: data.RATE_LIMIT_WINDOW_SECONDS,
      authenticated: data.RATE_LIMIT_AUTHENTICATED,
      public: data.RATE_LIMIT_PUBLIC,
    },
    port: data.PORT,
  };
};
