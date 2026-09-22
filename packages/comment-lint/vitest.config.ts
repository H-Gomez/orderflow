import { baseVitestConfig } from "@orderflow/config/vitest";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(baseVitestConfig, defineConfig({}));
