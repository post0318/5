/**
 * 1층 — IFRS 개념 → us-gaap 개념 대응(architecture.md §1). `markets/us/edgar-foreign.ts` IFRS_MAP 의 손익계산서 항목을
 * 옮겼다(지표 확장 때 BS·CF 항목을 같은 표에 더한다). 2층은 줄의 **역할**을 붙일 때 `canonical()` 로만 IFRS 를 본다 —
 * 값은 공시 개념 그대로(원본 표현 유지).
 */

const IFRS_TO_GAAP: Record<string, string> = {
  "ifrs-full:Revenue": "us-gaap:Revenues",
  // TSM 2025 20-F 는 Revenue 없이 이 개념만 달았다(edgar-foreign.ts 검증 2026-09-24)
  "ifrs-full:RevenueFromContractsWithCustomers": "us-gaap:Revenues",
  "ifrs-full:CostOfSales": "us-gaap:CostOfRevenue",
  "ifrs-full:GrossProfit": "us-gaap:GrossProfit",
  "ifrs-full:ProfitLossFromOperatingActivities": "us-gaap:OperatingIncomeLoss",
  "ifrs-full:ProfitLossBeforeTax": "us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
  "ifrs-full:IncomeTaxExpenseContinuingOperations": "us-gaap:IncomeTaxExpenseBenefit",
  "ifrs-full:ProfitLoss": "us-gaap:ProfitLoss",
  "ifrs-full:ProfitLossAttributableToOwnersOfParent": "us-gaap:NetIncomeLoss",
};

/** 역할 판정용 표준 이름(us-gaap). IFRS 가 아니면 그대로 */
export function canonical(qname: string): string {
  return IFRS_TO_GAAP[qname] ?? qname;
}

/** us-gaap 개념의 IFRS 대응 개념들(앞이 우선) */
export function ifrsAliases(gaapQ: string): string[] {
  return Object.entries(IFRS_TO_GAAP).filter(([, g]) => g === gaapQ).map(([i]) => i);
}
