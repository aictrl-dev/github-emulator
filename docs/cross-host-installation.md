# Reproduce an installation return across hosts

An application can start OAuth at `https://aictrl.dev` while its GitHub App's configured setup callback returns to `https://app.aictrl.dev/api/github-app/setup`. A host-only correlation cookie belongs to the initiating host. Validating it at the other host rejects the installation return because the browser doesn't send it there.

The emulator already redirects to the full configured `apps[].setup_url`, including its host. This proof exercises that behavior through the OAuth user picker and GitHub App installation form. Both application listeners stay on port 3005:

| Role | Local origin |
| --- | --- |
| Initiating application | `https://127.0.0.98:3005` |
| Configured setup callback | `https://127.0.0.99:3005` |
| GitHub emulator | `http://127.0.0.100:4200` |

These separate loopback IP hosts require no DNS or hosts-file changes. A second port on the same host wouldn't test host-only cookie isolation.

## Run the browser proof

Use Node 24, pnpm 11, OpenSSL, and `certutil` from `libnss3-tools`. On Debian or Ubuntu, install the last prerequisite with `sudo apt install libnss3-tools`. If the binary is outside `PATH`, set `CERTUTIL_PATH` to its absolute path.

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm exec playwright install firefox
pnpm test:cross-host
```

The test generates a temporary CA and a server certificate for both loopback hosts. It imports that CA into a temporary Firefox profile, starts the HTTPS listeners, and keeps browser certificate verification enabled. It removes the profile and certificates and closes the listeners afterward. The user's browser profile and system trust store remain unchanged.

The browser runs two flows. Each starts OAuth on the initiating host, chooses **octocat**, chooses **Install on example-org**, selects **Only select repositories**, checks **Select repository: example-org/selected**, and submits **Install**.

1. The first return stays on the configured callback host. The server receives no `__Host-emulator_oauth_correlation` cookie and reports `Missing host-only OAuth cookie`.
2. The second return verifies the fixture's signed state, redirects to the initiating host's same callback path, then validates the correlation cookie there. The browser supplies the cookie, and the fixture exchanges an App JWT for an installation token. `/installation/repositories` returns only `example-org/selected`.

The assertions check the emulator's installation response redirects to the configured host, the cookie's `Secure`, `HttpOnly`, `SameSite=Lax`, and `Path=/` attributes, and its absence from the other host. They also check the opaque `state`, `installation_id`, `setup_action=install`, and existing query parameters. The bounce preserves the entire callback query, including repeated parameters and encoded values. Requests use browser-managed cookies throughout.

## Run the demonstration interactively

Provide a PEM key and certificate whose subject alternative names include `127.0.0.98` and `127.0.0.99`, signed by a CA your browser trusts. The browser test's temporary trust applies only to its own Firefox profile.

```bash
CROSS_HOST_TLS_KEY=/path/to/server.key \
CROSS_HOST_TLS_CERT=/path/to/server.crt \
pnpm demo:cross-host
```

Open `https://127.0.0.98:3005`. Choose **Reproduce missing callback cookie** or **Return to the initiating host**, then complete the user, account, and repository choices. The callback displays the result as JSON. `/observations` on either application origin exposes the callback host, synthetic fixture state, raw query, and whether the request carried the correlation cookie.

The demonstration creates an installation on the selected account. Restart it before installing the same App on that account again. Stop it with Ctrl+C.

## Reuse the fixture in an application regression

[`examples/lib/local-https.mjs`](../examples/lib/local-https.mjs) exports:

- `createLocalTls(hostnames)` accepts IP addresses, creates temporary CA/server PEM files, and returns `{ ca, directory, tls, close }`. Its defaults are `127.0.0.98` and `127.0.0.99`.
- `launchTrustedFirefox(firefox, certificates, { headless })` imports the CA into an isolated profile and returns a Playwright browser context with HTTPS verification enabled.
- `startHttpsOrigins({ tls, handler, appPort, sourceHostname, callbackHostname })` binds two HTTPS listeners and returns `{ sourceOrigin, callbackOrigin, close }`. The handler receives Node request/response objects and both origins. The default application port is 3005.

[`startCrossHostDemo`](../examples/cross-host-demo.mjs) combines these origins with a seeded emulator. It returns `sourceOrigin`, `callbackOrigin`, `emulatorUrl`, `observations`, `reset()`, and `close()`. Its optional asynchronous `setupHandler` receives `{ request, response, url, sourceOrigin, callbackOrigin, observation }`. Return `true` after handling a setup callback, or return a false value to use the demonstration handler. `reset()` clears observations and resets emulator state between browser cases.

For an application's own handler, reuse the HTTPS and trusted-browser helpers, configure the emulator's `setup_url` to the callback origin, and route both HTTPS listeners to the application. Initiate OAuth through its normal route. Keep the negative assertion at the callback host and assert that the successful return reaches the initiating host with the original query and browser correlation cookie. The fixture's HMAC/state implementation illustrates the redirect order; the application must run its own state verification and correlation checks.
