import type { YahooFundamentalsRow } from "../source/us/market";
import type { Fx } from "./fx";

/**
 * 1층 — 20-F·40-F 제출사 LTM = Yahoo 분기(원통화) 최근 4개 분기(architecture.md §9, revenue.md §2).
 * `markets/us/edgar-yahoo-quarters.ts` 의 규칙을 옮겼다(값 동일):
 *  - SEC 최근 사업연도 결산일(달 말) 뒤의 Yahoo 분기 1~3개 + 그 사업연도 안 꼬리 분기 → 최근 4개 분기
 *  - 항목마다 연간 경계 확인: Yahoo 연간(SEC FY 말일) = SEC FY(원통화, 공시 단위 안). 다르면 그 항목 LTM 공란
 *  - 분기마다 그 분기 평균 환율로 USD 환산 후 합(흐름)
 * 20-F 는 분기 XBRL 이 없어 이 구조적 제약은 설계로도 해소되지 않는다(architecture.md §9).
 */

/** 표준(us-gaap) 개념 → Yahoo 필드 — 손익계산서 흐름 항목만(edgar-yahoo-quarters.ts FLOWS 와 같은 대응) */
export const YAHOO_FIELD: Record<string, string> = {
  "us-gaap:Revenues": "totalRevenue",
  "us-gaap:CostOfRevenue": "costOfRevenue",
  "us-gaap:GrossProfit": "grossProfit",
  "us-gaap:OperatingIncomeLoss": "totalOperatingIncomeAsReported",
  "us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest": "pretaxIncome",
  "us-gaap:IncomeTaxExpenseBenefit": "taxProvision",
  "us-gaap:NetIncomeLoss": "netIncome",
  "us-gaap:ProfitLoss": "netIncomeIncludingNoncontrollingInterests",
};

const DAY = 864e5;
const span = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / DAY;
const addDay = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const monthEndShift = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + n + 1, 0)).toISOString().slice(0, 10);
};
const isMonthEnd = (d: string) => monthEndShift(d, 0) === d;

/** 공시 단위 안에서 같은가 — edgar-yahoo-quarters.ts sameInUnit 과 같음 */
export function sameInUnit(sec: number, yv: number): boolean {
  const r = Math.round(Math.abs(sec));
  let unit = 1;
  while (unit < 1e6 && r !== 0 && r % (unit * 10) === 0) unit *= 10;
  return Math.abs(sec - yv) < unit + Math.abs(sec) * 1e-9;
}

export type YahooLtm =
  | { ok: true; usd: number; start: string; through: string; quarters: string[] }
  | { ok: false; reason: string };

/**
 * 한 항목의 Yahoo 분기 LTM. fyOrig = SEC 최근 사업연도 값(원통화), fyEnd = 그 결산일.
 */
export function yahooLtmOf(
  y: { quarterly: YahooFundamentalsRow[]; annual: YahooFundamentalsRow[] },
  field: string,
  fyOrig: number,
  fyEnd: string,
  fx: Fx,
): YahooLtm {
  const E = fyEnd;
  if (!isMonthEnd(E)) return { ok: false, reason: "달 말 결산 아님" };
  const qBy = new Map(y.quarterly.map((r) => [r.end, r.values]));
  const ya = y.annual.find((r) => Math.abs(span(r.end, E)) <= 10)?.values;
  if (!ya) return { ok: false, reason: `Yahoo FY${E.slice(0, 4)} 연간 없음 — 연간 경계 확인 불가` };
  const newQ: string[] = [];
  for (let i = 1; i <= 4 && qBy.has(monthEndShift(E, 3 * i)); i++) newQ.push(monthEndShift(E, 3 * i));
  if (!newQ.length) return { ok: false, reason: "Yahoo 에 SEC 사업연도 이후 분기 없음 — LTM = SEC 사업연도" };
  if (newQ.length >= 4) return { ok: false, reason: "Yahoo 분기가 SEC 연간보다 1년 이상 앞섬 — 새 연간 공시 대기" };
  const k = newQ.length;
  const tail: string[] = [];
  for (let j = 3 - k; j >= 0; j--) tail.push(monthEndShift(E, -3 * j));
  const last4 = [...tail, ...newQ];
  const yA = ya[field];
  if (yA == null) return { ok: false, reason: "Yahoo 연간 없음" };
  if (!sameInUnit(fyOrig, yA)) return { ok: false, reason: `Yahoo 연간 ≠ SEC FY(정의 차이) — SEC ${Math.round(fyOrig)} vs Yahoo ${Math.round(yA)}` };
  const missing = last4.filter((d) => qBy.get(d)?.[field] == null);
  if (missing.length) return { ok: false, reason: `Yahoo 분기 결측(${missing.join("·")})` };
  let usd = 0;
  for (const d of last4) {
    const r = fx.avg(addDay(monthEndShift(d, -3), 1), d);
    if (r == null) return { ok: false, reason: `환율 없음(${d} 분기)` };
    usd += qBy.get(d)![field] * r;
  }
  return { ok: true, usd, start: addDay(monthEndShift(last4[0], -3), 1), through: newQ[k - 1], quarters: last4 };
}
