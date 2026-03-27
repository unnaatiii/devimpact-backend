import type { AICommitAnalysis, AnalysisCache, AnalysisResult, RepoConfig } from "../lib/types";
import { upsertCommitsFromAnalysisResult } from "./commitService";
import { getAnalysisPersistence } from "./database/registry";

function repoKeysFromConfigs(repos: RepoConfig[]): string[] {
  return repos.map((r) => `${r.owner}/${r.repo}`);
}

/** Load persisted AI rows for the given repos (tenant-scoped). */
export async function getAIAnalysisForRepos(
  userId: string,
  repos: RepoConfig[],
): Promise<AnalysisCache> {
  const persistence = getAnalysisPersistence();
  return persistence.fetchAiAnalysisForRepos(userId, repoKeysFromConfigs(repos));
}

function shouldPersistAiRow(c: AnalysisResult["analyzedCommits"][number]): boolean {
  if (c.isMergeCommit || !c.analysis) return false;
  const m = c.modelUsed;
  return m !== "cache" && m !== "none" && m !== "skipped";
}

/** Persist new model outputs and refresh commit analyzed flags after an AI run. */
export async function persistAiAnalysisAfterRun(userId: string, result: AnalysisResult): Promise<void> {
  const persistence = getAnalysisPersistence();
  const aiRows: {
    repo: string;
    sha: string;
    impact_score: number | null;
    type: string | null;
    summary: string | null;
    full_analysis: AICommitAnalysis;
    model_used: string;
  }[] = [];
  for (const c of result.analyzedCommits) {
    if (!shouldPersistAiRow(c) || !c.analysis) continue;
    aiRows.push({
      repo: c.repo,
      sha: c.sha,
      impact_score: c.analysis.business_impact_score,
      type: c.analysis.type,
      summary: c.analysis.reasoning.slice(0, 2000),
      full_analysis: c.analysis,
      model_used: c.modelUsed,
    });
  }
  await persistence.upsertAiAnalysisRows(userId, aiRows);
  await upsertCommitsFromAnalysisResult(userId, result);
}
