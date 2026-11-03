#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createGitHubEmulator, type GitHubEmulatorOptions } from "./index.js";

const help = `GitHub-only emulator from the Vercel Labs emulate fork.

Usage: github-emulator [options]

  --port <number>       HTTP port (default: 4200; 0 chooses a free port)
  --host <hostname>     Bind address (default: 127.0.0.1)
  --base-url <origin>   Advertised HTTP(S) origin for API responses
  --config <file>       JSON seed config with a github object
  --help               Show this help

Source checkout: pnpm start --config examples/github.json
Demo application: pnpm demo (http://127.0.0.1:3005)
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "4200" },
      host: { type: "string", default: "127.0.0.1" },
      "base-url": { type: "string" },
      config: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  if (!/^\d+$/.test(values.port)) throw new Error("--port must be an integer between 0 and 65535");
  const options: GitHubEmulatorOptions = {
    port: Number(values.port),
    hostname: values.host,
    baseUrl: values["base-url"],
  };
  if (values.config) {
    const config = JSON.parse(await readFile(values.config, "utf8"));
    if (
      !config ||
      typeof config !== "object" ||
      !config.github ||
      typeof config.github !== "object" ||
      Array.isArray(config.github)
    ) {
      throw new Error("Config must contain a github seed object");
    }
    options.seed = config.github;
    options.tokens = config.tokens;
  }
  const emulator = await createGitHubEmulator(options);
  process.stdout.write(`GitHub emulator: ${emulator.url}\n`);
  if (emulator.generatedSecrets.length) {
    process.stdout.write(
      "App keys were generated in memory. Use the programmatic API to retrieve generatedSecrets, or configure explicit local test keys.\n",
    );
  }
  const stop = () => {
    void emulator.close().catch((error: unknown) => {
      process.stderr.write(`Shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

void main().catch((error: unknown) => {
  process.stderr.write(`github-emulator: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
