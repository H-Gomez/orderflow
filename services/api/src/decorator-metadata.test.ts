import "reflect-metadata";

import { Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";

import vitestConfig from "../vitest.config.js";

import { JwksVerifier } from "./auth/jwks-verifier.js";
import { JwtAuthGuard } from "./auth/jwt-auth.guard.js";

@Injectable()
class Dependency {
  readonly name = "dependency";
}

@Injectable()
class Consumer {
  constructor(readonly dependency: Dependency) {}
}

describe("decorator metadata under unplugin-swc", () => {
  // Vite's default transform also emits this metadata when tsconfig asks for it, so the tests below
  // would pass with the plugin missing. The plugin turns that transform off, so with it present
  // SWC is the only thing compiling this file.
  it("compiles this service's tests with the SWC plugin", () => {
    const plugins: unknown = vitestConfig["plugins"];

    expect(plugins).toEqual(expect.arrayContaining([expect.objectContaining({ name: "swc" })]));
  });

  it("emits the constructor's parameter types", () => {
    expect(Reflect.getMetadata("design:paramtypes", Consumer)).toEqual([Dependency]);
  });

  it("emits them for this service's own guard", () => {
    expect(Reflect.getMetadata("design:paramtypes", JwtAuthGuard)).toEqual([
      JwksVerifier,
      Reflector,
    ]);
  });

  it("lets Nest inject a provider by its type, with no explicit token", async () => {
    const module = await Test.createTestingModule({ providers: [Dependency, Consumer] }).compile();

    expect(module.get(Consumer).dependency).toBeInstanceOf(Dependency);

    await module.close();
  });
});
