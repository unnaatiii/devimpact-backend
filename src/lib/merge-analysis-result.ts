import type { AnalysisResult, AnalyzedCommit } from "./types";
import { analyzedCommitRowKey, dedupeAnalyzedCommitsByRepoSha } from "./dedupe-analyzed-commits";
import { ScoringEngine } from "./scoring-engine";

/**
 * Overlay AI rows from a scoped analysis run onto the wide org commit list.
 * De-duplicates by repo+sha, then rebuilds developers/leaderboard from the merged list so per-author
 * counts match the Commits tab (scoped-only leaderboard caused mismatches before).
 */
export function mergeWideAndScopedAi(
  wide: AnalysisResult,
  scoped: AnalysisResult | null,
): AnalysisResult {
  if (!scoped?.hasAiEnhancement) return wide;

  const byKey = new Map<string, AnalyzedCommit>();
  for (const c of scoped.analyzedCommits) {
    if (c.analysis) byKey.set(analyzedCommitRowKey(c), c);
  }

  const mergedLinear = wide.analyzedCommits.map((row) => {
    const hit = byKey.get(analyzedCommitRowKey(row));
    if (hit?.analysis) {
      return {
        ...row,
        analysis: hit.analysis,
        modelUsed: hit.modelUsed,
      };
    }
    return row;
  });

  const analyzedCommits = dedupeAnalyzedCommitsByRepoSha(mergedLinear);
  const withAi = analyzedCommits.filter((c) => c.analysis && !c.isMergeCommit).length;

  const rollup = ScoringEngine.rollupMergedWideScoped(analyzedCommits, wide.repos, wide.developers);

  const nextDiagnostics = scoped.aiDiagnostics ?? wide.aiDiagnostics;
  const eligibleNonMerge = analyzedCommits.filter((c) => !c.isMergeCommit).length;

  return {
    ...wide,
    analyzedCommits,
    commitCount: analyzedCommits.length,
    repoCount: wide.repoCount,
    repos: wide.repos,
    hasAiEnhancement: withAi > 0,
    aiPowered: scoped.aiPowered,
    modelsUsed: scoped.modelsUsed?.length ? scoped.modelsUsed : wide.modelsUsed,
    aiDiagnostics: nextDiagnostics
      ? {
          ...nextDiagnostics,
          commitsEligible: eligibleNonMerge,
          commitsWithAnalysis: withAi,
        }
      : nextDiagnostics,
    dataLayer: withAi > 0 ? "enhanced" : wide.dataLayer,
    developers: rollup.developers,
    leaderboard: rollup.leaderboard,
    topContributor: rollup.topContributor,
    teamInsights: rollup.teamInsights,
    analysisWindow: scoped.analysisWindow ?? wide.analysisWindow,
    analyzedAt: scoped.analyzedAt ?? wide.analyzedAt,
    analysisAllowlist: scoped.analysisAllowlist ?? wide.analysisAllowlist,
  };
}
