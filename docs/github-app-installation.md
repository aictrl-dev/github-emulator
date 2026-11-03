# GitHub App installation

Seed a GitHub App with an optional `setup_url` to exercise browser installation after OAuth sign-in. The existing demo uses a seeded installation; use a consuming application or browser test to drive this flow.

```json
{
  "github": {
    "users": [{ "login": "developer" }],
    "orgs": [{ "login": "example-org", "members": [{ "login": "developer", "role": "admin" }] }],
    "repos": [{ "owner": "example-org", "name": "widget", "private": true }],
    "apps": [{
      "app_id": 12345,
      "slug": "example-app",
      "name": "Example App",
      "setup_url": "http://localhost:3005/github/setup",
      "webhook_url": "http://localhost:3005/webhooks",
      "webhook_secret": "local-webhook-secret",
      "permissions": { "contents": "read", "metadata": "read" },
      "events": ["installation", "issues", "pull_request"],
      "installations": []
    }]
  }
}
```

The standalone wrapper generates omitted App keys. Direct `seedFromConfig` callers must supply a key or materialize the configuration first. Callback and webhook addresses must be reachable from their respective browser and emulator processes.

1. Complete OAuth sign-in through `/login/oauth/authorize` and `/login/oauth/callback`. The callback establishes the `_emu_session` browser cookie.
2. Open `/apps/example-app/installations/new?state=YOUR_OPAQUE_STATE` in that browser. The picker offers the signed-in user's own account and organizations where that user has the `admin` role.
3. Choose **Install on example-org**. Select **All repositories** or **Only select repositories**, then check the desired repositories and choose **Install**. Repository checkboxes have accessible names such as **Select repository: example-org/widget**.
4. The emulator creates the installation and dispatches an `installation` webhook with action `created`, installation/account metadata, selected repositories, and the sender. App webhook delivery uses the configured secret for `X-Hub-Signature-256` and is best effort.
5. The browser returns to the configured `setup_url` with `installation_id`, `setup_action=install`, and the original `state`. Existing callback query parameters are retained. Query or form fields cannot override the callback URL. The callback must be an absolute HTTP(S) URL. An omitted, malformed, relative, or non-HTTP(S) callback uses the installation's local settings URL; an installation settings UI is not implemented. The redirect is resolved before saving the installation.

Installation forms expire after 10 minutes, are bound to their user, App, and account, and can be submitted once. Pending forms are limited to 32 per user across accounts and 1024 per emulator instance. Reaching either limit evicts the oldest applicable form. Reopen the installation page after expiry or eviction. The server rechecks membership and repository ownership at submission, rejects empty selected sets and cross-account IDs with `422`, and rejects a duplicate App/account installation with `409`. Form sessions and pending forms are in memory and reset with the emulator.

## Discover memberships and installed repositories

`GET /user/memberships/orgs?state=active&per_page=100` requires a user token with `read:org`, `write:org`, or `admin:org`. Responses include `state: "active"`, `role: "admin" | "member"`, and organization metadata. The emulator has active memberships only; requesting `state=pending` returns an empty list. Installation tokens cannot call this endpoint. OAuth-authenticated `GET /user` and `PATCH /user` report the token's granted scopes in `X-OAuth-Scopes`.

Use an App JWT for `GET /repositories/:id/installation`. It returns only an installation belonging to that App whose current selection includes the repository, or `404`.

Exchange an App JWT at `POST /app/installations/:installation_id/access_tokens`, then call `GET /installation/repositories` with the resulting installation token. The response contains `total_count` and full `repositories` metadata. Results must belong to the installation account and satisfy both the token's requested scope and the current installation selection. Revoked or suspended installations are rejected. Membership and repository listings use `page`, `per_page` (up to 100), and `Link` headers.
