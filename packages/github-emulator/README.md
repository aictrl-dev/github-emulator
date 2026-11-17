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

Tokens are checked as GitHub checks them: a bearer token that the seed did not configure and the emulator did not issue (for example one issued before `reset()`) gets `401 Bad credentials`. Upstream emulate treats such a token as the default user; set `strict_scopes: false` in the seed to restore that. Private repositories answer `404` to callers who cannot see them.

Issue dependencies follow GitHub's REST API: `GET`/`POST /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by`, `DELETE .../dependencies/blocked_by/{issue_id}` and `GET .../dependencies/blocking`, across repositories, with GitHub's 50-relationship limit. Issue objects carry `issue_dependencies_summary`.

The default seed is synthetic. Configure `seed` and `tokens` for your tests. The instance provides `url`, `generatedSecrets`, `reset()`, and `close()`; tokens are resolved to seeded user IDs. Reset clears dynamic credentials and replays fixture state while preserving generated App keys.

After installing the tarball, `npx github-emulator --help` lists CLI options. It listens on loopback port 4200 by default and accepts `--port`, `--host`, `--base-url`, and `--config` for JSON configuration.

Browser App installation supports the OAuth session, account and repository selection, a configured setup callback, and signed `installation.created` webhooks. Pending forms expire after 10 minutes and are limited to 32 per user and 1024 per instance. Invalid callback configuration uses the installation's local settings URL. See [installation configuration](../../docs/github-app-installation.md).

The source checkout includes a [cross-host browser proof](../../docs/cross-host-installation.md) with local HTTPS origins and a temporary trusted browser profile. It verifies that `setup_url` preserves its configured host and that the initiating host's `__Host-` cookie returns only after a redirect back to that host.

Current limitations include GitHub App user-token refresh, native Git clone/push, and guaranteed cancellation of in-flight webhooks during reset. The baseline uses upstream's typed in-memory state; SQLite is a planned iteration. See the repository roadmap for the supported proof flows and contribution plan.
