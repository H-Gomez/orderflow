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
