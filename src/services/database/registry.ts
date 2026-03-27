import { isAnalysisDbConfigured } from "../../lib/db";
import type { AnalysisPersistence } from "./contracts";
import { noopAnalysisPersistence } from "./noop-persistence";
import { supabaseAnalysisPersistence } from "./supabase-persistence";

/** True when server can read/write the analysis store (Supabase + pepper). */
export function isAnalysisDatabaseConfigured(): boolean {
  return isAnalysisDbConfigured();
}

/** @deprecated alias — use isAnalysisDatabaseConfigured */
export function isUserDerivationConfigured(): boolean {
  return isAnalysisDbConfigured();
}

export function isAnalysisDatabaseReady(): boolean {
  return isAnalysisDbConfigured();
}

let cached: AnalysisPersistence | null = null;

export function getAnalysisPersistence(): AnalysisPersistence {
  if (cached) return cached;
  cached = isAnalysisDatabaseReady() ? supabaseAnalysisPersistence : noopAnalysisPersistence;
  return cached;
}
