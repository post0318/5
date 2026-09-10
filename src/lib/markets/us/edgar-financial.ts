/**
 * 미국 금융회사(은행·카드사) 판정 + 공통 개념 목록.
 * 제조업 손익 구조(매출→매출원가→영업이익)가 안 맞는 회사(SIC 60xx/61xx)를
 * 하이라이트·재무분석·총괄 요약 등 여러 빌더에서 동일 기준으로 분기하기 위한 공유 모듈.
 */
import type { CompanyFacts } from "./edgar";

/** 순수익 = 매출 − 이자비용 (은행·카드사 GAAP 손익계산서 최상단). */
export const FIN_NET_REVENUE = ["RevenuesNetOfInterestExpense"];
/** 총이자외비용(판관비 성격). */
export const FIN_NONINTEREST_EXPENSE = ["NoninterestExpense"];
/** 대손충당금. */
export const FIN_PROVISION = [
  "ProvisionForLoanLossesExpensed",
  "ProvisionForLoanAndLeaseLosses",
  "ProvisionForLoanLeaseAndOtherLosses",
];
/** 보통주 귀속 순이익(우선주배당 차감후) — 우선주 없는 회사는 NetIncomeLoss 로 자동 폴백. */
export const FIN_NET_INCOME = [
  "NetIncomeLossAvailableToCommonStockholdersDiluted",
  "NetIncomeLossAvailableToCommonStockholdersBasic",
  "NetIncomeLoss",
  "ProfitLoss",
];

/** 금융회사(은행·카드사) 판정 — SIC 60xx(예금기관)·61xx(비예금 신용기관) + NoninterestExpense 태깅 여부. */
export function isFinancialCompany(facts: CompanyFacts, sic: string | null): boolean {
  if (!sic || !/^6[01]/.test(sic)) return false;
  return (facts.facts["us-gaap"]?.["NoninterestExpense"]?.units?.USD?.length ?? 0) > 0;
}
