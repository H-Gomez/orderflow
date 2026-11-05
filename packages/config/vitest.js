import { defineConfig } from "vitest/config";

/** Base Vitest config; packages merge over it with `mergeConfig`. */
export const baseVitestConfig = defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    restoreMocks: true,
  },
});

/**
 * Opt-in config for a NestJS service: compiles its tests with SWC so they run with legacy decorators
 * and decorator metadata (ADR-008). Merge it over {@link baseVitestConfig}. The import is dynamic so
 * a package that does not opt in never loads SWC.
 */
export const decoratorMetadataVitestConfig = async () => {
  const { default: swc } = await import("unplugin-swc");
  return defineConfig({
    plugins: [
      swc.vite({
        swcrc: false,
        configFile: false,
        tsconfigFile: false,
        module: { type: "es6" },
        jsc: {
          target: "es2022",
          keepClassNames: true,
          parser: { syntax: "typescript", decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
        },
      }),
    ],
  });
};
