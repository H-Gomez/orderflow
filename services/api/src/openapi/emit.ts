import "reflect-metadata";

import { writeFile } from "node:fs/promises";

import { OPENAPI_PATH, renderOpenApi } from "./render.js";

await writeFile(OPENAPI_PATH, await renderOpenApi());
process.stdout.write(`Wrote ${OPENAPI_PATH}\n`);
