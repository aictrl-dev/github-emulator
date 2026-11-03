import { generateKeyPairSync, sign } from "crypto";
import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, createApiErrorHandler, type TokenMap } from "@emulators/core";
import { createAppKeyResolver, getGitHubStore, githubPlugin, seedFromConfig } from "../index.js";

type RepositoryList = { total_count: number; repositories: Array<{ full_name: string }> };

const base = "http://localhost:4200";
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});

function appJwt(appId: number) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: String(appId), iat: now - 60, exp: now + 300 })).toString(
    "base64url",
  );
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
}

function fixture(selection: "all" | "selected" = "all") {
  const store = new Store();
  const tokenMap: TokenMap = new Map();
  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", authMiddleware(tokenMap, createAppKeyResolver(store)));
  githubPlugin.register(app as any, store, new WebhookDispatcher(), base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }],
    orgs: [{ login: "acme" }, { login: "other" }],
    repos: [
      { owner: "acme", name: "alpha", private: true },
      { owner: "acme", name: "beta" },
      { owner: "other", name: "outside" },
      { owner: "octocat", name: "personal" },
    ],
    apps: [
      {
        app_id: 11,
        slug: "sample-app",
        name: "Sample App",
        private_key: privateKey,
        permissions: { contents: "read" },
        installations: [
          { installation_id: 101, account: "acme", repository_selection: selection, repositories: ["alpha"] },
        ],
      },
      { app_id: 22, slug: "other-app", name: "Other App", private_key: privateKey },
    ],
  });
  return { app, gh: getGitHubStore(store), tokenMap };
}

async function installationToken(f: ReturnType<typeof fixture>, body: Record<string, unknown> = {}) {
  const response = await f.app.request(`${base}/app/installations/101/access_tokens`, {
    method: "POST",
    headers: { Authorization: `Bearer ${appJwt(11)}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { token: string }).token;
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("installation repository APIs", () => {
  it("lists full account repository metadata with pagination for an all-repositories token", async () => {
    const f = fixture();
    const token = await installationToken(f);
    const response = await f.app.request(`${base}/installation/repositories?per_page=1`, { headers: bearer(token) });
    expect(response.status).toBe(200);
    expect(response.headers.get("Link")).toContain("page=2");
    expect(response.headers.get("Link")).toContain('rel="next"');
    const data = (await response.json()) as RepositoryList;
    expect(data.total_count).toBe(2);
    expect(data.repositories).toEqual([
      expect.objectContaining({
        full_name: "acme/alpha",
        private: true,
        default_branch: "main",
        owner: expect.objectContaining({ login: "acme" }),
      }),
    ]);
    const second = await f.app.request(`${base}/installation/repositories?per_page=1&page=2`, {
      headers: bearer(token),
    });
    expect(((await second.json()) as RepositoryList).repositories.map((repo) => repo.full_name)).toEqual(["acme/beta"]);
    expect(second.headers.get("Link")).toContain('rel="prev"');
  });

  it("intersects the token scope with the current installation selection", async () => {
    const f = fixture();
    const beta = f.gh.repos.findOneBy("full_name", "acme/beta")!;
    const token = await installationToken(f, { repository_ids: [beta.id] });
    let response = await f.app.request(`${base}/installation/repositories`, { headers: bearer(token) });
    expect(response.status).toBe(200);
    expect(((await response.json()) as RepositoryList).repositories.map((repo) => repo.full_name)).toEqual([
      "acme/beta",
    ]);
    const installation = f.gh.appInstallations.all()[0];
    const alpha = f.gh.repos.findOneBy("full_name", "acme/alpha")!;
    f.gh.appInstallations.update(installation.id, { repository_selection: "selected", repository_ids: [alpha.id] });
    response = await f.app.request(`${base}/installation/repositories`, { headers: bearer(token) });
    expect(await response.json()).toEqual({ total_count: 0, repositories: [] });
  });

  it("excludes out-of-account IDs even if current installation and token list them", async () => {
    const f = fixture("selected");
    const token = await installationToken(f);
    const outside = f.gh.repos.findOneBy("full_name", "other/outside")!;
    const installation = f.gh.appInstallations.all()[0];
    f.gh.appInstallations.update(installation.id, { repository_ids: [outside.id] });
    f.tokenMap.get(token)!.installation!.repositoryIds = [outside.id];
    const response = await f.app.request(`${base}/installation/repositories`, { headers: bearer(token) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ total_count: 0, repositories: [] });
  });

  it("rejects missing, user, and app authentication for installation listing", async () => {
    const f = fixture();
    f.tokenMap.set("oauth-user", { login: "octocat", id: 3, scopes: ["repo"] });
    for (const headers of [{}, bearer("oauth-user"), bearer(appJwt(11))]) {
      const response = await f.app.request(`${base}/installation/repositories`, { headers });
      expect(response.status).toBe(401);
    }
  });

  it("rejects revoked, suspended, and mismatched installation tokens", async () => {
    const f = fixture();
    const token = await installationToken(f);
    const installation = f.gh.appInstallations.all()[0];
    f.gh.appInstallations.update(installation.id, { suspended_at: new Date().toISOString() });
    expect((await f.app.request(`${base}/installation/repositories`, { headers: bearer(token) })).status).toBe(403);
    f.gh.appInstallations.update(installation.id, { suspended_at: null, app_id: 22 });
    expect((await f.app.request(`${base}/installation/repositories`, { headers: bearer(token) })).status).toBe(403);
    f.gh.appInstallations.update(installation.id, { app_id: 11 });
    f.tokenMap.get(token)!.installation!.accountId = 999;
    expect((await f.app.request(`${base}/installation/repositories`, { headers: bearer(token) })).status).toBe(403);
    f.gh.appInstallations.delete(installation.id);
    expect((await f.app.request(`${base}/installation/repositories`, { headers: bearer(token) })).status).toBe(403);
  });

  it("finds repository installation by numeric ID only for the authenticated app", async () => {
    const f = fixture("selected");
    const alpha = f.gh.repos.findOneBy("full_name", "acme/alpha")!;
    const response = await f.app.request(`${base}/repositories/${alpha.id}/installation`, {
      headers: bearer(appJwt(11)),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        id: 101,
        app_id: 11,
        target_type: "Organization",
        account: expect.objectContaining({ login: "acme" }),
      }),
    );
    expect(
      (await f.app.request(`${base}/repositories/${alpha.id}/installation`, { headers: bearer(appJwt(22)) })).status,
    ).toBe(404);
    expect((await f.app.request(`${base}/repositories/${alpha.id}/installation`)).status).toBe(401);
  });

  it("resolves each app to its own disjoint account installation", async () => {
    const f = fixture();
    const outside = f.gh.repos.findOneBy("full_name", "other/outside")!;
    f.gh.appInstallations.insert({
      installation_id: 202,
      app_id: 22,
      account_id: outside.owner_id,
      account_type: outside.owner_type,
      account_login: "other",
      repository_selection: "all",
      repository_ids: [],
      permissions: {},
      events: [],
      suspended_at: null,
    });
    const own = await f.app.request(`${base}/repositories/${outside.id}/installation`, { headers: bearer(appJwt(22)) });
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual(expect.objectContaining({ id: 202, app_id: 22 }));
    const foreign = await f.app.request(`${base}/repositories/${outside.id}/installation`, {
      headers: bearer(appJwt(11)),
    });
    expect(foreign.status).toBe(404);
  });

  it("returns 404 for missing, suspended, unselected, and out-of-account repositories", async () => {
    const f = fixture("selected");
    for (const id of [
      999,
      f.gh.repos.findOneBy("full_name", "acme/beta")!.id,
      f.gh.repos.findOneBy("full_name", "other/outside")!.id,
    ]) {
      expect(
        (await f.app.request(`${base}/repositories/${id}/installation`, { headers: bearer(appJwt(11)) })).status,
      ).toBe(404);
    }
    const installation = f.gh.appInstallations.all()[0];
    const alpha = f.gh.repos.findOneBy("full_name", "acme/alpha")!;
    f.gh.appInstallations.update(installation.id, { suspended_at: new Date().toISOString() });
    expect(
      (await f.app.request(`${base}/repositories/${alpha.id}/installation`, { headers: bearer(appJwt(11)) })).status,
    ).toBe(404);
  });
});
