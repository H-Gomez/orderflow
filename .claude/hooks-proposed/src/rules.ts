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
  /** Lowercased directories or files this rule protects. Absent for a rule keyed on the file name. */
  readonly roots?: readonly string[];
}

/** Blocks a Bash write whose target cannot be worked out from the command text. */
export interface BashWriteRule extends RuleBase {
  readonly kind: "bash-write";
}

export interface ContentRule extends RuleBase {
  readonly kind: "content";
  /** @param baseName lowercased file name */
  readonly appliesTo: (baseName: string) => boolean;
  /** Tested against the text the tool call is about to write, as given. Must not use the `g` flag. */
  readonly pattern: RegExp;
}

export type Rule = BashRule | PathRule | BashWriteRule | ContentRule;

const isUnder = (relativePath: string, dir: string): boolean =>
  relativePath === dir || relativePath.startsWith(`${dir}/`);

const rootedRule = (id: string, reason: string, roots: readonly string[]): PathRule => ({
  kind: "path",
  id,
  reason,
  roots,
  matches: (relativePath) => roots.some((root) => isUnder(relativePath, root)),
});

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
  rootedRule("infra-prod", "Production infrastructure is changed by humans only.", ["infra/prod"]),
  {
    kind: "path",
    id: "secrets-env-file",
    reason:
      "`.env*` files hold secrets (CLAUDE.md: never commit secrets or `.env` files). `.env.example` is allowed.",
    matches: (_relativePath, baseName) =>
      baseName.startsWith(".env") && baseName !== ".env.example",
  },
  rootedRule(
    "claude-settings",
    "Claude Code settings register these guardrails. Changes there are human-authored.",
    [".claude/settings.json", ".claude/settings.local.json"],
  ),
  rootedRule("claude-hooks", "The guardrail hooks are human-authored. Agents may not edit them.", [
    ".claude/hooks",
  ]),
  rootedRule("github-dir", "`.github` belongs to the human (CLAUDE.md). Agents may not edit it.", [
    ".github",
  ]),
  rootedRule(
    "claude-md",
    "`CLAUDE.md` holds the agents' rules. Changes there are human-authored.",
    ["claude.md"],
  ),
];

export const bashWriteUnresolvedRule: BashWriteRule = {
  kind: "bash-write",
  id: "bash-write-unresolved",
  reason:
    "This command writes to a target the hook cannot resolve from the command text, so it fails closed. Write to a literal path.",
};

/**
 * The first rule with a root inside `relativePath`: the ancestor case `matches` cannot see, such as
 * `rm -rf .claude`. `relativePath` is lowercased, POSIX and relative to the project root; `""` is
 * the root itself and a path of only `..` segments is above it.
 */
export function coversGuardedRoot(relativePath: string): PathRule | undefined {
  const aboveRoot = relativePath === "" || /^\.\.(?:\/\.\.)*$/.test(relativePath);
  return pathRules.find((rule) =>
    rule.roots?.some((root) => aboveRoot || root.startsWith(`${relativePath}/`)),
  );
}

export const contentRules: readonly ContentRule[] = [
  {
    kind: "content",
    id: "sql-destructive-statement",
    reason:
      "Destructive SQL needs a human's approval (CLAUDE.md: destructive operations such as `DROP TABLE`).",
    appliesTo: (baseName) => baseName.endsWith(".sql"),
    pattern: /\b(?:drop\s+(?:table|schema|database|index|column)|truncate|delete\s+from)\b/i,
  },
];
