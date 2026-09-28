import { baseVitestConfig } from "@orderflow/config/vitest";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
  baseVitestConfig,
  defineConfig({
    test: {
      // Creates a database for the run and drops it afterwards, so the tests never write into
      // a database anyone keeps. See src/testing/global-setup.ts.
      globalSetup: ["./src/testing/global-setup.ts"],
      // Every test file shares that one database, and nothing can be deleted from the ledger.
      // Run in parallel, schema.test.ts's treasury race would interleave with the ledger tests'
      // use of the treasury, and its whole-table counts with their writes. One file at a time
      // keeps each file's view of the shared rows its own.
      fileParallelism: false,
    },
  }),
);
