export interface RepoConfig {
  owner: string;
  repo: string;
  label: string;
  repoType: "frontend" | "backend" | "erp";
}

export interface GitHubConfig {
  token: string;
  repos: RepoConfig[];
}

export interface CommitData {
  sha: string;
  message: string;
  /** Resolved GitHub login when available; otherwise raw git author name */
  author: string;
  /** Commit author email from git (used to merge profiles & parse noreply login) */
  authorEmail?: string;
  date: string;
  repo: string;
  repoLabel: string;
  repoType: "frontend" | "backend" | "erp";
  filesChanged: string[];
  additions: number;
  deletions: number;
  diff: string;
  isMergeCommit: boolean;
}

export interface PullRequestData {
  number: number;
  title: string;
  body: string;
  state: string;
  merged: boolean;
  author: string;
  repo: string;
  repoLabel: string;
  created_at: string;
  merged_at: string | null;
}

export interface ReviewData {
  prNumber: number;
  prTitle: string;
  reviewer: string;
  repo: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
}

export type ContributionType = "feature" | "bug_fix" | "refactor" | "test" | "chore";
export type ImpactLevel = "low" | "medium" | "high" | "critical";
export type ContributorRole = "developer" | "manager";

export interface AICommitAnalysis {
  type: ContributionType;
  impact_level: ImpactLevel;
  business_impact_score: number;
  /** Narrative summary of what changed and evidence */
  reasoning: string;
  /** Dimensions explicitly weighed (e.g. "user submission path", "FE/BE contract") */
  parameters_considered?: string[];
  /** Why this exact score—not generic; tie number to parameters and evidence */
  score_justification?: string;
  /** Modules, routes, services, or user flows potentially affected */
  affected_modules_and_flows?: string[];
}

export interface AnalyzedCommit {
  sha: string;
  message: string;
  author: string;
  authorEmail?: string;
  date: string;
  repo: string;
  repoLabel: string;
  repoType: "frontend" | "backend" | "erp";
  filesChanged: string[];
  isMergeCommit: boolean;
  analysis: AICommitAnalysis | null;
  modelUsed: string;
}

export interface DeveloperProfile {
  login: string;
  avatar_url: string;
  role: ContributorRole;
  totalCommits: number;
  meaningfulCommits: number;
  mergeCommits: number;
  reposContributed: string[];
  impactScore: number;
  avgBusinessImpact: number;
  commits: AnalyzedCommit[];
  breakdown: Record<ContributionType, number>;
  repoBreakdown: Record<string, { commits: number; score: number }>;
  totalReviews: number;
  prsApproved: number;
  insights: string[];
  tier: "exceptional" | "high" | "medium" | "growing";
}

export interface LeaderboardEntry {
  rank: number;
  developer: DeveloperProfile;
  badge?: string;
}

export interface MultiRepoData {
  repos: RepoConfig[];
  commits: CommitData[];
  pullRequests: PullRequestData[];
  reviews: ReviewData[];
  fetchedAt: string;
}

export interface AIAnalysisDiagnostics {
  openrouterConfigured: boolean;
  commitsEligible: number;
  commitsWithAnalysis: number;
  modelCallFailures: number;
  recentErrors: string[];
}

export interface AnalysisResult {
  repos: RepoConfig[];
  developers: DeveloperProfile[];
  leaderboard: LeaderboardEntry[];
  analyzedCommits: AnalyzedCommit[];
  topContributor: LeaderboardEntry | null;
  teamInsights: TeamInsight[];
  analyzedAt: string;
  aiPowered: boolean;
  modelsUsed: string[];
  commitCount: number;
  repoCount: number;
  aiDiagnostics?: AIAnalysisDiagnostics;
  /** Inclusive YYYY-MM-DD range used when fetching from GitHub */
  analysisWindow?: { from: string; to: string };
  /** GitHub logins included when analysis was restricted (same order as sent) */
  analysisAllowlist?: string[];
  /** GitHub-only snapshot vs merged AI cache / fresh AI */
  dataLayer?: "base" | "enhanced";
  /** Any non-merge commit has AI analysis (from cache and/or this run) */
  hasAiEnhancement?: boolean;
}

/** Persisted AI layer keyed by `owner/repo` and commit SHA */
export type AnalysisCacheVersion = 1;

export interface CachedCommitAi {
  impactScore?: number;
  type?: ContributionType;
  summary?: string;
  full?: AICommitAnalysis;
  modelUsed?: string;
  analyzedAt?: string;
}

export interface AnalysisCacheRepoBucket {
  lastAnalyzedAt?: string;
  commits: Record<string, CachedCommitAi>;
}

export interface AnalysisCache {
  version: AnalysisCacheVersion;
  repos: Record<string, AnalysisCacheRepoBucket>;
}

export interface AnalysisHistoryEntry {
  /** Stable id for session snapshot lookup (new runs only; legacy entries get `legacy-${runAt}`). */
  id?: string;
  repos: string[];
  dateRange: { from: string; to: string };
  runAt: string;
  /** Non-merge commits in that run after de-duplication (matches Commits tab). */
  commitsInWindow?: number;
  /** Subset of those with AI analysis. */
  commitsAnalyzed?: number;
}

/** Client → analyze API: repos + optional OpenRouter override */
export interface AnalyzeImpactPayload {
  token: string;
  repos: RepoConfig[];
  dateFrom: string;
  dateTo: string;
  openrouterApiKey?: string;
  /** If set, only commits/reviews/PRs attributed to these logins are analyzed */
  allowedLogins?: string[];
  /** Prior AI results; only missing SHAs are sent to the model */
  analysisCache?: AnalysisCache;
  /** Cap commits per repo after `listCommits` (newest first). Route defaults: load-base 2500 (clamped 10–10_000), analyze-impact 200 (clamped 5–500). */
  commitLimitPerRepo?: number;
}

export interface TeamInsight {
  category: string;
  title: string;
  description: string;
  developers: string[];
}
