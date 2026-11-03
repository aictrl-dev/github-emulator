import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "github-emulator-consumer-"));
let child;
try {
  execFileSync("pnpm", ["--filter", "@aictrl/github-emulator", "pack", "--pack-destination", temporary], { cwd: root, stdio: "pipe" });
  const archive = join(temporary, (await readdir(temporary)).find((file) => file.endsWith(".tgz")));
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    assert.equal(execFileSync("tar", ["-xOf", archive, `package/${file}`], { encoding: "utf8" }), await readFile(join(root, file), "utf8"));
  }
  await writeFile(join(temporary, "package.json"), JSON.stringify({ private: true, type: "module" }));
  execFileSync("pnpm", ["add", archive], { cwd: temporary, stdio: "pipe" });
  const consumer = `
    import assert from 'node:assert/strict';
    import { createGitHubEmulator } from '@aictrl/github-emulator';
    const emulator = await createGitHubEmulator({port: 0});
    try {
      const user = await fetch(emulator.url + '/user', {headers:{authorization:'Bearer gho_local_token'}});
      assert.equal(user.status, 200);
      assert.equal((await user.json()).login, 'octocat');
      const font = await fetch(emulator.url + '/_emulate/fonts/geist-sans.woff2');
      assert.equal(font.status, 200);
      assert.ok((await font.arrayBuffer()).byteLength > 100);
    } finally { await emulator.close(); await emulator.close(); }
  `;
  await writeFile(join(temporary, "consumer.mjs"), consumer);
  execFileSync(process.execPath, ["consumer.mjs"], { cwd: temporary, stdio: "pipe" });
  const cli = join(temporary, "node_modules", "@aictrl", "github-emulator", "dist", "cli.js");
  const help = execFileSync(process.execPath, [cli, "--help"], { cwd: temporary, encoding: "utf8" });
  assert.match(help, /--config/);
  const invalid = spawnSync(process.execPath, [cli, "--port", "not-a-port"], { cwd: temporary, encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /--port/);
  child = spawn(process.execPath, [cli, "--port", "0"], { cwd: temporary, stdio: ["ignore", "pipe", "pipe"] });
  const origin = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Packaged CLI did not become ready")), 10000);
    let output = "";
    const fail = (error) => { clearTimeout(timeout); reject(error); };
    child.once("error", fail);
    child.once("exit", (code) => fail(new Error(`Packaged CLI exited before readiness: ${code}`)));
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = /GitHub emulator: (http:\/\/[^\s]+)/.exec(output);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  assert.deepEqual(await (await fetch(`${origin}/_emulate/health`)).json(), { ok: true, service: "github" });
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const [code] = await exited;
  assert.equal(code, 0);
  child = undefined;
  console.log("PASS: packed external consumer, API, fonts, license notices, CLI validation, startup, and SIGTERM shutdown.");
} finally {
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  await rm(temporary, { recursive: true, force: true });
}
