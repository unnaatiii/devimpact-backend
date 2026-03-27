/**
 * GitHub REST integration: multi-repo commit fetch, token validation, etc.
 * Octokit-only routes (list-repos, contributors) live in server handlers but use the same token model.
 */
export { GitHubService } from "../lib/github-service";
