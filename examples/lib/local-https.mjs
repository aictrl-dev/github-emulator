import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeServer } from "./http.mjs";

export async function createLocalTls(hostnames = ["127.0.0.98", "127.0.0.99"]) {
  const directory = await mkdtemp(join(tmpdir(), "github-emulator-https-"));
  const rootKey = join(directory, "root.key");
  const ca = join(directory, "root.crt");
  const key = join(directory, "server.key");
  const cert = join(directory, "server.crt");
  const csr = join(directory, "server.csr");
  const extensions = join(directory, "server.ext");
  const openssl = (args) => execFileSync("openssl", args, { stdio: "pipe" });
  try {
    openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-subj",
      "/CN=GitHub emulator local test CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-keyout",
      rootKey,
      "-out",
      ca,
    ]);
    openssl([
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      `/CN=${hostnames[0]}`,
      "-keyout",
      key,
      "-out",
      csr,
    ]);
    await writeFile(
      extensions,
      `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${hostnames.map((host) => `IP:${host}`).join(",")}\n`,
    );
    openssl([
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      ca,
      "-CAkey",
      rootKey,
      "-CAcreateserial",
      "-days",
      "2",
      "-extfile",
      extensions,
      "-out",
      cert,
    ]);
    return {
      ca,
      directory,
      tls: { key: await readFile(key), cert: await readFile(cert) },
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

// Firefox reads trusted roots from this profile, leaving the user's trust store unchanged.
export async function launchTrustedFirefox(firefox, certificates, { headless = true } = {}) {
  const profile = join(certificates.directory, "firefox");
  await mkdir(profile);
  const certutil = process.env.CERTUTIL_PATH ?? "certutil";
  try {
    execFileSync(certutil, ["-N", "-d", `sql:${profile}`, "--empty-password"], { stdio: "pipe" });
    execFileSync(
      certutil,
      ["-A", "-d", `sql:${profile}`, "-n", "github-emulator-local-test", "-t", "C,,", "-i", certificates.ca],
      { stdio: "pipe" },
    );
  } catch (error) {
    throw new Error(
      "Local browser trust requires certutil from libnss3-tools. Set CERTUTIL_PATH to its binary if needed.",
      { cause: error },
    );
  }
  return firefox.launchPersistentContext(profile, { headless, ignoreHTTPSErrors: false });
}

export async function startHttpsOrigins({
  tls,
  handler,
  appPort = 3005,
  sourceHostname = "127.0.0.98",
  callbackHostname = "127.0.0.99",
}) {
  if (sourceHostname === callbackHostname) throw new Error("Use different source and callback hosts");
  const sourceOrigin = `https://${sourceHostname}:${appPort}`;
  const callbackOrigin = `https://${callbackHostname}:${appPort}`;
  const servers = [];
  const close = () => Promise.all(servers.map(closeServer));
  try {
    for (const hostname of [sourceHostname, callbackHostname]) {
      const server = createServer(tls, (request, response) => {
        void Promise.resolve()
          .then(() => handler(request, response, { sourceOrigin, callbackOrigin }))
          .catch((error) => {
            if (response.headersSent) response.destroy(error);
            else {
              response.writeHead(500);
              response.end(error.message);
            }
          });
      });
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(appPort, hostname, () => {
          server.off("error", reject);
          resolve();
        });
      });
    }
    return { sourceOrigin, callbackOrigin, close };
  } catch (error) {
    await close();
    throw error;
  }
}
