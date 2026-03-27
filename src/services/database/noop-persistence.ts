import { emptyAnalysisCache } from "../../lib/analysis-cache";
import type { AnalysisHistoryEntry, AnalysisResult } from "../../lib/types";
import type { AnalysisPersistence } from "./contracts";

export const noopAnalysisPersistence: AnalysisPersistence = {
  async fetchAiAnalysisForRepos() {
    return emptyAnalysisCache();
  },
  async upsertAiAnalysisRows() {
    /* no-op */
  },
  async upsertCommits() {
    /* no-op */
  },
  async insertAnalysisRun() {
    return "";
  },
  async listAnalysisRuns(): Promise<AnalysisHistoryEntry[]> {
    return [];
  },
  async getAnalysisRunSnapshot(): Promise<AnalysisResult | null> {
    return null;
  },
};
