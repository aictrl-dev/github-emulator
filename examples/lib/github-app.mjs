import { sign } from "node:crypto";

export function getAppPrivateKey(emulator) {
  const secret = emulator.generatedSecrets.find((secret) => secret.kind === "github.app_private_key");
  if (!secret) throw new Error("Emulator did not generate a GitHub App private key");
  return secret.value;
}

export function mintAppJwt(key, appId) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = [
    { alg: "RS256", typ: "JWT" },
    { iss: String(appId), iat: now - 60, exp: now + 300 },
  ]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .join(".");
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
}
