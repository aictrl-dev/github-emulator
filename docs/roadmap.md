# Iteration roadmap

## First milestone

Make Vercel's existing GitHub emulator runnable as a GitHub-only fork. Prove OAuth App sign-in, a GitHub App installation-token exchange against a seeded installation, authenticated API changes, and signed webhook reception over real localhost HTTP.

This baseline does not provide browser-driven GitHub App installation. It does not claim complete GitHub OAuth or API compatibility. Keep the remaining gaps visible while the working subset is validated.

## Next behavior to prove

Exercise the application's full connection journey: user authorization, account and repository selection, installation setup callback, discovery of installations/repositories, and subsequent API access and webhooks. Add focused regression tests before changes, and keep behavior commits suitable for upstream review. Check existing upstream PR #265 and issue #328 before duplicating installation-discovery work.

## State consistency

Ephemeral SQLite remains the intended direction for schema constraints and transactional state changes with a webhook outbox. Start with upstream's current typed store while proving the baseline, subject to the user's explicit sequencing preference. Evaluate a compatibility boundary before replacing the shared upstream store, since a cross-service backend rewrite would enlarge any upstream proposal.

## Further verification

- PKCE, code/client binding, denial, refresh, and token-expiry behavior.
- Installation access changes reflected consistently across tokens, APIs, and webhook routing.
- Predictable webhook queue completion, retry identity, and reset isolation.
- Actual Git clone and push if agent workflows require them.
- A packaged first-run experience, followed by npm publication only when the fork's flows and compatibility claims are ready.
