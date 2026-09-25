/**
 * 3층 — 회사별 예외(architecture.md §2·§8 S2). **회사별 예외는 이 파일 한 곳.** `evidence`(공시 accn·숫자) 없는 항목은
 * 로드 시 예외를 던진다.
 */

export type OverrideRule =
  /** 총수익(revenue.total)에서 비영업 수익(지분법·기타수익, revenue.nonop)을 뺀 영업 매출 */
  | "revenue-excl-nonop";

export interface Override {
  symbol: string;
  metric: "revenue";
  rule: OverrideRule;
  /** 공시 accn 과 숫자로 된 근거 */
  evidence: string;
  since: string;
}

export const OVERRIDES: Override[] = [
  {
    symbol: "XOM",
    metric: "revenue",
    rule: "revenue-excl-nonop",
    evidence:
      "10-K FY2024 accn 0000034088-25-000010: us-gaap:Revenues(총수익·기타수익 포함) 349,585백만 = 매출및기타영업수익 339,247 + " +
      "지분법 이익·기타수익(srt:ProductOrServiceAxis 비영업 멤버 합, 인스턴스) 10,338(공시 원본 재확인 2026-09-25). Yahoo·StockAnalysis·MarketScreener·인포맥스 매출 = 339,247(edgar-revenue-dims.ts 검증 2026-09-24)",
    since: "2026-09-24",
  },
  {
    symbol: "CVX",
    metric: "revenue",
    rule: "revenue-excl-nonop",
    evidence:
      "10-K FY2024 accn 0000093410-25-000009: us-gaap:Revenues(Total revenues and other income) 202,792백만 = 고객계약 매출 193,414 + " +
      "지분법 이익(cvx:EquityMethodInvestmentIncome) 4,596 + 기타수익(cvx:NonoperatingIncome) 4,782 — 총수익 − 고객계약 매출 = 회사 고유 비영업 줄 합" +
      "(edgar-revenue-dims.ts 구조 확인 2026-09-24, 공시 원본 재확인 2026-09-25)",
    since: "2026-09-24",
  },
];

const ACCN = /\d{10}-\d{2}-\d{6}/;
for (const o of OVERRIDES)
  if (!ACCN.test(o.evidence) || !/\d{3},\d{3}/.test(o.evidence))
    throw new Error(`metrics/overrides.ts: ${o.symbol} ${o.metric} 예외에 공시 accn·숫자 근거가 없습니다(S2)`);

export function overrideFor(symbol: string, metric: Override["metric"]): Override | null {
  return OVERRIDES.find((o) => o.symbol === symbol.toUpperCase() && o.metric === metric) ?? null;
}
