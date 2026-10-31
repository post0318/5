/**
 * 미국 금융회사(은행·카드사) 판정 + 공통 개념 목록.
 * 제조업 손익 구조(매출→매출원가→영업이익)가 안 맞는 회사(SIC 60xx/61xx)를
 * 하이라이트·재무분석·총괄 요약 등 여러 빌더에서 동일 기준으로 분기하기 위한 공유 모듈.
 * 은행 순수익(매출)은 여기서 만들지 않는다 — 재무 5층 구조 매출 지표(src/lib/fin metrics/revenue.ts 은행 규칙)만 쓴다.
 */
import type { CompanyFacts } from "./edgar";

/** 총이자외비용(판관비 성격). */
export const FIN_NONINTEREST_EXPENSE = ["NoninterestExpense"];
/** 대손충당금. */
/**
 * 넓은 개념 먼저(손익계산서 「충당금」 줄 = 대출·리스·기타 합계, 2026-11-01). 대출분만인 ProvisionForLoanLossesExpensed 를 앞에 두면 두 개념을 다 쓰는
 * 해에 대출분만 잡혔다(JPM 2021 −9,071 vs 손익계산서 −9,256 백만 달러 — 세전이익과 185 차이). 기간마다 앞 개념, 없으면 다음(mergeConcepts)
 */
export const FIN_PROVISION = [
  "ProvisionForLoanLeaseAndOtherLosses",
  "ProvisionForLoanAndLeaseLosses",
  "ProvisionForLoanLossesExpensed",
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
