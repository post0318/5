import "server-only";
import type { CompanyFacts } from "./edgar";
import type { FinancialStatement, FinancialLineItem, FinancialPeriod } from "../types";
import { annualByYear, annualEnds, firstConcept, ttmOf } from "./edgar-series";

/**
 * 미국 상세 손익계산서 — SEC EDGAR companyfacts 정규화 재분류 (블룸버그 I/S 근사).
 * 컬럼: 최근 5개 사업연도 + 최근 12개월 + 차기 2개년(수익·EPS 만).
 * 계산 라인('기타 영업비용' 등)은 (구간값 − 매핑 라인)으로 자동 정합.
 */

const REVENUE = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "Revenues",
  "SalesRevenueNet",
];
const COGS = ["CostOfGoodsAndServicesSold", "CostOfRevenue", "CostOfGoodsSold"];
const OPEX = ["OperatingExpenses", "CostsAndExpenses"];
const SGA = [
  "SellingGeneralAndAdministrativeExpense",
  "GeneralAndAdministrativeExpense",
];
const RND = ["ResearchAndDevelopmentExpense"];
const OP_INCOME = ["OperatingIncomeLoss"];
const PRETAX = [
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
];
const TAX = ["IncomeTaxExpenseBenefit"];
const DISC_OPS = ["IncomeLossFromDiscontinuedOperationsNetOfTax"];
const NCI = ["NetIncomeLossAttributableToNoncontrollingInterest"];
const NET_INCOME = ["NetIncomeLoss"];
const WA_BASIC = [
  "WeightedAverageNumberOfSharesOutstandingBasic",
  "WeightedAverageNumberOfShareOutstandingBasicAndDiluted",
];
const WA_DIL = [
  "WeightedAverageNumberOfDilutedSharesOutstanding",
  "WeightedAverageNumberOfShareOutstandingBasicAndDiluted",
];
const EPS_BASIC = ["EarningsPerShareBasic", "EarningsPerShareBasicAndDiluted"];
const EPS_DIL = ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"];
const NONOP = ["NonoperatingIncomeExpense", "OtherNonoperatingIncomeExpense"];
const DA = [
  "DepreciationDepletionAndAmortization",
  "DepreciationAmortizationAndAccretionNet",
  "DepreciationAndAmortization",
];

export interface IncomeEstimatePeriod {
  period: string;
  endDate: string | null;
  epsAvg: number | null;
  revenueAvg: number | null;
}

const LTM = "현재/LTM";
const fyKey = (y: number) => `${y}Y`;
const estKey = (y: number) => `${y}Y 예상`;

export function buildUsIncome(
  facts: CompanyFacts,
  estimates: IncomeEstimatePeriod[],
): FinancialStatement {
  const revEntries = firstConcept(facts, REVENUE);
  const years = [...annualByYear(revEntries).keys()].sort((a, b) => a - b).slice(-5);
  const ends = annualEnds(revEntries);
  const lastFy = years[years.length - 1] ?? new Date().getFullYear();

  const periods: FinancialPeriod[] = years.map((y) => ({
    label: fyKey(y),
    fiscalYear: y,
    fiscalQuarter: null,
    endDate: ends.get(y) ?? `${y}-12-31`,
  }));
  periods.push({
    label: LTM,
    fiscalYear: lastFy + 1,
    fiscalQuarter: null,
    endDate: new Date().toISOString().slice(0, 10),
  });
  const estCols: { year: number; p: IncomeEstimatePeriod }[] = [];
  for (const p of estimates) {
    if (!["0y", "+1y", "+2y"].includes(p.period)) continue;
    const y = p.endDate ? Number(p.endDate.slice(0, 4)) : null;
    if (y == null || y <= lastFy || estCols.some((e) => e.year === y)) continue;
    estCols.push({ year: y, p });
  }
  estCols.sort((a, b) => a.year - b.year);
  for (const e of estCols.slice(0, 2))
    periods.push({
      label: estKey(e.year),
      fiscalYear: e.year,
      fiscalQuarter: null,
      endDate: e.p.endDate,
    });
  const labels = periods.map((p) => p.label);

  const blank = (): Record<string, number | null> =>
    Object.fromEntries(labels.map((l) => [l, null]));

  /** FY + LTM 값 (추정 컬럼은 null). */
  const val = (concepts: string[], unit = "USD"): Record<string, number | null> => {
    const e = firstConcept(facts, concepts, unit);
    const ann = annualByYear(e);
    const out = blank();
    for (const y of years) out[fyKey(y)] = ann.get(y) ?? null;
    // 순간값(EPS 등)은 ttmOf 가 FY 폴백 → 무방
    out[LTM] = ttmOf(e);
    return out;
  };
  const diff = (
    a: Record<string, number | null>,
    ...subs: Record<string, number | null>[]
  ): Record<string, number | null> => {
    const out = blank();
    for (const l of labels) {
      if (a[l] == null) continue;
      let x = a[l]!;
      let ok = true;
      for (const s of subs) {
        if (s[l] == null) {
          ok = false;
          break;
        }
        x -= s[l]!;
      }
      out[l] = ok ? Math.round(x) : null;
    }
    return out;
  };

  const revenue = val(REVENUE);
  // 추정 매출
  for (const e of estCols.slice(0, 2)) revenue[estKey(e.year)] = e.p.revenueAvg ?? null;

  const cogs = val(COGS);
  const grossProfit = (() => {
    const g = val(["GrossProfit"]);
    for (const l of labels)
      if (g[l] == null && revenue[l] != null && cogs[l] != null) g[l] = revenue[l]! - cogs[l]!;
    return g;
  })();
  const sga = val(SGA);
  const rnd = val(RND);
  const opex = val(OPEX);
  const opIncome = val(OP_INCOME);
  // 기타 영업비용 = OPEX − SGA − RND, 없으면 GrossProfit − OpIncome − SGA − RND
  const otherOpex = (() => {
    const base = labels.some((l) => opex[l] != null)
      ? opex
      : diff(grossProfit, opIncome);
    return diff(base, sga, rnd);
  })();
  const pretax = val(PRETAX);
  const nonOp = (() => {
    const n = val(NONOP);
    // 없으면 세전 − 영업이익
    for (const l of labels)
      if (n[l] == null && pretax[l] != null && opIncome[l] != null)
        n[l] = pretax[l]! - opIncome[l]!;
    return n;
  })();
  const tax = val(TAX);
  const contOps = diff(pretax, tax);
  const disc = val(DISC_OPS);
  const nci = val(NCI);
  const netIncome = val(NET_INCOME);
  for (const e of estCols.slice(0, 2)) {
    // 추정 순이익 = EPS × 희석주식수(최근)
    const sh = val(WA_DIL, "shares")[LTM];
    if (e.p.epsAvg != null && sh) netIncome[estKey(e.year)] = e.p.epsAvg * sh;
  }
  const waBasic = val(WA_BASIC, "shares");
  const waDil = val(WA_DIL, "shares");
  const epsBasic = val(EPS_BASIC, "USD/shares");
  const epsDil = val(EPS_DIL, "USD/shares");
  for (const e of estCols.slice(0, 2)) {
    epsBasic[estKey(e.year)] = e.p.epsAvg ?? null;
    epsDil[estKey(e.year)] = e.p.epsAvg ?? null;
  }

  const da = val(DA);
  const ebitda = blank();
  for (const l of labels)
    if (opIncome[l] != null) ebitda[l] = opIncome[l]! + (da[l] ?? 0);

  const pct = (a: Record<string, number | null>) => {
    const out = blank();
    for (const l of labels)
      if (a[l] != null && revenue[l]) out[l] = (a[l]! / revenue[l]!) * 100;
    return out;
  };

  const row = (
    label: string,
    values: Record<string, number | null>,
    opts: Partial<FinancialLineItem> = {},
  ): FinancialLineItem => ({
    accountName: label,
    accountId: `is:${label}`,
    depth: 1,
    isSubtotal: false,
    isHighlight: false,
    values,
    ...opts,
  });

  const items: FinancialLineItem[] = [
    row("매출액", revenue, { depth: 0, isSubtotal: true, isHighlight: true }),
    row("매출원가", cogs),
    row("매출총이익", grossProfit, { depth: 0, isSubtotal: true, isHighlight: true }),
    row("판매관리비", sga),
    row("연구개발비", rnd),
    row("기타 영업비용", otherOpex),
    row("영업이익", opIncome, { depth: 0, isSubtotal: true, isHighlight: true }),
    row("영업외손익", nonOp),
    row("세전이익", pretax, { depth: 0, isSubtotal: true }),
    row("법인세비용", tax),
    row("계속사업이익", contOps, { depth: 0, isSubtotal: true }),
    row("중단사업손익", disc),
    row("소수주주지분", nci),
    row("당기순이익", netIncome, { depth: 0, isSubtotal: true, isHighlight: true }),
    row("기본 가중평균주식수", waBasic, { numberFormat: "shares" }),
    row("기본 EPS", epsBasic, { numberFormat: "eps" }),
    row("희석 가중평균주식수", waDil, { numberFormat: "shares" }),
    row("희석 EPS", epsDil, { numberFormat: "eps" }),
    { accountName: "", accountId: "is:sp", depth: 0, isSubtotal: false, isHighlight: false, values: blank() },
    row("EBITDA", ebitda),
    row("EBITDA 마진", pct(ebitda), { numberFormat: "pct", depth: 2 }),
    row("매출총이익률", pct(grossProfit), { numberFormat: "pct", depth: 2 }),
    row("영업이익률", pct(opIncome), { numberFormat: "pct", depth: 2 }),
    row("순이익률", pct(netIncome), { numberFormat: "pct", depth: 2 }),
  ];

  return {
    symbol: "",
    market: "us",
    periodType: "annual",
    unit: "USD",
    currency: "USD",
    consolidation: "consolidated",
    periods,
    sections: [{ title: "손익계산서", items }],
    source: "SEC EDGAR · 표준화 재분류 · 추정 yahoo-finance2",
  };
}
