import type { RouteContext } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import { assertRepoPermission, getActorUser, isOrgMember, notFoundResponse } from "../route-helpers.js";
import { lookupRepo } from "../helpers.js";
import { formatIssueType, orgIssueTypes, repoIssueTypes } from "../issue-types.js";

export function issueTypesRoutes({ app, store }: RouteContext): void {
  const gh = getGitHubStore(store);

  // Organization members and installations on the organization may read its issue types.
  app.get("/orgs/:org/issue-types", (c) => {
    const login = c.req.param("org")!.toLowerCase();
    const org = gh.orgs.all().find((candidate) => candidate.login.toLowerCase() === login);
    if (!org) throw notFoundResponse();
    const authUser = c.get("authUser");
    const installation = authUser?.installation;
    const user = authUser && !installation ? getActorUser(gh, authUser) : undefined;
    const allowed = installation
      ? installation.accountType === "Organization" && installation.accountId === org.id
      : !!user && isOrgMember(gh, user.id, org.id);
    if (!allowed) throw notFoundResponse();
    return c.json(orgIssueTypes(gh, org.id).map(formatIssueType));
  });

  app.get("/repos/:owner/:repo/issue-types", (c) => {
    const repo = lookupRepo(gh, c.req.param("owner")!, c.req.param("repo")!);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, ["issues", "metadata"]);
    return c.json(repoIssueTypes(gh, repo).map(formatIssueType));
  });
}
