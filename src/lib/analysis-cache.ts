import type { AICommitAnalysis, AnalysisCache, AnalyzedCommit } from "./types";

export const ANALYSIS_CACHE_VERSION = 1 as const;

export function emptyAnalysisCache(): AnalysisCache {
  return { version: ANALYSIS_CACHE_VERSION, repos: {} };
}

export function cloneAnalysisCache(input: AnalysisCache | null | undefined): AnalysisCache {
  if (!input || input.version !== ANALYSIS_CACHE_VERSION) return emptyAnalysisCache();
  try {
    return JSON.parse(JSON.stringify(input)) as AnalysisCache;
  } catch {
    return emptyAnalysisCache();
  }
}

export function getRepoBucket(cache: AnalysisCache, repoKey: string) {
  if (!cache.repos[repoKey]) {
    cache.repos[repoKey] = { commits: {} };
  }
  return cache.repos[repoKey];
}

/** Return cached full AI output for a commit, if present */
export function getCachedFullAnalysis(
  cache: AnalysisCache | null | undefined,
  repoKey: string,
  sha: string,
): { analysis: AICommitAnalysis; modelUsed: string } | null {
  if (!cache?.repos[repoKey]?.commits[sha]?.full) return null;
  const e = cache.repos[repoKey].commits[sha];
  return {
    analysis: e.full!,
    modelUsed: e.modelUsed ?? "cache",
  };
}

export function upsertCommitAi(
  cache: AnalysisCache,
  repoKey: string,
  sha: string,
  analysis: AICommitAnalysis,
  modelUsed: string,
) {
  const bucket = getRepoBucket(cache, repoKey);
  bucket.commits[sha] = {
    full: analysis,
    modelUsed,
    analyzedAt: new Date().toISOString(),
    impactScore: analysis.business_impact_score,
    type: analysis.type,
    summary: analysis.reasoning.slice(0, 280),
  };
}

export function bumpRepoLastAnalyzedAt(cache: AnalysisCache, repoKey: string, iso: string) {
  const bucket = getRepoBucket(cache, repoKey);
  const prev = bucket.lastAnalyzedAt ? new Date(bucket.lastAnalyzedAt).getTime() : 0;
  const next = new Date(iso).getTime();
  if (Number.isFinite(next) && next >= prev) {
    bucket.lastAnalyzedAt = iso;
  }
}

export function maxCommitDateForRepo(
  commits: { repo: string; date: string }[],
  repoKey: string,
): string | null {
  const times = commits
    .filter((c) => c.repo === repoKey)
    .map((c) => new Date(c.date).getTime())
    .filter((t) => Number.isFinite(t));
  if (times.length === 0) return null;
  return new Date(Math.max(...times)).toISOString();
}

/** Rebuild cache from a stored AnalysisResult (migration when SESSION_AI_CACHE_KEY was missing). */
export function buildCacheFromAnalyzedCommits(commits: AnalyzedCommit[]): AnalysisCache {
  const cache = emptyAnalysisCache();
  for (const c of commits) {
    if (c.isMergeCommit || !c.analysis) continue;
    upsertCommitAi(cache, c.repo, c.sha, c.analysis, c.modelUsed);
  }
  for (const rk of new Set(commits.map((c) => c.repo))) {
    const maxD = maxCommitDateForRepo(commits, rk);
    if (maxD) bumpRepoLastAnalyzedAt(cache, rk, maxD);
  }
  return cache;
}

export function cacheCommitCount(cache: AnalysisCache): number {
  let n = 0;
  for (const b of Object.values(cache.repos)) {
    n += Object.keys(b.commits).length;
  }
  return n;
}

/** Client/session cache first; database rows with `full` overwrite (authoritative server cache). */
export function mergeAnalysisCachePreferDatabase(
  database: AnalysisCache,
  client: AnalysisCache | null | undefined,
): AnalysisCache {
  const out = cloneAnalysisCache(client);
  for (const [repoKey, bucket] of Object.entries(database.repos)) {
    const ob = getRepoBucket(out, repoKey);
    for (const [sha, ent] of Object.entries(bucket.commits)) {
      if (ent.full) {
        ob.commits[sha] = JSON.parse(JSON.stringify(ent)) as (typeof bucket.commits)[string];
      }
    }
    if (bucket.lastAnalyzedAt) bumpRepoLastAnalyzedAt(out, repoKey, bucket.lastAnalyzedAt);
  }
  return out;
}
