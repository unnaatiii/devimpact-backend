/**
 * Server-only Supabase access. All DB calls are wrapped in try/catch; failures are logged and ignored by callers.
 * Components and routes should use these helpers (or services that call them), not `@supabase/supabase-js` directly.
 *
 * Schema parity: when adding/changing columns referenced here, add an idempotent migration under
 * `supabase/migrations/` (see `20250328120000_align_db_schema_with_codebase.sql` and `20250324120000_devimpact_ai.sql`).
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { bumpRepoLastAnalyzedAt, emptyAnalysisCache, getRepoBucket } from "../analysis-cache";
import type {
  AICommitAnalysis,
  AnalysisCache,
  AnalysisHistoryEntry,
  AnalysisResult,
  CommitData,
  ContributionType,
  RepoConfig,
} from "../types";
import { tryDeriveUserIdFromToken } from "../user-id";

/** Only cache a successful client. Never cache "null" from missing env — that blocked retries in dev. */
let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    return null;
  }
  try {
    _client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return _client;
  } catch (e) {
    console.error("[lib/db] Supabase createClient failed:", e);
    return null;
  }
}

/** Why DB writes might be skipped (call from API routes when debugging). */
export function explainDbWriteSkip(): string {
  const url = Boolean(process.env.SUPABASE_URL?.trim());
  const key = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
  const pepper = Boolean(process.env.USER_ID_PEPPER?.trim());
  if (!url) return "SUPABASE_URL is missing or empty in .env.local";
  if (!key) return "SUPABASE_SERVICE_ROLE_KEY is missing or empty (use the service_role secret from Supabase → Settings → API)";
  if (!pepper) return "USER_ID_PEPPER is missing — required to derive user_id from PAT";
  if (!getClient()) return "Supabase client failed to initialize (check URL/key)";
  return "DB should be available";
}

export function isAnalysisDbConfigured(): boolean {
  return Boolean(
    process.env.SUPABASE_URL?.trim() &&
      process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() &&
      process.env.USER_ID_PEPPER?.trim(),
  );
}

/** Stable tenant id from PAT + USER_ID_PEPPER (sha256). */
export function getUserId(pat: string): string | null {
  return tryDeriveUserIdFromToken(pat);
}

export type CachedAiRow = {
  impact_score: number | null;
  type: string | null;
  summary: string | null;
  full_analysis: AICommitAnalysis | null;
  model_used: string | null;
};

/**
 * Lookup by user + sha (first match). Prefer {@link getCachedAnalysisForRepo} when repo is known.
 */
export async function getCachedAnalysis(userId: string, sha: string): Promise<CachedAiRow | null> {
  const supabase = getClient();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("ai_analysis")
      .select("impact_score, type, summary, full_analysis, model_used")
      .eq("user_id", userId)
      .eq("sha", sha)
      .limit(1)
      .maybeSingle();
    if (error || !data?.full_analysis || typeof data.full_analysis !== "object") return null;
    return {
      impact_score: data.impact_score,
      type: data.type,
      summary: data.summary,
      full_analysis: data.full_analysis as AICommitAnalysis,
      model_used: data.model_used,
    };
  } catch (e) {
    console.error("[lib/db] getCachedAnalysis:", e);
    return null;
  }
}

/** Correct cache lookup for multi-repo tenants (unique key is user_id + repo + sha). */
export async function getCachedAnalysisForRepo(
  userId: string,
  repo: string,
  sha: string,
): Promise<CachedAiRow | null> {
  const supabase = getClient();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("ai_analysis")
      .select("impact_score, type, summary, full_analysis, model_used")
      .eq("user_id", userId)
      .eq("repo", repo)
      .eq("sha", sha)
      .maybeSingle();
    if (error || !data?.full_analysis || typeof data.full_analysis !== "object") return null;
    return {
      impact_score: data.impact_score,
      type: data.type,
      summary: data.summary,
      full_analysis: data.full_analysis as AICommitAnalysis,
      model_used: data.model_used,
    };
  } catch (e) {
    console.error("[lib/db] getCachedAnalysisForRepo:", e);
    return null;
  }
}

/**
 * Upsert one AI row. `repo` is required by the schema (unique user_id, repo, sha).
 * Pass `fullAnalysis` + `modelUsed` when available so dashboards stay consistent.
 */
export async function saveAnalysis(
  userId: string,
  repo: string,
  sha: string,
  impact_score: number,
  type: string,
  summary: string,
  fullAnalysis?: AICommitAnalysis,
  modelUsed?: string,
): Promise<void> {
  const supabase = getClient();
  if (!supabase) return;
  try {
    const { error } = await supabase.from("ai_analysis").upsert(
      {
        user_id: userId,
        repo,
        sha,
        impact_score,
        type,
        summary,
        full_analysis: fullAnalysis ?? null,
        model_used: modelUsed ?? null,
      },
      { onConflict: "user_id,repo,sha" },
    );
    if (error) {
      console.error("[lib/db] saveAnalysis:", error.message);
    }
  } catch (e) {
    console.error("[lib/db] saveAnalysis:", e);
  }
}

const COMMIT_UPSERT_CHUNK = 120;

/** Row shape used to detect redundant commits upserts (skip DB write if fingerprint matches). */
export type CommitComparableFields = {
  repo: string;
  sha: string;
  author: string | null;
  message: string | null;
  date: string | null;
  analyzed: boolean;
};

type ExistingCommitRow = {
  repo: string;
  sha: string;
  author: string | null;
  message: string | null;
  date: string | null;
  analyzed: boolean | null;
};

function commitPairKey(repo: string, sha: string): string {
  return `${repo}\0${sha}`;
}

/** Stable fingerprint for author/message/date/analyzed (timestamps normalized to ms). */
function commitFingerprint(row: {
  author: string | null | undefined;
  message: string | null | undefined;
  date: string | null | undefined;
  analyzed: boolean | null | undefined;
}): string {
  const author = (row.author ?? "").trim();
  const message = (row.message ?? "").trim();
  const t = row.date != null && String(row.date).length > 0 ? new Date(row.date as string).getTime() : NaN;
  const datePart = Number.isFinite(t) ? String(t) : String(row.date ?? "").trim();
  const az = row.analyzed === true;
  return `${author}\u0001${message}\u0001${datePart}\u0001${az ? "1" : "0"}`;
}

function commitCoreUnchanged(
  existing: ExistingCommitRow,
  incoming: CommitComparableFields,
): boolean {
  return commitFingerprint(existing) === commitFingerprint(incoming);
}

/**
 * Load existing commit rows for the given repo+sha pairs (single query per chunk).
 * Uses .in(repo) + .in(sha) then matches exact pairs in memory.
 */
async function fetchExistingCommitsMap(
  userId: string,
  pairs: CommitComparableFields[],
): Promise<Map<string, ExistingCommitRow>> {
  const map = new Map<string, ExistingCommitRow>();
  const supabase = getClient();
  if (!supabase || pairs.length === 0) return map;
  const repos = [...new Set(pairs.map((p) => p.repo))];
  const shas = [...new Set(pairs.map((p) => p.sha))];
  if (repos.length === 0 || shas.length === 0) return map;
  try {
    const { data, error } = await supabase
      .from("commits")
      .select("repo,sha,author,message,date,analyzed")
      .eq("user_id", userId)
      .in("repo", repos)
      .in("sha", shas);
    if (error || !data) return map;
    const want = new Set(pairs.map((p) => commitPairKey(p.repo, p.sha)));
    for (const row of data as ExistingCommitRow[]) {
      const k = commitPairKey(row.repo, row.sha);
      if (want.has(k)) map.set(k, row);
    }
  } catch {
    /* non-fatal */
  }
  return map;
}

function partitionCommitsForUpsert(
  existing: Map<string, ExistingCommitRow>,
  incoming: CommitComparableFields[],
): { toWrite: CommitComparableFields[]; skipped: number } {
  let skipped = 0;
  const toWrite: CommitComparableFields[] = [];
  for (const row of incoming) {
    const key = commitPairKey(row.repo, row.sha);
    const prev = existing.get(key);
    if (prev && commitCoreUnchanged(prev, row)) {
      skipped++;
      continue;
    }
    toWrite.push(row);
  }
  return { toWrite, skipped };
}

export async function upsertCommit(
  userId: string,
  repo: string,
  sha: string,
  author: string | null,
  message: string | null,
  date: string | null,
  analyzed = false,
): Promise<void> {
  const supabase = getClient();
  if (!supabase) return;
  const incoming: CommitComparableFields = {
    repo,
    sha,
    author,
    message,
    date,
    analyzed,
  };
  try {
    const { data, error: readErr } = await supabase
      .from("commits")
      .select("repo,sha,author,message,date,analyzed")
      .eq("user_id", userId)
      .eq("repo", repo)
      .eq("sha", sha)
      .maybeSingle();
    if (readErr) {
      console.error("[lib/db] upsertCommit read:", readErr.message);
    } else if (data && commitCoreUnchanged(data as ExistingCommitRow, incoming)) {
      return;
    }

    console.log("🔥 Attempting to save commit:", sha);
    const { error } = await supabase.from("commits").upsert(
      {
        user_id: userId,
        repo,
        sha,
        author,
        message,
        date,
        analyzed,
      },
      { onConflict: "user_id,repo,sha" },
    );
    if (error) {
      console.error("[lib/db] upsertCommit:", error.message, error.details, error.hint);
      return;
    }
    console.log("✅ Commit saved");
  } catch (e) {
    console.error("[lib/db] upsertCommit:", e);
  }
}

export async function upsertCommitsFromGitHub(userId: string, commits: CommitData[]): Promise<void> {
  const supabase = getClient();
  if (!supabase || commits.length === 0) {
    if (!supabase) {
      console.warn("[lib/db] upsertCommitsFromGitHub skipped — no client:", explainDbWriteSkip());
    }
    return;
  }
  try {
    let totalSkipped = 0;
    let totalWritten = 0;
    console.log(`[lib/db] upsertCommitsFromGitHub: ${commits.length} commits for user_id prefix ${userId.slice(0, 12)}…`);
    for (let i = 0; i < commits.length; i += COMMIT_UPSERT_CHUNK) {
      const slice = commits.slice(i, i + COMMIT_UPSERT_CHUNK);
      const comparable: CommitComparableFields[] = slice.map((c) => ({
        repo: c.repo,
        sha: c.sha,
        author: c.author ?? null,
        message: c.message ?? null,
        date: c.date ?? null,
        analyzed: false,
      }));
      const existing = await fetchExistingCommitsMap(userId, comparable);
      const { toWrite, skipped } = partitionCommitsForUpsert(existing, comparable);
      totalSkipped += skipped;
      if (toWrite.length === 0) continue;

      for (const c of toWrite) {
        console.log("🔥 Attempting to save commit:", c.sha);
      }
      const payload = toWrite.map((c) => ({
        user_id: userId,
        repo: c.repo,
        sha: c.sha,
        author: c.author,
        message: c.message,
        date: c.date,
        analyzed: c.analyzed,
      }));
      const { error } = await supabase.from("commits").upsert(payload, {
        onConflict: "user_id,repo,sha",
      });
      if (error) {
        console.error("[lib/db] upsertCommitsFromGitHub batch:", error.message, error.details, error.hint, error.code);
        continue;
      }
      totalWritten += toWrite.length;
      for (const _c of toWrite) {
        console.log("✅ Commit saved");
      }
    }
    if (totalSkipped > 0) {
      console.log(
        `[lib/db] upsertCommitsFromGitHub: skipped ${totalSkipped} unchanged commit(s); upserted ${totalWritten}`,
      );
    }
  } catch (e) {
    console.error("[lib/db] upsertCommitsFromGitHub:", e);
  }
}

/**
 * Insert an analysis run. `result_snapshot` defaults to `{}` to satisfy NOT NULL if caller omits it.
 */
export async function saveAnalysisRun(
  userId: string,
  repos: string[],
  from_date: string,
  to_date: string,
  result_snapshot?: unknown,
): Promise<string | null> {
  const supabase = getClient();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("analysis_runs")
      .insert({
        user_id: userId,
        repos,
        from_date,
        to_date,
        result_snapshot: result_snapshot ?? {},
      })
      .select("id")
      .single();
    if (error) {
      console.error("[lib/db] saveAnalysisRun:", error.message);
      return null;
    }
    return data?.id ?? null;
  } catch (e) {
    console.error("[lib/db] saveAnalysisRun:", e);
    return null;
  }
}

function rowsToAnalysisCache(
  rows: {
    repo: string;
    sha: string;
    impact_score: number | null;
    type: string | null;
    summary: string | null;
    full_analysis: unknown;
    model_used: string | null;
    created_at: string;
  }[],
): AnalysisCache {
  const cache = emptyAnalysisCache();
  for (const row of rows) {
    if (!row.full_analysis || typeof row.full_analysis !== "object") continue;
    const full = row.full_analysis as AICommitAnalysis;
    const bucket = getRepoBucket(cache, row.repo);
    bucket.commits[row.sha] = {
      full,
      modelUsed: row.model_used ?? "cache",
      analyzedAt: row.created_at,
      impactScore: row.impact_score ?? undefined,
      type: (row.type as ContributionType) ?? undefined,
      summary: row.summary ?? undefined,
    };
  }
  for (const rk of Object.keys(cache.repos)) {
    const bucket = cache.repos[rk];
    const times = Object.values(bucket.commits)
      .map((e) => e.analyzedAt)
      .filter(Boolean) as string[];
    if (times.length === 0) continue;
    const maxT = Math.max(...times.map((d) => new Date(d).getTime()).filter(Number.isFinite));
    if (Number.isFinite(maxT)) bumpRepoLastAnalyzedAt(cache, rk, new Date(maxT).toISOString());
  }
  return cache;
}

export async function fetchAiAnalysisCacheForRepos(
  userId: string,
  repoKeys: string[],
): Promise<AnalysisCache> {
  const supabase = getClient();
  if (!supabase || repoKeys.length === 0) return emptyAnalysisCache();
  try {
    const { data, error } = await supabase
      .from("ai_analysis")
      .select(
        "repo, sha, impact_score, type, summary, full_analysis, model_used, created_at",
      )
      .eq("user_id", userId)
      .in("repo", repoKeys);
    if (error) {
      console.error("[lib/db] fetchAiAnalysisCacheForRepos:", error.message);
      return emptyAnalysisCache();
    }
    return rowsToAnalysisCache(data ?? []);
  } catch (e) {
    console.error("[lib/db] fetchAiAnalysisCacheForRepos:", e);
    return emptyAnalysisCache();
  }
}

export async function batchUpsertAiAnalysis(
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
): Promise<void> {
  const supabase = getClient();
  if (!supabase || rows.length === 0) return;
  try {
    const payload = rows.map((r) => ({
      user_id: userId,
      repo: r.repo,
      sha: r.sha,
      impact_score: r.impact_score,
      type: r.type,
      summary: r.summary,
      full_analysis: r.full_analysis,
      model_used: r.model_used,
    }));
    const { error } = await supabase.from("ai_analysis").upsert(payload, {
      onConflict: "user_id,repo,sha",
    });
    if (error) console.error("[lib/db] batchUpsertAiAnalysis:", error.message);
  } catch (e) {
    console.error("[lib/db] batchUpsertAiAnalysis:", e);
  }
}

export async function batchUpsertCommits(
  userId: string,
  rows: {
    repo: string;
    sha: string;
    author: string | null;
    message: string | null;
    date: string | null;
    analyzed: boolean;
  }[],
): Promise<void> {
  const supabase = getClient();
  if (!supabase || rows.length === 0) return;
  try {
    let skippedAll = 0;
    for (let i = 0; i < rows.length; i += COMMIT_UPSERT_CHUNK) {
      const slice = rows.slice(i, i + COMMIT_UPSERT_CHUNK);
      const comparable: CommitComparableFields[] = slice.map((r) => ({
        repo: r.repo,
        sha: r.sha,
        author: r.author,
        message: r.message,
        date: r.date,
        analyzed: r.analyzed,
      }));
      const existing = await fetchExistingCommitsMap(userId, comparable);
      const { toWrite, skipped } = partitionCommitsForUpsert(existing, comparable);
      skippedAll += skipped;
      if (toWrite.length === 0) continue;
      const payload = toWrite.map((r) => ({ user_id: userId, ...r }));
      const { error } = await supabase.from("commits").upsert(payload, {
        onConflict: "user_id,repo,sha",
      });
      if (error) console.error("[lib/db] batchUpsertCommits:", error.message);
    }
    if (skippedAll > 0) {
      console.log(`[lib/db] batchUpsertCommits: skipped ${skippedAll} unchanged row(s)`);
    }
  } catch (e) {
    console.error("[lib/db] batchUpsertCommits:", e);
  }
}

export async function listAnalysisRuns(
  userId: string,
  limit: number,
): Promise<AnalysisHistoryEntry[]> {
  const supabase = getClient();
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from("analysis_runs")
      .select("id, repos, from_date, to_date, run_at")
      .eq("user_id", userId)
      .order("run_at", { ascending: false })
      .limit(Math.min(48, Math.max(1, limit)));
    if (error) {
      console.error("[lib/db] listAnalysisRuns:", error.message);
      return [];
    }
    return (data ?? []).map((row) => ({
      id: row.id,
      repos: Array.isArray(row.repos) ? (row.repos as string[]) : [],
      dateRange: { from: row.from_date, to: row.to_date },
      runAt: row.run_at,
    }));
  } catch (e) {
    console.error("[lib/db] listAnalysisRuns:", e);
    return [];
  }
}

export async function getAnalysisRunSnapshot(
  userId: string,
  runId: string,
): Promise<AnalysisResult | null> {
  const supabase = getClient();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("analysis_runs")
      .select("result_snapshot")
      .eq("user_id", userId)
      .eq("id", runId)
      .maybeSingle();
    if (error) {
      console.error("[lib/db] getAnalysisRunSnapshot:", error.message);
      return null;
    }
    const snap = data?.result_snapshot;
    if (!snap || typeof snap !== "object") return null;
    return snap as AnalysisResult;
  } catch (e) {
    console.error("[lib/db] getAnalysisRunSnapshot:", e);
    return null;
  }
}

// ── Phase 2: repos + commit reads (wide dashboard / future Mongo adapter) ─────

export type StoredRepoRecord = {
  id: string;
  user_id: string;
  name: string;
  full_name: string;
  private: boolean;
  last_synced_at: string | null;
};

export type DbCommitStored = {
  repo: string;
  sha: string;
  author: string | null;
  message: string | null;
  date: string | null;
};

export async function saveRepo(
  userId: string,
  repo: { name: string; full_name: string; private?: boolean },
): Promise<void> {
  const supabase = getClient();
  if (!supabase) {
    console.warn("[lib/db] saveRepo skipped —", explainDbWriteSkip());
    return;
  }
  try {
    console.log("🔥 Attempting to save repo:", repo.full_name);
    const { error } = await supabase.from("repos").upsert(
      {
        user_id: userId,
        name: repo.name,
        full_name: repo.full_name,
        private: repo.private ?? false,
      },
      { onConflict: "user_id,full_name" },
    );
    if (error) {
      console.error("[lib/db] saveRepo:", repo.full_name, error.message, error.details, error.hint, error.code);
      return;
    }
    console.log("✅ Repo saved:", repo.full_name);
  } catch (e) {
    console.error("[lib/db] saveRepo:", e);
  }
}

export async function saveReposFromConfigs(userId: string, repos: RepoConfig[]): Promise<void> {
  try {
    for (const r of repos) {
      const full_name = `${r.owner}/${r.repo}`;
      await saveRepo(userId, { name: r.repo, full_name, private: false });
    }
  } catch (e) {
    console.error("[lib/db] saveReposFromConfigs:", e);
  }
}

export async function getRepos(userId: string): Promise<StoredRepoRecord[]> {
  const supabase = getClient();
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from("repos")
      .select("id, user_id, name, full_name, private, last_synced_at")
      .eq("user_id", userId)
      .order("full_name");
    if (error) {
      console.error("[lib/db] getRepos:", error.message);
      return [];
    }
    return (data ?? []) as StoredRepoRecord[];
  } catch (e) {
    console.error("[lib/db] getRepos:", e);
    return [];
  }
}

export async function touchReposLastSynced(userId: string, fullNames: string[]): Promise<void> {
  const supabase = getClient();
  if (!supabase || fullNames.length === 0) return;
  const now = new Date().toISOString();
  try {
    for (const full_name of fullNames) {
      const { error } = await supabase
        .from("repos")
        .update({ last_synced_at: now })
        .eq("user_id", userId)
        .eq("full_name", full_name);
      if (error) console.error("[lib/db] touchReposLastSynced:", error.message);
    }
  } catch (e) {
    console.error("[lib/db] touchReposLastSynced:", e);
  }
}

export async function getRepoLastSyncedAtMap(
  userId: string,
  fullNames: string[],
): Promise<Record<string, string>> {
  const supabase = getClient();
  if (!supabase || fullNames.length === 0) return {};
  try {
    const { data, error } = await supabase
      .from("repos")
      .select("full_name, last_synced_at")
      .eq("user_id", userId)
      .in("full_name", fullNames);
    if (error) {
      console.error("[lib/db] getRepoLastSyncedAtMap:", error.message);
      return {};
    }
    const out: Record<string, string> = {};
    for (const row of data ?? []) {
      if (row.last_synced_at && row.full_name) {
        out[row.full_name as string] = row.last_synced_at as string;
      }
    }
    return out;
  } catch (e) {
    console.error("[lib/db] getRepoLastSyncedAtMap:", e);
    return {};
  }
}

export async function getCommitsByRepo(
  userId: string,
  repoKey: string,
  opts?: { limit?: number; sinceIso?: string; untilIso?: string },
): Promise<DbCommitStored[]> {
  const supabase = getClient();
  if (!supabase) return [];
  const limit = Math.min(500, Math.max(1, opts?.limit ?? 50));
  try {
    let q = supabase
      .from("commits")
      .select("repo,sha,author,message,date")
      .eq("user_id", userId)
      .eq("repo", repoKey)
      .order("date", { ascending: false })
      .limit(limit);
    if (opts?.sinceIso) q = q.gte("date", opts.sinceIso);
    if (opts?.untilIso) q = q.lte("date", opts.untilIso);
    const { data, error } = await q;
    if (error) {
      console.error("[lib/db] getCommitsByRepo:", error.message);
      return [];
    }
    return (data ?? []) as DbCommitStored[];
  } catch (e) {
    console.error("[lib/db] getCommitsByRepo:", e);
    return [];
  }
}

export async function getCommitsForReposWindow(
  userId: string,
  repoKeys: string[],
  sinceIso: string,
  untilIso: string,
  limitPerRepo: number,
): Promise<DbCommitStored[]> {
  const supabase = getClient();
  if (!supabase || repoKeys.length === 0) return [];
  try {
    const cap = Math.min(20_000, repoKeys.length * Math.max(1, limitPerRepo));
    const { data, error } = await supabase
      .from("commits")
      .select("repo,sha,author,message,date")
      .eq("user_id", userId)
      .in("repo", repoKeys)
      .gte("date", sinceIso)
      .lte("date", untilIso)
      .order("date", { ascending: false })
      .limit(cap);
    if (error) {
      console.error("[lib/db] getCommitsForReposWindow:", error.message);
      return [];
    }
    const rows = (data ?? []) as DbCommitStored[];
    const perRepo: Record<string, number> = Object.fromEntries(repoKeys.map((k) => [k, 0]));
    const out: DbCommitStored[] = [];
    for (const row of rows) {
      const k = row.repo;
      if (perRepo[k] === undefined || perRepo[k] >= limitPerRepo) continue;
      perRepo[k]++;
      out.push(row);
    }
    return out;
  } catch (e) {
    console.error("[lib/db] getCommitsForReposWindow:", e);
    return [];
  }
}

function inferMergeCommitFromMessage(message: string): boolean {
  return /^Merge (pull request|branch)/i.test(message);
}

export function mapDbCommitsToCommitData(
  rows: DbCommitStored[],
  repoByKey: Map<string, RepoConfig>,
): CommitData[] {
  const out: CommitData[] = [];
  for (const row of rows) {
    const cfg = repoByKey.get(row.repo);
    if (!cfg) continue;
    const msg = row.message ?? "";
    out.push({
      sha: row.sha,
      message: msg,
      author: row.author ?? "unknown",
      date: row.date ?? new Date(0).toISOString(),
      repo: row.repo,
      repoLabel: cfg.label,
      repoType: cfg.repoType,
      filesChanged: [],
      additions: 0,
      deletions: 0,
      diff: "",
      isMergeCommit: inferMergeCommitFromMessage(msg),
    });
  }
  return out;
}

const BOT_AUTHORS = /\[bot\]|dependabot|renovate|github-actions|codecov/i;

export function filterCommitsForWideWindow(
  commits: CommitData[],
  sinceTs: number,
  untilTs: number,
): CommitData[] {
  return commits.filter((c) => {
    if (BOT_AUTHORS.test(c.author)) return false;
    const t = new Date(c.date).getTime();
    if (Number.isNaN(t)) return false;
    return t >= sinceTs && t <= untilTs;
  });
}

export type DbDeveloperAggregate = {
  authorKey: string;
  commitCount: number;
  repos: string[];
};

export async function getDevelopers(
  userId: string,
  repoKeys: string[],
  sinceIso: string,
  untilIso: string,
  limitPerRepo = 2500,
): Promise<DbDeveloperAggregate[]> {
  try {
    const rows = await getCommitsForReposWindow(userId, repoKeys, sinceIso, untilIso, limitPerRepo);
    const map = new Map<string, { count: number; repos: Set<string> }>();
    for (const r of rows) {
      const a = (r.author ?? "unknown").trim();
      const cur = map.get(a) ?? { count: 0, repos: new Set<string>() };
      cur.count += 1;
      cur.repos.add(r.repo);
      map.set(a, cur);
    }
    return [...map.entries()]
      .map(([authorKey, v]) => ({
        authorKey,
        commitCount: v.count,
        repos: [...v.repos].sort(),
      }))
      .sort((a, b) => b.commitCount - a.commitCount);
  } catch (e) {
    console.error("[lib/db] getDevelopers:", e);
    return [];
  }
}

/** Alias for analysis history UI / future adapters. */
export async function getAnalysisHistory(
  userId: string,
  limit = 24,
): Promise<AnalysisHistoryEntry[]> {
  return listAnalysisRuns(userId, limit);
}

/** Upsert GitHub profile for this tenant (OAuth or PAT). Safe to call on every list-repos. */
export async function upsertGitHubAccount(
  userId: string,
  profile: { githubUserId: number; login: string; avatarUrl: string | null },
): Promise<boolean> {
  const supabase = getClient();
  if (!supabase || !userId?.trim()) return false;
  try {
    const { error } = await supabase.from("github_accounts").upsert(
      {
        user_id: userId.trim(),
        github_user_id: profile.githubUserId,
        login: profile.login.trim(),
        avatar_url: profile.avatarUrl?.trim() || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) {
      console.error("[lib/db] upsertGitHubAccount:", error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[lib/db] upsertGitHubAccount:", e);
    return false;
  }
}

// ── Org webhook + navbar polls ────────────────────────────────────────────────

export async function getUserIdForOrgLogin(orgLogin: string): Promise<string | null> {
  const supabase = getClient();
  if (!supabase || !orgLogin?.trim()) return null;
  try {
    const { data, error } = await supabase
      .from("github_org_tenant_map")
      .select("user_id")
      .eq("org_login", orgLogin.trim().toLowerCase())
      .maybeSingle();
    if (error || !data?.user_id) return null;
    return data.user_id as string;
  } catch (e) {
    console.error("[lib/db] getUserIdForOrgLogin:", e);
    return null;
  }
}

export async function upsertOrgTenantMap(
  orgLogin: string,
  userId: string,
  note?: string | null,
): Promise<boolean> {
  const supabase = getClient();
  if (!supabase) return false;
  try {
    const { error } = await supabase.from("github_org_tenant_map").upsert(
      {
        org_login: orgLogin.trim().toLowerCase(),
        user_id: userId,
        note: note?.trim() || null,
      },
      { onConflict: "org_login" },
    );
    if (error) {
      console.error("[lib/db] upsertOrgTenantMap:", error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[lib/db] upsertOrgTenantMap:", e);
    return false;
  }
}

export async function incrementTenantAiPending(userId: string, delta: number): Promise<void> {
  const supabase = getClient();
  if (!supabase || delta <= 0) return;
  try {
    const { error } = await supabase.rpc("increment_tenant_ai_pending", {
      p_user_id: userId,
      p_delta: delta,
    });
    if (error) console.error("[lib/db] incrementTenantAiPending:", error.message);
  } catch (e) {
    console.error("[lib/db] incrementTenantAiPending:", e);
  }
}

export type TenantAiQueueRow = {
  pending_count: number;
  last_batch_completed_at: string | null;
  ai_batch_version: number;
};

export async function getTenantAiQueue(userId: string): Promise<TenantAiQueueRow | null> {
  const supabase = getClient();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("tenant_ai_queue")
      .select("pending_count, last_batch_completed_at, ai_batch_version")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return null;
    return {
      pending_count: Number(data.pending_count) || 0,
      last_batch_completed_at: (data.last_batch_completed_at as string) ?? null,
      ai_batch_version: Number(data.ai_batch_version) || 0,
    };
  } catch (e) {
    console.error("[lib/db] getTenantAiQueue:", e);
    return null;
  }
}

export async function completeTenantAiBatch(userId: string): Promise<number> {
  const supabase = getClient();
  if (!supabase) return 0;
  try {
    const { data, error } = await supabase.rpc("complete_tenant_ai_batch", {
      p_user_id: userId,
    });
    if (error) {
      console.error("[lib/db] completeTenantAiBatch:", error.message);
      return 0;
    }
    const v = typeof data === "number" ? data : Number(data);
    return Number.isFinite(v) ? v : 0;
  } catch (e) {
    console.error("[lib/db] completeTenantAiBatch:", e);
    return 0;
  }
}

export type CommitIngestNotification = {
  repo: string;
  sha: string;
  author: string | null;
  message: string | null;
  date: string | null;
  ingested_at: string;
};

export async function listCommitsIngestedSince(
  userId: string,
  sinceIso: string,
  limit = 50,
): Promise<CommitIngestNotification[]> {
  const supabase = getClient();
  if (!supabase) return [];
  const cap = Math.min(100, Math.max(1, limit));
  try {
    const { data, error } = await supabase
      .from("commits")
      .select("repo,sha,author,message,date,ingested_at")
      .eq("user_id", userId)
      .gt("ingested_at", sinceIso)
      .order("ingested_at", { ascending: true })
      .limit(cap);
    if (error) {
      console.error("[lib/db] listCommitsIngestedSince:", error.message);
      return [];
    }
    return (data ?? []) as CommitIngestNotification[];
  } catch (e) {
    console.error("[lib/db] listCommitsIngestedSince:", e);
    return [];
  }
}

export type UnanalyzedCommitRow = {
  repo: string;
  sha: string;
  author: string | null;
  message: string | null;
  date: string | null;
};

export async function listUnanalyzedCommitsForAi(
  userId: string,
  limit = 40,
): Promise<UnanalyzedCommitRow[]> {
  const supabase = getClient();
  if (!supabase) return [];
  const cap = Math.min(100, Math.max(1, limit));
  try {
    const { data, error } = await supabase
      .from("commits")
      .select("repo,sha,author,message,date")
      .eq("user_id", userId)
      .eq("analyzed", false)
      .order("date", { ascending: false })
      .limit(cap * 2);
    if (error) {
      console.error("[lib/db] listUnanalyzedCommitsForAi:", error.message);
      return [];
    }
    const rows = (data ?? []) as UnanalyzedCommitRow[];
    return rows
      .filter((r) => !inferMergeCommitFromMessage(r.message ?? ""))
      .slice(0, cap);
  } catch (e) {
    console.error("[lib/db] listUnanalyzedCommitsForAi:", e);
    return [];
  }
}

export async function userHasRepoFullName(userId: string, fullName: string): Promise<boolean> {
  try {
    const repos = await getRepos(userId);
    if (repos.length === 0) return true;
    return repos.some((r) => r.full_name === fullName);
  } catch {
    return true;
  }
}

export async function upsertCommitsWebhookRows(
  userId: string,
  rows: {
    repo: string;
    sha: string;
    author: string | null;
    message: string | null;
    date: string | null;
    analyzed: boolean;
    ingested_at: string;
  }[],
): Promise<void> {
  if (rows.length === 0) return;
  const supabase = getClient();
  if (!supabase) return;
  try {
    let skippedAll = 0;
    for (let i = 0; i < rows.length; i += COMMIT_UPSERT_CHUNK) {
      const slice = rows.slice(i, i + COMMIT_UPSERT_CHUNK);
      const comparable: CommitComparableFields[] = slice.map((r) => ({
        repo: r.repo,
        sha: r.sha,
        author: r.author,
        message: r.message,
        date: r.date,
        analyzed: r.analyzed,
      }));
      const existing = await fetchExistingCommitsMap(userId, comparable);
      const { toWrite: coreChanged, skipped } = partitionCommitsForUpsert(existing, comparable);
      skippedAll += skipped;
      if (coreChanged.length === 0) continue;
      const coreKeys = new Set(coreChanged.map((c) => commitPairKey(c.repo, c.sha)));
      const payload = slice
        .filter((r) => coreKeys.has(commitPairKey(r.repo, r.sha)))
        .map((r) => ({ user_id: userId, ...r }));
      const { error } = await supabase.from("commits").upsert(payload, {
        onConflict: "user_id,repo,sha",
      });
      if (error) console.error("[lib/db] upsertCommitsWebhookRows:", error.message);
    }
    if (skippedAll > 0) {
      console.log(`[lib/db] upsertCommitsWebhookRows: skipped ${skippedAll} unchanged row(s)`);
    }
  } catch (e) {
    console.error("[lib/db] upsertCommitsWebhookRows:", e);
  }
}
