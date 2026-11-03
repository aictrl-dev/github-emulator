import { createServer } from "node:http";
import { createHmac, randomBytes, sign, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createGitHubEmulator } from "../packages/github-emulator/dist/index.js";
import { escapeHtml, renderCardPage } from "../packages/@emulators/core/dist/index.js";

const clientId = "local-client";
const clientSecret = "local-secret";
const webhookSecret = "local-webhook-secret";

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1024 * 1024) throw new Error("Demo request exceeds 1 MiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function redirect(response, location) {
  response.writeHead(302, { location });
  response.end();
}

export async function startDemo({ appPort = 3005, emulatorPort = 4200, hostname = "127.0.0.1" } = {}) {
  let handler;
  const app = createServer((request, response) => {
    if (!handler) { json(response, 503, { error: "Starting" }); return; }
    void handler(request, response).catch((error) => {
      console.error("Demo request failed:", error.message);
      if (!response.headersSent) json(response, 500, { error: error.message });
      else response.destroy(error);
    });
  });
  await new Promise((resolve, reject) => {
    app.once("error", reject);
    app.listen(appPort, hostname, () => { app.off("error", reject); resolve(); });
  });
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  const appUrl = `http://${host}:${app.address().port}`;
  let emulator;
  try {
    emulator = await createGitHubEmulator({
      port: emulatorPort,
      hostname,
      seed: {
        users: [{ login: "octocat", name: "Local developer", email: "developer@example.test" }],
        repos: [{ owner: "octocat", name: "hello-world", private: true, auto_init: true }],
        oauth_apps: [{ client_id: clientId, client_secret: clientSecret, name: "Local demo", redirect_uris: [`${appUrl}/callback`] }],
        apps: [{
          app_id: 1234, slug: "local-proof", name: "Local proof",
          permissions: { contents: "read", issues: "write" }, events: ["issues"],
          webhook_url: `${appUrl}/webhooks/github`, webhook_secret: webhookSecret,
          installations: [{ installation_id: 100, account: "octocat", repository_selection: "selected", repositories: ["hello-world"] }],
        }],
      },
    });
  } catch (error) {
    await closeServer(app);
    throw error;
  }

  const sessions = new Map();
  const events = [];
  const waiters = new Set();
  const appKey = emulator.generatedSecrets.find((secret) => secret.kind === "github.app_private_key").value;
  const api = (path, options) => fetch(`${emulator.url}${path}`, { ...options, signal: AbortSignal.timeout(8000) });
  const sessionFor = (request) => {
    const match = /(?:^|;\s*)demo_session=([A-Za-z0-9_-]+)/.exec(request.headers.cookie ?? "");
    return match ? sessions.get(match[1]) : undefined;
  };

  handler = async (request, response) => {
    const url = new URL(request.url, appUrl);
    if (url.pathname.startsWith("/_emulate/fonts/") || url.pathname === "/_emulate/favicon.ico") {
      const upstream = await api(url.pathname);
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" });
      response.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    if (request.method === "GET" && url.pathname === "/login") {
      const id = randomBytes(24).toString("base64url");
      const state = randomBytes(24).toString("base64url");
      sessions.set(id, { state });
      response.setHeader("set-cookie", `demo_session=${id}; HttpOnly; SameSite=Lax; Path=/`);
      redirect(response, `${emulator.url}/login/oauth/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: `${appUrl}/callback`, scope: "repo user", state })}`);
      return;
    }
    if (request.method === "GET" && url.pathname === "/callback") {
      const session = sessionFor(request);
      if (!session?.state || session.state !== url.searchParams.get("state")) { json(response, 400, { error: "Invalid OAuth state" }); return; }
      delete session.state;
      const exchanged = await api("/login/oauth/access_token", {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ code: url.searchParams.get("code"), client_id: clientId, client_secret: clientSecret, redirect_uri: `${appUrl}/callback` }),
      });
      const result = await exchanged.json();
      if (!exchanged.ok || !result.access_token) throw new Error(`OAuth exchange failed: ${result.error ?? exchanged.status}`);
      session.token = result.access_token;
      redirect(response, "/");
      return;
    }
    if (request.method === "POST" && url.pathname === "/webhooks/github") {
      const body = await readBody(request);
      const expected = Buffer.from(`sha256=${createHmac("sha256", webhookSecret).update(body).digest("hex")}`);
      const actual = Buffer.from(request.headers["x-hub-signature-256"] ?? "");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { json(response, 401, { error: "Invalid webhook signature" }); return; }
      const event = { event: request.headers["x-github-event"], delivery: request.headers["x-github-delivery"], signatureValid: true, payload: JSON.parse(body.toString("utf8")) };
      events.push(event);
      for (const waiter of waiters) waiter(event);
      waiters.clear();
      json(response, 202, { accepted: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/events") { json(response, 200, events); return; }
    const session = sessionFor(request);
    if (request.method === "GET" && url.pathname === "/me") {
      if (!session?.token) { json(response, 401, { error: "Sign in first" }); return; }
      const user = await api("/user", { headers: { authorization: `Bearer ${session.token}` } });
      json(response, user.status, await user.json());
      return;
    }
    if (request.method === "POST" && url.pathname === "/issues") {
      if (!session?.token) { json(response, 401, { error: "Sign in first" }); return; }
      const now = Math.floor(Date.now() / 1000);
      const unsigned = [{ alg: "RS256", typ: "JWT" }, { iss: "1234", iat: now - 60, exp: now + 300 }].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".");
      const jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), appKey).toString("base64url")}`;
      const minted = await api("/app/installations/100/access_tokens", { method: "POST", headers: { authorization: `Bearer ${jwt}` } });
      const credentials = await minted.json();
      if (!minted.ok || !credentials.token) throw new Error(`App token exchange failed: ${minted.status}`);
      const created = await api("/repos/octocat/hello-world/issues", {
        method: "POST", headers: { authorization: `Bearer ${credentials.token}`, "content-type": "application/json" },
        body: JSON.stringify({ title: "Local integration proof", body: "Created with a local GitHub App installation token." }),
      });
      const issue = await created.json();
      if (!created.ok) throw new Error(`Issue creation failed: ${created.status}`);
      if (request.headers.accept?.includes("application/json")) json(response, created.status, issue);
      else redirect(response, "/");
      return;
    }
    if (request.method === "GET" && url.pathname === "/") {
      const action = session?.token
        ? '<p>OAuth sign-in completed.</p><p><a href="/me">Read authenticated user</a></p><form method="post" action="/issues"><button type="submit">Create issue with App token</button></form>'
        : '<p><a href="/login">Sign in with the local GitHub emulator</a></p>';
      const body = `<p>Emulator: <code>${escapeHtml(emulator.url)}</code></p>${action}<p>Verified webhooks received: ${events.length}. <a href="/events">Inspect events</a></p><p>This proof uses a seeded App installation. Browser App installation is the next iteration.</p>`;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderCardPage("GitHub integration proof", "OAuth, App tokens, API calls, and signed callbacks on localhost.", body, "GitHub"));
      return;
    }
    json(response, 404, { error: "Not found" });
  };

  let closing;
  return {
    appUrl, emulatorUrl: emulator.url,
    waitForEvent(timeout = 5000) {
      if (events.length) return Promise.resolve(events.at(-1));
      return new Promise((resolve, reject) => {
        const waiter = (event) => { clearTimeout(timer); resolve(event); };
        const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error("Timed out waiting for a signed webhook")); }, timeout);
        waiters.add(waiter);
      });
    },
    close() {
      return closing ??= Promise.all([closeServer(app), emulator.close()]).then(() => {});
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const demo = await startDemo({ hostname: process.env.DEMO_HOST ?? "127.0.0.1" });
    console.log(`Demo application: ${demo.appUrl}\nGitHub emulator: ${demo.emulatorUrl}`);
    const stop = () => { void demo.close().catch((error) => { console.error(error); process.exitCode = 1; }); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    console.error(`Demo startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
