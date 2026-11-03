# Contributing fixes upstream

This repository is a GitHub-only fork of [Vercel Labs emulate](https://github.com/vercel-labs/emulate). Upstream source history, the Apache-2.0 license, and third-party notices are retained. The first baseline starts at upstream revision `1566b8e38177bd606f1b4415b7da047ae653a8b7`.

`main` retains the upstream repository layout. The GitHub-only edition lives on the fork's working branch. Package removal, the standalone wrapper, and these fork docs are distribution changes for this repository. They are separate from later behavioral changes inside `packages/@emulators/github` and `packages/@emulators/core`.

For an upstream contribution:

1. Write a regression test for one missing or incorrect behavior using the preserved package's existing test conventions.
2. Prove the test fails, implement the change, and run the package tests, type checks, and lint. Run the local integration demo or smoke flow when the behavior spans OAuth, APIs, and callbacks.
3. Commit the behavior and its tests separately from fork packaging changes.
4. Fetch `upstream` and create a new contribution branch from `upstream/main` in another worktree. Cherry-pick the behavior commits, then update upstream's full documentation surfaces and run its required checks.
5. Review the resulting diff to confirm it contains no provider deletions, fork branding, or wrapper-only packaging changes.
6. Propose the pull request after the behavior is proved. The initial baseline does not open an upstream pull request.

Use `gh` for GitHub operations. Preserve commit hooks and never push with `--no-verify`.
