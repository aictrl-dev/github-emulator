import { ApiError } from "@emulators/core";
import type { GitHubIssueType, GitHubOrg, GitHubRepo } from "./entities.js";
import type { GitHubStore } from "./store.js";
import { generateNodeId } from "./helpers.js";
export { formatIssueType } from "./helpers.js";

export interface IssueTypeSeed {
  name: string;
  description?: string | null;
  color?: string | null;
  is_enabled?: boolean;
}

/** The issue types GitHub creates for a new organization. */
export const DEFAULT_ISSUE_TYPES: IssueTypeSeed[] = [
  { name: "Task", description: "A specific piece of work", color: "yellow" },
  { name: "Bug", description: "An unexpected problem or behavior", color: "red" },
  { name: "Feature", description: "A request, idea, or new functionality", color: "blue" },
];

export function seedIssueTypes(gh: GitHubStore, org: GitHubOrg, types?: IssueTypeSeed[] | null): void {
  for (const type of types ?? DEFAULT_ISSUE_TYPES) {
    if (!type.name?.trim()) throw new Error(`Issue type for ${org.login} needs a name`);
    if (orgIssueTypes(gh, org.id).some((existing) => existing.name.toLowerCase() === type.name.toLowerCase())) continue;
    const row = gh.issueTypes.insert({
      node_id: "",
      org_id: org.id,
      name: type.name.trim(),
      description: type.description ?? null,
      color: type.color ?? null,
      is_enabled: type.is_enabled ?? true,
    } as Omit<GitHubIssueType, "id" | "created_at" | "updated_at">);
    gh.issueTypes.update(row.id, { node_id: generateNodeId("IssueType", row.id) });
  }
}

export function orgIssueTypes(gh: GitHubStore, orgId: number): GitHubIssueType[] {
  return gh.issueTypes.findBy("org_id", orgId);
}

/** Issue types belong to organizations; a personal repository has none. */
export function repoIssueTypes(gh: GitHubStore, repo: GitHubRepo): GitHubIssueType[] {
  return repo.owner_type === "Organization" ? orgIssueTypes(gh, repo.owner_id) : [];
}

/**
 * Resolves the `type` field of an issue write: `null` or an absent field clears it, and a name selects an
 * enabled type of the repository's organization, matched without regard to case.
 */
export function resolveIssueTypeId(gh: GitHubStore, repo: GitHubRepo, raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || !raw.trim()) throw new ApiError(422, "Validation failed");
  const type = repoIssueTypes(gh, repo).find(
    (candidate) => candidate.is_enabled && candidate.name.toLowerCase() === raw.trim().toLowerCase(),
  );
  if (!type) throw new ApiError(422, "Validation failed");
  return type.id;
}
