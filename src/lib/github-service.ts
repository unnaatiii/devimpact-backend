import { Octokit } from "@octokit/rest";
import { createOctokitForUserPat } from "./octokit-pat.js";
import type {
  RepoConfig,
  CommitData,
  PullRequestData,
  ReviewData,
  MultiRepoData,
} from "./types";
import { parseNoreplyGithubLogin } from "./commit-author";

/** Skip unhelpful GitHub system accounts when using committer as fallback */
const SKIP_COMMITTER_LOGINS = /^(web-flow|ghost)$/i;

function resolveCommitAuthorLogin(commit: {
  author: { login?: string } | null;
  committer: { login?: string } | null;
  commit: {
    author?: { name?: string | null; email?: string | null } | null;
    committer?: { name?: string | null; email?: string | null } | null;
  };
}): string {
  if (commit.author?.login) return commit.author.login;
  const cl = commit.committer?.login;
  if (cl && !SKIP_COMMITTER_LOGINS.test(cl)) return cl;

  const authorEmail = commit.commit.author?.email ?? undefined;
  const committerEmail = commit.commit.committer?.email ?? undefined;
  const fromAuthorEmail = parseNoreplyGithubLogin(authorEmail);
  if (fromAuthorEmail) return fromAuthorEmail;
  const fromCommitterEmail = parseNoreplyGithubLogin(committerEmail);
  if (fromCommitterEmail) return fromCommitterEmail;

  const name = commit.commit.author?.name?.trim() || "unknown";
  return name;
}

export type GitHubFetchWindow = {
  /** ISO 8601 — commits on/after this instant */
  since: string;
  /** ISO 8601 — commits on/before this instant */
  until: string;
};

/** Per-repo commit fetch tuning (performance vs AI readiness) */
export type GitHubRepoFetchOptions = {
  /** Max commits from listCommits (newest first). Default 500 when omitted; API routes pass explicit limits. */
  maxCommits?: number;
  /** Skip per-commit getCommit — no diff/files; fast base layer */
  skipDetails?: boolean;
};

export class GitHubService {
  private octokit: Octokit;
  private readonly window: GitHubFetchWindow;

  constructor(token: string, window: GitHubFetchWindow) {
    this.octokit = createOctokitForUserPat(token);
    this.window = window;
  }

  async validateConnection(): Promise<{ valid: boolean; user?: string }> {
    try {
      const { data } = await this.octokit.users.getAuthenticated();
      return { valid: true, user: data.login };
    } catch {
      return { valid: false };
    }
  }

  async fetchRepoCommits(
    repo: RepoConfig,
    options?: GitHubRepoFetchOptions,
  ): Promise<CommitData[]> {
    try {
      const maxCommits = Math.min(10_000, Math.max(1, options?.maxCommits ?? 500));
      const skipDetails = options?.skipDetails ?? false;
      const perPage = 100;
      const maxPages = Math.min(500, Math.ceil(maxCommits / perPage) + 2);

      console.log(
        `[GitHub] Fetching commits for ${repo.owner}/${repo.repo} (${this.window.since} … ${this.window.until}) limit=${maxCommits} skipDetails=${skipDetails}`,
      );

      const collected: Awaited<ReturnType<Octokit["repos"]["listCommits"]>>["data"] = [];
      let page = 1;
      while (collected.length < maxCommits && page <= maxPages) {
        const { data } = await this.octokit.repos.listCommits({
          owner: repo.owner,
          repo: repo.repo,
          since: this.window.since,
          until: this.window.until,
          per_page: perPage,
          page,
        });
        if (!data?.length) break;
        for (const c of data) {
          collected.push(c);
          if (collected.length >= maxCommits) break;
        }
        if (data.length < perPage) break;
        page += 1;
      }

      const slice = collected.slice(0, maxCommits);
      console.log(
        `[GitHub] ${repo.repo}: ${slice.length} commits (${page} listCommits page(s), cap ${maxCommits})`,
      );

      const commits: CommitData[] = [];

      for (const commit of slice) {
        const isMerge =
          commit.parents.length > 1 ||
          /^Merge (pull request|branch)/.test(commit.commit.message);

        let diff = "";
        let filesChanged: string[] = [];
        let additions = 0;
        let deletions = 0;

        if (!isMerge && !skipDetails) {
          try {
            const { data: detail } = await this.octokit.repos.getCommit({
              owner: repo.owner,
              repo: repo.repo,
              ref: commit.sha,
            });

            filesChanged = detail.files?.map((f) => f.filename ?? "") ?? [];
            additions = detail.stats?.additions ?? 0;
            deletions = detail.stats?.deletions ?? 0;

            diff = (detail.files ?? [])
              .slice(0, 8)
              .map((f) => {
                const patch = (f.patch ?? "").substring(0, 300);
                return `--- ${f.filename} (${f.status}: +${f.additions}/-${f.deletions})\n${patch}`;
              })
              .join("\n\n");
          } catch {
            // rate limit or error — continue with basic data
          }
        }

        const authorEmail =
          commit.commit.author?.email?.trim() || commit.commit.committer?.email?.trim() || undefined;

        commits.push({
          sha: commit.sha,
          message: commit.commit.message,
          author: resolveCommitAuthorLogin(commit),
          authorEmail: authorEmail || undefined,
          date: commit.commit.author?.date ?? "",
          repo: `${repo.owner}/${repo.repo}`,
          repoLabel: repo.label,
          repoType: repo.repoType,
          filesChanged,
          additions,
          deletions,
          diff,
          isMergeCommit: isMerge,
        });
      }

      return commits;
    } catch (err) {
      console.error(`[GitHub] Failed to fetch ${repo.owner}/${repo.repo}:`, err);
      return [];
    }
  }

  async fetchRepoPRs(repo: RepoConfig): Promise<PullRequestData[]> {
    try {
      const { data } = await this.octokit.pulls.list({
        owner: repo.owner,
        repo: repo.repo,
        state: "all",
        per_page: 20,
        sort: "updated",
        direction: "desc",
      });

      const sinceTs = new Date(this.window.since).getTime();
      const untilTs = new Date(this.window.until).getTime();

      return data
        .filter((pr) => {
          const t = new Date(pr.created_at).getTime();
          return t >= sinceTs && t <= untilTs;
        })
        .map((pr) => ({
          number: pr.number,
          title: pr.title,
          body: (pr.body ?? "").substring(0, 300),
          state: pr.state,
          merged: pr.merged_at !== null,
          author: pr.user?.login ?? "unknown",
          repo: `${repo.owner}/${repo.repo}`,
          repoLabel: repo.label,
          created_at: pr.created_at,
          merged_at: pr.merged_at ?? null,
        }));
    } catch {
      return [];
    }
  }

  async fetchRepoReviews(repo: RepoConfig, prNumbers: number[]): Promise<ReviewData[]> {
    const reviews: ReviewData[] = [];

    const results = await Promise.all(
      prNumbers.slice(0, 15).map(async (prNum) => {
        try {
          const { data } = await this.octokit.pulls.listReviews({
            owner: repo.owner,
            repo: repo.repo,
            pull_number: prNum,
            per_page: 50,
          });
          return data.map((r) => ({
            prNumber: prNum,
            prTitle: "",
            reviewer: r.user?.login ?? "unknown",
            repo: `${repo.owner}/${repo.repo}`,
            state: r.state as ReviewData["state"],
          }));
        } catch {
          return [];
        }
      }),
    );

    reviews.push(...results.flat());
    return reviews;
  }

  async fetchAllRepos(
    repos: RepoConfig[],
    commitOptions?: GitHubRepoFetchOptions,
  ): Promise<MultiRepoData> {
    console.log(`[GitHub] Fetching data from ${repos.length} repositories`);

    const repoResults = await Promise.all(
      repos.map(async (repo) => {
        const [commits, prs] = await Promise.all([
          this.fetchRepoCommits(repo, commitOptions),
          this.fetchRepoPRs(repo),
        ]);
        const prNumbers = prs.map((p) => p.number);
        const reviews = await this.fetchRepoReviews(repo, prNumbers);
        return { commits, prs, reviews };
      }),
    );

    const allCommits: CommitData[] = [];
    const allPRs: PullRequestData[] = [];
    const allReviews: ReviewData[] = [];

    for (const r of repoResults) {
      allCommits.push(...r.commits);
      allPRs.push(...r.prs);
      allReviews.push(...r.reviews);
    }

    // filter out bots
    const sinceTs = new Date(this.window.since).getTime();
    const untilTs = new Date(this.window.until).getTime();

    const botPatterns = /\[bot\]|dependabot|renovate|github-actions|codecov/i;
    const filteredCommits = allCommits.filter((c) => {
      if (botPatterns.test(c.author)) return false;
      const t = new Date(c.date).getTime();
      if (Number.isNaN(t)) return false;
      return t >= sinceTs && t <= untilTs;
    });
    const filteredPRs = allPRs.filter((p) => !botPatterns.test(p.author));
    const filteredReviews = allReviews.filter((r) => !botPatterns.test(r.reviewer));

    console.log(`[GitHub] Total: ${filteredCommits.length} commits, ${filteredPRs.length} PRs, ${filteredReviews.length} reviews across ${repos.length} repos`);

    return {
      repos,
      commits: filteredCommits,
      pullRequests: filteredPRs,
      reviews: filteredReviews,
      fetchedAt: new Date().toISOString(),
    };
  }
}
