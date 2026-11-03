import { randomBytes } from "node:crypto";
import { escapeAttr, escapeHtml, renderCardPage, renderErrorPage, type RouteContext } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import { formatUser } from "../helpers.js";
import { formatInstallation } from "./apps.js";
import { orgRoleForUser } from "./orgs.js";
import { resolveBrowserSessionUser } from "./oauth.js";

type Account = { id: number; login: string; type: "User" | "Organization" };
type PendingInstallation = {
  userId: number;
  appId: number;
  account: Account;
  state: string;
  createdAt: number;
};
const FORM_TTL_MS = 10 * 60 * 1000;

export function appInstallationFlowRoutes({ app, store, baseUrl, webhooks }: RouteContext): void {
  const gh = getGitHubStore(store);
  function forms(): Map<string, PendingInstallation> {
    let pending = store.getData<Map<string, PendingInstallation>>("github.installation.pendingForms");
    if (!pending) {
      pending = new Map();
      store.setData("github.installation.pendingForms", pending);
    }
    for (const [nonce, form] of pending) {
      if (Date.now() - form.createdAt > FORM_TTL_MS) pending.delete(nonce);
    }
    return pending;
  }
  function accounts(userId: number): Account[] {
    const user = gh.users.get(userId);
    return [
      ...(user ? [{ id: user.id, login: user.login, type: "User" as const }] : []),
      ...gh.orgs
        .all()
        .filter((org) => orgRoleForUser(gh, org.id, userId) === "admin")
        .map((org) => ({ id: org.id, login: org.login, type: "Organization" as const })),
    ];
  }
  const error = (title: string, message: string) => renderErrorPage(title, message, "GitHub");

  app.get("/apps/:slug/installations/new", (c) => {
    const user = resolveBrowserSessionUser(store, c);
    if (!user) return c.html(error("Unauthorized", "Sign in through OAuth before installing an application."), 401);
    const ghApp = gh.apps.findOneBy("slug", c.req.param("slug"));
    if (!ghApp) return c.html(error("Not Found", "Application not found."), 404);
    const state = c.req.query("state") ?? "";
    const path = `/apps/${encodeURIComponent(ghApp.slug)}/installations/new`;
    const allowedAccounts = accounts(user.id);
    const selectedLogin = c.req.query("account");
    if (!selectedLogin) {
      const body = allowedAccounts
        .map((account) => {
          const params = new URLSearchParams({ state, account: account.login });
          return `<a class="app-link" href="${escapeAttr(`${path}?${params}`)}">Install on ${escapeHtml(account.login)}</a>`;
        })
        .join("\n");
      return c.html(renderCardPage(`Install ${ghApp.name}`, "Choose an account for this application.", body, "GitHub"));
    }
    const account = allowedAccounts.find((candidate) => candidate.login === selectedLogin);
    if (!account) return c.html(error("Forbidden", "You cannot install an application on this account."), 403);
    const nonce = randomBytes(24).toString("base64url");
    forms().set(nonce, { userId: user.id, appId: ghApp.app_id, account, state, createdAt: Date.now() });
    const repositories = gh.repos
      .all()
      .filter((repo) => repo.owner_id === account.id && repo.owner_type === account.type);
    const repositoryFields = repositories
      .map(
        (repo) =>
          `<label class="org-row"><input type="checkbox" name="repository_ids" value="${repo.id}" aria-label="Select repository: ${escapeAttr(repo.full_name)}">${escapeHtml(repo.full_name)}</label>`,
      )
      .join("\n");
    const body = `<form method="post" action="${escapeAttr(path)}">
      <input type="hidden" name="nonce" value="${nonce}">
      <input type="hidden" name="account" value="${escapeAttr(account.login)}">
      <label class="org-row"><input type="radio" name="repository_selection" value="all" checked>All repositories</label>
      <label class="org-row"><input type="radio" name="repository_selection" value="selected">Only select repositories</label>
      ${repositoryFields}
      <button class="user-btn" type="submit">Install</button>
    </form>`;
    return c.html(renderCardPage(`Install ${ghApp.name}`, `Install on ${escapeHtml(account.login)}.`, body, "GitHub"));
  });

  app.post("/apps/:slug/installations/new", async (c) => {
    const user = resolveBrowserSessionUser(store, c);
    if (!user) return c.html(error("Unauthorized", "Sign in through OAuth before installing an application."), 401);
    const body = await c.req.parseBody();
    const nonce = typeof body.nonce === "string" ? body.nonce : "";
    const pending = forms().get(nonce);
    forms().delete(nonce);
    const ghApp = gh.apps.findOneBy("slug", c.req.param("slug"));
    if (
      !pending ||
      !ghApp ||
      pending.userId !== user.id ||
      pending.appId !== ghApp.app_id ||
      body.account !== pending.account.login
    ) {
      return c.html(error("Forbidden", "The installation form is invalid or expired."), 403);
    }
    const account = accounts(user.id).find(
      (candidate) => candidate.id === pending.account.id && candidate.type === pending.account.type,
    );
    if (!account) return c.html(error("Forbidden", "You cannot install an application on this account."), 403);
    if (
      gh.appInstallations
        .all()
        .some(
          (installation) =>
            installation.app_id === ghApp.app_id &&
            installation.account_id === account.id &&
            installation.account_type === account.type,
        )
    ) {
      return c.html(error("Already installed", "This application is already installed on this account."), 409);
    }
    const selection = body.repository_selection;
    const rawIds =
      body.repository_ids === undefined
        ? []
        : Array.isArray(body.repository_ids)
          ? body.repository_ids
          : [body.repository_ids];
    const repoIds = [...new Set(rawIds.map((id) => (typeof id === "string" && /^\d+$/.test(id) ? Number(id) : NaN)))];
    const repositories = gh.repos
      .all()
      .filter((repo) => repo.owner_id === account.id && repo.owner_type === account.type);
    if (
      (selection !== "all" && selection !== "selected") ||
      repoIds.some((id) => !repositories.some((repo) => repo.id === id)) ||
      (selection === "selected" && repoIds.length === 0)
    ) {
      return c.html(error("Invalid repositories", "Select repositories belonging to this account."), 422);
    }
    const installationId =
      Math.max(0, ...gh.appInstallations.all().map((installation) => installation.installation_id)) + 1;
    const installation = gh.appInstallations.insert({
      installation_id: installationId,
      app_id: ghApp.app_id,
      account_type: account.type,
      account_id: account.id,
      account_login: account.login,
      repository_selection: selection,
      repository_ids: selection === "selected" ? repoIds : [],
      permissions: { ...ghApp.permissions },
      events: [...ghApp.events],
      suspended_at: null,
    });
    const selectedRepos = selection === "all" ? repositories : repositories.filter((repo) => repoIds.includes(repo.id));
    await webhooks.dispatch(
      "installation",
      "created",
      {
        action: "created",
        installation: formatInstallation(installation, ghApp, baseUrl, gh),
        repositories: selectedRepos.map((repo) => ({
          id: repo.id,
          node_id: repo.node_id,
          name: repo.name,
          full_name: repo.full_name,
          private: repo.private,
        })),
        sender: formatUser(gh.users.get(user.id)!, baseUrl),
      },
      account.login,
    );
    const callback = new URL(ghApp.setup_url ?? `${baseUrl}/settings/installations/${installationId}`);
    callback.searchParams.set("installation_id", String(installationId));
    callback.searchParams.set("setup_action", "install");
    callback.searchParams.set("state", pending.state);
    return c.redirect(callback.toString(), 302);
  });
}
