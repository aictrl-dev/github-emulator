# Iteration roadmap

## First milestone

Make Vercel's existing GitHub emulator runnable as a GitHub-only fork. Prove OAuth App sign-in, a GitHub App installation-token exchange against a seeded installation, authenticated API changes, and signed webhook reception over real localhost HTTP.

The follow-up implementation adds [browser GitHub App installation](github-app-installation.md), setup callbacks, signed creation webhooks, and scoped repository discovery. Complete GitHub OAuth and API compatibility remain outside the verified subset.

## Next behavior to prove

Verify the supported connection journey in consuming applications: OAuth user authorization, account and repository selection, setup callback, scoped discovery, subsequent API access, and signed webhooks. The protocol regression suite covers these emulator contracts. Keep behavior commits suitable for upstream review.

## State consistency

Ephemeral SQLite remains the intended direction for schema constraints and transactional state changes with a webhook outbox. Start with upstream's current typed store while proving the baseline, subject to the user's explicit sequencing preference. Evaluate a compatibility boundary before replacing the shared upstream store, since a cross-service backend rewrite would enlarge any upstream proposal.

## Further verification

- PKCE, code/client binding, denial, refresh, and token-expiry behavior.
- Installation access changes reflected consistently across tokens, APIs, and webhook routing.
- Predictable webhook queue completion, retry identity, and reset isolation.
- Actual Git clone and push if agent workflows require them.
- A packaged first-run experience, followed by npm publication only when the fork's flows and compatibility claims are ready.
