---
name: github
description: Run and test the GitHub-only fork of Vercel Labs emulate locally, including OAuth App sign-in, browser App installation, installation tokens, API calls, and signed webhooks.
---

# GitHub-only emulator

Use Node 24 and pnpm 11 in this repository. Preserve Apache-2.0, upstream attribution, and the shared core/GitHub package structure so later behavioral changes can be proposed upstream.

## Start

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start --config examples/github.json
```

The emulator listens at `http://127.0.0.1:4200`. Use `--port`, `--host`, and `--base-url` to override networking. Use `pnpm start --help` for the full CLI contract. For a browser demonstration, `pnpm demo` starts an application on port 3005 and its own emulator on 4200; do not start another emulator on that port first.

## Verify

```bash
pnpm type-check
pnpm lint
pnpm test
pnpm test:smoke
node scripts/package-smoke.mjs
```

The smoke command uses real HTTP requests and signature verification. It proves OAuth App sign-in, user identity, a JWT-signed App token exchange against a seeded installation, an API mutation, and matching webhook resource identity.

## Route applications

Point OAuth authorization at `$GITHUB_EMULATOR_URL/login/oauth/authorize`, token exchange at `$GITHUB_EMULATOR_URL/login/oauth/access_token`, and API calls at `$GITHUB_EMULATOR_URL`. Set Octokit's `baseUrl` to that origin. Use synthetic credentials from the seed config; unknown bearer tokens are rejected by this wrapper.

## Install a GitHub App

Seed `apps[].setup_url` as the application callback and configure `webhook_url`, `webhook_secret`, and `events: ['installation']`. Start with `installations: []` to exercise creation. Complete OAuth sign-in first so the browser has `_emu_session`, then visit `/apps/:slug/installations/new?state=...` in the same browser. Choose **Install on ACCOUNT**, select all or specific repositories, and submit **Install**. The callback receives `installation_id`, `setup_action=install`, and the original `state`. The server uses only the configured callback URL.

Use an App JWT for `/repositories/:id/installation`, then exchange it for an installation token and call `/installation/repositories`. Request `read:org` for OAuth organization discovery through `/user/memberships/orgs`; `/user` reports granted scopes in `X-OAuth-Scopes`. See `docs/github-app-installation.md` for the authorization and pagination contracts.

## Iteration boundary

Full user authorization/refresh remains outside the verified subset. SQLite remains planned; upstream's typed store is retained initially. Keep source changes and regression tests for protocol behavior in their own commits under the upstream package paths. See `docs/upstream-workflow.md` before preparing an upstream PR. Do not publish npm releases during the baseline.
