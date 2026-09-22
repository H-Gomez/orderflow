import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Rules about the shape of the schema itself, checked without a database so they run
 * everywhere. They are the invariants that no amount of application code can restore once the
 * schema gets them wrong: money precision, and the absence of a stored balance.
 */
const schema = readFileSync(join(import.meta.dirname, "..", "prisma", "schema.prisma"), "utf8");
const migration = readFileSync(
  join(import.meta.dirname, "..", "prisma", "migrations", "20260922000000_init", "migration.sql"),
  "utf8",
);

/** Field lines like `  amount    Decimal  @db.Decimal(38, 18)`, ignoring comments and blocks. */
const fieldLines = schema
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("//") && !line.startsWith("///"));

describe("money representation (ledger.md section 7)", () => {
  it("gives every Decimal field the exact precision and scale the ledger states", () => {
    const decimalFields = fieldLines.filter((line) => /\bDecimal\??\s/u.test(line));

    expect(decimalFields.length).toBeGreaterThan(0);
    for (const field of decimalFields) {
      expect(field).toContain("@db.Decimal(38, 18)");
    }
  });

  it("uses no binary floating point in any field", () => {
    // Declarations only: the file's own prose says the words "Float" and "Double" too.
    const declarations = fieldLines.join("\n");

    expect(declarations).not.toMatch(/\bFloat\b/u);
    expect(declarations).not.toMatch(/\bDouble\b/u);
    expect(declarations).not.toMatch(/@db\.Real\b/u);
    expect(declarations).not.toMatch(/@db\.DoublePrecision\b/u);
  });

  it("writes the money columns as NUMERIC(38, 18) in the migration", () => {
    expect(migration).toMatch(/DECIMAL\(38,18\)/u);
    expect(migration).not.toMatch(/\bDOUBLE PRECISION\b/u);
    expect(migration).not.toMatch(/\bREAL\b/u);
  });
});

describe("no stored balance (ledger.md section 5)", () => {
  it("declares no balance field on any model", () => {
    const balanceFields = fieldLines.filter((line) => /^balance\w*\s/iu.test(line));

    expect(balanceFields).toEqual([]);
  });

  it("creates no balance column and no materialised view in the migration", () => {
    expect(migration).not.toMatch(/"balance\w*"/iu);
    expect(migration).not.toMatch(/MATERIALIZED VIEW/iu);
  });
});

describe("append-only ledger (ledger.md section 4)", () => {
  it("installs a trigger on both ledger tables", () => {
    expect(migration).toMatch(/CREATE TRIGGER "ledger_entry_append_only"/u);
    expect(migration).toMatch(/CREATE TRIGGER "ledger_transaction_append_only"/u);
    expect(migration).toMatch(/BEFORE UPDATE OR DELETE ON "LedgerEntry"/u);
    expect(migration).toMatch(/BEFORE UPDATE OR DELETE ON "LedgerTransaction"/u);
  });

  it("keys a transaction by its cause, so a repeat is not a second transaction", () => {
    expect(schema).toMatch(/causeKey\s+String\s+@unique/u);
  });
});

describe("accounts (accounts.md sections 1 and 6)", () => {
  it("installs the single-treasury trigger", () => {
    expect(migration).toMatch(/CREATE TRIGGER "account_single_treasury"/u);
  });

  it("keeps currency off the account and account type off the entry", () => {
    const accountModel = /model Account \{[\s\S]*?\n\}/u.exec(schema)?.[0] ?? "";
    const entryModel = /model LedgerEntry \{[\s\S]*?\n\}/u.exec(schema)?.[0] ?? "";

    expect(accountModel).not.toMatch(/^\s*currency\s/mu);
    expect(entryModel).not.toMatch(/^\s*type\s/mu);
    expect(entryModel).toMatch(/^\s*currency\s+String/mu);
  });
});
