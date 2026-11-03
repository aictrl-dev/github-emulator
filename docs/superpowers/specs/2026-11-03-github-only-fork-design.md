# GitHub-only Vercel fork baseline

The user chose to start from a fork of `vercel-labs/emulate`, focus it on GitHub, prove the behavior locally, and propose behavioral improvements upstream later. This first milestone makes that existing implementation independently runnable. It supersedes extraction of the private aictrl fake as the starting point.

Keep upstream `main` and Git history intact. The `github-only` branch retains the upstream `@emulators/core` and `@emulators/github` package sources at revision `1566b8e38177bd606f1b4415b7da047ae653a8b7`. Remove other provider packages and the multi-service app/tooling from this edition. Retain Apache-2.0, third-party notices, the GitHub skill, and technical-writing guidance.

Add a bundled `@aictrl/github-emulator` package with `createGitHubEmulator({port, hostname, baseUrl, seed, tokens})`, returning `{url, generatedSecrets, reset, close}`. Preserve upstream GitHub endpoint behavior. The wrapper binds loopback by default, accepts port 0, resolves tokens to seeded user IDs, rejects unrecognized tokens, and resets all dynamic tokens and OAuth state while retaining generated app identity. Start HTTP routing only after valid seeding; close a reserved listener if startup fails. The CLI accepts JSON config and configurable host, port, and advertised URL, and handles termination signals. Bundle source and fonts so a packed tarball works outside the workspace.

Prove an OAuth App user-picker/code exchange, an authenticated API read/write, an App JWT to installation-token exchange against a seeded installation, and signed webhook reception. Provide an interactive demo on port 3005 and an automated HTTP smoke flow. Do not claim this proves a browser installation flow: that is the next behavior to implement and validate.

SQLite remains a design target. The builder's first-milestone decision is to preserve the upstream backend while proving the baseline; the optional sequencing question received no answer, so the stated recommendation to prove flows first applies. Do not silently replace this with a permanent decision to abandon SQLite. Native Git transport and protocol fixes are later iterations. Do not open an upstream PR or publish to npm in this milestone.

Use Node 24 and pnpm as required upstream. Add focused CI for these three packages, packaging checks, and the real HTTP smoke flow. Keep fork-specific packaging commits separate from later changes under the preserved GitHub/core paths so those later patches can be applied on a branch from upstream/main.

Acceptance: preserved package suites, focused wrapper tests, build/type checks/lint, packaged external-consumer smoke, and interactive demo startup pass. Fork is public on GitHub, with the GitHub-only branch discoverable as the default. Document current flow gaps and the upstream contribution workflow.
