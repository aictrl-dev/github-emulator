import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createGitHubEmulator } from "../packages/github-emulator/dist/index.js";
import { renderCardPage } from "../packages/@emulators/core/dist/index.js";
import { getAppPrivateKey, mintAppJwt } from "./lib/github-app.mjs";
import { json, redirect } from "./lib/http.mjs";
import { startHttpsOrigins } from "./lib/local-https.mjs";

export const correlationCookie = "__Host-emulator_oauth_correlation";
const clientId = "cross-host-client";
const clientSecret = "cross-host-local-secret";
const appId = 12345;
const hashNonce = (nonce) => createHash("sha256").update(nonce).digest("hex");
const cookieFor = (request) =>
  request.headers.cookie
    ?.split(/;\s*/)
    .find((part) => part.startsWith(`${correlationCookie}=`))
    ?.slice(correlationCookie.length + 1);
const matchesCorrelation = (claims, request) => {
  const nonce = cookieFor(request);
  if (!nonce || typeof claims.nonceHash !== "string") return false;
  const actual = Buffer.from(hashNonce(nonce));
  const expected = Buffer.from(claims.nonceHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export async function startCrossHostDemo({
  tls,
  appPort = 3005,
  sourceHostname = "127.0.0.98",
  callbackHostname = "127.0.0.99",
  emulatorHostname = "127.0.0.100",
  emulatorPort = 4200,
  setupHandler,
} = {}) {
  let emulator;
  const observations = [];
  const stateKey = randomBytes(32);
  const mac = (body) => createHmac("sha256", stateKey).update(body).digest("base64url");
  const verifyState = (state) => {
    const index = state.lastIndexOf(".");
    if (index < 0) return undefined;
    const body = state.slice(0, index);
    const actual = Buffer.from(state.slice(index + 1));
    const expected = Buffer.from(mac(body));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
    try {
      return JSON.parse(body);
    } catch {
      return undefined;
    }
  };
  const origins = await startHttpsOrigins({
    tls,
    appPort,
    sourceHostname,
    callbackHostname,
    handler: async (request, response, { sourceOrigin, callbackOrigin }) => {
      const origin = `https://${request.headers.host}`;
      if (![sourceOrigin, callbackOrigin].includes(origin)) {
        json(response, 400, { error: "Unexpected host" });
        return;
      }
      const url = new URL(request.url, origin);
      if (request.method !== "GET") {
        json(response, 405, { error: "Use GET" });
        return;
      }
      if (url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          renderCardPage(
            "Cross-host GitHub installation",
            "Observe a host-only OAuth cookie across the configured setup callback.",
            '<p><a href="/login?mode=reject">Reproduce missing callback cookie</a></p><p><a href="/login?mode=bounce">Return to the initiating host</a></p>',
            "GitHub",
          ),
        );
        return;
      }
      if (url.pathname === "/login" && origin === sourceOrigin) {
        const nonce = randomBytes(24).toString("base64url");
        const body = JSON.stringify({
          origin,
          nonceHash: hashNonce(nonce),
          bounce: url.searchParams.get("mode") === "bounce",
          note: "opaque + /?&=%#return",
        });
        const state = `${body}.${mac(body)}`;
        response.setHeader("set-cookie", `${correlationCookie}=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/`);
        redirect(
          response,
          `${emulator.url}/login/oauth/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: `${sourceOrigin}/oauth/callback`, scope: "repo read:org", state })}`,
        );
        return;
      }
      if (url.pathname === "/oauth/callback" && origin === sourceOrigin) {
        const state = url.searchParams.get("state") ?? "";
        const claims = verifyState(state);
        if (claims?.origin !== sourceOrigin || !matchesCorrelation(claims, request)) {
          json(response, 400, { error: "Invalid OAuth correlation" });
          return;
        }
        const exchanged = await fetch(`${emulator.url}/login/oauth/access_token`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            code: url.searchParams.get("code"),
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: `${sourceOrigin}/oauth/callback`,
          }),
        });
        const result = await exchanged.json();
        if (!exchanged.ok || !result.access_token) throw new Error("OAuth exchange failed");
        redirect(response, `${emulator.url}/apps/cross-host-proof/installations/new?${new URLSearchParams({ state })}`);
        return;
      }
      if (url.pathname === "/api/github-app/setup") {
        const state = url.searchParams.get("state") ?? "";
        const claims = verifyState(state);
        const observation = {
          origin,
          path: url.pathname,
          search: url.search,
          state,
          installationId: url.searchParams.get("installation_id"),
          setupAction: url.searchParams.get("setup_action"),
          hasCorrelationCookie: cookieFor(request) !== undefined,
        };
        observations.push(observation);
        if (setupHandler && (await setupHandler({ request, response, url, sourceOrigin, callbackOrigin, observation })))
          return;
        if (
          claims?.origin !== sourceOrigin ||
          !/^\d+$/.test(observation.installationId ?? "") ||
          observation.setupAction !== "install"
        ) {
          json(response, 400, { error: "Invalid installation callback" });
          return;
        }
        if (origin !== claims.origin && claims.bounce) {
          // Copy the original callback query before correlating the initiating host's cookie.
          redirect(response, `${claims.origin}${url.pathname}${url.search}`);
          return;
        }
        if (!matchesCorrelation(claims, request)) {
          json(response, 400, { error: "Missing host-only OAuth cookie", observation });
          return;
        }
        const jwt = mintAppJwt(getAppPrivateKey(emulator), appId);
        const minted = await fetch(`${emulator.url}/app/installations/${observation.installationId}/access_tokens`, {
          method: "POST",
          headers: { authorization: `Bearer ${jwt}` },
        });
        const credentials = await minted.json();
        if (!minted.ok || !credentials.token) throw new Error("Installation token exchange failed");
        const repositories = await fetch(`${emulator.url}/installation/repositories`, {
          headers: { authorization: `Bearer ${credentials.token}` },
        });
        if (!repositories.ok) throw new Error("Installation repositories request failed");
        json(response, 200, {
          complete: true,
          observation,
          repositories: (await repositories.json()).repositories.map((repo) => repo.full_name),
        });
        return;
      }
      if (url.pathname === "/observations") {
        json(response, 200, observations);
        return;
      }
      json(response, 404, { error: "Not found" });
    },
  });
  try {
    emulator = await createGitHubEmulator({
      port: emulatorPort,
      hostname: emulatorHostname,
      seed: {
        users: [{ login: "octocat", name: "Local developer" }],
        orgs: [{ login: "example-org", members: [{ login: "octocat", role: "admin" }] }],
        repos: [
          { owner: "example-org", name: "selected", private: true },
          { owner: "example-org", name: "unselected", private: true },
        ],
        oauth_apps: [
          {
            client_id: clientId,
            client_secret: clientSecret,
            name: "Cross-host proof",
            redirect_uris: [`${origins.sourceOrigin}/oauth/callback`],
          },
        ],
        apps: [
          {
            app_id: appId,
            slug: "cross-host-proof",
            name: "Cross-host proof",
            setup_url: `${origins.callbackOrigin}/api/github-app/setup?marker=keep%2Bencoded&extra=first&extra=second`,
            permissions: { contents: "read" },
            events: [],
            installations: [],
          },
        ],
      },
    });
    return {
      ...origins,
      emulatorUrl: emulator.url,
      observations,
      reset() {
        observations.length = 0;
        emulator.reset();
      },
      close: () => Promise.all([origins.close(), emulator.close()]),
    };
  } catch (error) {
    await origins.close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.env.CROSS_HOST_TLS_KEY || !process.env.CROSS_HOST_TLS_CERT)
      throw new Error("Set CROSS_HOST_TLS_KEY and CROSS_HOST_TLS_CERT to trusted local PEM files");
    const demo = await startCrossHostDemo({
      tls: {
        key: await readFile(process.env.CROSS_HOST_TLS_KEY),
        cert: await readFile(process.env.CROSS_HOST_TLS_CERT),
      },
    });
    console.log(
      `Initiating application: ${demo.sourceOrigin}\nConfigured setup host: ${demo.callbackOrigin}\nGitHub emulator: ${demo.emulatorUrl}`,
    );
    const stop = () => {
      void demo.close().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
