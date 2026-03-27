import {
  batchUpsertAiAnalysis,
  getCachedAnalysisForRepo,
  isAnalysisDbConfigured,
  saveAnalysis,
} from "./db";
import type {
  CommitData,
  AICommitAnalysis,
  AnalyzedCommit,
  ContributionType,
  ImpactLevel,
} from "./types";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const MODELS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
  "qwen/qwen3-4b:free",
  "openrouter/free",
  "google/gemini-2.0-flash-001",
  "deepseek/deepseek-chat",
] as const;

function analysisModelOrder(): string[] {
  const primary = process.env.OPENROUTER_ANALYSIS_MODEL?.trim();
  if (primary) {
    const rest = [...MODELS].filter((m) => m !== primary);
    return [primary, ...rest];
  }
  return [...MODELS];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function modelSupportsSeed(model: string): boolean {
  if (model.includes(":free") || model === "openrouter/free") return false;
  return true;
}

function deterministicSeedFromSha(sha: string): number {
  let h = 2166136261;
  for (let i = 0; i < sha.length; i++) {
    h ^= sha.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 42;
}

/** Stable key for multi-repo batches (sha alone can theoretically collide across forks). */
function commitKey(c: CommitData): string {
  return `${c.repo}:${c.sha}`;
}

function aiBatchSize(): number {
  const n = Number.parseInt(process.env.OPENROUTER_AI_BATCH_SIZE ?? "4", 10);
  if (!Number.isFinite(n)) return 4;
  return Math.max(1, Math.min(8, n));
}

function aiBatchMaxTokens(commitCount: number): number {
  const fromEnv = Number.parseInt(process.env.OPENROUTER_AI_BATCH_MAX_TOKENS ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv >= 512) {
    return Math.min(16_000, fromEnv);
  }
  return Math.min(12_000, 800 + commitCount * 520);
}

const DIFF_MAX_SINGLE = 4500;
const DIFF_MAX_BATCH = 2200;

export type AIBatchDiagnostics = {
  openrouterConfigured: boolean;
  commitsEligible: number;
  commitsWithAnalysis: number;
  modelCallFailures: number;
  recentErrors: string[];
};

const SYSTEM_PROMPT = `You are a staff+ engineer performing a rigorous, evidence-based review of exactly ONE Git commit.

INPUTS (order of trust): (1) unified diff, (2) file paths/extensions, (3) full commit message, (4) line stats (weak).

You MUST produce explicit audit-style output so humans understand WHY a score was chosen.

TYPE RULES (strict): feature | bug_fix | refactor | test | chore — same definitions as before: user-visible behavior vs fix vs internal vs tests-only vs noise.

IMPACT_LEVEL vs business_impact_score (1–100), aligned:
- critical 85–100, high 70–84, medium 40–69, low 1–39 (security/data/payments can be high despite small diff).

REQUIRED JSON FIELDS (all mandatory, use arrays of short strings):
- type, impact_level, business_impact_score
- reasoning: 2–4 sentences — what changed, key evidence from paths/diff
- parameters_considered: 4–8 bullets you actually weighed (e.g. "correctness of payload to backend", "user-visible form submit path", "type contract FE/BE", "regression risk", "repo role frontend/backend/erp")
- score_justification: 3–6 sentences that EXPLICITLY tie the numeric business_impact_score to those parameters (e.g. "Score 60 because … not 80 because …"). Mention tradeoffs.
- affected_modules_and_flows: 3–10 items naming concrete modules, routes, APIs, screens, jobs, or user journeys touched or downstream (infer from paths if needed)

If diff is missing: state uncertainty in score_justification; cap score at 72 unless message implies outage/security/data loss.

Determinism: Same evidence should yield the same type, impact_level, and business_impact_score band. Do not randomize. The AUTHOR line may be an unlinked local git name — judge only the code/message; never use author identity to raise or lower the score.

OUTPUT: ONE raw JSON object only — no markdown fences, no extra keys:
{"type":"...","impact_level":"...","business_impact_score":<int>,"reasoning":"...","parameters_considered":["..."],"score_justification":"...","affected_modules_and_flows":["..."]}`;

const BATCH_SYSTEM_PROMPT = `You are a staff+ engineer. You will receive MULTIPLE Git commits, each in a clearly marked block with sha and repo.

For EACH commit, produce ONE JSON object with the SAME schema as a single-commit review (all fields mandatory):
- type, impact_level, business_impact_score, reasoning, parameters_considered (array of strings), score_justification, affected_modules_and_flows (array of strings)

Rules match single-commit review: types feature|bug_fix|refactor|test|chore; impact_level low|medium|high|critical; score bands aligned with impact; judge only code/message (not author identity); if diff is missing cap score at 72 unless message implies critical risk.

Every object MUST include "sha" (full git sha) and "repo" (owner/repo string exactly as given in the block header) so outputs can be matched.

OUTPUT: ONE raw JSON array only — no markdown fences, no prose outside the array.
Example shape:
[{"sha":"abc...","repo":"org/name","type":"bug_fix",...}, {"sha":"def...","repo":"org/name",...}]`;

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : trimmed;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return body.slice(start, end + 1);
}

function extractJsonArray(text: string): string | null {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : trimmed;
  const start = body.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\" && inStr) {
      esc = true;
      continue;
    }
    if (ch === '"' && !esc) {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

function alignScoreToImpact(score: number, level: ImpactLevel): number {
  const bands: Record<ImpactLevel, [number, number]> = {
    critical: [85, 100],
    high: [70, 84],
    medium: [40, 69],
    low: [1, 39],
  };
  const [min, max] = bands[level];
  return Math.min(max, Math.max(min, Math.round(score)));
}

function asStringArray(v: unknown, max = 14): string[] {
  if (Array.isArray(v)) {
    return v.map((x) => String(x).trim()).filter(Boolean).slice(0, max);
  }
  if (typeof v === "string" && v.trim()) {
    return v
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, max);
  }
  return [];
}

const REPO_CONTEXT: Record<string, string> = {
  frontend:
    "Repo role: CUSTOMER-FACING FRONTEND. Weight UX, accessibility, performance perceived by users, and broken flows.",
  backend:
    "Repo role: BACKEND / APIs / services. Weight correctness, security, data integrity, scalability, and blast radius.",
  erp: "Repo role: ERP / ADMIN / internal ops. Weight operational risk, reporting accuracy, permissions, and business process breakage.",
};

function buildCommitBlock(commit: CommitData, diffMax: number): string {
  const diffSection = commit.diff
    ? `\nCODE DIFF (truncated):\n${commit.diff.substring(0, diffMax)}`
    : "\nCODE DIFF: (not available — infer from message and paths; widen uncertainty.)";

  const paths =
    commit.filesChanged.length > 0
      ? commit.filesChanged.slice(0, 40).join("\n")
      : "(unknown — list not fetched)";

  return `### COMMIT
sha: ${commit.sha}
repo: ${commit.repo}
label: "${commit.repoLabel}" (${commit.repoType})
${REPO_CONTEXT[commit.repoType] ?? REPO_CONTEXT.backend}

FIRST LINE: ${commit.message.split("\n")[0].slice(0, 240)}
MESSAGE (truncated):
${commit.message.slice(0, 1200)}

AUTHOR: ${commit.author}
LINE STATS: +${commit.additions} / -${commit.deletions}

FILES:
${paths}
${diffSection}
---`;
}

/**
 * Normalize OpenRouter JSON fields into AICommitAnalysis (shared by single + batch items).
 */
function normalizeParsedAnalysis(
  parsed: Record<string, unknown>,
  commit: CommitData,
): AICommitAnalysis {
  const validTypes: ContributionType[] = ["feature", "bug_fix", "refactor", "test", "chore"];
  const validImpacts: ImpactLevel[] = ["low", "medium", "high", "critical"];

  const rawType = String(parsed.type ?? "").replace(/\s/g, "_").toLowerCase();
  const normalizedType = rawType === "bugfix" ? "bug_fix" : rawType;
  const type = validTypes.includes(normalizedType as ContributionType)
    ? (normalizedType as ContributionType)
    : "chore";

  const il = String(parsed.impact_level ?? "medium").toLowerCase();
  const impact_level = validImpacts.includes(il as ImpactLevel) ? (il as ImpactLevel) : "medium";

  const scoreRaw = Number(parsed.business_impact_score);
  const rawScore = Number.isFinite(scoreRaw)
    ? Math.min(100, Math.max(1, Math.round(scoreRaw)))
    : 35;
  const alignedScore = alignScoreToImpact(rawScore, impact_level);

  const reasoning = String(parsed.reasoning ?? "").trim().slice(0, 900);
  const scoreJust = String(
    parsed.score_justification ?? parsed.score_rationale ?? reasoning,
  )
    .trim()
    .slice(0, 1400);
  const params = asStringArray(parsed.parameters_considered);
  const flows = asStringArray(parsed.affected_modules_and_flows);

  return {
    type,
    impact_level,
    business_impact_score: alignedScore,
    reasoning: reasoning || scoreJust.slice(0, 400),
    parameters_considered:
      params.length > 0
        ? params
        : ["change type & intent", "evidence from message/paths", "user/system blast radius"],
    score_justification:
      scoreJust ||
      `${alignedScore}/100 aligns with ${impact_level} impact for a ${type} change; see reasoning.`,
    affected_modules_and_flows:
      flows.length > 0
        ? flows
        : commit.filesChanged.length > 0
          ? commit.filesChanged.slice(0, 6).map((f) => `Touched: ${f}`)
          : ["Unable to infer modules — no paths in payload"],
  };
}

function batchSeedFromCommits(commits: CommitData[]): number {
  let h = 2166136261;
  for (const c of commits) {
    for (let i = 0; i < c.sha.length; i++) {
      h ^= c.sha.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return (h >>> 0) || 42;
}

export class AIAnalyzer {
  private apiKey: string | null;
  lastBatchDiagnostics: AIBatchDiagnostics;

  constructor(apiKey?: string) {
    this.apiKey = apiKey?.trim() || null;
    this.lastBatchDiagnostics = {
      openrouterConfigured: false,
      commitsEligible: 0,
      commitsWithAnalysis: 0,
      modelCallFailures: 0,
      recentErrors: [],
    };
  }

  get isAIPowered(): boolean {
    return this.apiKey !== null;
  }

  get modelNames(): string[] {
    return [...MODELS];
  }

  private pushError(msg: string) {
    const short = msg.replace(/\s+/g, " ").slice(0, 180);
    if (!this.lastBatchDiagnostics.recentErrors.includes(short)) {
      this.lastBatchDiagnostics.recentErrors.push(short);
    }
    if (this.lastBatchDiagnostics.recentErrors.length > 8) {
      this.lastBatchDiagnostics.recentErrors.shift();
    }
  }

  /**
   * Analyze only non-merge commits (order preserved vs input).
   * Uses batched OpenRouter calls (chunk size OPENROUTER_AI_BATCH_SIZE), with per-commit fallback.
   */
  async analyzeCommitsSubset(
    realCommits: CommitData[],
    analysisDbUserId?: string | null,
  ): Promise<AnalyzedCommit[]> {
    this.lastBatchDiagnostics = {
      openrouterConfigured: !!this.apiKey,
      commitsEligible: realCommits.length,
      commitsWithAnalysis: 0,
      modelCallFailures: 0,
      recentErrors: [],
    };

    const K = aiBatchSize();
    console.log(
      `[AI] Subset: ${realCommits.length} commits (key: ${this.apiKey ? "yes" : "no"}, batchSize=${K})`,
    );

    const pacingMs = Math.max(
      0,
      Number.parseInt(process.env.OPENROUTER_COMMIT_DELAY_MS ?? "180", 10) || 0,
    );

    const useDb = Boolean(analysisDbUserId?.trim()) && isAnalysisDbConfigured();

    type Slot =
      | { kind: "done"; analyzed: AnalyzedCommit }
      | { kind: "ai"; commit: CommitData };

    const slots: Slot[] = [];

    for (let i = 0; i < realCommits.length; i++) {
      const commit = realCommits[i];
      if (!this.apiKey) {
        slots.push({ kind: "done", analyzed: this.toAnalyzedCommit(commit, null, "none") });
        continue;
      }

      if (useDb && analysisDbUserId) {
        try {
          const cached = await getCachedAnalysisForRepo(analysisDbUserId, commit.repo, commit.sha);
          if (cached?.full_analysis) {
            slots.push({
              kind: "done",
              analyzed: this.toAnalyzedCommit(
                commit,
                cached.full_analysis,
                cached.model_used ?? "cache",
              ),
            });
            this.lastBatchDiagnostics.commitsWithAnalysis += 1;
            continue;
          }
        } catch {
          /* fall through */
        }
      }

      slots.push({ kind: "ai", commit });
    }

    const aiSlots = slots
      .map((s, idx) => ({ s, idx }))
      .filter((x): x is { s: { kind: "ai"; commit: CommitData }; idx: number } => x.s.kind === "ai");

    for (let c = 0; c < aiSlots.length; c += K) {
      const sliceMeta = aiSlots.slice(c, c + K);
      const chunk = sliceMeta.map((x) => x.s.commit);
      const indexByKey = new Map<string, number>();
      for (const { s, idx } of sliceMeta) {
        indexByKey.set(commitKey(s.commit), idx);
      }

      const resolved = new Map<
        string,
        { analysis: AICommitAnalysis; modelUsed: string; viaBatch: boolean }
      >();

      for (const model of analysisModelOrder()) {
        const need = chunk.filter((cm) => !resolved.has(commitKey(cm)));
        if (need.length === 0) break;

        const batchMap =
          need.length > 1
            ? await this.callModelBatch(model, need)
            : await this.callModelSingleAsMap(model, need[0]);
        if (batchMap) {
          for (const cm of need) {
            const a = batchMap.get(commitKey(cm));
            if (a) {
              resolved.set(commitKey(cm), { analysis: a, modelUsed: model, viaBatch: need.length > 1 });
            }
          }
        }
      }

      for (const cm of chunk) {
        const key = commitKey(cm);
        if (resolved.has(key)) continue;

        for (const model of analysisModelOrder()) {
          const analysis = await this.callModel(model, cm);
          if (analysis) {
            resolved.set(key, { analysis, modelUsed: model, viaBatch: false });
            break;
          }
        }
      }

      if (useDb && analysisDbUserId) {
        const batchRows: {
          repo: string;
          sha: string;
          impact_score: number | null;
          type: string | null;
          summary: string | null;
          full_analysis: AICommitAnalysis;
          model_used: string;
        }[] = [];

        for (const cm of chunk) {
          const r = resolved.get(commitKey(cm));
          if (!r?.analysis) continue;
          if (r.viaBatch) {
            batchRows.push({
              repo: cm.repo,
              sha: cm.sha,
              impact_score: r.analysis.business_impact_score,
              type: r.analysis.type,
              summary: r.analysis.reasoning.slice(0, 2000),
              full_analysis: r.analysis,
              model_used: r.modelUsed,
            });
          } else {
            try {
              await saveAnalysis(
                analysisDbUserId,
                cm.repo,
                cm.sha,
                r.analysis.business_impact_score,
                r.analysis.type,
                r.analysis.reasoning.slice(0, 2000),
                r.analysis,
                r.modelUsed,
              );
            } catch {
              /* non-fatal */
            }
          }
        }

        if (batchRows.length > 0) {
          try {
            await batchUpsertAiAnalysis(analysisDbUserId, batchRows);
          } catch {
            /* non-fatal */
          }
        }
      }

      for (const cm of chunk) {
        const r = resolved.get(commitKey(cm));
        const analyzed = this.toAnalyzedCommit(cm, r?.analysis ?? null, r?.modelUsed ?? "none");
        const slotIdx = indexByKey.get(commitKey(cm));
        if (slotIdx !== undefined) {
          slots[slotIdx] = { kind: "done", analyzed };
        }
        if (r?.analysis) {
          this.lastBatchDiagnostics.commitsWithAnalysis += 1;
        }
      }

      if (pacingMs > 0 && c + K < aiSlots.length) {
        await sleep(pacingMs);
      }
    }

    const analyzed: AnalyzedCommit[] = slots.map((s) =>
      s.kind === "done" ? s.analyzed : this.toAnalyzedCommit(s.commit, null, "none"),
    );

    console.log(
      `[AI] Subset done: ${this.lastBatchDiagnostics.commitsWithAnalysis}/${this.lastBatchDiagnostics.commitsEligible} with analysis; ${this.lastBatchDiagnostics.modelCallFailures} failed model calls`,
    );
    return analyzed;
  }

  async analyzeAllCommits(commits: CommitData[]): Promise<AnalyzedCommit[]> {
    const realCommits = commits.filter((c) => !c.isMergeCommit);
    const analyzedReals = await this.analyzeCommitsSubset(realCommits);
    const bySha = new Map(analyzedReals.map((a) => [a.sha, a]));
    return commits.map((c) =>
      c.isMergeCommit
        ? this.toAnalyzedCommit(c, null, "skipped")
        : (bySha.get(c.sha) as AnalyzedCommit),
    );
  }

  /** Single-commit path wrapped as Map for unified batch/fallback flow. */
  private async callModelSingleAsMap(
    model: string,
    commit: CommitData,
  ): Promise<Map<string, AICommitAnalysis> | null> {
    const a = await this.callModel(model, commit);
    if (!a) return null;
    return new Map([[commitKey(commit), a]]);
  }

  private async callModelBatch(
    model: string,
    commits: CommitData[],
  ): Promise<Map<string, AICommitAnalysis> | null> {
    if (!this.apiKey || commits.length === 0) return null;

    const userPrompt = `${commits.map((c) => buildCommitBlock(c, DIFF_MAX_BATCH)).join("\n\n")}

Return one JSON array with ${commits.length} objects, one per commit above. Each object must include "sha", "repo", and all analysis fields.`;

    try {
      console.log(
        `[AI] ${model} batch → ${commits.length} commits (${commits.map((c) => c.sha.slice(0, 7)).join(", ")})`,
      );

      const maxTokens = aiBatchMaxTokens(commits.length);
      const baseBody: Record<string, unknown> = {
        model,
        messages: [
          { role: "system", content: BATCH_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
        max_tokens: maxTokens,
      };
      if (modelSupportsSeed(model)) {
        baseBody.seed = batchSeedFromCommits(commits);
      }

      const doFetch = () =>
        fetch(OPENROUTER_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER || "https://localhost:3000",
            "X-Title": "DevImpact AI",
          },
          body: JSON.stringify(baseBody),
        });

      let res = await doFetch();
      if (res.status === 429) {
        const retryAfter = 2200;
        console.log(`[AI] ${model} batch HTTP 429 — retry once after ${retryAfter}ms`);
        await sleep(retryAfter);
        res = await doFetch();
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        this.lastBatchDiagnostics.modelCallFailures += 1;
        this.pushError(`${model} batch HTTP ${res.status}: ${errBody.slice(0, 120)}`);
        console.log(`[AI] ${model} batch HTTP ${res.status}: ${errBody.slice(0, 200)}`);
        return null;
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      const jsonStr = extractJsonArray(content);
      if (!jsonStr) {
        this.lastBatchDiagnostics.modelCallFailures += 1;
        this.pushError(`${model} batch: no JSON array`);
        console.log(`[AI] ${model} batch parse: no array, raw=${content.slice(0, 160)}...`);
        return null;
      }

      let arr: unknown[];
      try {
        arr = JSON.parse(jsonStr) as unknown[];
      } catch {
        this.lastBatchDiagnostics.modelCallFailures += 1;
        this.pushError(`${model} batch: JSON.parse array failed`);
        return null;
      }
      if (!Array.isArray(arr)) {
        this.lastBatchDiagnostics.modelCallFailures += 1;
        this.pushError(`${model} batch: root not array`);
        return null;
      }

      const out = new Map<string, AICommitAnalysis>();
      for (const raw of arr) {
        if (!raw || typeof raw !== "object") continue;
        const item = raw as Record<string, unknown>;
        const sha = String(item.sha ?? "").trim();
        const repo = String(item.repo ?? "").trim();
        if (!sha) continue;

        const commit =
          repo ?
            commits.find((c) => c.sha === sha && c.repo === repo)
          : commits.filter((c) => c.sha === sha).length === 1 ?
            commits.find((c) => c.sha === sha)
          : undefined;
        if (!commit) continue;

        const { sha: _s, repo: _r, ...rest } = item;
        const analysis = normalizeParsedAnalysis(rest as Record<string, unknown>, commit);
        out.set(commitKey(commit), analysis);
      }

      console.log(`[AI] ${model} batch OK: parsed ${out.size}/${commits.length} commits`);
      return out;
    } catch (err) {
      this.lastBatchDiagnostics.modelCallFailures += 1;
      this.pushError(`${model} batch: ${err instanceof Error ? err.message : "unknown"}`);
      console.log(`[AI] ${model} batch error: ${err instanceof Error ? err.message : "unknown"}`);
      return null;
    }
  }

  private async callModel(model: string, commit: CommitData): Promise<AICommitAnalysis | null> {
    const userPrompt = `${buildCommitBlock(commit, DIFF_MAX_SINGLE)}

Return the JSON object now.`;

    try {
      console.log(`[AI] ${model} → ${commit.sha.slice(0, 7)} (${commit.repoLabel})`);

      const baseBody: Record<string, unknown> = {
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 1400,
      };
      if (modelSupportsSeed(model)) {
        baseBody.seed = deterministicSeedFromSha(commit.sha);
      }

      const doFetch = () =>
        fetch(OPENROUTER_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER || "https://localhost:3000",
            "X-Title": "DevImpact AI",
          },
          body: JSON.stringify(baseBody),
        });

      let res = await doFetch();

      if (res.status === 429) {
        const retryAfter = 2200;
        console.log(`[AI] ${model} HTTP 429 — retry once after ${retryAfter}ms`);
        await sleep(retryAfter);
        res = await doFetch();
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        this.lastBatchDiagnostics.modelCallFailures += 1;
        this.pushError(`${model} HTTP ${res.status}: ${errBody.slice(0, 120)}`);
        console.log(`[AI] ${model} HTTP ${res.status}: ${errBody.slice(0, 200)}`);
        return null;
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      const jsonStr = extractJsonObject(content);
      if (!jsonStr) {
        this.lastBatchDiagnostics.modelCallFailures += 1;
        this.pushError(`${model}: no JSON in model output`);
        console.log(`[AI] ${model} parse: no JSON, raw=${content.slice(0, 120)}...`);
        return null;
      }

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(jsonStr) as Record<string, unknown>;
      } catch {
        this.lastBatchDiagnostics.modelCallFailures += 1;
        this.pushError(`${model}: JSON.parse failed`);
        return null;
      }

      const result = normalizeParsedAnalysis(parsed, commit);

      console.log(
        `[AI] ${model} OK ${commit.sha.slice(0, 7)}: ${result.type}/${result.impact_level} (${result.business_impact_score})`,
      );
      return result;
    } catch (err) {
      this.lastBatchDiagnostics.modelCallFailures += 1;
      this.pushError(`${model}: ${err instanceof Error ? err.message : "unknown"}`);
      console.log(`[AI] ${model} error: ${err instanceof Error ? err.message : "unknown"}`);
      return null;
    }
  }

  toAnalyzedCommit(
    commit: CommitData,
    analysis: AICommitAnalysis | null,
    modelUsed: string,
  ): AnalyzedCommit {
    return {
      sha: commit.sha,
      message: commit.message,
      author: commit.author,
      authorEmail: commit.authorEmail,
      date: commit.date,
      repo: commit.repo,
      repoLabel: commit.repoLabel,
      repoType: commit.repoType,
      filesChanged: commit.filesChanged,
      isMergeCommit: commit.isMergeCommit,
      analysis,
      modelUsed,
    };
  }
}
