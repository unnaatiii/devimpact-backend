import type { AICommitAnalysis, AnalysisCache, AnalysisHistoryEntry, AnalysisResult } from "../../lib/types";

/** Swappable persistence — implemented by Supabase today; replace with Mongo later. */
export interface AnalysisPersistence {
  fetchAiAnalysisForRepos(userId: string, repoKeys: string[]): Promise<AnalysisCache>;
  upsertAiAnalysisRows(
    userId: string,
    rows: {
      repo: string;
      sha: string;
      impact_score: number | null;
      type: string | null;
      summary: string | null;
      full_analysis: AICommitAnalysis;
      model_used: string;
    }[],
  ): Promise<void>;
  upsertCommits(
    userId: string,
    rows: {
      repo: string;
      sha: string;
      author: string | null;
      message: string | null;
      date: string | null;
      analyzed: boolean;
    }[],
  ): Promise<void>;
  insertAnalysisRun(
    userId: string,
    payload: {
      repos: string[];
      from_date: string;
      to_date: string;
      result_snapshot: AnalysisResult;
    },
  ): Promise<string>;
  listAnalysisRuns(userId: string, limit: number): Promise<AnalysisHistoryEntry[]>;
  getAnalysisRunSnapshot(userId: string, runId: string): Promise<AnalysisResult | null>;
}
