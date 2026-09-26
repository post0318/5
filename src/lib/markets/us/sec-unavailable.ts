import { isFetchFailure } from "../http";

/**
 * **SEC 원본 조회 실패 = 공란 + 사유**(2026-09-26 긴급 결함 수정 — docs/handoff-verification.md).
 *
 * 본표 판독기(계산 구조 `_cal`·`_lab`·`.xsd`, 인스턴스 `_htm.xml`, 공시 `index.json`, 과거 제출 목록)가 조회에 실패하면
 * 예전엔 오류를 삼키고 옛 태그 규칙으로 **조용히 대체**해 다른 숫자를 냈다(DE 총차입금 651.9억 → 136.4억, GE 일회성비용
 * 빈칸, F·DELL 감가상각비·기타 영업활동, AAPL 총차입금·EV/EBITDA 공란 — SEC 429). 이제는:
 *  - "원래 없음"(목록에 파일이 없음, 구조에 해당 줄이 없음)은 종전 규칙 그대로(문서화된 대체).
 *  - "조회 실패"(429·5xx·시간 초과·네트워크, 목록에 있는 파일의 404 포함 — http.ts FetchError)는 판독기가 오류를 올리고,
 *    로더(edgar.ts getCompanyFacts)가 해당 판독을 `sourceUnavailable` 에 적는다. 소비 모듈은 그 값을 **대체 계산 없이
 *    공란**으로 두고 화면에 "원본 조회 실패 — 잠시 후 다시 시도" 를 싣는다. 결과는 짧게만 캐시(재시도).
 */

/** 판독 단위 — 실패 시 공란이 되는 값 묶음 */
export type SourceFeature = "debt" | "da" | "opIncome" | "oneOff" | "yearEndShares" | "filings";

export interface SourceUnavailable {
  /** 실패한 조회 요약(상태·파일) */
  reason: string;
  /** 일부 날짜만 실패했으면 그 날짜(YYYY-MM-DD) — 없으면 판독 전체 */
  dates?: string[];
}
export type SourceUnavailableMap = Partial<Record<SourceFeature, SourceUnavailable>>;

export const UNAVAILABLE_REASON = "원본 조회 실패 — 잠시 후 다시 시도";

/** 공란이 되는 화면 값(주석 문구용) */
export const FEATURE_LABEL: Record<SourceFeature, string> = {
  debt: "총차입금·순차입금·EV",
  da: "감가상각비·EBITDA",
  opIncome: "영업이익·EBITDA",
  oneOff: "일회성비용",
  yearEndShares: "결산일 주식수·시가총액",
  filings: "최신 공시 보완(companyfacts 미반영 공시)",
};

/** 판독기가 조회 실패를 알릴 때 던진다. dates 가 있으면 그 날짜만 실패 */
export class SecFetchError extends Error {
  constructor(
    readonly feature: SourceFeature,
    readonly reason: string,
    readonly dates?: string[],
  ) {
    super(`${feature}: ${reason}`);
    this.name = "SecFetchError";
  }
}

const fileOf = (msg: string) => msg.replace(/https?:\/\/\S+\/([^/\s]+)$/, "$1");

/** 조회 실패면 그 사유, 아니면 null(코드·파싱 오류 — 종전 처리) */
export function fetchFailureReason(err: unknown): string | null {
  if (err instanceof SecFetchError) return err.reason;
  if (isFetchFailure(err)) return fileOf(err.message);
  return null;
}

/** 조회 실패만 그대로 올리고(판독 전체 미적용 → 공란), 그 밖의 오류는 fallback 값 */
export function rethrowFetch<T>(fallback: T): (err: unknown) => T {
  return (err) => {
    if (fetchFailureReason(err) != null) throw err;
    return fallback;
  };
}

type WithUnavailable = { sourceUnavailable?: SourceUnavailableMap };

/** 이 판독이 날짜 d(±7일)에서 조회 실패로 공란이어야 하는가. dates 없는 실패는 모든 날짜 */
export function unavailableOn(facts: WithUnavailable, feature: SourceFeature, d?: string | null): boolean {
  const u = facts.sourceUnavailable?.[feature];
  if (!u) return false;
  if (!u.dates || d == null) return true;
  const t = Date.parse(d);
  return u.dates.some((x) => Math.abs(Date.parse(x) - t) <= 7 * 864e5);
}

/** 화면 주석 한 줄 — 공란이 된 값과 사유. 없으면 null */
export function unavailableNote(facts: WithUnavailable): string | null {
  const m = facts.sourceUnavailable;
  const fs = m ? (Object.keys(m) as SourceFeature[]) : [];
  if (!fs.length) return null;
  const what = fs.map((f) => (m![f]!.dates?.length ? `${FEATURE_LABEL[f]}(${m![f]!.dates!.join(", ")})` : FEATURE_LABEL[f]));
  return `⚠ ${UNAVAILABLE_REASON}: ${what.join(" · ")} 공란`;
}

/** 일부 날짜만 조회 실패한 판독 — 읽은 날짜는 그대로 두고 실패 날짜만 적는다 */
export function markUnavailable<T extends WithUnavailable>(facts: T, feature: SourceFeature, reason: string, dates?: string[]): T {
  const prev = facts.sourceUnavailable?.[feature];
  const merged: SourceUnavailable = prev
    ? { reason: prev.reason, dates: prev.dates && dates ? [...new Set([...prev.dates, ...dates])] : undefined }
    : { reason, dates };
  return { ...facts, sourceUnavailable: { ...facts.sourceUnavailable, [feature]: merged } };
}

/** 재무제표 표의 LTM 열 이름(edgar-income·balance·cashflow·analysis 공통) */
const LTM_LABEL = "현재/LTM";

/**
 * companyfacts 에 없는 최신 공시 보완(edgar-gapfill.ts)이 조회 실패면, 그 공시가 빠진 채 계산한 LTM 은 같은 "현재/LTM" 열에
 * 더 오래된 기간 값이 들어간다 — 열을 통째로 공란으로(대체 계산 없음). 연도 열은 해당 연도가 빠질 뿐 값이 바뀌지 않는다.
 */
export function blankLtmIfFilingsUnavailable(
  facts: WithUnavailable,
  stmt: { sections: { items: { values: Record<string, number | null> }[] }[] },
): void {
  if (!unavailableOn(facts, "filings")) return;
  for (const s of stmt.sections) for (const it of s.items) if (LTM_LABEL in it.values) it.values[LTM_LABEL] = null;
}

/** 하이라이트 표(열 배열) 판 — kind "ltm" 열 */
export function blankLtmColumnIfFilingsUnavailable(
  facts: WithUnavailable,
  h: { columns: { kind: string }[]; rows: { values: (number | null)[] }[]; valuationRows: { values: (number | null)[] }[] },
): void {
  if (!unavailableOn(facts, "filings")) return;
  const idx = h.columns.findIndex((c) => c.kind === "ltm");
  if (idx < 0) return;
  for (const r of [...h.rows, ...h.valuationRows]) if (idx < r.values.length) r.values[idx] = null;
}
