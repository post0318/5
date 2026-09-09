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
/**
 * 나열된 개념(대체 태그)을 우선순위대로 병합한 엔트리 배열.
 * 같은 보고기간(start·end·form)은 앞선 개념 값을 쓰고, 없는 기간만 뒤 개념이 채운다.
 * → 회사가 연도에 따라 태그를 바꾼 경우(NVIDIA 등) 시계열이 끊기지 않음.
 */
export function firstConcept(
  facts: CompanyFacts,
  concepts: string[],
  unit = "USD",
): FactUnitEntry[] {
  if (concepts.length === 1) return entriesOf(facts, concepts[0], unit);
  const out: FactUnitEntry[] = [];
  const seen = new Set<string>();
  for (const c of concepts) {
    for (const e of entriesOf(facts, c, unit)) {
      const key = `${e.start ?? ""}|${e.end}|${e.form}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

/**
 * 온전한 1개 회계연도 기간인지 (약 300~400일).
 * 일부 기업(NVIDIA 등)은 90일 분기 값에도 fp="FY" 를 붙여 태깅한다 → duration 으로 걸러야 한다.
 */
export function isFullYearDuration(e: FactUnitEntry): boolean {
  if (!e.start) return false;
  const d = days(e.start, e.end);
  return d >= 300 && d <= 400;
}

/** 같은 회계기간의 두 값 중 채택할 것 — 최신 종료일, 동률이면 최신 공시(재작성) 우선. */
function preferNewer(cand: FactUnitEntry, prev: { end: string; filed?: string }): boolean {
  if (cand.end !== prev.end) return cand.end > prev.end;
  return (cand.filed ?? "") >= (prev.filed ?? "");
}

/** 사업연도(FY, 10-K) duration 값 Map<year, val>. */
export function annualByYear(entries: FactUnitEntry[]): Map<number, number> {
  const m = new Map<number, { val: number; end: string; filed?: string }>();
  for (const e of entries) {
    if (e.fp !== "FY" || !isFullYearDuration(e) || !ANNUAL_FORMS.includes(e.form)) continue;
    const y = Number(e.end.slice(0, 4));
    const prev = m.get(y);
    if (!prev || preferNewer(e, prev)) m.set(y, { val: e.val, end: e.end, filed: e.filed });
  }
  return new Map([...m].map(([y, v]) => [y, v.val]));
}

/** 재무상태표(instant) — 사업연도말 값 Map<year, val>. */
export function instantByYear(entries: FactUnitEntry[]): Map<number, number> {
  const m = new Map<number, { val: number; end: string; filed?: string }>();
  for (const e of entries) {
    if (e.start || !ANNUAL_FORMS.includes(e.form)) continue;
    const y = Number(e.end.slice(0, 4));
    const prev = m.get(y);
    if (!prev || preferNewer(e, prev)) m.set(y, { val: e.val, end: e.end, filed: e.filed });
  }
  return new Map([...m].map(([y, v]) => [y, v.val]));
}

/** 재무상태표 — 가장 최근 instant 값 (분기 포함). */
export function latestInstant(entries: FactUnitEntry[]): number | null {
  let best: { val: number; end: string } | null = null;
  for (const e of entries) {
    if (e.start) continue;
    if (!best || e.end > best.end) best = { val: e.val, end: e.end };
  }
  return best?.val ?? null;
}

/** 재무상태표 — 특정 기준일(정확 일치 ±6일)의 instant 값. */
export function instantOn(entries: FactUnitEntry[], end: string): number | null {
  let best: { val: number; d: number } | null = null;
  for (const e of entries) {
    if (e.start) continue;
    const dd = Math.abs(days(end, e.end));
    if (dd > 6) continue;
    if (!best || dd < best.d) best = { val: e.val, d: dd };
  }
  return best?.val ?? null;
}

/** 최근 n개 분기말 (instant 기준). */
export function recentInstantQuarters(entries: FactUnitEntry[], n = 5): string[] {
  const ends = new Set<string>();
  for (const e of entries) {
    if (e.start || !INTERIM_FORMS.includes(e.form)) continue;
    ends.add(e.end);
  }
  // 10-K 기말도 포함 (연말 분기)
  for (const e of entries) {
    if (e.start || !ANNUAL_FORMS.includes(e.form)) continue;
    ends.add(e.end);
  }
  return [...ends].sort().reverse().slice(0, n);
}

/** 사업연도 종료일 Map<year, endDate>. */
export function annualEnds(entries: FactUnitEntry[]): Map<number, string> {
  const m = new Map<number, string>();
  for (const e of entries) {
    if (e.fp !== "FY" || !isFullYearDuration(e) || !ANNUAL_FORMS.includes(e.form)) continue;
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

/**
 * 액면분할 보정 계수 Map<year, factor>. 보고된 주당 지표(EPS·BPS·DPS)에 곱하면
 * 최신 연도 기준으로 환산된다. 가중평균 희석주식수(최신 공시 기준) 시계열에서
 * 인접 연도 배수가 크고 매출 배수는 ~1 인 지점을 분할로 판정한다.
 * NVIDIA(10:1, FY2025) 등 소급 재작성 안 된 과거 연도 대응.
 */
export function splitFactorsByYear(
  facts: CompanyFacts,
  shareConcepts: string[] = [
    "WeightedAverageNumberOfDilutedSharesOutstanding",
    "WeightedAverageNumberOfSharesOutstandingBasic",
  ],
  revenueConcepts: string[] = [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
  ],
): Map<number, number> {
  const merge = (concepts: string[], unit = "USD") => {
    const out = new Map<number, number>();
    for (const c of concepts)
      for (const [y, v] of annualByYear(entriesOf(facts, c, unit))) if (!out.has(y)) out.set(y, v);
    return out;
  };
  const sh = merge(shareConcepts, "shares");
  const rev = merge(revenueConcepts);
  const years = [...sh.keys()].sort((a, b) => a - b);
  const factor = new Map<number, number>();
  if (!years.length) return factor;
  factor.set(years[years.length - 1], 1);
  const SPLITS = [2, 3, 4, 5, 6, 7, 8, 10, 15, 20];
  for (let i = years.length - 1; i > 0; i--) {
    const yNew = years[i];
    const yOld = years[i - 1];
    const f = factor.get(yNew) ?? 1;
    const sNew = sh.get(yNew);
    const sOld = sh.get(yOld);
    let step = 1;
    if (sNew != null && sOld != null && sOld > 0) {
      const r = sNew / sOld;
      const rvNew = rev.get(yNew);
      const rvOld = rev.get(yOld);
      const revStable = rvNew != null && rvOld != null && rvOld > 0
        ? rvNew / rvOld > 0.4 && rvNew / rvOld < 2.5
        : true;
      if (revStable) {
        if (r >= 1.6) {
          const k = SPLITS.reduce((best, c) => (Math.abs(c - r) < Math.abs(best - r) ? c : best), SPLITS[0]);
          if (Math.abs(k - r) / k < 0.15) step = 1 / k; // 정방향 분할
        } else if (r <= 1 / 1.6) {
          const k = SPLITS.reduce((best, c) => (Math.abs(c - 1 / r) < Math.abs(best - 1 / r) ? c : best), SPLITS[0]);
          if (Math.abs(k - 1 / r) / k < 0.15) step = k; // 병합
        }
      }
    }
    factor.set(yOld, f * step);
  }
  return factor;
}

/** 흐름 TTM = 최근 FY + 당기누적 − 전년동기누적. */
export function ttmOf(entries: FactUnitEntry[]): number | null {
  const annuals = entries
    .filter((e) => e.fp === "FY" && isFullYearDuration(e) && ANNUAL_FORMS.includes(e.form))
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
