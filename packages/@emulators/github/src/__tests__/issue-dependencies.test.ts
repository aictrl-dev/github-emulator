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
import { githubPlugin, seedFromConfig } from "../index.js";
import { getGitHubStore } from "../store.js";
import { MAX_ISSUE_DEPENDENCIES } from "../routes/issue-dependencies.js";

const base = "http://localhost:4000";

type Issue = {
  id: number;
  number: number;
  issue_dependencies_summary: {
    blocked_by: number;
    blocking: number;
    total_blocked_by: number;
    total_blocking: number;
  };
};

function createTestApp() {
  const store = new Store();
  const tokenMap: TokenMap = new Map([
    ["octocat-token", { login: "octocat", id: 1, scopes: ["repo", "user"] }],
    ["hubot-token", { login: "hubot", id: 2, scopes: ["repo", "user"] }],
  ]);
  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, new WebhookDispatcher(), base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }, { login: "hubot" }],
    repos: [
      { owner: "octocat", name: "alpha" },
      { owner: "octocat", name: "beta" },
      { owner: "hubot", name: "secret", private: true },
    ],
  });
  return { app, store };
}

describe("GitHub issue dependencies", () => {
  let app: Hono;
  let store: Store;

  const call = (path: string, init: { method?: string; token?: string | null; body?: unknown } = {}) => {
    const headers: Record<string, string> = {};
    const token = init.token === undefined ? "octocat-token" : init.token;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    return app.request(`${base}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  };

  const createIssue = async (repo: string, token = "octocat-token"): Promise<Issue> => {
    const res = await call(`/repos/${repo}/issues`, { method: "POST", token, body: { title: `Issue in ${repo}` } });
    expect(res.status).toBe(201);
    return (await res.json()) as Issue;
  };

  const addBlocker = (repo: string, number: number, issueId: unknown, token?: string | null) =>
    call(`/repos/${repo}/issues/${number}/dependencies/blocked_by`, {
      method: "POST",
      token,
      body: { issue_id: issueId },
    });

  beforeEach(() => {
    ({ app, store } = createTestApp());
  });

  it("adds, lists in both directions and removes an edge across repositories", async () => {
    const blocked = await createIssue("octocat/alpha");
    const blocker = await createIssue("octocat/beta");

    const added = await addBlocker("octocat/alpha", blocked.number, blocker.id);
    expect(added.status).toBe(201);
    expect(((await added.json()) as Issue).id).toBe(blocker.id);

    const blockedBy = (await (
      await call(`/repos/octocat/alpha/issues/${blocked.number}/dependencies/blocked_by`)
    ).json()) as Issue[];
    expect(blockedBy.map((issue) => issue.id)).toEqual([blocker.id]);
    const blocking = (await (
      await call(`/repos/octocat/beta/issues/${blocker.number}/dependencies/blocking`)
    ).json()) as Issue[];
    expect(blocking.map((issue) => issue.id)).toEqual([blocked.id]);

    const summary = ((await (await call(`/repos/octocat/alpha/issues/${blocked.number}`)).json()) as Issue)
      .issue_dependencies_summary;
    expect(summary).toEqual({ blocked_by: 1, blocking: 0, total_blocked_by: 1, total_blocking: 0 });

    const removed = await call(`/repos/octocat/alpha/issues/${blocked.number}/dependencies/blocked_by/${blocker.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as Issue).id).toBe(blocker.id);
    expect(await (await call(`/repos/octocat/alpha/issues/${blocked.number}/dependencies/blocked_by`)).json()).toEqual(
      [],
    );
    const again = await call(`/repos/octocat/alpha/issues/${blocked.number}/dependencies/blocked_by/${blocker.id}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(404);
  });

  it("counts only open issues in blocked_by and blocking, and all in the totals", async () => {
    const blocked = await createIssue("octocat/alpha");
    const open = await createIssue("octocat/alpha");
    const closed = await createIssue("octocat/alpha");
    await addBlocker("octocat/alpha", blocked.number, open.id);
    await addBlocker("octocat/alpha", blocked.number, closed.id);
    await call(`/repos/octocat/alpha/issues/${closed.number}`, { method: "PATCH", body: { state: "closed" } });

    const summary = ((await (await call(`/repos/octocat/alpha/issues/${blocked.number}`)).json()) as Issue)
      .issue_dependencies_summary;
    expect(summary).toEqual({ blocked_by: 1, blocking: 0, total_blocked_by: 2, total_blocking: 0 });
  });

  it("rejects a self-reference, a duplicate edge and a malformed id with 422", async () => {
    const blocked = await createIssue("octocat/alpha");
    const blocker = await createIssue("octocat/alpha");
    expect((await addBlocker("octocat/alpha", blocked.number, blocked.id)).status).toBe(422);
    expect((await addBlocker("octocat/alpha", blocked.number, blocker.id)).status).toBe(201);
    expect((await addBlocker("octocat/alpha", blocked.number, blocker.id)).status).toBe(422);
    expect((await addBlocker("octocat/alpha", blocked.number, "not-a-number")).status).toBe(422);
  });

  it("returns 404 for an unknown issue, an unknown issue id and an issue the caller cannot see", async () => {
    const blocked = await createIssue("octocat/alpha");
    const hidden = await createIssue("hubot/secret", "hubot-token");
    expect((await call("/repos/octocat/alpha/issues/999/dependencies/blocked_by")).status).toBe(404);
    expect((await addBlocker("octocat/alpha", blocked.number, 999_999)).status).toBe(404);
    expect((await addBlocker("octocat/alpha", blocked.number, hidden.id)).status).toBe(404);
    expect((await call(`/repos/hubot/secret/issues/${hidden.number}/dependencies/blocking`)).status).toBe(404);
  });

  it("omits related issues the caller cannot see from lists", async () => {
    const blocked = await createIssue("octocat/alpha");
    const hidden = await createIssue("hubot/secret", "hubot-token");
    getGitHubStore(store).issueDependencies.insert({ blocked_issue_id: blocked.id, blocking_issue_id: hidden.id });

    const asOctocat = await call(`/repos/octocat/alpha/issues/${blocked.number}/dependencies/blocked_by`);
    expect(await asOctocat.json()).toEqual([]);
    const asHubot = await call(`/repos/octocat/alpha/issues/${blocked.number}/dependencies/blocked_by`, {
      token: "hubot-token",
    });
    expect(((await asHubot.json()) as Issue[]).map((issue) => issue.id)).toEqual([hidden.id]);
    // The shared issue payload never counts a blocker some readers of this issue cannot see.
    const summary = ((await (await call(`/repos/octocat/alpha/issues/${blocked.number}`)).json()) as Issue)
      .issue_dependencies_summary;
    expect(summary).toEqual({ blocked_by: 0, blocking: 0, total_blocked_by: 0, total_blocking: 0 });
  });

  it("removes an edge whose far end the caller can no longer read, and rejects a malformed id", async () => {
    const blocked = await createIssue("octocat/alpha");
    const hidden = await createIssue("hubot/secret", "hubot-token");
    getGitHubStore(store).issueDependencies.insert({ blocked_issue_id: blocked.id, blocking_issue_id: hidden.id });
    const path = `/repos/octocat/alpha/issues/${blocked.number}/dependencies/blocked_by`;
    expect((await call(`${path}/not-a-number`, { method: "DELETE" })).status).toBe(422);
    // The private far end is not serialized back to a caller who cannot read it.
    const removed = await call(`${path}/${hidden.id}`, { method: "DELETE" });
    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe("");
    expect(getGitHubStore(store).issueDependencies.findBy("blocked_issue_id", blocked.id)).toEqual([]);
  });

  it("requires authentication to add an edge", async () => {
    const blocked = await createIssue("octocat/alpha");
    const blocker = await createIssue("octocat/alpha");
    expect((await addBlocker("octocat/alpha", blocked.number, blocker.id, null)).status).toBe(401);
  });

  it("paginates and caps each issue at the GitHub relationship limit", async () => {
    const blocked = await createIssue("octocat/alpha");
    const blockers: Issue[] = [];
    for (let i = 0; i <= MAX_ISSUE_DEPENDENCIES; i++) blockers.push(await createIssue("octocat/beta"));
    for (const blocker of blockers.slice(0, MAX_ISSUE_DEPENDENCIES)) {
      expect((await addBlocker("octocat/alpha", blocked.number, blocker.id)).status).toBe(201);
    }
    expect((await addBlocker("octocat/alpha", blocked.number, blockers[MAX_ISSUE_DEPENDENCIES]!.id)).status).toBe(422);

    const page = await call(`/repos/octocat/alpha/issues/${blocked.number}/dependencies/blocked_by?per_page=20&page=3`);
    expect(((await page.json()) as Issue[]).length).toBe(10);
    expect(page.headers.get("Link")).toContain('rel="first"');
    const all = await call(`/repos/octocat/alpha/issues/${blocked.number}/dependencies/blocked_by?per_page=100`);
    expect(((await all.json()) as Issue[]).length).toBe(MAX_ISSUE_DEPENDENCIES);
  });
});
