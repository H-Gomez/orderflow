import { baseVitestConfig } from "@orderflow/config/vitest";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  baseVitestConfig,
  defineConfig({
    test: {
      // Creates a database for the run and drops it afterwards, so the tests never write into
      // a database anyone keeps. See src/testing/global-setup.ts.
      globalSetup: ["./src/testing/global-setup.ts"],
    },
  }),
);
