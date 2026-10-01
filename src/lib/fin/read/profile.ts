import type { FactIndex, Submissions } from "../source/us/sec";
import type { CompanyProfile, CompanyType } from "../types";

/**
 * 1층 — 회사 유형 판정(architecture.md §2). **유형 판정은 이 파일 한 곳** — 지표 모듈은 SIC 를 직접 보지 않는다.
 *
 * 규칙(SIC + 공시 구조, 기존 모듈의 판정을 한곳에 모음):
 *  - reit    : SIC 6798(edgar.ts isReit 과 같음)
 *  - bank    : SIC 60xx·61xx + NoninterestExpense 태그(edgar-financial.ts isFinancialCompany 와 같음 — 은행·카드사)
 *  - broker  : SIC 62xx(증권·투자은행 — GS·MS·SCHW)
 *  - insurer : SIC 63xx·64xx
 *  - captive : 금융업 SIC 가 아니면서 금융 부문 매출 태그(FinancialServicesRevenue)가 있는 제조사(GM·CAT 등 — 휴리스틱, §9)
 *  - general : 그 외
 */
export function companyType(sic: number | null, idx: FactIndex): CompanyType {
  if (sic === 6798) return "reit";
  if (sic != null && sic >= 6000 && sic <= 6199 && idx.get("us-gaap:NoninterestExpense").length > 0) return "bank";
  if (sic != null && sic >= 6200 && sic <= 6299) return "broker";
  if (sic != null && sic >= 6300 && sic <= 6499) return "insurer";
  if ((sic == null || sic < 6000 || sic > 6799) && idx.get("us-gaap:FinancialServicesRevenue").length > 0) return "captive";
  return "general";
}

/** 제출 유형 — 가장 최근 연간 정기공시 형식 */
export function filerKind(sub: Submissions): CompanyProfile["filer"] {
  const f = sub.recent.find((r) => /^(10-K|20-F|40-F)(\/A)?$/.test(r.form))?.form ?? "10-K";
  return /^20-F/.test(f) ? "20-F" : /^40-F/.test(f) ? "40-F" : "domestic";
}
