import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { firefox } from "playwright";
import { correlationCookie, startCrossHostDemo } from "./cross-host-demo.mjs";
import { createLocalTls, launchTrustedFirefox } from "./lib/local-https.mjs";

test(
  "GitHub installation preserves setup_url host, then a source-host bounce restores the host-only cookie",
  { timeout: 90_000 },
  async (t) => {
    const certificates = await createLocalTls();
    let context;
    let demo;
    try {
      context = await launchTrustedFirefox(firefox, certificates);
      demo = await startCrossHostDemo({ tls: certificates.tls });
      const page = await context.newPage();
      for (const mode of ["reject", "bounce"]) {
        demo.reset();
        await context.clearCookies();
        await page.goto(`${demo.sourceOrigin}/login?mode=${mode}`);
        await page.locator('form:has(input[name="login"][value="octocat"]) button').click();
        await page.getByRole("link", { name: "Install on example-org", exact: true }).click();
        await page.getByRole("radio", { name: "Only select repositories", exact: true }).check();
        await page.getByRole("checkbox", { name: "Select repository: example-org/selected", exact: true }).check();
        assert.equal(
          await page
            .getByRole("checkbox", { name: "Select repository: example-org/unselected", exact: true })
            .isChecked(),
          false,
        );
        const initialState = new URL(page.url()).searchParams.get("state");
        assert.ok(initialState.includes("opaque + /?&=%#return"));
        const installationResponse = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname === "/apps/cross-host-proof/installations/new",
        );
        const finalOrigin = mode === "bounce" ? demo.sourceOrigin : demo.callbackOrigin;
        const callbackResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).origin === finalOrigin &&
            new URL(response.url()).pathname === "/api/github-app/setup" &&
            response.status() !== 302,
        );
        await page.getByRole("button", { name: "Install", exact: true }).click();
        const redirect = await installationResponse;
        assert.equal(redirect.status(), 302);
        assert.equal(new URL((await redirect.allHeaders()).location).origin, demo.callbackOrigin);
        await page.waitForURL(
          (url) =>
            url.origin === (mode === "bounce" ? demo.sourceOrigin : demo.callbackOrigin) &&
            url.pathname === "/api/github-app/setup",
        );
        const result = JSON.parse(await page.locator("body").innerText());
        const cookies = await context.cookies(demo.sourceOrigin);
        const correlation = cookies.find((cookie) => cookie.name === correlationCookie);
        assert.ok(correlation);
        const claims = JSON.parse(initialState.slice(0, initialState.lastIndexOf(".")));
        assert.equal(claims.nonceHash, createHash("sha256").update(correlation.value).digest("hex"));
        assert.equal(Object.hasOwn(claims, "nonce"), false);
        assert.equal(initialState.includes(correlation.value), false);
        assert.equal(correlation.domain, new URL(demo.sourceOrigin).hostname);
        assert.equal(correlation.secure, true);
        assert.equal(correlation.httpOnly, true);
        assert.equal(correlation.sameSite, "Lax");
        assert.equal(correlation.path, "/");
        assert.equal(
          (await context.cookies(demo.callbackOrigin)).some((cookie) => cookie.name === correlationCookie),
          false,
        );
        assert.equal(demo.observations[0].origin, demo.callbackOrigin);
        assert.equal(demo.observations[0].hasCorrelationCookie, false);
        assert.equal(demo.observations[0].state, initialState);
        assert.equal(demo.observations[0].setupAction, "install");
        assert.ok(/^\d+$/.test(demo.observations[0].installationId));
        const callback = new URL(`${demo.callbackOrigin}${demo.observations[0].path}${demo.observations[0].search}`);
        assert.equal(callback.searchParams.get("marker"), "keep+encoded");
        assert.deepEqual(callback.searchParams.getAll("extra"), ["first", "second"]);
        if (mode === "reject") {
          assert.equal((await callbackResponse).status(), 400);
          assert.equal(result.error, "Missing host-only OAuth cookie");
          assert.equal(demo.observations.length, 1);
          t.diagnostic(`${demo.callbackOrigin}: correlation cookie absent, callback rejected with HTTP 400`);
        } else {
          assert.equal((await callbackResponse).status(), 200);
          assert.equal(result.complete, true);
          assert.deepEqual(result.repositories, ["example-org/selected"]);
          assert.equal(demo.observations.length, 2);
          assert.equal(demo.observations[1].origin, demo.sourceOrigin);
          assert.equal(demo.observations[1].hasCorrelationCookie, true);
          assert.equal(demo.observations[1].path, demo.observations[0].path);
          assert.equal(demo.observations[1].search, demo.observations[0].search);
          assert.equal(demo.observations[1].state, initialState);
          t.diagnostic(
            `${demo.callbackOrigin}: cookie absent; ${demo.sourceOrigin}: cookie restored, query preserved, selected repository verified with HTTP 200`,
          );
        }
      }
    } finally {
      try {
        await context?.close();
      } finally {
        try {
          await demo?.close();
        } finally {
          await certificates.close();
        }
      }
    }
  },
);
