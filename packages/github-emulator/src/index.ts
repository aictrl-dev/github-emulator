import { createPrivateKey } from "node:crypto";
import type { Server } from "node:http";
import { createServer, serve, type AppKeyResolver } from "@emulators/core";
import {
  createAppKeyResolver,
  getGitHubStore,
  githubPlugin,
  materializeGitHubSeedConfig,
  seedFromConfig,
  type GitHubSeedConfig,
} from "@emulators/github";

export type { GitHubSeedConfig } from "@emulators/github";

export interface GitHubEmulatorOptions {
  port?: number;
  hostname?: string;
  baseUrl?: string;
  seed?: GitHubSeedConfig;
  tokens?: Record<string, { login: string; scopes?: string[] }>;
}

export interface GeneratedSecret {
  readonly kind: string;
  readonly id: string;
  readonly label: string;
  readonly value: string;
}

export interface GitHubEmulator {
  readonly url: string;
  readonly generatedSecrets: readonly GeneratedSecret[];
  reset(): void;
  close(): Promise<void>;
}

const defaultSeed: GitHubSeedConfig = {
  users: [{ login: "octocat", name: "Local developer", email: "developer@example.test" }],
  repos: [{ owner: "octocat", name: "hello-world", private: true, auto_init: true }],
  oauth_apps: [
    {
      client_id: "local-client",
      client_secret: "local-secret",
      name: "Local app",
      redirect_uris: ["http://127.0.0.1:3005/callback"],
    },
  ],
  tokens: { gho_local_token: { login: "octocat", scopes: ["repo", "user", "admin:repo_hook"] } },
};

function waitForListening(server: Server): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const ready = () => {
      server.off("error", fail);
      resolve();
    };
    const fail = (error: Error) => {
      server.off("listening", ready);
      reject(error);
    };
    server.once("listening", ready);
    server.once("error", fail);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
    server.closeAllConnections();
  });
}

function validateOptions(options: GitHubEmulatorOptions): void {
  const port = options.port ?? 4200;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("port must be an integer between 0 and 65535");
  if (options.hostname !== undefined && !options.hostname.trim()) throw new Error("hostname must not be empty");
  if (options.baseUrl !== undefined) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new Error("baseUrl must be an absolute HTTP(S) origin");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      throw new Error("baseUrl must be an absolute HTTP(S) origin without path, query, or credentials");
    }
  }
}

export async function createGitHubEmulator(options: GitHubEmulatorOptions = {}): Promise<GitHubEmulator> {
  validateOptions(options);
  const prepared = await materializeGitHubSeedConfig(structuredClone(options.seed ?? defaultSeed));
  for (const app of prepared.config.apps ?? []) {
    const key = createPrivateKey(app.private_key!);
    if (key.asymmetricKeyType !== "rsa") throw new Error(`App ${app.app_id} requires an RSA private key`);
  }
  const tokenSeeds = structuredClone({ ...prepared.config.tokens, ...options.tokens });
  const generatedSecrets = Object.freeze(
    prepared.generatedPrivateKeys.map((key) =>
      Object.freeze({
        kind: "github.app_private_key",
        id: String(key.app_id),
        label: key.name,
        value: key.private_key,
      }),
    ),
  );

  let handler: ((request: Request) => Response | Promise<Response>) | undefined;
  const hostname = options.hostname ?? "127.0.0.1";
  const server = serve({
    port: options.port ?? 4200,
    hostname,
    fetch: (request) => (handler ? handler(request) : Response.json({ error: "Starting" }, { status: 503 })),
  });

  try {
    await waitForListening(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
    const advertisedHost = hostname === "0.0.0.0" ? "127.0.0.1" : hostname === "::" ? "::1" : hostname;
    const host = advertisedHost.includes(":") ? `[${advertisedHost}]` : advertisedHost;
    const url = options.baseUrl ? new URL(options.baseUrl).origin : `http://${host}:${address.port}`;

    const buildRuntime = () => {
      let resolver: AppKeyResolver = () => null;
      const runtime = createServer(githubPlugin, {
        baseUrl: url,
        port: address.port,
        appKeyResolver: (appId) => resolver(appId),
      });
      resolver = createAppKeyResolver(runtime.store);
      githubPlugin.seed?.(runtime.store, url);
      seedFromConfig(runtime.store, url, structuredClone(prepared.config));
      const gh = getGitHubStore(runtime.store);
      for (const [token, entry] of Object.entries(tokenSeeds)) {
        const user = gh.users.findOneBy("login", entry.login);
        if (!user) throw new Error(`Token refers to unknown seeded user: ${entry.login}`);
        runtime.tokenMap.set(token, { login: user.login, id: user.id, scopes: entry.scopes ?? ["repo", "user"] });
      }
      runtime.app.get("/_emulate/health", (c) => c.json({ ok: true, service: "github" }));
      return runtime;
    };

    let runtime = buildRuntime();
    handler = runtime.app.fetch;
    let closing: Promise<void> | undefined;
    return {
      url,
      generatedSecrets,
      reset() {
        if (closing) throw new Error("Cannot reset a closed emulator");
        const next = buildRuntime();
        runtime = next;
        handler = runtime.app.fetch;
      },
      close() {
        return (closing ??= closeServer(server));
      },
    };
  } catch (error) {
    await closeServer(server);
    throw error;
  }
}
