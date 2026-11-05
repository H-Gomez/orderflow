import { describe, expect, it, vi } from "vitest";

import { run } from "./run.js";

const valid = {
  DATABASE_URL: "postgresql://user:hunter2@localhost:5432/db",
  OIDC_ISSUER: "https://issuer.example.invalid/",
  OIDC_AUDIENCE: "orderflow-api",
  OIDC_JWKS_URI: "https://issuer.example.invalid/jwks.json",
};

describe("run", () => {
  it("exits non-zero, names the variable and never starts when config is invalid", async () => {
    const start = vi.fn<() => Promise<void>>();
    const report = vi.fn<(message: string) => void>();
    const env = { ...valid, OIDC_AUDIENCE: undefined };

    await expect(run(env, start, report)).resolves.toBe(1);

    expect(start).not.toHaveBeenCalled();
    expect(report.mock.calls[0]?.[0]).toContain("OIDC_AUDIENCE");
  });

  it("starts with the parsed config when config is valid", async () => {
    const start = vi.fn<() => Promise<void>>().mockResolvedValue();

    await expect(run(valid, start, vi.fn())).resolves.toBe(0);

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ databaseUrl: valid.DATABASE_URL }),
    );
  });

  it("does not swallow an error from starting the server", async () => {
    const start = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("port in use"));

    await expect(run(valid, start, vi.fn())).rejects.toThrow("port in use");
  });
});
