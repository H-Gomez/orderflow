import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BLOCK_EXIT_CODE } from "./hook-io.ts";
import { truncate } from "./post-edit.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempPackage(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "post-edit-"));
  tempDirs.push(dir);
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "temp", private: true, type: "module" }),
  );
  writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        types: [],
        module: "nodenext",
        target: "es2024",
      },
      include: ["*.ts"],
    }),
  );
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

function runPostEdit(filePath: string): { status: number | null; stdout: string; stderr: string } {
  const payload = {
    cwd: path.dirname(filePath),
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: filePath, content: "" },
  };
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "post-edit.ts")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: path.dirname(filePath) },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("post-edit.ts", () => {
  it("exits 2 with the TypeScript error and file name when the owning package fails to typecheck", () => {
    const dir = tempPackage({ "broken.ts": 'export const n: number = "x";\n' });
    const { status, stderr } = runPostEdit(path.join(dir, "broken.ts"));
    expect(status).toBe(BLOCK_EXIT_CODE);
    expect(stderr).toContain("TS2322");
    expect(stderr).toContain("broken.ts");
  });

  it("exits 0 with no output for a valid file", () => {
    const dir = tempPackage({ "valid.ts": "export const n: number = 1;\n" });
    expect(runPostEdit(path.join(dir, "valid.ts"))).toEqual({ status: 0, stdout: "", stderr: "" });
  });

  it("formats the edited file with Prettier", () => {
    const dir = tempPackage({ "messy.ts": "export   const n:number=1\n" });
    const filePath = path.join(dir, "messy.ts");
    expect(runPostEdit(filePath).status).toBe(0);
    expect(readFileSync(filePath, "utf8")).toBe("export const n: number = 1;\n");
  });

  it("exits 2 when Prettier cannot parse the file", () => {
    const dir = tempPackage({ "notes.json": "{ not json" });
    const { status, stderr } = runPostEdit(path.join(dir, "notes.json"));
    expect(status).toBe(BLOCK_EXIT_CODE);
    expect(stderr).toContain("Prettier could not format");
  });

  it("fails open (exit 1, not 2) on malformed input", () => {
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "post-edit.ts")], {
      input: "{",
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
  });
});

describe("truncate", () => {
  it("keeps short output as is", () => {
    expect(truncate("a\nb\n")).toBe("a\nb");
  });

  it("caps long output and says so", () => {
    const output = Array.from({ length: 100 }, (_, i) => `line ${String(i)}`).join("\n");
    const truncated = truncate(output);
    expect(truncated.split("\n")).toHaveLength(31);
    expect(truncated).toMatch(/output truncated$/);
  });
});
