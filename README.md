# github-emulator

A GitHub-only fork of [Vercel Labs emulate](https://github.com/vercel-labs/emulate) for local integration tests. It retains the upstream GitHub API and shared core, with a standalone library, CLI, and localhost demo. Licensed under Apache-2.0 with upstream attribution and third-party notices preserved.

The emulator supports OAuth App sign-in, browser GitHub App installation with account and repository selection, installation-token API calls, and signed webhook delivery. Installation forms have bounded, expiring storage, and invalid setup callbacks fall back to a local settings URL. See [GitHub App installation](docs/github-app-installation.md) for the browser flow and discovery endpoints, and the [roadmap](docs/roadmap.md) for remaining gaps.

## Run the demo

Requires Node.js 24 or newer and pnpm 11. The `packageManager` field pins the pnpm version; Corepack can provision it.

```bash
git clone --branch github-only https://github.com/aictrl-dev/github-emulator.git
cd github-emulator
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm demo
```

Open **http://127.0.0.1:3005**. The demo starts its own GitHub emulator at **http://127.0.0.1:4200**.

1. Select **Sign in with the local GitHub emulator**, then choose the seeded `octocat` user.
2. After the OAuth callback, select **Read authenticated user** to exercise the API with the exchanged user token.
3. Select **Create issue with App token**. The demo signs an App JWT, mints an installation token, and creates an issue in the private fixture repository.
4. Select **Inspect events** to see the signature-verified webhook from that mutation.

Both servers use local synthetic credentials. The private App key stays in the demo server. Stop them with Ctrl+C. The browser proof uses a seeded installation, so it does not establish browser installation or repository-selection behavior.

If another local application already uses `127.0.0.1:3005`, choose another available loopback address while keeping the demo on port 3005: `DEMO_HOST=127.0.0.98 pnpm demo`.

## Run the emulator by itself

```bash
pnpm start --config examples/github.json
```

The CLI accepts:

| Flag | Default | Purpose |
| --- | --- | --- |
| `--port` | `4200` | Listening port; `0` chooses a free port |
| `--host` | `127.0.0.1` | Bind address |
| `--base-url` | Listener origin | Advertised HTTP(S) origin for responses |
| `--config` | Built-in local seed | JSON config with a `github` seed object and optional `tokens` map |
| `--help` | | Show usage |

The built-in seed and example config provide `octocat/hello-world`, OAuth client `local-client` with local secret `local-secret`, and seeded API token `gho_local_token`. The default OAuth callback is `http://127.0.0.1:3005/callback`.

```bash
curl -H 'Authorization: Bearer gho_local_token' http://127.0.0.1:4200/user
```

`GET /_emulate/health` reports readiness. Unknown bearer tokens are rejected; this wrapper does not enable upstream's fallback identity for arbitrary credentials. For container clients, bind `--host 0.0.0.0` and set `--base-url` to an origin those clients can reach.

## Use the library

From this source checkout after building:

```js
import { createGitHubEmulator } from './packages/github-emulator/dist/index.js'

const github = await createGitHubEmulator({
  port: 0,
  seed: {
    users: [{ login: 'developer' }],
    repos: [{ owner: 'developer', name: 'widget', private: true, auto_init: true }],
  },
  tokens: { local_test_token: { login: 'developer', scopes: ['repo', 'user'] } },
})

try {
  const response = await fetch(`${github.url}/user`, {
    headers: { Authorization: 'Bearer local_test_token' },
  })
  console.log(await response.json())
  github.reset()
} finally {
  await github.close()
}
```

Options are `port`, `hostname`, `baseUrl`, `seed`, and `tokens`. The instance exposes `url`, `generatedSecrets`, `reset()`, and `close()`. Seeding uses the retained [upstream GitHub config](packages/@emulators/github/README.md). Tokens resolve to actual seeded user IDs. Omitted GitHub App keys are generated and returned through `generatedSecrets` in the programmatic API; the CLI does not print private keys.

Each instance has independent in-memory state. Reset replays its seed and clears dynamic OAuth and installation tokens while retaining generated App keys. Closing an instance releases its HTTP listener. The baseline retains upstream's in-memory backend; SQLite is planned as a later consistency improvement. In-flight webhook cancellation across reset is not guaranteed by this baseline.

## Test and package

```bash
pnpm build
pnpm type-check
pnpm lint
pnpm format:check
pnpm test
pnpm test:smoke
node scripts/package-smoke.mjs
```

The smoke flow uses actual localhost HTTP for OAuth redirects, token exchange, an App-authenticated mutation, and signature verification at a separate callback server. It selects available ports and closes its servers when done.

The package check builds a tarball, installs it in an external temporary consumer, and verifies API requests, bundled fonts, license notices, CLI validation, startup, and shutdown. To create a tarball for your own project:

```bash
pnpm pack:standalone
```

Install the generated `.tgz` from `artifacts/` with `npm install /path/to/archive.tgz`, then import `createGitHubEmulator` from `@aictrl/github-emulator` or run `npx github-emulator --help`. The fork package is not published to npm yet.

The root build script keeps esbuild's working directory in the system temporary directory to avoid unrelated ancestor Yarn PnP manifests while preserving each upstream package's build configuration.

## Upstream contributions

`main` keeps upstream history and layout. The default `github-only` branch contains this reduced edition. Protocol improvements and their regression tests stay in the preserved upstream package paths, separate from wrapper and packaging changes. Follow the [contribution procedure](docs/upstream-workflow.md) to propose behavior-only patches against Vercel's full repository after tests prove them.

Retained packages:

- `packages/@emulators/core`: upstream HTTP, typed store, OAuth UI helpers, and webhook dispatcher.
- `packages/@emulators/github`: upstream GitHub routes, entities, and fixtures.
- `packages/github-emulator`: fork library and CLI wrapper.

The original project, GitHub, and Vercel retain their respective names and attribution. This fork is independently maintained.
