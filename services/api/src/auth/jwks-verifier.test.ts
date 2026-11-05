import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testConfig } from "../testing/test-app.js";
import { TestOidc } from "../testing/test-oidc.js";
import { ApiError } from "../errors/error-response.js";

import { JwksVerifier } from "./jwks-verifier.js";

describe("JwksVerifier", () => {
  let oidc: TestOidc;

  beforeEach(async () => {
    oidc = await TestOidc.start();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await oidc.stop();
  });

  const verifier = (overrides: Parameters<TestOidc["config"]>[0] = {}): JwksVerifier =>
    new JwksVerifier(testConfig({ oidc: oidc.config(overrides) }));

  const codeOf = async (promise: Promise<string>): Promise<string> => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof ApiError) {
        return error.code;
      }
      throw error;
    }
    return "ACCEPTED";
  };

  it("resolves the subject of a correctly signed token", async () => {
    await expect(verifier().verify(await oidc.sign({ sub: "someone" }))).resolves.toBe("someone");
  });

  it("does not fetch the JWKS again while the cache is fresh", async () => {
    const subject = verifier();

    await subject.verify(await oidc.sign());
    await subject.verify(await oidc.sign());
    await subject.verify(await oidc.sign());

    expect(oidc.fetchCount).toBe(1);
  });

  it("fetches again once the TTL has passed, so the cache is bounded", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const subject = verifier({ jwksCacheTtlSeconds: 60 });

    await subject.verify(await oidc.sign());
    vi.setSystemTime(Date.now() + 61_000);
    await subject.verify(await oidc.sign());

    expect(oidc.fetchCount).toBe(2);
  });

  it("stops accepting a withdrawn key once the TTL has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const subject = verifier({ jwksCacheTtlSeconds: 60 });
    const signedWithOldKey = await oidc.sign();
    await subject.verify(signedWithOldKey);

    await oidc.rotate();
    vi.setSystemTime(Date.now() + 61_000);

    await expect(codeOf(subject.verify(signedWithOldKey))).resolves.toBe("UNAUTHENTICATED");
  });

  it("picks up a rotated key without a restart", async () => {
    const subject = verifier();
    await subject.verify(await oidc.sign());
    const fetchesBefore = oidc.fetchCount;

    await oidc.rotate();

    await expect(subject.verify(await oidc.sign({ sub: "after" }))).resolves.toBe("after");
    expect(oidc.fetchCount).toBe(fetchesBefore + 1);
  });

  it("does not refetch for every unknown key id during the cooldown", async () => {
    const subject = verifier({ jwksCooldownSeconds: 30 });
    await subject.verify(await oidc.sign());
    const stranger = await oidc.foreignKey();

    await expect(codeOf(subject.verify(await oidc.sign({ key: stranger })))).resolves.toBe(
      "UNAUTHENTICATED",
    );
    await expect(codeOf(subject.verify(await oidc.sign({ key: stranger })))).resolves.toBe(
      "UNAUTHENTICATED",
    );

    expect(oidc.fetchCount).toBe(1);
  });

  it("reports an unreachable JWKS as unavailable, not as a bad token", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const subject = verifier();
    const token = await oidc.sign();

    await oidc.stop();

    await expect(codeOf(subject.verify(token))).resolves.toBe("AUTH_UNAVAILABLE");

    oidc = await TestOidc.start();
  });
});
