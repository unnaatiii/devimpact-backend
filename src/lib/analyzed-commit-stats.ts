import { dedupeAnalyzedCommitsByRepoSha } from "./dedupe-analyzed-commits";
import type { AnalyzedCommit } from "./types";

/** Stats aligned with the Commits table (non-merge, de-duplicated by repo+sha). */
export function commitTableStats(analyzedCommits: AnalyzedCommit[] | undefined | null): {
  nonMergeInView: number;
  analyzedWithAi: number;
} {
  if (!analyzedCommits?.length) return { nonMergeInView: 0, analyzedWithAi: 0 };
  const base = dedupeAnalyzedCommitsByRepoSha(analyzedCommits.filter((c) => !c.isMergeCommit));
  return {
    nonMergeInView: base.length,
    analyzedWithAi: base.filter((c) => c.analysis).length,
  };
}
