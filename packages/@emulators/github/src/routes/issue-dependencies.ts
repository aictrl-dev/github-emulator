import type { Context, RouteContext } from "@emulators/core";
import { ApiError, parseJsonBody, parsePagination, setLinkHeader } from "@emulators/core";
import type { AuthUser } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import type { GitHubStore } from "../store.js";
import type { GitHubIssue, GitHubRepo } from "../entities.js";
import { assertIssueWrite, assertRepoPermission, notFoundResponse } from "../route-helpers.js";
import { findIssueForRepo, formatIssue, lookupRepo } from "../helpers.js";

/** GitHub limits each issue to 50 relationships of each kind. */
export const MAX_ISSUE_DEPENDENCIES = 50;

type Direction = "blocked_by" | "blocking";

function canRead(gh: GitHubStore, authUser: AuthUser | undefined, repo: GitHubRepo): boolean {
  try {
    assertRepoPermission(gh, authUser, repo, "issues");
    return repo.has_issues;
  } catch {
    return false;
  }
}

/** The issue in the path, visible to the caller, or 404 as on GitHub. */
function pathIssue(gh: GitHubStore, c: Context, required: "read" | "write"): { repo: GitHubRepo; issue: GitHubIssue } {
  const repo = lookupRepo(gh, c.req.param("owner")!, c.req.param("repo")!);
  if (!repo) throw notFoundResponse();
  if (required === "write") assertIssueWrite(gh, c.get("authUser"), repo);
  else assertRepoPermission(gh, c.get("authUser"), repo, "issues");
  if (!repo.has_issues) throw notFoundResponse();
  const issueNumber = Number(c.req.param("issue_number"));
  if (!Number.isInteger(issueNumber)) throw notFoundResponse();
  const issue = findIssueForRepo(gh, repo.id, issueNumber);
  if (!issue) throw notFoundResponse();
  return { repo, issue };
}

/** The other end of an edge, addressed by its issue id; it may live in another repository. */
function issueById(gh: GitHubStore, authUser: AuthUser | undefined, raw: unknown): GitHubIssue {
  const id = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof id !== "number" || !Number.isInteger(id)) throw new ApiError(422, "Validation failed");
  const issue = gh.issues.get(id);
  const repo = issue ? gh.repos.get(issue.repo_id) : undefined;
  if (!issue || issue.is_pull_request || !repo || !canRead(gh, authUser, repo)) throw notFoundResponse();
  return issue;
}

function related(gh: GitHubStore, issue: GitHubIssue, direction: Direction): GitHubIssue[] {
  const edges =
    direction === "blocked_by"
      ? gh.issueDependencies.findBy("blocked_issue_id", issue.id).map((edge) => edge.blocking_issue_id)
      : gh.issueDependencies.findBy("blocking_issue_id", issue.id).map((edge) => edge.blocked_issue_id);
  return edges.map((id) => gh.issues.get(id)).filter((other): other is GitHubIssue => !!other);
}

export function issueDependenciesRoutes({ app, store, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  const list = (direction: Direction) => (c: Context) => {
    const { issue } = pathIssue(gh, c, "read");
    const authUser = c.get("authUser");
    const visible = related(gh, issue, direction).filter((other) => {
      const repo = gh.repos.get(other.repo_id);
      return !!repo && canRead(gh, authUser, repo);
    });
    const { page, per_page } = parsePagination(c);
    setLinkHeader(c, visible.length, page, per_page);
    const start = (page - 1) * per_page;
    return c.json(visible.slice(start, start + per_page).map((other) => formatIssue(other, gh, baseUrl)));
  };

  app.get("/repos/:owner/:repo/issues/:issue_number/dependencies/blocked_by", list("blocked_by"));
  app.get("/repos/:owner/:repo/issues/:issue_number/dependencies/blocking", list("blocking"));

  app.post("/repos/:owner/:repo/issues/:issue_number/dependencies/blocked_by", async (c) => {
    const { issue } = pathIssue(gh, c, "write");
    const body = (await parseJsonBody(c)) as { issue_id?: unknown };
    const blocking = issueById(gh, c.get("authUser"), body.issue_id);
    if (blocking.id === issue.id) throw new ApiError(422, "Validation failed");
    const existing = gh.issueDependencies.findBy("blocked_issue_id", issue.id);
    if (existing.some((edge) => edge.blocking_issue_id === blocking.id)) throw new ApiError(422, "Validation failed");
    if (
      existing.length >= MAX_ISSUE_DEPENDENCIES ||
      gh.issueDependencies.findBy("blocking_issue_id", blocking.id).length >= MAX_ISSUE_DEPENDENCIES
    ) {
      throw new ApiError(422, "Validation failed");
    }
    gh.issueDependencies.insert({ blocked_issue_id: issue.id, blocking_issue_id: blocking.id });
    return c.json(formatIssue(blocking, gh, baseUrl), 201);
  });

  app.delete("/repos/:owner/:repo/issues/:issue_number/dependencies/blocked_by/:issue_id", (c) => {
    // Removing an edge needs write on the blocked issue only: the far end may have become unreadable since.
    const { issue } = pathIssue(gh, c, "write");
    const raw = c.req.param("issue_id")!;
    if (!/^\d+$/.test(raw)) throw new ApiError(400, "Problems parsing issue_id");
    const blockingId = Number(raw);
    const edge = gh.issueDependencies
      .findBy("blocked_issue_id", issue.id)
      .find((candidate) => candidate.blocking_issue_id === blockingId);
    const blocking = edge ? gh.issues.get(blockingId) : undefined;
    if (!edge || !blocking) throw notFoundResponse();
    gh.issueDependencies.delete(edge.id);
    return c.json(formatIssue(blocking, gh, baseUrl));
  });
}
