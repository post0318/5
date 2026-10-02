import "server-only";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import type { FinancialLineItem } from "../types";
import { fiscalYearOf } from "./edgar-series";

/**
 * 빈 칸 사유·무배당 0 — 재무상태표·현금흐름표·하이라이트·재무분석 공통(오너 지시 2026-10-02: 사유 없는 빈칸 389건, 무배당 = 0).
 */

/** 배당 관련 공시 개념(지급액·주당 결의·자본변동표 배당) — 이 중 하나라도 그 기간에 0 이 아닌 값이 있으면 "배당 있음" */
const DIV_CONCEPTS = [
  "PaymentsOfDividends",
  "PaymentsOfDividendsCommonStock",
  "PaymentsOfOrdinaryDividends",
  "CommonStockDividendsPerShareDeclared",
  "CommonStockDividendsPerShareCashPaid",
  "DividendsCommonStock",
  "DividendsCommonStockCash",
  "Dividends",
];

function divEntries(facts: CompanyFacts): FactUnitEntry[] {
  const g = (facts.facts as Record<string, Record<string, { units: Record<string, FactUnitEntry[]> }> | undefined>)["us-gaap"] ?? {};
  return DIV_CONCEPTS.flatMap((c) => Object.values(g[c]?.units ?? {}).flat());
}

/** 그 사업연도(결산일 기준 연도 키)에 배당 공시가 하나도 없는가 — 공시가 아예 없는 회사(AMD·AMZN)와 배당 시작 전 연도(META 2021) */
export function dividendFreeYear(facts: CompanyFacts, fy: number): boolean {
  return !divEntries(facts).some((e) => e.val !== 0 && fiscalYearOf(e.end) === fy);
}

/** 최근 1년(LTM 기준일까지) 배당 공시가 하나도 없는가 */
export function dividendFreeSince(facts: CompanyFacts, fromExclusive: string, to: string): boolean {
  return !divEntries(facts).some((e) => e.val !== 0 && e.end > fromExclusive && e.end <= to);
}

/**
 * 표의 빈 칸 중 사유가 없는 칸에 사유를 단다 — 그 열의 재무제표가 있을 때만(presentCols). 제목·주석 줄(빈 이름·"※"·"[") 은 건너뛴다.
 * 0 으로 채우지 않는 이유: 회사가 다른 줄에 합쳐 공시했을 수 있다(AMZN 투자자산 — "기타 자산" 안)
 */
export function fillBlankReasons(items: FinancialLineItem[], presentCols: string[], text = "본표에 별도 줄 없음"): void {
  for (const it of items) {
    if (!it.values || !it.accountName || /^[※[]/.test(it.accountName)) continue;
    for (const c of presentCols) {
      if (it.values[c] != null || it.cellNotes?.[c]) continue;
      it.cellNotes = { ...(it.cellNotes ?? {}), [c]: text };
    }
  }
}

/** 주당배당금 공시가 없는 사업연도 — 배당금 지급액 ÷ 가중평균 주식수(지급 기준). 결의 기준 주당배당 공시가 다음 해 20-F 에 실리는 회사(ASML —
 * 2025 년분은 아직 미공시)라도 현금흐름표 배당 지급이 확정돼 있으면 비워 두지 않는다(오너 지시 2026-10-02 "cf 는 배당금 지급 확정지었는데") */
export const DPS_FROM_PAID_NOTE = "주당배당금 공시 없음 — 배당금 지급액 ÷ 가중평균 주식수(지급 기준)";
export function dpsFromPaid(facts: CompanyFacts, fy: number): number | null {
  const g = (facts.facts as Record<string, Record<string, { units: Record<string, FactUnitEntry[]> }> | undefined>)["us-gaap"] ?? {};
  const annual = (c: string, u: string) =>
    (g[c]?.units?.[u] ?? [])
      .filter((e) => e.start && (Date.parse(e.end) - Date.parse(e.start)) / 864e5 > 350 && fiscalYearOf(e.end) === fy)
      .sort((a, b) => (b.filed ?? "").localeCompare(a.filed ?? ""))[0]?.val ?? null;
  const paid = ["PaymentsOfDividendsCommonStock", "PaymentsOfOrdinaryDividends", "PaymentsOfDividends"].map((c) => annual(c, "USD")).find((v) => v != null) ?? null;
  const sh = annual("WeightedAverageNumberOfSharesOutstandingBasic", "shares");
  return paid != null && paid !== 0 && sh ? Math.abs(paid) / sh : null;
}

