import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

/** @type {import("eslint").Linter.RulesRecord} */
const noDefaultExports = {
  "no-restricted-exports": [
    "error",
    {
      restrictDefaultExports: {
        direct: true,
        named: true,
        defaultFrom: true,
        namedFrom: true,
        namespaceFrom: true,
      },
    },
  ],
};

/** Shared flat config. Tool config files (`*.config.*`) may default-export, since their tools require it. */
export const base = defineConfig(
  { ignores: ["**/dist/**", "**/coverage/**", "**/.turbo/**", "**/node_modules/**"] },
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: globals.node,
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
  js.configs.recommended,
  {
    files: ["**/*.ts", "**/*.mts", "**/*.cts"],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    rules: noDefaultExports,
  },
  {
    files: ["**/*.config.{js,mjs,cjs,ts,mts,cts}"],
    rules: { "no-restricted-exports": "off" },
  },
  prettier,
);
