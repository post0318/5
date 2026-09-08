/**
 * SEC EDGAR companyfacts 에서 TTM 흐름 + 최근분기(MRQ) 재무상태표 + D&A + 주당배당금 산출.
 *
 * 흐름(매출·순이익·EPS·D&A·DPS)의 TTM =
 *   최근 사업연도(10-K, FY) + 당기 누적(최근 10-Q, YTD) − 전년 동기 누적(YTD)
 * 한국(OpenDART) 과 동일한 누적 차감 방식.
 */

export interface FactEntry {
  start?: string;
  end: string;
  val: number;
  fp: string;
  form: string;
}

const ANNUAL_FORMS = ["10-K", "10-K/A", "20-F", "20-F/A"];
const INTERIM_FORMS = ["10-Q", "10-Q/A"];

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
  /** TTM 값 (전년동기 데이터가 없으면 최근 연간값으로 폴백) */
  ttm: number | null;
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

/** 흐름 계정의 TTM. */
export function ttmFlow(entries: FactEntry[] | undefined): TtmResult {
  const empty: TtmResult = {
    ttm: null,
    annual: null,
    annualLabel: "",
    ttmLabel: "",
    from: null,
    to: null,
  };
  if (!entries?.length) return empty;

  // 1) 최근 사업연도 (FY, 10-K)
  const annuals = entries.filter(
    (e) => e.fp === "FY" && isFullYear(e) && ANNUAL_FORMS.includes(e.form) && e.val != null,
  );
  annuals.sort((a, b) => b.end.localeCompare(a.end));
  const fy = annuals[0];
  if (!fy || !fy.start) return empty;
  const fyYear = fy.end.slice(0, 4);
  const annualLabel = `FY${fyYear} (${fy.start}~${fy.end})`;

  // 2) 당기 누적 (FY 종료 직후 시작하는 최근 10-Q YTD)
  const interims = entries.filter(
    (e) => e.start && INTERIM_FORMS.includes(e.form) && e.val != null,
  );
  const curCands = interims
    .filter((e) => Math.abs(days(fy.end, e.start!)) <= 12 && e.end > fy.end)
    .sort((a, b) => b.end.localeCompare(a.end));
  const cur = curCands[0];

  if (!cur || !cur.start) {
    // 신규 분기 없음 → 연간이 곧 TTM
    return {
      ttm: fy.val,
      annual: fy.val,
      annualLabel,
      ttmLabel: annualLabel,
      from: fy.start,
      to: fy.end,
    };
  }

  // 3) 전년 동기 누적 (start·end 를 1년 당긴 YTD)
  const wantStart = shiftYear(cur.start, -1);
  const wantEnd = shiftYear(cur.end, -1);
  const prior = interims
    .filter(
      (e) =>
        e.start &&
        Math.abs(days(wantStart, e.start)) <= 12 &&
        Math.abs(days(wantEnd, e.end)) <= 12,
    )
    .sort((a, b) => Math.abs(days(wantEnd, a.end)) - Math.abs(days(wantEnd, b.end)))[0];

  if (!prior) {
    // 전년동기 없음 → 연간값 폴백
    return {
      ttm: fy.val,
      annual: fy.val,
      annualLabel,
      ttmLabel: `${annualLabel} (전년동기 누락 → 연간)`,
      from: fy.start,
      to: fy.end,
    };
  }

  const ttm = fy.val + cur.val - prior.val;
  return {
    ttm,
    annual: fy.val,
    annualLabel,
    ttmLabel: `FY${fyYear} + ${cur.start.slice(0, 4)}누적(~${cur.end}) − 전년동기`,
    from: shiftYear(cur.end, -1),
    to: cur.end,
  };
}
