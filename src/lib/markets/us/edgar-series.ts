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

export interface QuarterCol {
  label: string; // "2026 Q3"
  end: string; // 2026-06-27
  fyStartApprox: string; // 회계연도 시작 근사 (전년 동월)
}

/** 최근 n개 분기 컬럼 (anchor 개념의 10-Q 보고 기간 기준, 최신→과거). */
export function recentQuarters(
  entries: FactUnitEntry[],
  n = 5,
): QuarterCol[] {
  const seen = new Map<string, { end: string; fy: number; fp: string }>();
  for (const e of entries) {
    if (!INTERIM_FORMS.includes(e.form) || e.fp === "FY" || !e.start) continue;
    const key = `${e.fy} ${e.fp}`;
    const prev = seen.get(key);
    if (!prev || e.end > prev.end) seen.set(key, { end: e.end, fy: e.fy, fp: e.fp });
  }
  return [...seen.entries()]
    .map(([label, v]) => ({
      label,
      end: v.end,
      fyStartApprox: shiftYear(v.end, -1),
    }))
    .sort((a, b) => b.end.localeCompare(a.end))
    .slice(0, n);
}

/** 단일 분기 값: 직접 태깅(≈90일) → 없으면 당기 YTD − 직전분기 YTD. */
export function singleQuarter(
  entries: FactUnitEntry[],
  col: QuarterCol,
  prevCol: QuarterCol | undefined,
): number | null {
  const interim = entries.filter(
    (e) => INTERIM_FORMS.includes(e.form) && e.fp !== "FY" && e.start,
  );
  // 1) 직접 단일분기 (기간 60~100일, end 일치)
  const direct = interim.find(
    (e) =>
      Math.abs(days(e.start!, e.end)) >= 55 &&
      Math.abs(days(e.start!, e.end)) <= 100 &&
      Math.abs(days(col.end, e.end)) <= 6,
  );
  if (direct) return direct.val;
  // 2) YTD 차감
  const ytd = (end: string) =>
    interim
      .filter((e) => Math.abs(days(end, e.end)) <= 6)
      .sort((a, b) => Math.abs(days(a.start!, a.end)) - Math.abs(days(b.start!, b.end)))
      .pop(); // 가장 긴 기간 = YTD
  const cur = ytd(col.end);
  if (!cur) return null;
  if (!prevCol) {
    // 회계연도 첫 분기로 추정 (start 가 fy 시작 근처면 YTD == 단일분기)
    return Math.abs(days(col.fyStartApprox, cur.start!)) <= 20 &&
      Math.abs(days(cur.start!, cur.end)) <= 100
      ? cur.val
      : null;
  }
  const prev = ytd(prevCol.end);
  if (!prev) return null;
  // 서로 같은 회계연도인지 (prev.start ≈ cur.start)
  if (Math.abs(days(cur.start!, prev.start!)) > 20) return cur.val; // 회계연도 바뀜 → cur 이 곧 단일분기 성격
  return cur.val - prev.val;
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
