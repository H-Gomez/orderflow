import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { SignJWT, exportJWK, exportSPKI, generateKeyPair } from "jose";
import type { CryptoKey, JWK } from "jose";

import type { AppConfig } from "../config/config.js";

const ALG = "RS256";
const ISSUER = "https://issuer.test.invalid/";
const AUDIENCE = "orderflow-test-audience";

interface SigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
  readonly publicPem: string;
}

let keyCounter = 0;

const newSigningKey = async (): Promise<SigningKey> => {
  const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true });
  keyCounter += 1;
  const kid = `test-key-${String(keyCounter)}`;
  return {
    kid,
    privateKey,
    publicJwk: { ...(await exportJWK(publicKey)), kid, alg: ALG, use: "sig" },
    publicPem: await exportSPKI(publicKey),
  };
};

export interface TokenOptions {
  readonly sub?: string | null;
  readonly issuer?: string;
  readonly audience?: string;
  /** Seconds since the epoch. `null` leaves the claim out. */
  readonly expiresAt?: number | null;
  readonly key?: SigningKey;
}

const inAnHour = (): number => Math.floor(Date.now() / 1_000) + 3_600;

const base64Url = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * An identity provider for tests: a real HTTP server on a loopback port, serving a JWKS of keys
 * generated when the test runs. Nothing is mocked in the verifier and no key is ever committed.
 */
export class TestOidc {
  /** How many times the JWKS has been fetched. */
  fetchCount = 0;

  private constructor(
    private readonly server: Server,
    private current: SigningKey,
  ) {}

  static async start(): Promise<TestOidc> {
    const server = createServer();
    const oidc = new TestOidc(server, await newSigningKey());
    server.on("request", (_request, response) => {
      oidc.fetchCount += 1;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ keys: [oidc.current.publicJwk] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return oidc;
  }

  get jwksUri(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${String(port)}/jwks.json`;
  }

  /** The `oidc` section of a config pointing at this server. */
  config(overrides: Partial<AppConfig["oidc"]> = {}): AppConfig["oidc"] {
    return {
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUri: this.jwksUri,
      jwksCacheTtlSeconds: 600,
      jwksCooldownSeconds: 0,
      ...overrides,
    };
  }

  /** Replaces the published key: the old one stops being served, as in a real rotation. */
  async rotate(): Promise<void> {
    this.current = await newSigningKey();
  }

  /** A key that is not, and never was, in the JWKS. */
  foreignKey = newSigningKey;

  async sign(options: TokenOptions = {}): Promise<string> {
    const key = options.key ?? this.current;
    const expiresAt = options.expiresAt === undefined ? inAnHour() : options.expiresAt;
    const sub = options.sub === undefined ? "subject-under-test" : options.sub;

    let jwt = new SignJWT({})
      .setProtectedHeader({ alg: ALG, kid: key.kid })
      .setIssuer(options.issuer ?? ISSUER)
      .setAudience(options.audience ?? AUDIENCE)
      .setIssuedAt();
    if (sub !== null) {
      jwt = jwt.setSubject(sub);
    }
    if (expiresAt !== null) {
      jwt = jwt.setExpirationTime(expiresAt);
    }
    return jwt.sign(key.privateKey);
  }

  /** An `alg: none` token: claims that would pass, with no signature at all. */
  unsigned(): string {
    const header = base64Url({ alg: "none", kid: this.current.kid });
    const payload = base64Url({
      sub: "subject-under-test",
      iss: ISSUER,
      aud: AUDIENCE,
      exp: inAnHour(),
    });
    return `${header}.${payload}.`;
  }

  /** The key-confusion attack: HS256, using the published public key as the shared secret. */
  async signedWithPublicKeyAsSecret(): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: "HS256", kid: this.current.kid })
      .setSubject("subject-under-test")
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime(inAnHour())
      .sign(new TextEncoder().encode(this.current.publicPem));
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
