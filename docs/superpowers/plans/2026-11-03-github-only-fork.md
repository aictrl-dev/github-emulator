# GitHub-only fork implementation plan

> **For agentic workers:** Use superpowers:executing-plans for native execution. Steps use checkbox syntax for tracking. Delegate test suites and hook-running commits/pushes as the user requested.

**Goal:** Ship a runnable GitHub-only fork baseline that can validate later upstream contributions.

**Architecture:** Preserve the two upstream provider/core packages and add an independent bundled wrapper. Keep packaging changes off upstream/main. The real HTTP demo proves existing flows and explicitly identifies the missing browser installation journey.

**Tech stack:** Node 24, pnpm 11, TypeScript, existing upstream HTTP/store/GitHub packages, Vitest, tsup.

**Spec:** `docs/superpowers/specs/2026-11-03-github-only-fork-design.md`.

## Global constraints

- Demo uses port 3005; emulator defaults to 4200 and permits ephemeral ports.
- Preserve Apache-2.0 and third-party notices.
- Keep upstream GitHub and core source unchanged for this baseline.
- SQLite remains planned; retain the upstream backend for this baseline.
- Do not propose the upstream PR until behavior is proved; no npm publication.

## Review focus

- A failed configuration must release its listener.
- Reset must revoke dynamic OAuth and installation tokens, not only clear visible entities.
- Token seeds must use actual seeded user IDs, not assume an ID allocation order.
- A packed consumer must find fonts and dependencies outside this monorepo.
- Startup and shutdown must report failures and leave no demo listeners behind.

## Task 1: Isolated provider baseline and runtime

**Files:** root workspace/lock/config; `packages/github-emulator/{package.json,tsup.config.ts,tsconfig.json,src/index.ts,src/cli.ts,src/__tests__/runtime.test.ts}`.

**Interfaces:** consume upstream `githubPlugin`, `seedFromConfig`, `prepareSeed`, `createAppKeyResolver`, `createServer`, `serve`; produce `createGitHubEmulator(options): Promise<GitHubEmulator>` with `url`, `generatedSecrets`, `reset(): void`, `close(): Promise<void>`.

- [x] Keep the core/GitHub package files unchanged and install the reduced workspace; run their suites as a baseline.
- [x] Write focused HTTP tests for binding, seeded credentials, unknown-token rejection, OAuth exchange, reset revocation/key stability, and failed startup cleanup; run them before implementing the wrapper and record the expected missing-runtime failure.
- [x] Implement only the wrapper and CLI, with generated app keys in programmatic results and no private key output in CLI logs.
- [x] Build and run wrapper tests plus upstream suites and type/lint checks.

## Task 2: Demo, consumer proof, and packaging

**Files:** `examples/{demo.mjs,smoke.mjs,github.json}`, `scripts/package-smoke.mjs`, `.github/workflows/ci.yml`, wrapper README and package assets.

**Interfaces:** consume `createGitHubEmulator`; produce a real HTTP demonstration and `pnpm test:smoke` command. The demo exports `startDemo({appPort, emulatorPort})` for isolated smoke tests and starts at 3005/4200 when executed directly.

- [x] Write smoke assertions for browser OAuth redirects, user identity, App token issuance, issue creation, and a signature-verified webhook with matching repository/issue identity.
- [x] Implement the demo using the upstream shared UI renderer and an actual local webhook receiver. Browser installation remains identified as a gap.
- [x] Pack the wrapper and install/import it in a temporary consumer; run binding/API/font/CLI checks and assert license notices are included.
- [x] Add focused CI and source/run documentation, then run the complete checks.

## Task 3: Review and publish the fork branch

**Files:** `README.md`, `AGENTS.md`, `skills/github/SKILL.md`, `docs/{upstream-workflow,roadmap}.md`.

**Interfaces:** consume verified commands/results; produce a public GitHub-only fork with clean branch history and an upstream contribution procedure.

- [x] Document accepted decisions, flow limitations, SQLite follow-up, and how to move behavior-only patches onto upstream/main.
- [x] Run a fresh branch review, address material defects, and verify changed behavior.
- [ ] Delegate commits and push to the fork, keep hooks enabled, set the GitHub-only branch as fork default, and inspect CI results. Do not open an upstream PR.
