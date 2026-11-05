# ADR-008: Test runner (Vitest over Jest)

- Status: Accepted
- Date: 2026-11-04
- Decider: H-Gomez (repository owner)
- Issue: #21

## Context

CLAUDE.md already says tests use Vitest and forbids adding Jest, ts-jest or Babel, but the decision
behind that rule has not been recorded. The repository uses Vitest 5.0.1 today: shared config is
exported from `packages/config` as `@orderflow/config/vitest`, and `packages/db`, `packages/smoke`,
`packages/comment-lint` and `.claude/hooks` run `vitest run`. Packages are ES modules
(`"type": "module"`) and TypeScript is strict. The matching engine and settlement rely on
property-based tests with fast-check. The API will be NestJS, whose CLI scaffolds Jest by default.

This ADR records the choice so the rule has a reason, and so a later proposal to switch can argue
against something concrete.

Source: CLAUDE.md test conventions and docs/plan.md §3

## Decision

Use Vitest as the only test runner for TypeScript packages, with shared settings from
`@orderflow/config/vitest`. Do not add Jest, ts-jest or Babel.

## Alternatives considered

- **Jest.** The mature choice and the one to beat. It has been the default JavaScript test runner
  for years, so it has the larger ecosystem of matchers, reporters, IDE integrations and answers to
  edge cases. It is what the NestJS CLI generates and what most NestJS documentation and examples
  assume, so new services would follow the framework's path with no adaptation. Its snapshot,
  mocking and watch behaviour are battle-tested. It loses because this repository is native ES
  modules and TypeScript: Jest needs ts-jest or Babel (or an SWC transform) to run TypeScript, and
  its ESM support is still behind an experimental flag as of Jest 30; verify at next review. That is
  an extra transform layer with its own config and failure modes in every package. Vitest runs the
  same TypeScript and ESM with no extra transform, offers a largely Jest-compatible API (`describe`,
  `it`, `expect`, `vi.fn` in place of `jest.fn`), and supports multi-project runs that fit a
  monorepo.
- **Node's built-in test runner (`node:test`).** No dependency at all. Loses on missing features the
  repository uses or will use (rich matchers, watch mode, coverage integration and shared config are
  weaker or absent; details TBC) and on ecosystem support.
- **Keeping both.** Jest for NestJS services, Vitest elsewhere. Loses because two runners mean two
  configs, two mocking APIs and two sets of conventions for agents to follow.

## Consequences

- Easier: one runner, one shared config, no TypeScript transform layer to maintain, and tests run
  against the same ESM output the code ships as.
- Harder: NestJS relies on decorator metadata, which Vitest's default transform does not emit.
  NestJS services use `unplugin-swc` with `decoratorMetadata` enabled, configured once in
  `@orderflow/config/vitest` rather than per service. CLAUDE.md bans Babel and ts-jest, not SWC.
- Harder: Jest-specific examples from NestJS docs and the wider ecosystem need translating
  (`jest.fn` to `vi.fn`, `jest.mock` to `vi.mock`, and config).
- Must stay true: no Jest, ts-jest or Babel in any `package.json`. Python services are out of scope
  and use `pytest` (see ADR-002).
- `@fast-check/vitest` is not adopted. Plain fast-check already works with Vitest, as
  `packages/db` shows.
