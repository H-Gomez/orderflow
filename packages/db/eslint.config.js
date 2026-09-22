import { base } from "@orderflow/config/eslint";
import { defineConfig } from "eslint/config";

/** The Prisma client is generated code; nobody lints it or fixes its style. */
export default defineConfig({ ignores: ["src/generated/**"] }, base);
