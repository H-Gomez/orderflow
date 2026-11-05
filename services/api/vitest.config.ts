import { baseVitestConfig, decoratorMetadataVitestConfig } from "@orderflow/config/vitest";
import { mergeConfig } from "vitest/config";

export default mergeConfig(baseVitestConfig, await decoratorMetadataVitestConfig());
