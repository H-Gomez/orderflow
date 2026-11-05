import { base } from "@orderflow/config/eslint";
import { defineConfig } from "eslint/config";

/** A Nest module is a decorated class with an empty body, which is the framework's own shape. */
export default defineConfig(base, {
  files: ["**/*.ts"],
  rules: {
    "@typescript-eslint/no-extraneous-class": ["error", { allowWithDecorator: true }],
  },
});
