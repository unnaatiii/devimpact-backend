/**
 * DevImpact Express API
 * ---------------------
 * 1. GitHub org webhook → verify signature → upsert commits → optional AI batch (pending ≥ 5).
 * 2. /api/analyze — full GitHub fetch + OpenRouter + persist (was Next.js analyze-impact).
 * 3. /api/load-base — GitHub + DB merge, scoring without live AI.
 * 4. Other /api/* routes mirror the former Next.js app/api handlers (DB + GitHub token passthrough).
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";

/** Prefer package-root `.env` (next to package.json); fall back to cwd. `override` so IDE/shell empty vars do not block real secrets. */
function resolveBackendEnvPath(): string {
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const nextToPkg = path.join(pkgRoot, ".env");
  const cwdEnv = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(nextToPkg)) return nextToPkg;
  if (fs.existsSync(cwdEnv)) return cwdEnv;
  return nextToPkg;
}

dotenv.config({ path: resolveBackendEnvPath(), override: true });
import express from "express";
import {
  verifyGitHubWebhookSignature,
  parseOrgLogin,
  parseRepositoryFullName,
  type GitHubPushWebhookPayload,
} from "./lib/github-webhook.js";
import {
  getUserIdForOrgLogin,
  userHasRepoFullName,
  upsertCommitsWebhookRows,
  incrementTenantAiPending,
  getTenantAiQueue,
  isAnalysisDbConfigured,
  explainDbWriteSkip,
  getUserId,
  saveReposFromConfigs,
  upsertCommitsFromGitHub,
  touchReposLastSynced,
  saveRepo,
  getRepoLastSyncedAtMap,
  getCommitsForReposWindow,
  mapDbCommitsToCommitData,
  filterCommitsForWideWindow,
  listCommitsIngestedSince,
  upsertOrgTenantMap,
  getAnalysisHistory,
  upsertGitHubAccount,
} from "./services/dbService.js";
import { runWebhookAiBatchForUser, ScoringEngine } from "./services/aiService.js";
import { GitHubService } from "./services/githubService.js";
import { tryDeriveUserIdFromToken } from "./lib/user-id.js";
import { getOpenRouterApiKey } from "./lib/openrouter-key.js";
import {
  endOfDayUtcIso,
  startOfDayUtcIso,
  validateAnalysisDateRange,
  validateWideDashboardDateRange,
} from "./lib/date-range.js";
import {
  cloneAnalysisCache,
  emptyAnalysisCache,
  mergeAnalysisCachePreferDatabase,
} from "./lib/analysis-cache.js";
import type { AnalyzeImpactPayload, RepoConfig } from "./lib/types.js";
import {
  buildAllowlistSet,
  commitMatchesAllowlist,
  loginMatchesAllowlist,
} from "./lib/contributor-allowlist.js";
import { isAnalysisDatabaseReady } from "./services/database/registry.js";
import { getAIAnalysisForRepos, persistAiAnalysisAfterRun } from "./services/analysisService.js";
import { getAnalysisRunSnapshotForUser, saveAnalysisRun } from "./services/runService.js";
import {
  createOctokitForUserPat,
  githubApiClientMessage,
  listReposForAuthenticatedUserPat,
  normalizeUserPat,
} from "./lib/octokit-pat.js";

const PORT = Number(process.env.PORT) || 8000;

const app = express();

// CORS: allow Next.js dev server and configurable production origin
const corsOrigin =
  process.env.CORS_ORIGIN === "*"
    ? true
    : (process.env.CORS_ORIGIN ?? true);
app.use(
  cors({
    origin: corsOrigin,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-hub-signature-256", "x-github-event"],
  }),
);

app.get("/", (_req, res) => {
  res.send("Backend is running");
});

app.get("/api/test", (_req, res) => {
  res.json({ message: "Backend connected successfully" });
});

// ── GitHub webhook: MUST use raw body for HMAC (before express.json) ────────
function inferMergeCommitFromMessage(message: string): boolean {
  return /^Merge (pull request|branch)/i.test(message);
}

function authorFromWebhookCommit(
  c: NonNullable<GitHubPushWebhookPayload["commits"]>[number],
): string {
  const u = c.author?.username?.trim();
  if (u) return u;
  const n = c.author?.name?.trim();
  if (n) return n;
  return "unknown";
}

app.post(
  "/api/github/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET?.trim();
    if (!secret) {
      res.status(503).json({ error: "Webhook not configured" });
      return;
    }

    if (!isAnalysisDbConfigured()) {
      res.status(503).json({ error: "Database not configured" });
      return;
    }

    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body ?? "");
    const sig = req.get("x-hub-signature-256") ?? null;
    if (!verifyGitHubWebhookSignature(raw, sig, secret)) {
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    const event = req.get("x-github-event");
    if (event === "ping") {
      res.json({ ok: true, ping: true });
      return;
    }
    if (event !== "push") {
      res.json({ ok: true, ignored: event ?? "unknown" });
      return;
    }

    let payload: GitHubPushWebhookPayload;
    try {
      payload = JSON.parse(raw) as GitHubPushWebhookPayload;
    } catch {
      res.status(400).json({ error: "Invalid JSON" });
      return;
    }

    const orgLogin = parseOrgLogin(payload);
    if (!orgLogin) {
      res.status(400).json({ error: "Organization context required" });
      return;
    }

    const userId = await getUserIdForOrgLogin(orgLogin);
    if (!userId) {
      console.warn(`[webhook] no tenant map for org ${orgLogin}`);
      res.json({ ok: true, mapped: false });
      return;
    }

    const fullName = parseRepositoryFullName(payload);
    if (!fullName) {
      res.status(400).json({ error: "Missing repository" });
      return;
    }

    const allowed = await userHasRepoFullName(userId, fullName);
    if (!allowed) {
      console.warn(`[webhook] repo ${fullName} not in tenant repos list for ${orgLogin}`);
      res.json({ ok: true, skipped: "repo_not_registered" });
      return;
    }

    const commits = payload.commits ?? [];
    if (commits.length === 0) {
      res.json({ ok: true, commits: 0 });
      return;
    }

    const ingested_at = new Date().toISOString();
    const rows: Parameters<typeof upsertCommitsWebhookRows>[1] = [];
    let aiDelta = 0;

    for (const c of commits) {
      const sha = c.id?.trim();
      if (!sha) continue;
      const message = c.message ?? "";
      const isMerge = inferMergeCommitFromMessage(message);
      const analyzed = isMerge;
      if (!isMerge) aiDelta += 1;
      rows.push({
        repo: fullName,
        sha,
        author: authorFromWebhookCommit(c),
        message: message || null,
        date: c.timestamp?.trim() || null,
        analyzed,
        ingested_at,
      });
    }

    if (rows.length === 0) {
      res.json({ ok: true, commits: 0 });
      return;
    }

    await upsertCommitsWebhookRows(userId, rows);
    if (aiDelta > 0) {
      await incrementTenantAiPending(userId, aiDelta);
    }

    const q = await getTenantAiQueue(userId);
    const pending = q?.pending_count ?? aiDelta;
    if (pending >= 5) {
      // Fire-and-forget batch (replaces Next.js `after()`)
      setImmediate(() => {
        void runWebhookAiBatchForUser(userId).catch((e) => console.error("[webhook] AI batch:", e));
      });
    }

    res.json({
      ok: true,
      stored: rows.length,
      aiPendingIncrement: aiDelta,
    });
  },
);

// JSON body for all routes below
app.use(express.json({ limit: "10mb" }));

// ── POST /api/analyze (formerly analyze-impact) ─────────────────────────────
app.post("/api/analyze", async (req, res) => {
  try {
    const body = req.body as Partial<AnalyzeImpactPayload>;
    const { token, repos, dateFrom, dateTo } = body;

    if (!token || !repos?.length) {
      res.status(400).json({ error: "GitHub token and at least one repo required" });
      return;
    }

    if (!dateFrom || !dateTo || typeof dateFrom !== "string" || typeof dateTo !== "string") {
      res.status(400).json({ error: "dateFrom and dateTo (YYYY-MM-DD) are required" });
      return;
    }

    const rangeCheck = validateAnalysisDateRange(dateFrom, dateTo);
    if (!rangeCheck.ok) {
      res.status(400).json({ error: rangeCheck.error });
      return;
    }

    const since = startOfDayUtcIso(dateFrom);
    const until = endOfDayUtcIso(dateTo);

    console.log(`[API] analyze: ${repos.length} repos, window ${dateFrom}…${dateTo}`);

    const githubService = new GitHubService(token, { since, until });
    const connection = await githubService.validateConnection();
    if (!connection.valid) {
      res.status(401).json({ error: "Invalid GitHub token" });
      return;
    }

    const commitLimit = Math.min(500, Math.max(5, Number(body.commitLimitPerRepo) || 200));

    const data = await githubService.fetchAllRepos(repos, {
      maxCommits: commitLimit,
      skipDetails: false,
    });

    const allow = buildAllowlistSet(body.allowedLogins);
    if (allow) {
      const beforeCommits = data.commits.length;
      data.commits = data.commits.filter((c) => commitMatchesAllowlist(c, allow));
      data.reviews = data.reviews.filter((r) => loginMatchesAllowlist(r.reviewer, allow));
      data.pullRequests = data.pullRequests.filter((p) => loginMatchesAllowlist(p.author, allow));
      const realLeft = data.commits.filter((c) => !c.isMergeCommit).length;
      console.log(
        `[API] allowlist ${allow.size} logins: commits ${beforeCommits} → ${data.commits.length} (${realLeft} non-merge)`,
      );
      if (realLeft === 0) {
        res.status(400).json({
          error:
            "allowedLogins removed all non-merge commits. Include logins that authored commits in this window, widen the list or dates, or omit allowedLogins.",
        });
        return;
      }
    }

    const repoKeys = repos.map((r) => `${r.owner}/${r.repo}`);
    let userId: string | null = null;
    if (isAnalysisDatabaseReady()) {
      userId = tryDeriveUserIdFromToken(token);
      if (userId) {
        try {
          await saveReposFromConfigs(userId, repos);
          await upsertCommitsFromGitHub(userId, data.commits);
          await touchReposLastSynced(userId, repoKeys);
        } catch {
          /* non-fatal */
        }
      }
    }

    const fromBody = body.openrouterApiKey?.trim();
    const openrouterKey = fromBody || getOpenRouterApiKey();
    if (!openrouterKey?.trim()) {
      console.warn(
        "[API] analyze: OPENROUTER_API_KEY is missing on the API server and no openrouterApiKey was sent — AI scores will be empty. Set OPENROUTER_API_KEY in devimpact-backend/.env or pass openrouterApiKey from the client (dev only).",
      );
    }
    const engine = new ScoringEngine(openrouterKey);

    let mergedCache = cloneAnalysisCache(body.analysisCache ?? null);
    if (userId) {
      try {
        const dbCache = await getAIAnalysisForRepos(userId, repos);
        mergedCache = mergeAnalysisCachePreferDatabase(dbCache, mergedCache);
      } catch {
        /* non-fatal */
      }
    }

    console.log(`[API] OpenRouter key loaded: ${!!openrouterKey} (len=${openrouterKey?.length ?? 0})`);
    const { result, analysisCache } = await engine.composeFromMultiRepo(data, {
      analysisCache: mergedCache,
      skipAi: false,
      analysisDbUserId: userId,
    });

    let analysisRunId: string | undefined;
    const databasePersistence = Boolean(userId);
    if (userId) {
      try {
        await persistAiAnalysisAfterRun(userId, result);
      } catch {
        /* non-fatal */
      }
      try {
        const id = await saveAnalysisRun(userId, {
          repoLabels: repos.map((r) => r.label),
          from: dateFrom,
          to: dateTo,
          result,
        });
        if (id) analysisRunId = id;
      } catch {
        /* non-fatal */
      }
    }

    res.json({
      success: true,
      ...result,
      analysisCache,
      analysisWindow: { from: dateFrom, to: dateTo },
      analysisAllowlist: body.allowedLogins?.length ? body.allowedLogins : undefined,
      databasePersistence,
      ...(analysisRunId ? { analysisRunId } : {}),
    });
  } catch (err) {
    console.error("[API] analyze error:", err);
    res.status(500).json({ error: "Analysis failed", details: String(err) });
  }
});

// ── POST /api/load-base ──────────────────────────────────────────────────────
app.post("/api/load-base", async (req, res) => {
  try {
    const body = req.body as Partial<AnalyzeImpactPayload>;
    const { token, repos, dateFrom, dateTo } = body;

    if (!token || !repos?.length) {
      res.status(400).json({ error: "GitHub token and at least one repo required" });
      return;
    }

    if (!dateFrom || !dateTo || typeof dateFrom !== "string" || typeof dateTo !== "string") {
      res.status(400).json({ error: "dateFrom and dateTo (YYYY-MM-DD) are required" });
      return;
    }

    const rangeCheck = validateWideDashboardDateRange(dateFrom, dateTo);
    if (!rangeCheck.ok) {
      res.status(400).json({ error: rangeCheck.error });
      return;
    }

    const since = startOfDayUtcIso(dateFrom);
    const until = endOfDayUtcIso(dateTo);
    const commitLimit = Math.min(10_000, Math.max(10, Number(body.commitLimitPerRepo) || 2500));

    console.log(`[API] load-base: ${repos.length} repos, limit ${commitLimit}/repo`);

    const githubService = new GitHubService(token, { since, until });
    const connection = await githubService.validateConnection();
    if (!connection.valid) {
      res.status(401).json({ error: "Invalid GitHub token" });
      return;
    }

    const ghData = await githubService.fetchAllRepos(repos, {
      maxCommits: commitLimit,
      skipDetails: true,
    });

    const allow = buildAllowlistSet(body.allowedLogins);
    if (allow) {
      const beforeCommits = ghData.commits.length;
      ghData.commits = ghData.commits.filter((c) => commitMatchesAllowlist(c, allow));
      ghData.reviews = ghData.reviews.filter((r) => loginMatchesAllowlist(r.reviewer, allow));
      ghData.pullRequests = ghData.pullRequests.filter((p) => loginMatchesAllowlist(p.author, allow));
      const realLeft = ghData.commits.filter((c) => !c.isMergeCommit).length;
      console.log(
        `[API] load-base allowlist: commits ${beforeCommits} → ${ghData.commits.length} (${realLeft} non-merge)`,
      );
      if (realLeft === 0) {
        res.status(400).json({
          error:
            "allowedLogins removed all non-merge commits. Widen the login list or date range, or omit allowedLogins.",
        });
        return;
      }
    }

    const sinceTs = new Date(since).getTime();
    const untilTs = new Date(until).getTime();
    const repoKeys = repos.map((r) => `${r.owner}/${r.repo}`);
    const repoByKey = new Map<string, (typeof repos)[number]>();
    for (const r of repos) {
      repoByKey.set(`${r.owner}/${r.repo}`, r);
    }

    let userId: string | null = null;
    let repoSyncAt: Record<string, string> = {};
    let commitsDataSource: "github" | "database" = "github";
    let data = ghData;

    if (isAnalysisDatabaseReady()) {
      userId = tryDeriveUserIdFromToken(token);
      if (userId) {
        try {
          await saveReposFromConfigs(userId, repos);
          await upsertCommitsFromGitHub(userId, ghData.commits);
          await touchReposLastSynced(userId, repoKeys);
          repoSyncAt = await getRepoLastSyncedAtMap(userId, repoKeys);
        } catch {
          /* non-fatal */
        }

        try {
          const dbRows = await getCommitsForReposWindow(userId, repoKeys, since, until, commitLimit);
          let mapped = mapDbCommitsToCommitData(dbRows, repoByKey);
          mapped = filterCommitsForWideWindow(mapped, sinceTs, untilTs);
          if (allow) {
            mapped = mapped.filter((c) => commitMatchesAllowlist(c, allow));
          }
          const realLeftDb = mapped.filter((c) => !c.isMergeCommit).length;
          if (mapped.length > 0 && realLeftDb > 0) {
            data = {
              ...ghData,
              commits: mapped,
              fetchedAt: new Date().toISOString(),
            };
            commitsDataSource = "database";
            console.log(`[API] load-base: using ${mapped.length} commits from database`);
          }
        } catch {
          /* non-fatal */
        }
      }
    }

    const fromBody = body.openrouterApiKey?.trim();
    const openrouterKey = fromBody || getOpenRouterApiKey();
    const engine = new ScoringEngine(openrouterKey);

    let mergedCache = cloneAnalysisCache(body.analysisCache ?? null);
    const databasePersistence = Boolean(userId);
    if (userId) {
      try {
        const dbCache = await getAIAnalysisForRepos(userId, repos);
        mergedCache = mergeAnalysisCachePreferDatabase(dbCache, mergedCache);
      } catch {
        /* non-fatal */
      }
    }

    const { result, analysisCache } = await engine.composeFromMultiRepo(data, {
      analysisCache: mergedCache,
      skipAi: true,
    });

    res.json({
      success: true,
      ...result,
      analysisCache,
      analysisWindow: { from: dateFrom, to: dateTo },
      analysisAllowlist: body.allowedLogins?.length ? body.allowedLogins : undefined,
      databasePersistence,
      repoSyncAt,
      commitsDataSource,
    });
  } catch (err) {
    console.error("[API] load-base error:", err);
    res.status(500).json({ error: "Failed to load GitHub data", details: String(err) });
  }
});

// ── POST /api/commits/notifications ─────────────────────────────────────────
app.post("/api/commits/notifications", async (req, res) => {
  try {
    if (!isAnalysisDbConfigured()) {
      res.json({ enabled: false, commits: [] });
      return;
    }

    const body = req.body as {
      token?: string;
      sinceIso?: string;
      lastKnownAiBatchVersion?: number;
    };
    const token = body.token?.trim();
    if (!token) {
      res.status(400).json({ error: "token required" });
      return;
    }

    const userId = tryDeriveUserIdFromToken(token);
    if (!userId) {
      res.status(503).json({ error: "USER_ID_PEPPER not configured" });
      return;
    }

    const sinceIso =
      typeof body.sinceIso === "string" && body.sinceIso.trim()
        ? body.sinceIso.trim()
        : new Date(0).toISOString();

    const commits = await listCommitsIngestedSince(userId, sinceIso, 50);
    const queue = await getTenantAiQueue(userId);
    const aiBatchVersion = queue?.ai_batch_version ?? 0;
    const lastKnown =
      typeof body.lastKnownAiBatchVersion === "number" && Number.isFinite(body.lastKnownAiBatchVersion)
        ? body.lastKnownAiBatchVersion
        : -1;

    const analysisVersionBumped = lastKnown >= 0 && aiBatchVersion > lastKnown;

    res.json({
      enabled: true,
      commits,
      aiBatchVersion,
      analysisVersionBumped,
    });
  } catch (e) {
    console.error("[commits/notifications]", e);
    res.status(500).json({ error: "Request failed" });
  }
});

// ── GET /api/analysis/settings ───────────────────────────────────────────────
app.get("/api/analysis/settings", (_req, res) => {
  res.json({
    databasePersistenceEnabled: isAnalysisDbConfigured(),
    openRouterConfigured: Boolean(getOpenRouterApiKey()?.trim()),
  });
});

// ── POST /api/analysis/ai-cache ─────────────────────────────────────────────
app.post("/api/analysis/ai-cache", async (req, res) => {
  try {
    const body = req.body as Partial<Pick<AnalyzeImpactPayload, "token" | "repos">>;
    const token = body.token?.trim();
    const repos = body.repos;
    if (!token || !repos?.length) {
      res.status(400).json({ error: "token and repos required" });
      return;
    }
    if (!isAnalysisDatabaseReady()) {
      res.json({
        enabled: false,
        analysisCache: emptyAnalysisCache(),
      });
      return;
    }
    const userId = tryDeriveUserIdFromToken(token);
    if (!userId) {
      res.json({
        enabled: false,
        analysisCache: emptyAnalysisCache(),
      });
      return;
    }
    const analysisCache = await getAIAnalysisForRepos(userId, repos);
    res.json({ enabled: true, analysisCache });
  } catch (e) {
    console.error("[API] analysis/ai-cache:", e);
    res.status(500).json({ error: "Failed to load cache" });
  }
});

// ── POST /api/analysis/runs/list ─────────────────────────────────────────────
app.post("/api/analysis/runs/list", async (req, res) => {
  try {
    const body = req.body as { token?: string };
    const token = body.token?.trim();
    if (!token) {
      res.status(400).json({ error: "token required" });
      return;
    }
    if (!isAnalysisDatabaseReady()) {
      res.json({ enabled: false, runs: [] });
      return;
    }
    const userId = tryDeriveUserIdFromToken(token);
    if (!userId) {
      res.json({ enabled: false, runs: [] });
      return;
    }
    const runs = await getAnalysisHistory(userId, 24);
    res.json({ enabled: true, runs });
  } catch (e) {
    console.error("[API] analysis/runs/list:", e);
    res.status(500).json({ error: "Failed to list runs" });
  }
});

// ── POST /api/analysis/runs/restore ──────────────────────────────────────────
app.post("/api/analysis/runs/restore", async (req, res) => {
  try {
    const body = req.body as { token?: string; runId?: string };
    const token = body.token?.trim();
    const runId = body.runId?.trim();
    if (!token || !runId) {
      res.status(400).json({ error: "token and runId required" });
      return;
    }
    if (!isAnalysisDatabaseReady()) {
      res.status(400).json({ success: false, error: "Database persistence disabled" });
      return;
    }
    const userId = tryDeriveUserIdFromToken(token);
    if (!userId) {
      res.status(400).json({ success: false, error: "Invalid persistence config" });
      return;
    }
    const result = await getAnalysisRunSnapshotForUser(userId, runId);
    if (!result) {
      res.status(404).json({ success: false, error: "Run not found" });
      return;
    }
    res.json({ success: true, result });
  } catch (e) {
    console.error("[API] analysis/runs/restore:", e);
    res.status(500).json({ success: false, error: "Restore failed" });
  }
});

// ── POST /api/data/repos-sync-status ─────────────────────────────────────────
app.post("/api/data/repos-sync-status", async (req, res) => {
  try {
    const body = req.body as { token?: string; repos?: RepoConfig[] };
    const token = body.token?.trim();
    const repos = body.repos;
    if (!token || !repos?.length) {
      res.status(400).json({ error: "token and repos required" });
      return;
    }
    if (!isAnalysisDbConfigured()) {
      res.json({ enabled: false, syncAt: {} });
      return;
    }
    const userId = getUserId(token);
    if (!userId) {
      res.json({ enabled: false, syncAt: {} });
      return;
    }
    const keys = repos.map((r) => `${r.owner}/${r.repo}`);
    const syncAt = await getRepoLastSyncedAtMap(userId, keys);
    res.json({ enabled: true, syncAt });
  } catch (e) {
    console.error("[API] repos-sync-status:", e);
    res.status(500).json({ error: "Failed to load sync status" });
  }
});

// ── GitHub helper routes (Octokit) ───────────────────────────────────────────

export type ListedRepo = {
  owner: string;
  repo: string;
  fullName: string;
  description: string | null;
  private: boolean;
  htmlUrl: string;
  defaultBranch: string;
};

app.post("/api/github/list-repos", async (req, res) => {
  try {
    const raw = (req.body as { token?: string }).token;

    if (!raw?.trim()) {
      res.status(400).json({ error: "GitHub token is required" });
      return;
    }

    const authToken = normalizeUserPat(raw);
    const octokit = createOctokitForUserPat(authToken);

    const { data: user } = await octokit.users.getAuthenticated();

    const all: ListedRepo[] = await listReposForAuthenticatedUserPat(octokit);

    if (isAnalysisDbConfigured()) {
      const uid = getUserId(authToken);
      if (uid) {
        void upsertGitHubAccount(uid, {
          githubUserId: user.id,
          login: user.login,
          avatarUrl: user.avatar_url ?? null,
        });
        console.log(`[list-repos] Saving ${all.length} repos to Supabase for tenant ${uid.slice(0, 12)}…`);
        try {
          for (const r of all) {
            await saveRepo(uid, {
              name: r.repo,
              full_name: r.fullName,
              private: r.private,
            });
          }
        } catch (e) {
          console.error("[list-repos] saveRepo loop failed:", e);
        }
      } else {
        console.warn(
          "[list-repos] getUserId returned null — ensure USER_ID_PEPPER is set (required to hash PAT).",
        );
      }
    } else {
      console.warn("[list-repos] Supabase persistence disabled:", explainDbWriteSkip());
    }

    res.json({
      success: true,
      login: user.login,
      repos: all,
      total: all.length,
    });
  } catch (err: unknown) {
    console.error("[API] list-repos:", err);
    const { httpStatus, message } = githubApiClientMessage(err);
    res.status(httpStatus).json({ error: message });
  }
});

app.post("/api/github/connect", async (req, res) => {
  try {
    const { token, repos } = req.body as {
      token: string;
      repos: RepoConfig[];
    };

    if (!token) {
      res.status(400).json({ error: "GitHub token is required" });
      return;
    }

    const githubService = new GitHubService(token, {
      since: new Date(0).toISOString(),
      until: new Date().toISOString(),
    });
    const connection = await githubService.validateConnection();

    if (!connection.valid) {
      res.status(401).json({ error: "Invalid GitHub token" });
      return;
    }

    if (isAnalysisDbConfigured() && repos?.length) {
      const uid = getUserId(token);
      if (uid) {
        try {
          await saveReposFromConfigs(uid, repos);
        } catch {
          /* non-fatal */
        }
      }
    }

    res.json({
      success: true,
      data: {
        user: connection.user,
        repos: repos?.length ?? 0,
        message: `Connected as ${connection.user}. ${repos?.length ?? 0} repos configured.`,
      },
    });
  } catch {
    res.status(500).json({ error: "Connection failed" });
  }
});

app.post("/api/github/org-map", async (req, res) => {
  try {
    if (!isAnalysisDbConfigured()) {
      res.status(503).json({ error: "Database not configured" });
      return;
    }

    const body = req.body as {
      token?: string;
      orgLogin?: string;
      note?: string;
    };
    const token = body.token?.trim();
    const orgLogin = body.orgLogin?.trim().toLowerCase();
    if (!token || !orgLogin) {
      res.status(400).json({ error: "token and orgLogin required" });
      return;
    }

    const userId = tryDeriveUserIdFromToken(token);
    if (!userId) {
      res.status(503).json({ error: "USER_ID_PEPPER not configured" });
      return;
    }

    const gh = new GitHubService(token, {
      since: new Date(0).toISOString(),
      until: new Date().toISOString(),
    });
    const conn = await gh.validateConnection();
    if (!conn.valid) {
      res.status(401).json({ error: "Invalid GitHub token" });
      return;
    }

    const ok = await upsertOrgTenantMap(orgLogin, userId, body.note ?? null);
    if (!ok) {
      res.status(500).json({ error: "Failed to save mapping" });
      return;
    }

    res.json({
      success: true,
      orgLogin,
      userIdPrefix: userId.slice(0, 12),
    });
  } catch (e) {
    console.error("[org-map]", e);
    res.status(500).json({ error: "Request failed" });
  }
});

const BOT = /\[bot\]|dependabot|renovate|github-actions/i;

app.post("/api/github/repo-contributors", async (req, res) => {
  try {
    const body = req.body as { token?: string; repos?: RepoConfig[] };
    const token = body.token?.trim();
    const repos = body.repos;

    if (!token || !repos?.length) {
      res.status(400).json({ error: "token and repos[] required" });
      return;
    }

    const octokit = createOctokitForUserPat(token);
    const byLogin = new Map<
      string,
      { login: string; avatar_url: string; html_url: string | null; contributions: number }
    >();
    const warnings: string[] = [];

    for (const r of repos) {
      if (!r.owner?.trim() || !r.repo?.trim()) continue;
      let page = 1;
      const perPage = 100;

      try {
        while (true) {
          const { data } = await octokit.repos.listContributors({
            owner: r.owner,
            repo: r.repo,
            per_page: perPage,
            page,
          });

          for (const row of data) {
            const login = row.login;
            if (!login || BOT.test(login)) continue;
            const key = login.toLowerCase();
            const prev = byLogin.get(key);
            const add = row.contributions ?? 0;
            if (!prev) {
              byLogin.set(key, {
                login,
                avatar_url: row.avatar_url ?? `https://github.com/${login}.png`,
                html_url: row.html_url ?? null,
                contributions: add,
              });
            } else {
              prev.contributions += add;
            }
          }

          if (data.length < perPage) break;
          page += 1;
        }
      } catch (err: unknown) {
        const msg =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: string }).message)
            : "unknown error";
        const status =
          err && typeof err === "object" && "status" in err
            ? Number((err as { status: number }).status)
            : 0;
        warnings.push(`${r.owner}/${r.repo} (${status || "?"}): ${msg}`);
      }
    }

    const members = [...byLogin.values()].sort((a, b) => b.contributions - a.contributions);

    if (members.length === 0 && warnings.length > 0) {
      res.status(502).json({
        success: false,
        error:
          "Could not list contributors for any repository. Ensure the token has repo scope and can read the selected repos.",
        warnings,
      });
      return;
    }

    res.json({
      success: true,
      members,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  } catch (err) {
    console.error("[API] repo-contributors:", err);
    res.status(500).json({ error: "Failed to load contributors" });
  }
});

app.post("/api/github/repo-collaborators", async (req, res) => {
  try {
    const body = req.body as { token?: string; repos?: RepoConfig[] };
    const token = body.token?.trim();
    const repos = body.repos;

    if (!token || !repos?.length) {
      res.status(400).json({ error: "token and repos[] required" });
      return;
    }

    const octokit = createOctokitForUserPat(token);
    const byLogin = new Map<string, { login: string; avatar_url: string; html_url: string | null }>();
    const warnings: string[] = [];

    for (const r of repos) {
      if (!r.owner?.trim() || !r.repo?.trim()) continue;
      let page = 1;
      const perPage = 100;

      try {
        while (true) {
          const { data } = await octokit.repos.listCollaborators({
            owner: r.owner,
            repo: r.repo,
            affiliation: "all",
            per_page: perPage,
            page,
          });

          for (const u of data) {
            const login = u.login;
            if (!login || BOT.test(login)) continue;
            const key = login.toLowerCase();
            if (!byLogin.has(key)) {
              byLogin.set(key, {
                login,
                avatar_url: u.avatar_url,
                html_url: u.html_url ?? null,
              });
            }
          }

          if (data.length < perPage) break;
          page += 1;
        }
      } catch (err: unknown) {
        const msg =
          err && typeof err === "object" && "message" in err
            ? String((err as { message: string }).message)
            : "unknown error";
        const status =
          err && typeof err === "object" && "status" in err
            ? Number((err as { status: number }).status)
            : 0;
        warnings.push(`${r.owner}/${r.repo} (${status || "?"}): ${msg}`);
      }
    }

    const members = [...byLogin.values()].sort((a, b) => a.login.localeCompare(b.login));

    if (members.length === 0 && warnings.length > 0) {
      res.status(502).json({
        success: false,
        error:
          "Could not list collaborators for any repository. Your token needs repo access; listing collaborators may require admin on the repo.",
        warnings,
      });
      return;
    }

    res.json({
      success: true,
      members,
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  } catch (err) {
    console.error("[API] repo-collaborators:", err);
    res.status(500).json({ error: "Failed to load collaborators" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
