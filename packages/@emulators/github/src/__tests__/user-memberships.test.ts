import { beforeEach, describe, expect, it } from "vitest";
import {
  Hono,
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type TokenMap,
} from "@emulators/core";
import { getGitHubStore, githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const tokens: TokenMap = new Map();
  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokens));
  githubPlugin.register(app as any, store, new WebhookDispatcher(), base, tokens);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "alice" }, { login: "bob" }],
    orgs: [
      { login: "zeta", members: [{ login: "alice" }] },
      { login: "acme", members: [{ login: "alice", role: "admin" }] },
      { login: "other", members: [{ login: "bob", role: "admin" }] },
    ],
  });
  const user = getGitHubStore(store).users.findOneBy("login", "alice")!;
  for (const scope of ["read:org", "write:org", "admin:org", "repo"]) {
    tokens.set(scope, { login: user.login, id: user.id, scopes: [scope] });
  }
  tokens.set("unscoped", { login: user.login, id: user.id, scopes: [] });
  tokens.set("multiple", { login: user.login, id: user.id, scopes: ["repo", "read:org", "user:email"] });
  tokens.set("installation", {
    login: user.login,
    id: user.id,
    scopes: ["read:org"],
    installation: {
      installationId: 1,
      appId: 1,
      accountId: user.id,
      accountType: "User",
      permissions: {},
      repositoryIds: [],
      repositorySelection: "all",
    },
  });
  return app;
}

function headers(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe("authenticated user organization memberships", () => {
  let app: Hono;
  beforeEach(() => {
    app = createTestApp();
  });

  it("returns active memberships with shared administrator and member roles", async () => {
    const response = await app.request(`${base}/user/memberships/orgs?state=active&per_page=100`, {
      headers: headers("read:org"),
    });
    expect(response.status).toBe(200);
    const memberships = (await response.json()) as any[];
    expect(memberships).toHaveLength(2);
    expect(memberships.map(({ state, role, organization }) => [state, role, organization.login])).toEqual([
      ["active", "admin", "acme"],
      ["active", "member", "zeta"],
    ]);
    expect(memberships[0].organization.id).toEqual(expect.any(Number));
    expect(memberships[0].organization.url).toBe(`${base}/orgs/acme`);
    expect(memberships[0].url).toBe(`${base}/orgs/acme/memberships/alice`);
  });

  it("paginates memberships with Link headers while preserving the state filter", async () => {
    const response = await app.request(`${base}/user/memberships/orgs?state=active&per_page=1`, {
      headers: headers("read:org"),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as any[]).map((membership) => membership.organization.login)).toEqual(["acme"]);
    const next = response.headers.get("Link")!.match(/<([^>]+)>; rel="next"/)![1]!;
    expect(new URL(next).searchParams.get("state")).toBe("active");
    const nextResponse = await app.request(next, { headers: headers("read:org") });
    expect(((await nextResponse.json()) as any[]).map((membership) => membership.organization.login)).toEqual(["zeta"]);
  });

  it.each(["read:org", "write:org", "admin:org"])("accepts the %s scope", async (scope) => {
    const response = await app.request(`${base}/user/memberships/orgs`, { headers: headers(scope) });
    expect(response.status).toBe(200);
  });

  it("does not invent pending memberships", async () => {
    const response = await app.request(`${base}/user/memberships/orgs?state=pending`, {
      headers: headers("read:org"),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("rejects unsupported membership states", async () => {
    const response = await app.request(`${base}/user/memberships/orgs?state=inactive`, {
      headers: headers("read:org"),
    });
    expect(response.status).toBe(422);
  });

  it("requires authentication", async () => {
    const response = await app.request(`${base}/user/memberships/orgs`);
    expect(response.status).toBe(401);
  });

  it.each(["repo", "installation"])("rejects %s credentials", async (token) => {
    const response = await app.request(`${base}/user/memberships/orgs`, { headers: headers(token) });
    expect(response.status).toBe(403);
  });

  it.each([
    ["repo", "repo"],
    ["unscoped", ""],
  ])("does not add ungranted OAuth scopes for %s", async (token, scopes) => {
    const response = await app.request(`${base}/user`, { headers: headers(token) });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-OAuth-Scopes")).toBe(scopes);
  });

  it("reports OAuth scopes when updating /user", async () => {
    const response = await app.request(`${base}/user`, {
      method: "PATCH",
      headers: { ...headers("multiple"), "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-OAuth-Scopes")).toBe("repo, read:org, user:email");
  });

  it("reports the actual OAuth token scopes on /user", async () => {
    const response = await app.request(`${base}/user`, { headers: headers("multiple") });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-OAuth-Scopes")).toBe("repo, read:org, user:email");
  });
});
