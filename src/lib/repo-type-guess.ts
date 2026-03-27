/** Heuristic repo role for scoring weights (matches ConnectForm defaults). */
export function guessRepoType(name: string): "frontend" | "backend" | "erp" {
  const n = name.toLowerCase();
  if (/portal|ui|web|client|app|frontend|next|react|vue/.test(n)) return "frontend";
  if (/erp|admin|dashboard|internal/.test(n)) return "erp";
  return "backend";
}
