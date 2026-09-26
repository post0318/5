import "server-only";
import { fxDaily, fxFetchedAt } from "../source/us/market";
import type { FactIndex } from "../source/us/sec";

/** 기간 평균 환율 입력의 참조 키(파생값 입력 `x` — types.ts DerivedInput) */
export const fxAvgRef = (cur: string, start: string, end: string) => `x:${cur}|avg|${start}|${end}`;

/**
 * 1층 — 환율(architecture.md §1). `markets/us/edgar-foreign.ts` 의 규칙을 옮겼다(값 동일):
 *   기간 값(손익) = 그 기간 일별 환율 평균, 시점 값 = 그 날짜(이전 최근 영업일, 10일 안) 환율.
 *   기간 영업일의 30% 미만이면 평균을 믿지 않는다(null).
 */

export interface Fx {
  cur: string;
  /** 환율 원천 조회 시각(ISO) — 파생값 입력의 asOf */
  asOf: string;
  avg(start: string, end: string): number | null;
  at(date: string): number | null;
}

type Series = { date: string; rate: number }[];

function rateAt(s: Series, date: string): number | null {
  let lo = 0, hi = s.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid].date <= date) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best < 0) return null;
  return (Date.parse(date) - Date.parse(s[best].date)) / 864e5 <= 10 ? s[best].rate : null;
}
function avgRate(s: Series, start: string, end: string): number | null {
  let sum = 0, n = 0;
  for (const q of s) if (q.date >= start && q.date <= end) { sum += q.rate; n++; }
  const d = (Date.parse(end) - Date.parse(start)) / 864e5;
  return n > 0 && n >= d * 0.3 ? sum / n : null;
}

export async function makeFx(cur: string): Promise<Fx> {
  if (cur === "USD") return { cur, asOf: new Date().toISOString(), avg: () => 1, at: () => 1 };
  const s = await fxDaily(cur);
  return { cur, asOf: fxFetchedAt(cur) ?? new Date().toISOString(), avg: (a, b) => avgRate(s, a, b), at: (d) => rateAt(s, d) };
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
