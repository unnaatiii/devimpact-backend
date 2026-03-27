import type { AnalysisResult } from "../lib/types";
import { getAnalysisPersistence } from "./database/registry";

/**
 * Upsert commit metadata for a user. Every row is scoped with `user_id` in the adapter.
 */
export async function upsertCommitsFromAnalysisResult(
  userId: string,
  result: AnalysisResult,
): Promise<void> {
  const persistence = getAnalysisPersistence();
  const rows = result.analyzedCommits.map((c) => ({
    repo: c.repo,
    sha: c.sha,
    author: c.author ?? null,
    message: c.message ?? null,
    date: c.date ?? null,
    analyzed: !c.isMergeCommit && !!c.analysis,
  }));
  await persistence.upsertCommits(userId, rows);
}
