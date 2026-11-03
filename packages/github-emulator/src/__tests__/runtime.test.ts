import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { sign } from "node:crypto";
import { createGitHubEmulator } from "../index.js";

const open: Array<{ close(): Promise<void> }> = [];
const seed = {
  users: [{ login: "octocat" }],
  repos: [{ owner: "octocat", name: "widget", private: true, auto_init: true }],
  oauth_apps: [
    {
      client_id: "local-client",
      client_secret: "local-secret",
      name: "Local app",
      redirect_uris: ["http://127.0.0.1:3005/callback"],
    },
  ],
};

afterEach(async () => {
  await Promise.all(open.splice(0).map((instance) => instance.close()));
});

async function start(options: Parameters<typeof createGitHubEmulator>[0] = {}) {
  const instance = await createGitHubEmulator({ port: 0, seed, ...options });
  open.push(instance);
  return instance;
}

describe("GitHub-only runtime", () => {
  it("advertises the actual ephemeral port and serves bundled OAuth font assets", async () => {
    const instance = await start();
    expect(new URL(instance.url).port).not.toBe("0");
    const page = await fetch(
      `${instance.url}/login/oauth/authorize?client_id=local-client&redirect_uri=${encodeURIComponent(seed.oauth_apps[0].redirect_uris[0])}`,
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("octocat");
    const font = await fetch(`${instance.url}/_emulate/fonts/geist-sans.woff2`);
    expect(font.status).toBe(200);
    expect((await font.arrayBuffer()).byteLength).toBeGreaterThan(100);
  });

  it("resolves seeded token identity and rejects unknown credentials", async () => {
    const instance = await start({ tokens: { "local-token": { login: "octocat", scopes: ["repo", "user"] } } });
    const user = await fetch(`${instance.url}/user`, { headers: { authorization: "Bearer local-token" } });
    expect(user.status).toBe(200);
    expect(await user.json()).toMatchObject({ login: "octocat" });
    const unknown = await fetch(`${instance.url}/user`, { headers: { authorization: "Bearer unrecognized" } });
    expect(unknown.status).toBe(401);
  });

  it("completes OAuth and revokes dynamic credentials and pending codes on reset", async () => {
    const instance = await start();
    const authorize = async () => {
      const response = await fetch(`${instance.url}/login/oauth/callback`, {
        method: "POST",
        redirect: "manual",
        body: new URLSearchParams({
          login: "octocat",
          client_id: "local-client",
          redirect_uri: seed.oauth_apps[0].redirect_uris[0],
          state: "local-state",
          scope: "repo user",
        }),
      });
      expect(response.status).toBe(302);
      const target = new URL(response.headers.get("location")!);
      expect(target.searchParams.get("state")).toBe("local-state");
      return target.searchParams.get("code")!;
    };
    const exchange = (code: string) =>
      fetch(`${instance.url}/login/oauth/access_token`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ code, client_id: "local-client", client_secret: "local-secret" }),
      });
    const code = await authorize();
    const { access_token: token } = (await (await exchange(code)).json()) as { access_token: string };
    expect(typeof token).toBe("string");
    expect((await fetch(`${instance.url}/user`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    const pending = await authorize();
    instance.reset();
    expect((await fetch(`${instance.url}/user`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect(await (await exchange(pending)).json()).toMatchObject({ error: "bad_verification_code" });
  });

  it("keeps generated App identity across reset and revokes installation tokens", async () => {
    const instance = await start({
      seed: {
        ...seed,
        apps: [
          {
            app_id: 42,
            slug: "local-app",
            name: "Local app",
            installations: [
              { installation_id: 99, account: "octocat", repository_selection: "selected", repositories: ["widget"] },
            ],
          },
        ],
      },
    });
    const key = instance.generatedSecrets.find((secret) => secret.kind === "github.app_private_key")!.value;
    const now = Math.floor(Date.now() / 1000);
    const unsigned = [
      { alg: "RS256", typ: "JWT" },
      { iss: "42", iat: now - 60, exp: now + 300 },
    ]
      .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
      .join(".");
    const jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
    const response = await fetch(`${instance.url}/app/installations/99/access_tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(response.status).toBe(201);
    const { token } = (await response.json()) as { token: string };
    const repo = () => fetch(`${instance.url}/repos/octocat/widget`, { headers: { authorization: `Bearer ${token}` } });
    expect((await repo()).status).toBe(200);
    instance.reset();
    expect(instance.generatedSecrets.find((secret) => secret.kind === "github.app_private_key")!.value).toBe(key);
    expect((await repo()).status).toBe(401);
  });

  it("releases its listener when seeding credentials fails", async () => {
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const address = reservation.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    await expect(
      createGitHubEmulator({ port: address.port, seed, tokens: { bad: { login: "missing-user" } } }),
    ).rejects.toThrow("missing-user");
    const instance = await start({ port: address.port });
    expect(new URL(instance.url).port).toBe(String(address.port));
  });

  it("rejects invalid port and advertised URL options before startup", async () => {
    await expect(createGitHubEmulator({ port: -1 })).rejects.toThrow("port");
    await expect(createGitHubEmulator({ baseUrl: "file:///tmp/test" })).rejects.toThrow("baseUrl");
    await expect(createGitHubEmulator({ baseUrl: "http://localhost:4200/path" })).rejects.toThrow("baseUrl");
  });
});
