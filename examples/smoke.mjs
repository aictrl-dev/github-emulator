import assert from "node:assert/strict";
import { startDemo } from "./demo.mjs";

const demo = await startDemo({ appPort: 0, emulatorPort: 0 });
try {
  const login = await fetch(`${demo.appUrl}/login`, { redirect: "manual" });
  assert.equal(login.status, 302);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const authorizeUrl = new URL(login.headers.get("location"));
  const authorize = await fetch(authorizeUrl);
  assert.equal(authorize.status, 200);
  assert.match(await authorize.text(), /octocat/);

  const selection = await fetch(`${demo.emulatorUrl}/login/oauth/callback`, {
    method: "POST", redirect: "manual",
    body: new URLSearchParams({ ...Object.fromEntries(authorizeUrl.searchParams), login: "octocat" }),
  });
  assert.equal(selection.status, 302);
  const callback = await fetch(selection.headers.get("location"), { redirect: "manual", headers: { cookie } });
  assert.equal(callback.status, 302);
  const identity = await fetch(`${demo.appUrl}/me`, { headers: { cookie } });
  assert.equal(identity.status, 200);
  assert.equal((await identity.json()).login, "octocat");

  const issue = await fetch(`${demo.appUrl}/issues`, { method: "POST", headers: { cookie, accept: "application/json" } });
  assert.equal(issue.status, 201);
  const created = await issue.json();
  assert.equal(created.title, "Local integration proof");
  const event = await demo.waitForEvent(5000);
  assert.equal(event.signatureValid, true);
  assert.equal(event.event, "issues");
  assert.equal(event.payload.issue.number, created.number);
  assert.equal(event.payload.repository.full_name, "octocat/hello-world");
  assert.equal(event.payload.installation.id, 100);

  console.log("PASS: OAuth redirects, user identity, App JWT, installation token, API mutation, and verified webhook agree.");
  console.log("Browser GitHub App installation is covered separately by the protocol regression tests.");
} finally {
  await demo.close();
}
