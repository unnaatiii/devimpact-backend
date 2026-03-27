import type { AnalysisHistoryEntry, AnalysisResult } from "../lib/types";
import { getAnalysisPersistence } from "./database/registry";

export async function saveAnalysisRun(
  userId: string,
  payload: {
    repoLabels: string[];
    from: string;
    to: string;
    result: AnalysisResult;
  },
): Promise<string> {
  const persistence = getAnalysisPersistence();
  return persistence.insertAnalysisRun(userId, {
    repos: payload.repoLabels,
    from_date: payload.from,
    to_date: payload.to,
    result_snapshot: payload.result,
  });
}

export async function listAnalysisRunsForUser(
  userId: string,
  limit = 24,
): Promise<AnalysisHistoryEntry[]> {
  const persistence = getAnalysisPersistence();
  return persistence.listAnalysisRuns(userId, limit);
}

export async function getAnalysisRunSnapshotForUser(
  userId: string,
  runId: string,
): Promise<AnalysisResult | null> {
  const persistence = getAnalysisPersistence();
  return persistence.getAnalysisRunSnapshot(userId, runId);
}
