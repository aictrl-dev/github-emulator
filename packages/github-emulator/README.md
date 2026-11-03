# @aictrl/github-emulator

GitHub-only library and CLI from the [aictrl fork of Vercel Labs emulate](https://github.com/aictrl-dev/github-emulator). Apache-2.0; upstream attribution and third-party notices are included.

This package is distributed as a source-built tarball during the baseline. It is not published to npm yet. Build and pack it from the repository README instructions, install the resulting archive, then use:

```js
import { createGitHubEmulator } from '@aictrl/github-emulator'

const github = await createGitHubEmulator({ port: 0 })
try {
  const response = await fetch(`${github.url}/user`, {
    headers: { Authorization: 'Bearer gho_local_token' },
  })
  console.log(await response.json())
} finally {
  await github.close()
}
```

The default seed is synthetic. Configure `seed` and `tokens` for your tests. The instance provides `url`, `generatedSecrets`, `reset()`, and `close()`; tokens are resolved to seeded user IDs. Reset clears dynamic credentials and replays fixture state while preserving generated App keys.

After installing the tarball, `npx github-emulator --help` lists CLI options. It listens on loopback port 4200 by default and accepts `--port`, `--host`, `--base-url`, and `--config` for JSON configuration.

Browser App installation supports the OAuth session, account and repository selection, a configured setup callback, and signed `installation.created` webhooks. See [installation configuration](../../docs/github-app-installation.md).

Current limitations include GitHub App user-token refresh, native Git clone/push, and guaranteed cancellation of in-flight webhooks during reset. The baseline uses upstream's typed in-memory state; SQLite is a planned iteration. See the repository roadmap for the supported proof flows and contribution plan.
