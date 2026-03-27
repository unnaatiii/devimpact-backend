/** Session storage keys (shared by provider + developer profile). */
export const SESSION_RESULT_KEY = "devimpact-result";
export const SESSION_CONFIG_KEY = "devimpact-config";
export const SESSION_AI_CACHE_KEY = "devimpact-ai-cache";
export const SESSION_ANALYSIS_HISTORY_KEY = "devimpact-analysis-history";
/** Full AnalysisResult per history run id (for reopening Insights). */
export const SESSION_ANALYSIS_SNAPSHOTS_KEY = "devimpact-analysis-snapshots";
/** Full-org GitHub snapshot (all repos after PAT); not replaced by scoped AI runs. */
export const SESSION_WIDE_BASE_KEY = "devimpact-wide-base";
/** `live` = merge wide org + latest scoped AI; `restored` = show a saved history snapshot only. */
export const SESSION_DISPLAY_MODE_KEY = "devimpact-display-mode";
