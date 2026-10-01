/**
 * SEC EDGAR companyfacts 에서 TTM 흐름 + 최근분기(MRQ) 재무상태표 + D&A + 주당배당금 산출.
 *
 * 흐름(매출·순이익·EPS·D&A·DPS)의 TTM =
 *   최근 사업연도(10-K, FY) + 당기 누적(최근 10-Q, YTD) − 전년 동기 누적(YTD)
 * 한국(OpenDART) 과 동일한 누적 차감 방식.
 */

import type { FactUnitEntry } from "./edgar";
import { fiscalYearOf, ltmFlowOf, vintageOrder } from "./edgar-series";

export interface FactEntry {
  start?: string;
  end: string;
  val: number;
  fp: string;
  form: string;
  filed?: string;
  /** 외화 공시 — 분기별 평균 환율 합 환산값(edgar-foreign.ts). LTM 조합 전용 */
  ltmQ?: number;
  /** 20-F Yahoo 분기 LTM 에서 채우지 못한 항목(edgar-yahoo-quarters.ts) — LTM 공란 */
  ltmNone?: boolean;
}

const ANNUAL_FORMS = ["10-K", "10-K/A", "20-F", "20-F/A"];

function days(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}
/** 온전한 1개 회계연도(약 300~400일)인지 — 90일 분기에도 fp="FY" 붙이는 기업(NVIDIA) 대응. */
function isFullYear(e: FactEntry): boolean {
  return Boolean(e.start) && days(e.start!, e.end) >= 300 && days(e.start!, e.end) <= 400;
}
function shiftYear(iso: string, n: number): string {
  const [y, m, d] = iso.split("-");
  return `${Number(y) + n}-${m}-${d}`;
}

/** 순간값(재무상태표·주식수 등): 가장 최근 end 의 값. */
export function latestInstant(entries: FactEntry[] | undefined): FactEntry | null {
  if (!entries?.length) return null;
  let best: FactEntry | null = null;
  for (const e of entries) {
    if (e.val == null || !e.end) continue;
    if (!best || e.end > best.end) best = e;
  }
  return best;
}

export interface TtmResult {
  /** TTM 값 — 구성 분기가 없으면 null(사업연도 값으로 대신하지 않음, edgar-series.ts ltmFlowOf) */
  ttm: number | null;
  /** ttm 이 null 인 사유(화면 주석) */
  reason: string | null;
  /** 최근 사업연도 값 */
  annual: number | null;
  /** 최근 사업연도 라벨 (예: "FY2025 (2024-09-29~2025-09-27)") */
  annualLabel: string;
  /** TTM 계산 기준 라벨 */
  ttmLabel: string;
  /** TTM 구간 [from, to] */
  from: string | null;
  to: string | null;
}

/** 흐름 계정의 TTM — edgar-series.ts ltmFlowOf(단일 함수)에 라벨·구간만 붙인다. anchor = ltmAnchor(facts) */
export function ttmFlow(entries: FactEntry[] | undefined, anchor: string | null): TtmResult {
  const empty: TtmResult = { ttm: null, reason: null, annual: null, annualLabel: "", ttmLabel: "", from: null, to: null };
  if (!entries?.length) return empty;
  const r = ltmFlowOf(entries as FactUnitEntry[], anchor);
  // 최근 사업연도(라벨·연간 값용) — LTM 판정과 무관하게 표시
  const annuals = entries
    .filter((e) => e.fp === "FY" && isFullYear(e) && ANNUAL_FORMS.includes(e.form) && e.val != null)
    .sort((a, b) => b.end.localeCompare(a.end) || vintageOrder(a, b));
  const fy0 = annuals[0];
  const annualLabel = fy0?.start ? `FY${fiscalYearOf(fy0.end)} (${fy0.start}~${fy0.end})` : "";
  if (r.value == null || !r.fy?.start)
    return { ...empty, reason: r.reason, annual: fy0?.val ?? null, annualLabel };
  const fy = r.fy;
  const fyYear = String(fiscalYearOf(fy.end));
  if (!r.cur?.start || !r.prior) {
    // 사업연도 뒤 정기공시가 아직 없음 → 연간이 곧 TTM(정의상 같은 기간)
    return { ttm: r.value, reason: null, annual: fy.val, annualLabel, ttmLabel: annualLabel, from: fy.start ?? null, to: fy.end };
  }
  const cur = r.cur, prior = r.prior;
  return {
    ttm: r.value,
    reason: null,
    annual: fy.val,
    annualLabel,
    ttmLabel:
      cur.form === "YAHOO-Q"
        ? `최근 4개 분기(~${cur.end}) · Yahoo 분기(원통화, 연준 H.10 분기 평균 환율 환산)`
        : `FY${fyYear} + ${(cur.start ?? "").slice(0, 4)}누적(~${cur.end}) − 전년동기${fy.ltmQ != null && cur.ltmQ != null && prior.ltmQ != null ? " · USD 환산 = 분기마다 그 분기 평균 환율" : ""}`,
    from: shiftYear(cur.end, -1),
    to: cur.end,
  };
}
