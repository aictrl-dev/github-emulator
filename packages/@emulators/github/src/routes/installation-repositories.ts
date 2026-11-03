import type { RouteContext } from "@emulators/core";
import { forbidden, parsePagination, setLinkHeader, unauthorized } from "@emulators/core";
import { formatRepo } from "../helpers.js";
import { getGitHubStore } from "../store.js";
import { formatInstallation } from "./apps.js";

export function installationRepositoriesRoutes({ app, store, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  app.get("/installation/repositories", (c) => {
    const tokenInstallation = c.get("authUser")?.installation;
    if (!tokenInstallation) throw unauthorized();

    const installation = gh.appInstallations.all().find((candidate) => {
      return (
        candidate.installation_id === tokenInstallation.installationId &&
        candidate.app_id === tokenInstallation.appId &&
        candidate.account_id === tokenInstallation.accountId &&
        candidate.account_type === tokenInstallation.accountType
      );
    });
    if (!installation || installation.suspended_at || !gh.apps.findOneBy("app_id", installation.app_id)) {
      throw forbidden();
    }

    const repositories = gh.repos.all().filter((repo) => {
      if (repo.owner_id !== installation.account_id || repo.owner_type !== installation.account_type) return false;
      if (installation.repository_selection === "selected" && !installation.repository_ids.includes(repo.id))
        return false;
      return tokenInstallation.repositorySelection === "all" || tokenInstallation.repositoryIds.includes(repo.id);
    });
    const { page, per_page } = parsePagination(c);
    setLinkHeader(c, repositories.length, page, per_page);
    return c.json({
      total_count: repositories.length,
      repositories: repositories
        .slice((page - 1) * per_page, page * per_page)
        .map((repo) => formatRepo(repo, gh, baseUrl)),
    });
  });

  app.get("/repositories/:repository_id/installation", (c) => {
    const authApp = c.get("authApp");
    if (!authApp) throw unauthorized();

    const repositoryId = Number(c.req.param("repository_id"));
    const repo = Number.isSafeInteger(repositoryId) && repositoryId > 0 ? gh.repos.get(repositoryId) : undefined;
    const installation = repo
      ? gh.appInstallations.all().find((candidate) => {
          return (
            candidate.app_id === authApp.appId &&
            !candidate.suspended_at &&
            candidate.account_id === repo.owner_id &&
            candidate.account_type === repo.owner_type &&
            (candidate.repository_selection === "all" || candidate.repository_ids.includes(repo.id))
          );
        })
      : undefined;
    if (!installation) {
      return c.json({ message: "Not Found", documentation_url: "https://docs.github.com/rest" }, 404);
    }
    const ghApp = gh.apps.findOneBy("app_id", authApp.appId);
    return c.json(formatInstallation(installation, ghApp, baseUrl, gh));
  });
}
