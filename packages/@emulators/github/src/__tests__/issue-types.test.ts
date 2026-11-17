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

const base = "http://localhost:4000";

type IssueType = { id: number; name: string; is_enabled: boolean; description: string | null };
type Issue = { number: number; type: IssueType | null };

function createTestApp() {
  const store = new Store();
  const tokenMap: TokenMap = new Map([
    ["admin-token", { login: "admin", id: 1, scopes: ["repo", "user", "read:org"] }],
    ["outsider-token", { login: "outsider", id: 2, scopes: ["repo", "user", "read:org"] }],
  ]);
  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, new WebhookDispatcher(), base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "admin" }, { login: "outsider" }],
    orgs: [
      { login: "acme", members: [{ login: "admin", role: "admin" }] },
      {
        login: "custom",
        members: [{ login: "admin", role: "admin" }],
        issue_types: [
          { name: "Epic", description: "A large body of work" },
          { name: "Chore", is_enabled: false },
        ],
      },
      { login: "untyped", members: [{ login: "admin", role: "admin" }], issue_types: [] },
    ],
    repos: [
      { owner: "acme", name: "widget" },
      { owner: "custom", name: "tool" },
      { owner: "admin", name: "personal" },
    ],
  });
  return app;
}

describe("GitHub issue types", () => {
  let app: Hono;
  const call = (path: string, init: { method?: string; token?: string | null; body?: unknown } = {}) => {
    const headers: Record<string, string> = {};
    const token = init.token === undefined ? "admin-token" : init.token;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    return app.request(`${base}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  };
  const names = async (res: Response) => ((await res.json()) as IssueType[]).map((type) => type.name);

  beforeEach(() => {
    app = createTestApp();
  });

  it("seeds GitHub's default types, custom types or none per organization", async () => {
    expect(await names(await call("/orgs/acme/issue-types"))).toEqual(["Task", "Bug", "Feature"]);
    const custom = (await (await call("/orgs/custom/issue-types")).json()) as IssueType[];
    expect(custom.map((type) => [type.name, type.is_enabled, type.description])).toEqual([
      ["Epic", true, "A large body of work"],
      ["Chore", false, null],
    ]);
    expect(await names(await call("/orgs/untyped/issue-types"))).toEqual([]);
  });

  it("lists a repository's types from its organization, and none for a personal repository", async () => {
    expect(await names(await call("/repos/acme/widget/issue-types"))).toEqual(["Task", "Bug", "Feature"]);
    expect(await names(await call("/repos/admin/personal/issue-types"))).toEqual([]);
  });

  it("hides an organization's types from non-members", async () => {
    expect((await call("/orgs/acme/issue-types", { token: "outsider-token" })).status).toBe(404);
    expect((await call("/orgs/acme/issue-types", { token: null })).status).toBe(404);
    expect((await call("/orgs/missing/issue-types")).status).toBe(404);
  });

  it("sets, changes and clears an issue's type by name", async () => {
    const created = await call("/repos/acme/widget/issues", { method: "POST", body: { title: "Typed", type: "bug" } });
    expect(created.status).toBe(201);
    const issue = (await created.json()) as Issue;
    expect(issue.type?.name).toBe("Bug");

    const changed = await call(`/repos/acme/widget/issues/${issue.number}`, {
      method: "PATCH",
      body: { type: "Feature" },
    });
    expect(((await changed.json()) as Issue).type?.name).toBe("Feature");
    const untouched = await call(`/repos/acme/widget/issues/${issue.number}`, {
      method: "PATCH",
      body: { title: "Renamed" },
    });
    expect(((await untouched.json()) as Issue).type?.name).toBe("Feature");
    const cleared = await call(`/repos/acme/widget/issues/${issue.number}`, { method: "PATCH", body: { type: null } });
    expect(((await cleared.json()) as Issue).type).toBeNull();

    const plain = await call("/repos/acme/widget/issues", { method: "POST", body: { title: "Untyped" } });
    expect(((await plain.json()) as Issue).type).toBeNull();
  });

  it("rejects an unknown, disabled or personal-repository type with 422 and writes nothing", async () => {
    const before = ((await (await call("/repos/custom/tool/issues?state=all")).json()) as unknown[]).length;
    for (const type of ["Bug", "Chore", ""]) {
      const res = await call("/repos/custom/tool/issues", { method: "POST", body: { title: "Rejected", type } });
      expect(res.status, type).toBe(422);
    }
    expect(((await (await call("/repos/custom/tool/issues?state=all")).json()) as unknown[]).length).toBe(before);
    expect(
      (await call("/repos/admin/personal/issues", { method: "POST", body: { title: "Personal", type: "Task" } }))
        .status,
    ).toBe(422);
  });
});
