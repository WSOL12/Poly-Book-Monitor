export function money(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function signedMoney(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const s = money(Math.abs(n), digits);
  if (n > 0) return `+${s}`;
  if (n < 0) return `−${s}`;
  return s;
}

export function pnlClass(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return "zero";
  return n > 0 ? "pos" : "neg";
}

export function pct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}%`;
}

export function num(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US");
}

export function age(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function clock(iso: string | number | null | undefined): string {
  if (iso == null || iso === "") return "—";
  const d = typeof iso === "number" ? new Date(iso) : new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleTimeString("en-GB", { hour12: false });
}

export function dateTime(iso: string | number | null | undefined): string {
  if (iso == null || iso === "") return "—";
  const d = typeof iso === "number" ? new Date(iso) : new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("en-GB", { hour12: false });
}

export function rate(num: number, den: number): string {
  if (!den) return "—";
  return `${((num / den) * 100).toFixed(0)}%`;
}

export function lockedPnl(p: { bcOdds: number; bcStake: number; polyAsk: number; polyShares: number }): number | null {
  if (![p.bcOdds, p.bcStake, p.polyAsk, p.polyShares].every((n) => Number.isFinite(n))) return null;
  const polyCost = p.polyAsk * p.polyShares;
  const ifBc = p.bcStake * p.bcOdds - polyCost;
  const ifPoly = p.polyShares - p.bcStake;
  return Math.min(ifBc, ifPoly);
}

export function cls(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
