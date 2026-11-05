import { fileURLToPath } from "node:url";

// A devDependency: this and emit.ts are build tooling, and main.ts never reaches them.
import { format, resolveConfig } from "prettier";

import { buildOpenApiDocument } from "./document.js";

/** The same relative path from `src/openapi` and from `dist/openapi`. */
export const OPENAPI_PATH = fileURLToPath(new URL("../../openapi.json", import.meta.url));

/** The committed form of the document, formatted so that `pnpm format:check` accepts it. */
export const renderOpenApi = async (): Promise<string> => {
  const config = await resolveConfig(OPENAPI_PATH);
  return format(JSON.stringify(await buildOpenApiDocument()), { ...config, parser: "json" });
};
