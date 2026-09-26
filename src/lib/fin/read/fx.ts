import "server-only";
import { fxDaily, h10Avg, h10At, h10Pending } from "../source/us/market";
import type { FactIndex } from "../source/us/sec";

/** 기간 평균 환율 입력의 참조 키(파생값 입력 `x` — types.ts DerivedInput) */
export const fxAvgRef = (cur: string, start: string, end: string) => `x:${cur}|avg|${start}|${end}`;

/**
 * 1층 — 환율(architecture.md §1.3). 원천 = 연준 H.10 공식 일별 환율(markets/quote/fred-fx.ts, 오너 결정 2026-09-27):
 *   기간 값(손익) = 그 기간 고시값 산술평균, 시점 값 = 그 날짜 또는 이전 마지막 고시값.
 *   창 끝이 최신 고시일보다 뒤면 null + why() 사유 "H.10 공식 환율 미고시(최신 {날짜})" — 다른 원천으로 대체하지 않는다.
 */

export interface Fx {
  cur: string;
  /** 환율 원천 조회 시각(ISO) — 파생값 입력의 asOf */
  asOf: string;
  /** 최신 고시일(USD 면 null) */
  latest: string | null;
  avg(start: string, end: string): number | null;
  at(date: string): number | null;
  /** 값이 없을 때 사유(미고시 창) — 없으면 null */
  why(end: string): string | null;
}

export async function makeFx(cur: string): Promise<Fx> {
  if (cur === "USD") return { cur, asOf: new Date().toISOString(), latest: null, avg: () => 1, at: () => 1, why: () => null };
  const s = await fxDaily(cur);
  return { cur, asOf: s.fetchedAt, latest: s.latest, avg: (a, b) => h10Avg(s, a, b), at: (d) => h10At(s, d), why: (e) => h10Pending(s, e) };
}

const isCurrency = (u: string) => /^[A-Z]{3}$/.test(u);

/** 보고 통화 — 매출·자산·순이익 개념의 USD 외 통화 단위 중 가장 많은 것(edgar-foreign.ts reportingCurrency 와 같은 판정). */
export function reportingCurrency(idx: FactIndex): string {
  const count = new Map<string, number>();
  const probe = [
    "us-gaap:Revenues", "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", "us-gaap:Assets", "us-gaap:NetIncomeLoss", "us-gaap:ProfitLoss",
    "ifrs-full:Revenue", "ifrs-full:Assets", "ifrs-full:ProfitLoss", "ifrs-full:ProfitLossAttributableToOwnersOfParent",
  ];
  for (const q of probe) for (const f of idx.get(q)) if (isCurrency(f.unit) && f.unit !== "USD") count.set(f.unit, (count.get(f.unit) ?? 0) + 1);
  if (!count.size) return "USD";
  return [...count].sort((a, b) => b[1] - a[1])[0][0];
}
