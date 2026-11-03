# Baseline verification

Verified on 2026-11-03 with Node 24.21.0 and pnpm 11.2.2.

| Check | Result |
| --- | --- |
| `pnpm build` | Pass: core, GitHub, bundled wrapper, CLI, and declarations |
| `pnpm type-check` | Pass for all three packages |
| `pnpm format:check` | Pass |
| `pnpm lint` | Pass with 19 inherited warnings and zero errors |
| `pnpm test` | 221 tests in 14 files pass: core 103, GitHub 112, wrapper 6 |
| `pnpm test:smoke` | Pass: actual HTTP OAuth redirects, identity, App JWT exchange, installation token, API mutation, and matching signed webhook |
| `node scripts/package-smoke.mjs` | Pass: packed external consumer, API, bundled fonts, license notices, CLI validation, startup, and SIGTERM shutdown |

The wrapper's six behavioral tests failed against its typed unimplemented stub before implementation, then passed. They exercise ephemeral-port advertisement, font assets, seeded identity mapping, unknown credentials, OAuth and installation-token reset behavior, App key stability, failed-seed listener cleanup, and invalid runtime options.

The retained `packages/@emulators/core` and `packages/@emulators/github` trees have no changes against upstream revision `1566b8e38177bd606f1b4415b7da047ae653a8b7`. A fresh read-only branch review reported no important findings.

A browser run also completed sign-in as `octocat`, returned through the OAuth callback, created an issue using the seeded installation, and displayed one signature-verified webhook. The local demonstration used `127.0.0.98:3005` because another application owned `127.0.0.1:3005`.

These checks establish the baseline's existing seeded-installation flow. They do not establish browser-driven GitHub App installation, SQLite behavior, native Git transport, or complete GitHub protocol fidelity. Those remain roadmap work.
