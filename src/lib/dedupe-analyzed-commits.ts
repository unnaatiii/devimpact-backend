import type { AnalyzedCommit } from "./types";

/** Same SHA can appear twice in merged feeds — keys must be unique per repo. */
export function analyzedCommitRowKey(c: { repo: string; sha: string }): string {
  return `${c.repo}:${c.sha}`;
}

/** Keep first occurrence; prefer a row that already has AI analysis. */
export function dedupeAnalyzedCommitsByRepoSha(commits: AnalyzedCommit[]): AnalyzedCommit[] {
  const map = new Map<string, AnalyzedCommit>();
  for (const c of commits) {
    const k = analyzedCommitRowKey(c);
    const prev = map.get(k);
    if (!prev) {
      map.set(k, c);
      continue;
    }
    if (!prev.analysis && c.analysis) map.set(k, c);
  }
  return [...map.values()];
}
