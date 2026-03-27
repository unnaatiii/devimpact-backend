import type {
  AICommitAnalysis,
  AnalysisCache,
  AnalysisHistoryEntry,
  AnalysisResult,
} from "../../lib/types";
import * as db from "../../lib/db";
import type { AnalysisPersistence } from "./contracts";

/** Supabase-backed adapter; all I/O goes through `@/lib/db`. */
export const supabaseAnalysisPersistence: AnalysisPersistence = {
  async fetchAiAnalysisForRepos(userId: string, repoKeys: string[]): Promise<AnalysisCache> {
    return db.fetchAiAnalysisCacheForRepos(userId, repoKeys);
  },

  async upsertAiAnalysisRows(userId, rows) {
    await db.batchUpsertAiAnalysis(userId, rows);
  },

  async upsertCommits(userId, rows) {
    await db.batchUpsertCommits(userId, rows);
  },

  async insertAnalysisRun(userId, payload) {
    const id = await db.saveAnalysisRun(
      userId,
      payload.repos,
      payload.from_date,
      payload.to_date,
      payload.result_snapshot,
    );
    return id ?? "";
  },

  async listAnalysisRuns(userId: string, limit: number): Promise<AnalysisHistoryEntry[]> {
    return db.listAnalysisRuns(userId, limit);
  },

  async getAnalysisRunSnapshot(userId: string, runId: string): Promise<AnalysisResult | null> {
    return db.getAnalysisRunSnapshot(userId, runId);
  },
};
