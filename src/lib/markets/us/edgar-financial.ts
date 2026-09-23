/**
 * 미국 금융회사(은행·카드사) 판정 + 공통 개념 목록.
 * 제조업 손익 구조(매출→매출원가→영업이익)가 안 맞는 회사(SIC 60xx/61xx)를
 * 하이라이트·재무분석·총괄 요약 등 여러 빌더에서 동일 기준으로 분기하기 위한 공유 모듈.
 */
import type { CompanyFacts, FactUnitEntry } from "./edgar";

/** 합성 순수익 개념 이름 — withFinNetRevenue() 가 사본 데이터에 끼워 넣는다. */
const SYN_NET_REVENUE = "FinNetRevenueDerived";
/** 순수익 = 매출 − 이자비용 (은행·카드사 GAAP 손익계산서 최상단). withFinNetRevenue() 를 거친 facts 에서만 쓴다. */
export const FIN_NET_REVENUE = [SYN_NET_REVENUE];

/**
 * 은행 순수익 시계열 — ① RevenuesNetOfInterestExpense → ② Revenues → ③ 순이자이익 +
 * 비이자이익(같은 기간). 대형 은행 14곳 실측(2026-09-23): ①을 쓰는 곳은 JPM·WFC 뿐이고,
 * BAC·C·USB·PNC·COF·KEY·CFG 는 ②(= 순이자이익 + 비이자이익과 일치 확인), TFC·MTB·FITB·
 * RF·HBAN 은 둘 다 없어 ③만 가능. ①만 보던 예전엔 14곳 중 12곳의 은행 하이라이트·분석
 * 지표가 과거 연도 없이 비어 있었다(검증 체계 2층으로 발견).
 */
export function finNetRevenueEntries(facts: CompanyFacts): FactUnitEntry[] {
  const g = facts.facts["us-gaap"] ?? {};
  const E = (c: string): FactUnitEntry[] => g[c]?.units?.USD ?? [];
  const key = (e: FactUnitEntry) => `${e.start ?? ""}|${e.end}|${e.form}|${e.fp}`;
  const out: FactUnitEntry[] = [];
  const covered = new Set<string>();
  for (const c of ["RevenuesNetOfInterestExpense", "Revenues"])
    for (const e of E(c)) {
      const k = key(e);
      if (covered.has(k) || !e.start) continue;
      covered.add(k);
      out.push(e);
    }
  const non = new Map<string, number>();
  for (const e of E("NoninterestIncome")) if (e.start && e.val != null) non.set(key(e), e.val);
  for (const e of E("InterestIncomeExpenseNet")) {
    const k = key(e);
    if (covered.has(k) || !e.start || e.val == null || !non.has(k)) continue;
    covered.add(k);
    out.push({ ...e, val: e.val + non.get(k)! });
  }
  return out;
}

/** 합성 순수익(FIN_NET_REVENUE)을 끼운 **사본** facts — 원본(캐시)은 건드리지 않는다. */
export function withFinNetRevenue(facts: CompanyFacts): CompanyFacts {
  const g = facts.facts["us-gaap"] ?? {};
  return {
    ...facts,
    facts: {
      ...facts.facts,
      "us-gaap": { ...g, [SYN_NET_REVENUE]: { units: { USD: finNetRevenueEntries(facts) } } },
    },
  } as CompanyFacts;
}
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
