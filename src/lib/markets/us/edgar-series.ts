import "server-only";
import type { CompanyFacts, FactUnitEntry } from "./edgar";

/** EDGAR companyfacts 시계열 헬퍼 (상세 CF·IS 공용). */

export const ANNUAL_FORMS = ["10-K", "10-K/A", "20-F", "20-F/A"];
export const INTERIM_FORMS = ["10-Q", "10-Q/A"];

export function days(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}
export function shiftYear(iso: string, n: number): string {
  const [y, m, d] = iso.split("-");
  return `${Number(y) + n}-${m}-${d}`;
}

export function entriesOf(
  facts: CompanyFacts,
  concept: string,
  unit = "USD",
): FactUnitEntry[] {
  return facts.facts["us-gaap"]?.[concept]?.units?.[unit] ?? [];
}
export function firstConcept(
  facts: CompanyFacts,
  concepts: string[],
  unit = "USD",
): FactUnitEntry[] {
  for (const c of concepts) {
    const e = entriesOf(facts, c, unit);
    if (e.length) return e;
  }
  return [];
}

/** 사업연도(FY, 10-K) duration 값 Map<year, val>. */
export function annualByYear(entries: FactUnitEntry[]): Map<number, number> {
  const m = new Map<number, { val: number; end: string }>();
  for (const e of entries) {
    if (e.fp !== "FY" || !e.start || !ANNUAL_FORMS.includes(e.form)) continue;
    const y = Number(e.end.slice(0, 4));
    const prev = m.get(y);
    if (!prev || e.end > prev.end) m.set(y, { val: e.val, end: e.end });
  }
  return new Map([...m].map(([y, v]) => [y, v.val]));
}

/** 사업연도 종료일 Map<year, endDate>. */
export function annualEnds(entries: FactUnitEntry[]): Map<number, string> {
  const m = new Map<number, string>();
  for (const e of entries) {
    if (e.fp !== "FY" || !e.start || !ANNUAL_FORMS.includes(e.form)) continue;
    const y = Number(e.end.slice(0, 4));
    if (!m.has(y) || e.end > m.get(y)!) m.set(y, e.end);
  }
  return m;
}

/** 흐름 TTM = 최근 FY + 당기누적 − 전년동기누적. */
export function ttmOf(entries: FactUnitEntry[]): number | null {
  const annuals = entries
    .filter((e) => e.fp === "FY" && e.start && ANNUAL_FORMS.includes(e.form))
    .sort((a, b) => b.end.localeCompare(a.end));
  const fy = annuals[0];
  if (!fy?.start) return null;
  const interims = entries.filter((e) => e.start && INTERIM_FORMS.includes(e.form));
  const cur = interims
    .filter((e) => Math.abs(days(fy.end, e.start!)) <= 12 && e.end > fy.end)
    .sort((a, b) => b.end.localeCompare(a.end))[0];
  if (!cur?.start) return fy.val;
  const wS = shiftYear(cur.start, -1);
  const wE = shiftYear(cur.end, -1);
  const prior = interims
    .filter(
      (e) =>
        e.start &&
        Math.abs(days(wS, e.start)) <= 12 &&
        Math.abs(days(wE, e.end)) <= 12,
    )
    .sort((a, b) => Math.abs(days(wE, a.end)) - Math.abs(days(wE, b.end)))[0];
  if (!prior) return fy.val;
  return fy.val + cur.val - prior.val;
}
