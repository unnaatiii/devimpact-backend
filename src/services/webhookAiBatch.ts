import { Octokit } from "@octokit/rest";
import type { CommitData, MultiRepoData, RepoConfig } from "../lib/types";
import { getOpenRouterApiKey } from "../lib/openrouter-key";
import {
  completeTenantAiBatch,
  listUnanalyzedCommitsForAi,
} from "../lib/db";
import { guessRepoType } from "../lib/repo-type-guess";
import { ScoringEngine } from "../lib/scoring-engine";
import { cloneAnalysisCache, mergeAnalysisCachePreferDatabase } from "../lib/analysis-cache";
import { getAIAnalysisForRepos, persistAiAnalysisAfterRun } from "./analysisService";
import { parseNoreplyGithubLogin } from "../lib/commit-author";

const SKIP_COMMITTER_LOGINS = /^(web-flow|ghost)$/i;

function authorFromGithubCommit(commit: {
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
  const fromA = parseNoreplyGithubLogin(commit.commit.author?.email ?? undefined);
  if (fromA) return fromA;
  const fromC = parseNoreplyGithubLogin(commit.commit.committer?.email ?? undefined);
  if (fromC) return fromC;
  return commit.commit.author?.name?.trim() || "unknown";
}

function inferMergeCommitFromMessage(message: string): boolean {
  return /^Merge (pull request|branch)/i.test(message);
}

function repoConfigFromFullName(fullName: string): RepoConfig {
  const [owner, repo] = fullName.split("/");
  return {
    owner: owner ?? "",
    repo: repo ?? fullName,
    label: repo ?? fullName,
    repoType: guessRepoType(repo ?? ""),
  };
}

async function fetchCommitDetail(
  octokit: Octokit,
  fullName: string,
  sha: string,
): Promise<CommitData | null> {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) return null;
  try {
    const { data: detail } = await octokit.repos.getCommit({
      owner,
      repo,
      ref: sha,
    });
    const msg = detail.commit.message ?? "";
    const cfg = repoConfigFromFullName(fullName);
    const filesChanged = detail.files?.map((f) => f.filename ?? "") ?? [];
    const additions = detail.stats?.additions ?? 0;
    const deletions = detail.stats?.deletions ?? 0;
    const diff = (detail.files ?? [])
      .slice(0, 8)
      .map((f) => {
        const patch = (f.patch ?? "").substring(0, 300);
        return `--- ${f.filename} (${f.status}: +${f.additions}/-${f.deletions})\n${patch}`;
      })
      .join("\n\n");
    const authorEmail =
      detail.commit.author?.email?.trim() || detail.commit.committer?.email?.trim() || undefined;
    return {
      sha: detail.sha,
      message: msg,
      author: authorFromGithubCommit(detail),
      authorEmail,
      date: detail.commit.author?.date ?? new Date().toISOString(),
      repo: fullName,
      repoLabel: cfg.label,
      repoType: cfg.repoType,
      filesChanged,
      additions,
      deletions,
      diff,
      isMergeCommit: inferMergeCommitFromMessage(msg),
    };
  } catch (e) {
    console.error("[webhookAiBatch] getCommit failed", fullName, sha, e);
    return null;
  }
}

/**
 * Runs AI for unanalyzed commits using `GITHUB_ORG_SYNC_TOKEN` and OpenRouter.
 * On success, bumps `tenant_ai_queue.ai_batch_version` so clients can refresh dashboards.
 */
export async function runWebhookAiBatchForUser(userId: string): Promise<void> {
  const ghToken = process.env.GITHUB_ORG_SYNC_TOKEN?.trim();
  if (!ghToken) {
    console.warn("[webhookAiBatch] GITHUB_ORG_SYNC_TOKEN not set; skipping batch");
    return;
  }

  const openrouterKey = getOpenRouterApiKey();
  if (!openrouterKey?.trim()) {
    console.warn("[webhookAiBatch] OPENROUTER_API_KEY not set; skipping batch");
    return;
  }

  const rows = await listUnanalyzedCommitsForAi(userId, 40);
  if (rows.length === 0) {
    await completeTenantAiBatch(userId);
    return;
  }

  const octokit = new Octokit({ auth: ghToken });
  const commitData: CommitData[] = [];
  for (const r of rows) {
    const c = await fetchCommitDetail(octokit, r.repo, r.sha);
    if (c && !c.isMergeCommit) commitData.push(c);
  }

  if (rows.length > 0 && commitData.length === 0) {
    console.warn("[webhookAiBatch] no commit details fetched; leaving queue for retry");
    return;
  }

  const repoMap = new Map<string, RepoConfig>();
  for (const c of commitData) {
    if (!repoMap.has(c.repo)) repoMap.set(c.repo, repoConfigFromFullName(c.repo));
  }
  const repos = [...repoMap.values()];
  const multi: MultiRepoData = {
    repos,
    commits: commitData,
    pullRequests: [],
    reviews: [],
    fetchedAt: new Date().toISOString(),
  };

  let mergedCache = cloneAnalysisCache(null);
  try {
    const dbCache = await getAIAnalysisForRepos(userId, repos);
    mergedCache = mergeAnalysisCachePreferDatabase(dbCache, mergedCache);
  } catch {
    /* non-fatal */
  }

  const engine = new ScoringEngine(openrouterKey);
  const { result } = await engine.composeFromMultiRepo(multi, {
    analysisCache: mergedCache,
    skipAi: false,
    analysisDbUserId: userId,
  });

  try {
    await persistAiAnalysisAfterRun(userId, result);
  } catch (e) {
    console.error("[webhookAiBatch] persistAiAnalysisAfterRun:", e);
    return;
  }

  await completeTenantAiBatch(userId);

  console.log(`[webhookAiBatch] analyzed ${commitData.length} commits for tenant`);
}
