import { describe, expect, it } from "vitest";

import { serverUrlFrom } from "./global-setup.js";

/** The compose server from docker-compose.yml, which this file must stay in step with. */
const COMPOSE_SERVER_URL = "postgresql://orderflow:orderflow@localhost:55432/orderflow";

/** Reads an injected environment, so this needs no database and never skips. */
describe("serverUrlFrom", () => {
  it("uses DATABASE_URL when it names a server", () => {
    const url = "postgresql://orderflow:orderflow@localhost:5432/orderflow";
    expect(serverUrlFrom({ DATABASE_URL: url })).toBe(url);
  });

  it("falls back to the compose server when DATABASE_URL is unset", () => {
    expect(serverUrlFrom({})).toBe(COMPOSE_SERVER_URL);
  });

  it("falls back to the compose server when DATABASE_URL is empty", () => {
    // A workflow that sets the variable on one matrix leg only leaves it empty on the rest.
    expect(serverUrlFrom({ DATABASE_URL: "" })).toBe(COMPOSE_SERVER_URL);
  });
});
