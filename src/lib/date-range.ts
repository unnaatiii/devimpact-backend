/** Calendar date YYYY-MM-DD */
export function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function defaultAnalysisDateRange(): { dateFrom: string; dateTo: string } {
  const to = new Date();
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - 30);
  return { dateFrom: toYMD(from), dateTo: toYMD(to) };
}

/** After PAT: deep history for Repo / Developers (GitHub exists since ~2008). */
export function orgWideHistoryDateRange(): { dateFrom: string; dateTo: string } {
  return { dateFrom: "2008-01-01", dateTo: toYMD(new Date()) };
}

/** Optional shorter window (e.g. last 6 months) if you want to cap org fetch. */
export function lastMonthsDashboardDateRange(months: number): { dateFrom: string; dateTo: string } {
  const to = new Date();
  const from = new Date();
  from.setUTCMonth(from.getUTCMonth() - months);
  return { dateFrom: toYMD(from), dateTo: toYMD(to) };
}

/** Start of UTC day for GitHub `since` */
export function startOfDayUtcIso(ymd: string): string {
  return `${ymd}T00:00:00.000Z`;
}

/** End of UTC day for GitHub `until` */
export function endOfDayUtcIso(ymd: string): string {
  return `${ymd}T23:59:59.999Z`;
}

const MAX_RANGE_DAYS = 366;

/** PAT / wide org GitHub fetch (Repo, Developers) — allows multi-year history. */
export const WIDE_DASHBOARD_MAX_RANGE_DAYS = 8000;

function validateDateRangeWithMax(
  dateFrom: string,
  dateTo: string,
  maxDays: number,
): { ok: true } | { ok: false; error: string } {
  const from = new Date(startOfDayUtcIso(dateFrom));
  const to = new Date(endOfDayUtcIso(dateTo));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return { ok: false, error: "Invalid date format. Use YYYY-MM-DD." };
  }
  if (from > to) {
    return { ok: false, error: "Start date must be on or before end date." };
  }
  const days = (to.getTime() - from.getTime()) / 86400000;
  if (days > maxDays) {
    return { ok: false, error: `Date range cannot exceed ${maxDays} days.` };
  }
  const todayEnd = new Date();
  todayEnd.setUTCHours(23, 59, 59, 999);
  if (from > todayEnd) {
    return { ok: false, error: "Start date cannot be in the future." };
  }
  const todayYmd = toYMD(new Date());
  if (dateTo > todayYmd) {
    return { ok: false, error: "End date cannot be after today." };
  }
  return { ok: true };
}

/** Analysis page / AI runs — keep windows bounded for cost and latency. */
export function validateAnalysisDateRange(
  dateFrom: string,
  dateTo: string,
): { ok: true } | { ok: false; error: string } {
  return validateDateRangeWithMax(dateFrom, dateTo, MAX_RANGE_DAYS);
}

/** load-base (org dashboard) — allows lifetime-scale history. */
export function validateWideDashboardDateRange(
  dateFrom: string,
  dateTo: string,
): { ok: true } | { ok: false; error: string } {
  return validateDateRangeWithMax(dateFrom, dateTo, WIDE_DASHBOARD_MAX_RANGE_DAYS);
}
