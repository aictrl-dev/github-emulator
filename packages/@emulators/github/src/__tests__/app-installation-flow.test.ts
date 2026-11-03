import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, createApiErrorHandler, type TokenMap } from "@emulators/core";
import { githubPlugin, getGitHubStore, seedFromConfig } from "../index.js";

const base = "http://localhost:4200";
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function fixture(webhookUrl?: string, setupUrl = "https://client.example/setup?keep=1") {
  const store = new Store();
  const tokens: TokenMap = new Map();
  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", authMiddleware(tokens));
  githubPlugin.register(app as any, store, new WebhookDispatcher(), base, tokens);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }, { login: "other" }],
    orgs: [
      { login: "acme", members: [{ login: "octocat", role: "admin" }] },
      { login: "member-org", members: [{ login: "octocat", role: "member" }] },
      { login: "stranger-org" },
    ],
    repos: [
      { owner: "acme", name: "widget", private: true },
      { owner: "acme", name: "another" },
      { owner: "other", name: "secret", private: true },
      { owner: "octocat", name: "personal" },
    ],
    apps: [
      {
        app_id: 42,
        slug: "example-app",
        name: "Example App",
        private_key: "fixture-key",
        setup_url: setupUrl,
        webhook_url: webhookUrl,
        webhook_secret: "fixture-webhook-secret",
        events: ["installation"],
        permissions: { contents: "read", metadata: "read" },
        installations: [],
      },
    ],
  });
  return { app, gh: getGitHubStore(store), store };
}

type Fixture = ReturnType<typeof fixture>;
async function session(f: Fixture, login = "octocat") {
  const response = await f.app.request(`${base}/login/oauth/callback`, {
    method: "POST",
    body: new URLSearchParams({
      login,
      redirect_uri: "https://client.example/oauth",
      scope: "read:org",
      client_id: "fixture",
    }),
  });
  return response.headers.get("set-cookie")!.split(";")[0];
}
async function form(f: Fixture, cookie: string, account = "acme", state = "opaque + /?&=%<state>") {
  const picker = await f.app.request(`${base}/apps/example-app/installations/new?state=${encodeURIComponent(state)}`, {
    headers: { Cookie: cookie },
  });
  const html = await picker.text();
  const link = html.match(new RegExp(`href="([^"]+)"[^>]*>Install on ${account}</a>`));
  expect(link, html).not.toBeNull();
  const response = await f.app.request(new URL(link![1].replaceAll("&amp;", "&"), base).href, {
    headers: { Cookie: cookie },
  });
  expect(response.status).toBe(200);
  const formHtml = await response.text();
  const nonce = formHtml.match(/name="nonce" value="([^"]+)"/)![1];
  return {
    html: formHtml,
    body: new URLSearchParams({ nonce, account, repository_selection: "selected" }),
    url: `${base}/apps/example-app/installations/new`,
  };
}
async function submit(f: Fixture, cookie: string, data: Awaited<ReturnType<typeof form>>) {
  return f.app.request(data.url, { method: "POST", headers: { Cookie: cookie }, body: data.body });
}

describe("GitHub App browser installation", () => {
  it("requires a shared OAuth session cookie and offers only the user's own account and admin organizations", async () => {
    const f = fixture();
    expect((await f.app.request(`${base}/apps/example-app/installations/new`)).status).toBe(401);
    const cookie = await session(f);
    const response = await f.app.request(`${base}/apps/example-app/installations/new`, { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Install on octocat");
    expect(html).toContain("Install on acme");
    expect(html).not.toContain("Install on other");
    expect(html).not.toContain("Install on member-org");
    expect(html).not.toContain("Install on stranger-org");
  });

  it("creates a selected installation and preserves opaque state in the configured setup callback", async () => {
    const f = fixture();
    const cookie = await session(f);
    const data = await form(f, cookie);
    expect(data.html).toContain("Select repository: acme/widget");
    expect(data.html).not.toContain("other/secret");
    const repo = f.gh.repos.findOneBy("full_name", "acme/widget")!;
    data.body.append("repository_ids", String(repo.id));
    data.body.set("setup_url", "https://attacker.example/");
    const response = await submit(f, cookie, data);
    expect(response.status).toBe(302);
    const redirect = new URL(response.headers.get("location")!);
    expect(redirect.origin + redirect.pathname).toBe("https://client.example/setup");
    expect(redirect.searchParams.get("keep")).toBe("1");
    expect(redirect.searchParams.get("state")).toBe("opaque + /?&=%<state>");
    expect(redirect.searchParams.get("setup_action")).toBe("install");
    const installation = f.gh.appInstallations.all()[0];
    expect(installation).toMatchObject({
      app_id: 42,
      account_login: "acme",
      repository_selection: "selected",
      repository_ids: [repo.id],
    });
    expect(installation.installation_id).toBeGreaterThan(0);
    expect(redirect.searchParams.get("installation_id")).toBe(String(installation.installation_id));
    expect((await submit(f, cookie, data)).status).toBe(403);
  });

  it("delivers a signed installation.created webhook through the real app dispatcher", async () => {
    const deliveries: Array<{ headers: import("node:http").IncomingHttpHeaders; body: string }> = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      deliveries.push({ headers: req.headers, body });
      res.end("ok");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as import("node:net").AddressInfo;
    const f = fixture(`http://127.0.0.1:${address.port}/webhook`);
    const cookie = await session(f);
    const data = await form(f, cookie);
    data.body.set("repository_selection", "all");
    expect((await submit(f, cookie, data)).status).toBe(302);
    expect(deliveries).toHaveLength(1);
    const delivery = deliveries[0];
    expect(delivery.headers["x-github-event"]).toBe("installation");
    expect(delivery.headers["x-hub-signature-256"]).toBe(
      `sha256=${createHmac("sha256", "fixture-webhook-secret").update(delivery.body).digest("hex")}`,
    );
    const payload = JSON.parse(delivery.body);
    expect(payload).toMatchObject({
      action: "created",
      installation: {
        id: f.gh.appInstallations.all()[0].installation_id,
        app_id: 42,
        account: { login: "acme", type: "Organization" },
        repository_selection: "all",
      },
      sender: { login: "octocat" },
    });
    expect(payload.repositories.map((repo: any) => repo.full_name)).toEqual(["acme/widget", "acme/another"]);
  });

  it("rejects cross-account IDs, altered account fields, missing sessions, and nonces from another user", async () => {
    const f = fixture();
    const cookie = await session(f);
    const data = await form(f, cookie);
    data.body.append("repository_ids", String(f.gh.repos.findOneBy("full_name", "other/secret")!.id));
    expect((await submit(f, cookie, data)).status).toBe(422);
    expect(f.gh.appInstallations.all()).toHaveLength(0);
    const second = await form(f, cookie);
    second.body.set("account", "other");
    second.body.append("repository_ids", String(f.gh.repos.findOneBy("full_name", "acme/widget")!.id));
    expect((await submit(f, "", second)).status).toBe(401);
    expect((await submit(f, await session(f, "other"), second)).status).toBe(403);
    expect((await submit(f, cookie, second)).status).toBe(403);
    expect(f.gh.appInstallations.all()).toHaveLength(0);
  });

  it("validates membership again at submission and prevents duplicate app/account installations", async () => {
    const f = fixture();
    const cookie = await session(f);
    const first = await form(f, cookie);
    const second = await form(f, cookie);
    first.body.set("repository_selection", "all");
    expect((await submit(f, cookie, first)).status).toBe(302);
    second.body.set("repository_selection", "all");
    expect((await submit(f, cookie, second)).status).toBe(409);
    expect(f.gh.appInstallations.all()).toHaveLength(1);
    const personal = await form(f, cookie, "octocat");
    personal.body.set("repository_selection", "all");
    expect((await submit(f, cookie, personal)).status).toBe(302);
    expect(new Set(f.gh.appInstallations.all().map((i) => i.installation_id)).size).toBe(2);
    const f2 = fixture();
    const cookie2 = await session(f2);
    const pending = await form(f2, cookie2);
    for (const member of f2.gh.teamMembers.all()) f2.gh.teamMembers.delete(member.id);
    expect((await submit(f2, cookie2, pending)).status).toBe(403);
  });
  it("accepts repeated repository checkboxes and rejects a nonce submitted for another app", async () => {
    const f = fixture();
    const cookie = await session(f);
    const data = await form(f, cookie);
    for (const repo of f.gh.repos.all().filter((repo) => repo.full_name.startsWith("acme/"))) {
      data.body.append("repository_ids", String(repo.id));
    }
    expect((await submit(f, cookie, data)).status).toBe(302);
    expect(f.gh.appInstallations.all()[0].repository_ids).toHaveLength(2);
    const second = await form(f, cookie, "octocat");
    second.body.set("repository_selection", "all");
    second.url = `${base}/apps/another-app/installations/new`;
    expect((await submit(f, cookie, second)).status).toBe(403);
  });

  it("rejects non-admin account queries and malformed or empty selected repositories", async () => {
    const f = fixture();
    const cookie = await session(f);
    for (const account of ["other", "member-org", "stranger-org"]) {
      const response = await f.app.request(`${base}/apps/example-app/installations/new?account=${account}`, {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(403);
    }
    for (const ids of [[], ["1oops"], ["0"], ["-1"]]) {
      const data = await form(f, cookie);
      for (const id of ids) data.body.append("repository_ids", id);
      expect((await submit(f, cookie, data)).status).toBe(422);
    }
    expect(f.gh.appInstallations.all()).toHaveLength(0);
  });
});

describe("installation form lifetime and callback recovery", () => {
  it("evicts the oldest of more than 32 forms for one user while preserving another user's form", async () => {
    const f = fixture();
    const cookie = await session(f);
    const otherCookie = await session(f, "other");
    const otherForm = await form(f, otherCookie, "other");
    const tabs = [];
    for (let index = 0; index < 33; index++) {
      tabs.push(await form(f, cookie, index === 32 ? "octocat" : "acme"));
    }
    for (const tab of [tabs[0], tabs[1], tabs.at(-1)!, otherForm]) tab.body.set("repository_selection", "all");
    expect((await submit(f, cookie, tabs[0])).status).toBe(403);
    expect(f.gh.appInstallations.all()).toHaveLength(0);
    expect(f.store.getData<Map<string, unknown>>("github.installation.pendingForms")!.size).toBeLessThanOrEqual(33);
    expect((await submit(f, cookie, tabs[1])).status).toBe(302);
    expect((await submit(f, cookie, tabs.at(-1)!)).status).toBe(302);
    expect((await submit(f, otherCookie, otherForm)).status).toBe(302);
    expect(
      f.gh.appInstallations
        .all()
        .map((installation) => installation.account_login)
        .sort(),
    ).toEqual(["acme", "octocat", "other"]);
  });

  it("evicts the oldest global form after 1024 pending forms spread across users", async () => {
    const f = fixture();
    const users = Array.from({ length: 33 }, (_, index) => ({ login: `capacity-user-${index}` }));
    seedFromConfig(f.store, base, { users });
    let oldest: { cookie: string; data: Awaited<ReturnType<typeof form>> } | undefined;
    let retained: typeof oldest;
    let latest: typeof oldest;
    for (let userIndex = 0; userIndex < users.length; userIndex++) {
      const login = users[userIndex].login;
      const cookie = await session(f, login);
      for (let index = 0; index < (userIndex === 32 ? 1 : 32); index++) {
        const data = await form(f, cookie, login);
        data.body.set("repository_selection", "all");
        oldest ??= { cookie, data };
        if (userIndex === 0 && index === 1) retained = { cookie, data };
        latest = { cookie, data };
      }
    }
    expect((await submit(f, oldest!.cookie, oldest!.data)).status).toBe(403);
    expect(f.gh.appInstallations.all()).toHaveLength(0);
    expect(f.store.getData<Map<string, unknown>>("github.installation.pendingForms")!.size).toBeLessThanOrEqual(1024);
    expect((await submit(f, retained!.cookie, retained!.data)).status).toBe(302);
    expect((await submit(f, latest!.cookie, latest!.data)).status).toBe(302);
    expect(f.gh.appInstallations.all()).toHaveLength(2);
    expect((await submit(f, latest!.cookie, latest!.data)).status).toBe(403);
  }, 15_000);

  it("cleans forms older than ten minutes while preserving both unexpired tabs", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const f = fixture();
    const cookie = await session(f);
    const expired = await form(f, cookie);
    now += 9 * 60 * 1000;
    const personalTab = await form(f, cookie, "octocat");
    now += 60 * 1000 + 1;
    const organizationTab = await form(f, cookie);
    expect(f.store.getData<Map<string, unknown>>("github.installation.pendingForms")!.size).toBe(2);
    for (const tab of [expired, personalTab, organizationTab]) tab.body.set("repository_selection", "all");
    expect((await submit(f, cookie, expired)).status).toBe(403);
    expect((await submit(f, cookie, personalTab)).status).toBe(302);
    expect((await submit(f, cookie, organizationTab)).status).toBe(302);
    expect(
      f.gh.appInstallations
        .all()
        .map((installation) => installation.account_login)
        .sort(),
    ).toEqual(["acme", "octocat"]);
  });

  it.each([
    "",
    "/setup",
    "//client.example/setup",
    "not a URL",
    "https://[",
    "javascript:alert(1)",
    "data:text/html,local",
    "file:///tmp/setup",
    "ftp://client.example/setup",
    "mailto:local@example.test",
  ])("falls back to local settings when the seeded setup URL is %j", async (setupUrl) => {
    const f = fixture(undefined, setupUrl);
    const cookie = await session(f);
    const state = "opaque + /?&=%<state>#return";
    const data = await form(f, cookie, "acme", state);
    data.body.set("repository_selection", "all");
    const response = await submit(f, cookie, data);
    expect(response.status).toBe(302);
    expect(f.gh.appInstallations.all()).toHaveLength(1);
    const installation = f.gh.appInstallations.all()[0];
    const redirect = new URL(response.headers.get("location")!);
    expect(redirect.origin + redirect.pathname).toBe(`${base}/settings/installations/${installation.installation_id}`);
    expect(redirect.searchParams.get("state")).toBe(state);
    expect(redirect.searchParams.get("installation_id")).toBe(String(installation.installation_id));
    expect(redirect.searchParams.get("setup_action")).toBe("install");
    expect((await submit(f, cookie, data)).status).toBe(403);
    expect(f.gh.appInstallations.all()).toHaveLength(1);
  });

  it.each(["http://client.example/setup?keep=1", "https://client.example/setup?keep=1"])(
    "continues to the configured HTTP callback %s",
    async (setupUrl) => {
      const f = fixture(undefined, setupUrl);
      const cookie = await session(f);
      const state = "opaque + /?&=%<state>#return";
      const data = await form(f, cookie, "acme", state);
      data.body.set("repository_selection", "all");
      const response = await submit(f, cookie, data);
      expect(response.status).toBe(302);
      const redirect = new URL(response.headers.get("location")!);
      const configured = new URL(setupUrl);
      expect(redirect.origin + redirect.pathname).toBe(configured.origin + configured.pathname);
      expect(redirect.searchParams.get("keep")).toBe("1");
      expect(redirect.searchParams.get("state")).toBe(state);
      expect(f.gh.appInstallations.all()).toHaveLength(1);
    },
  );

  it("delivers one installation webhook and saves once when the seeded callback is malformed", async () => {
    const deliveries: string[] = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      deliveries.push(body);
      res.end("ok");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as import("node:net").AddressInfo;
    const f = fixture(`http://127.0.0.1:${address.port}/webhook`, "https://[");
    const cookie = await session(f);
    const data = await form(f, cookie);
    data.body.set("repository_selection", "all");
    const response = await submit(f, cookie, data);
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!).origin).toBe(base);
    expect(f.gh.appInstallations.all()).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
    expect(JSON.parse(deliveries[0]).installation.id).toBe(f.gh.appInstallations.all()[0].installation_id);
    expect((await submit(f, cookie, data)).status).toBe(403);
    expect(f.gh.appInstallations.all()).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
  });
});
