/**
 * Guardrail rules for agent sessions. The deny list traces to CLAUDE.md (Invariants) and STORY-001c.
 * The tech lead owns this list. Every rule needs a blocking and a near-miss fixture in `fixtures/`.
 */

interface RuleBase {
  /** Stable id. Printed when the rule blocks and used to name its fixtures. */
  readonly id: string;
  /** Why the rule exists. Printed when it blocks. */
  readonly reason: string;
}

export interface BashRule extends RuleBase {
  readonly kind: "bash";
  /** Tested against the lowercased, whitespace-normalised command. */
  readonly pattern: RegExp;
  /** Allow the command when every `DATABASE_URL=` set inline in it points at this machine. */
  readonly allowWhenLocalTarget: boolean;
}

export interface PathRule extends RuleBase {
  readonly kind: "path";
  /**
   * @param relativePath lowercased POSIX path relative to the project root (may start with `../`)
   * @param baseName lowercased file name
   */
  readonly matches: (relativePath: string, baseName: string) => boolean;
}

export type Rule = BashRule | PathRule;

const isUnder = (relativePath: string, dir: string): boolean =>
  relativePath === dir || relativePath.startsWith(`${dir}/`);

export const bashRules: readonly BashRule[] = [
  {
    kind: "bash",
    id: "pulumi-destroy",
    reason: "Destroying infrastructure is forbidden for agents (CLAUDE.md: `pulumi destroy`).",
    pattern: /\bpulumi\b.*\b(?:destroy|down)\b/,
    allowWhenLocalTarget: false,
  },
  {
    kind: "bash",
    id: "sql-drop-table",
    reason: "Dropping tables is forbidden for agents (CLAUDE.md: `DROP TABLE`).",
    pattern: /\bdrop\s+table\b/,
    allowWhenLocalTarget: false,
  },
  {
    kind: "bash",
    id: "sqs-purge-queue",
    reason: "Purging queues is forbidden for agents (CLAUDE.md: queue purges).",
    pattern: /\bsqs\b.*\bpurge-queue\b/,
    allowWhenLocalTarget: false,
  },
  {
    kind: "bash",
    id: "prisma-migrate-reset",
    reason:
      "`prisma migrate reset` wipes the database. It is only allowed with an inline DATABASE_URL pointing at localhost.",
    pattern: /\bprisma\b.*\bmigrate\s+reset\b/,
    allowWhenLocalTarget: true,
  },
];

export const pathRules: readonly PathRule[] = [
  {
    kind: "path",
    id: "infra-prod",
    reason: "Production infrastructure is changed by humans only.",
    matches: (relativePath) => isUnder(relativePath, "infra/prod"),
  },
  {
    kind: "path",
    id: "secrets-env-file",
    reason:
      "`.env*` files hold secrets (CLAUDE.md: never commit secrets or `.env` files). `.env.example` is allowed.",
    matches: (_relativePath, baseName) =>
      baseName.startsWith(".env") && baseName !== ".env.example",
  },
  {
    kind: "path",
    id: "claude-settings",
    reason: "Claude Code settings register these guardrails. Changes there are human-authored.",
    matches: (relativePath) =>
      relativePath === ".claude/settings.json" || relativePath === ".claude/settings.local.json",
  },
  {
    kind: "path",
    id: "claude-hooks",
    reason: "The guardrail hooks are human-authored. Agents may not edit them.",
    matches: (relativePath) => isUnder(relativePath, ".claude/hooks"),
  },
];
