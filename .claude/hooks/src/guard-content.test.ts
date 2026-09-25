import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findBlockingContent } from "./guard-content.ts";
import type { HookInput } from "./hook-io.ts";

const write = (filePath: string, content: string): HookInput => ({
  cwd: "/repo",
  toolName: "Write",
  toolInput: { file_path: filePath, content },
});

const blockedStatement = (input: HookInput): string | undefined =>
  findBlockingContent(input, "/repo")?.statement;

describe("findBlockingContent", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    "DROP TABLE x;",
    "DROP SCHEMA x;",
    "DROP DATABASE x;",
    "DROP INDEX x;",
    "ALTER TABLE x DROP COLUMN y;",
    "TRUNCATE x;",
    "DELETE FROM x;",
  ])("blocks %s", (sql) => {
    expect(blockedStatement(write("/repo/a.sql", sql))).toBeDefined();
  });

  it("names the statement it matched, as written", () => {
    expect(blockedStatement(write("/repo/a.sql", "drop\n  table x;"))).toBe("drop\n  table");
  });

  it.each([
    "CREATE OR REPLACE FUNCTION f() RETURNS TRIGGER AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql;",
    "CREATE OR REPLACE TRIGGER t BEFORE UPDATE OR DELETE ON x FOR EACH ROW EXECUTE FUNCTION f();",
    "ALTER TABLE x ADD CONSTRAINT x_fk FOREIGN KEY (y) REFERENCES z(id) ON DELETE CASCADE;",
    'CREATE TABLE "Backdrop" ("id" UUID NOT NULL, "deleted_from" TEXT);',
  ])("allows %s", (sql) => {
    expect(blockedStatement(write("/repo/a.sql", sql))).toBeUndefined();
  });

  it("reads the pending content, not the file on disk", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "guard-content-"));
    dirs.push(dir);
    const onDisk = path.join(dir, "old.sql");
    writeFileSync(onDisk, "DROP TABLE x;\n");
    const edit: HookInput = {
      cwd: dir,
      toolName: "Edit",
      toolInput: { file_path: onDisk, old_string: "x", new_string: "y" },
    };
    expect(findBlockingContent(edit, dir)).toBeUndefined();
  });

  it("fails closed when a .sql write carries no content", () => {
    const input: HookInput = {
      cwd: "/repo",
      toolName: "Write",
      toolInput: { file_path: "a.sql" },
    };
    expect(() => findBlockingContent(input, "/repo")).toThrow("no content");
  });

  it("ignores content written to files that are not .sql", () => {
    expect(blockedStatement(write("/repo/notes.md", "DROP TABLE x;"))).toBeUndefined();
  });
});