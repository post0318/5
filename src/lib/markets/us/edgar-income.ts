import "server-only";
import type { CompanyFacts } from "./edgar";
import type { FinancialStatement, FinancialLineItem, FinancialPeriod } from "../types";
import {
  annualByYear,
  annualEnds,
  firstConcept,
  recentQuarters,
  singleQuarter,
  ttmOf,
} from "./edgar-series";

/**
 * 미국 상세 손익계산서 — SEC EDGAR companyfacts 정규화 재분류 (블룸버그 I/S 근사).
 * 컬럼: 최근 5개 사업연도 + 최근 12개월 (분기 모드는 최근 5분기).
 * 계산 라인('기타 영업비용' 등)은 (구간값 − 매핑 라인)으로 자동 정합.
 * 예상치는 재무 하이라이트(개요)에서 제공 → 여기선 실적만.
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
const NET_INCOME = ["NetIncomeLoss"];
const EPS_BASIC = ["EarningsPerShareBasic", "EarningsPerShareBasicAndDiluted"];
const EPS_DIL = ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"];
const NONOP = ["NonoperatingIncomeExpense", "OtherNonoperatingIncomeExpense"];
const INT_EXP = [
  "InterestExpense",
  "InterestExpenseNonoperating",
  "InterestAndDebtExpense",
  "InterestExpenseDebt",
];
const INT_INC = [
  "InvestmentIncomeInterestAndDividend",
  "InvestmentIncomeInterest",
  "InterestAndDividendIncomeOperating",
  "InterestIncomeOperating",
  "InterestIncomeNonoperating",
];
const DA = [
  "DepreciationDepletionAndAmortization",
  "DepreciationAmortizationAndAccretionNet",
  "DepreciationAndAmortization",
];

const LTM = "현재/LTM";
const fyKey = (y: number) => `${y}Y`;

export function buildUsIncome(
  facts: CompanyFacts,
  mode: "annual" | "quarter" = "annual",
): FinancialStatement {
  const revEntries = firstConcept(facts, REVENUE);
  const quarterly = mode === "quarter";

  const years = [...annualByYear(revEntries).keys()].sort((a, b) => a - b).slice(-5);
  const ends = annualEnds(revEntries);
  const lastFy = years[years.length - 1] ?? new Date().getFullYear();
  // 6개 확보 → 가장 오래된 1개는 YTD 차감용 prev 로만 쓰고 표시는 5개
  const qCols = quarterly ? [...recentQuarters(revEntries, 6)].reverse() : [];
  const qShow = qCols.slice(-5);

  let periods: FinancialPeriod[];
  if (quarterly) {
    periods = qShow.map((q) => ({
      label: q.label,
      fiscalYear: Number(q.label.slice(0, 4)),
      fiscalQuarter: Number(q.label.slice(-1)) || null,
      endDate: q.end,
    }));
  } else {
    periods = years.map((y) => ({
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
  }
  const labels = periods.map((p) => p.label);

  const blank = (): Record<string, number | null> =>
    Object.fromEntries(labels.map((l) => [l, null]));

  const val = (concepts: string[], unit = "USD"): Record<string, number | null> => {
    const e = firstConcept(facts, concepts, unit);
    const out = blank();
    if (quarterly) {
      qCols.forEach((q, i) => {
        if (i === 0) return; // prev 전용
        out[q.label] = singleQuarter(e, q, qCols[i - 1]);
      });
      return out;
    }
    const ann = annualByYear(e);
    for (const y of years) out[fyKey(y)] = ann.get(y) ?? null;
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
  // (−)영업외손익 = 영업외 순손실 (양수 = 손실 → 세전이익에서 차감, 음수 = 이익)
  const nonOpLoss = (() => {
    const n = val(NONOP); // EDGAR: 양수 = 순이익
    for (const l of labels)
      if (n[l] == null && pretax[l] != null && opIncome[l] != null)
        n[l] = pretax[l]! - opIncome[l]!;
    const out = blank();
    for (const l of labels) if (n[l] != null) out[l] = -n[l]!;
    return out;
  })();
  // 순이자손익(−) = 이자비용 − 이자수익 (양수 = 순이자 부담, 음수 = 순이자 이익)
  const intInc = val(INT_INC);
  const intExp = val(INT_EXP);
  const netIntCost = blank();
  for (const l of labels) {
    if (intExp[l] == null && intInc[l] == null) continue;
    netIntCost[l] = (intExp[l] ?? 0) - (intInc[l] ?? 0);
  }
  // 최근 데이터가 없으면(예: 회사가 이자 항목 별도 표시 중단) LTM 공란
  const recentIso = new Date(Date.now() - 500 * 864e5).toISOString().slice(0, 10);
  const intFresh = [...INT_EXP, ...INT_INC].some((c) =>
    firstConcept(facts, [c]).some((e) => e.end >= recentIso),
  );
  if (!intFresh && LTM in netIntCost) netIntCost[LTM] = null;
  const hasInterest = labels.some((l) => netIntCost[l] != null);
  const tax = val(TAX);
  const netIncome = val(NET_INCOME);
  // (−) 기타 = (세전이익 − 법인세비용) − 공시 당기순이익 (중단사업·소수주주지분 등)
  const otherToNi = blank();
  for (const l of labels)
    if (pretax[l] != null && tax[l] != null && netIncome[l] != null)
      otherToNi[l] = Math.round(pretax[l]! - tax[l]! - netIncome[l]!);
  const epsBasic = val(EPS_BASIC, "USD/shares");
  const epsDil = val(EPS_DIL, "USD/shares");

  const da = val(DA);
  const ebitda = blank();
  for (const l of labels)
    if (opIncome[l] != null) ebitda[l] = opIncome[l]! + (da[l] ?? 0);
  const divPaid = val(["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"]);

  const pct = (a: Record<string, number | null>) => {
    const out = blank();
    for (const l of labels)
      if (a[l] != null && revenue[l]) out[l] = (a[l]! / revenue[l]!) * 100;
    return out;
  };
  // 전기 대비 증가율 (연간 모드만 — 분기 QoQ 는 의미 약함)
  const yoy = (a: Record<string, number | null>): Record<string, number | null> => {
    const out = blank();
    if (quarterly) return out;
    for (let i = 1; i < labels.length; i++) {
      const c = a[labels[i]];
      const p = a[labels[i - 1]];
      if (c != null && p != null && p !== 0) out[labels[i]] = ((c - p) / Math.abs(p)) * 100;
    }
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
    row("(−) 매출원가", cogs),
    row("매출총이익", grossProfit, { depth: 0, isSubtotal: true, isHighlight: true }),
    row("(−) 판매관리비", sga),
    row("(−) 연구개발비", rnd),
    row("(−) 기타 영업비용", otherOpex),
    row("영업이익", opIncome, { depth: 0, isSubtotal: true, isHighlight: true }),
    row("(−) 영업외손익", nonOpLoss),
    ...(hasInterest
      ? [row("(순이자비용)", netIntCost, { depth: 2, italic: true, paren: true })]
      : []),
    row("세전이익", pretax, { depth: 0, isSubtotal: true }),
    row("(−) 법인세비용", tax),
    row("(−) 기타", otherToNi),
    row("당기순이익", netIncome, { depth: 0, isSubtotal: true, isHighlight: true }),
    row("기본 EPS", epsBasic, { numberFormat: "eps" }),
    row("희석 EPS", epsDil, { numberFormat: "eps" }),
    { accountName: "", accountId: "is:sp", depth: 0, isSubtotal: false, isHighlight: false, values: blank() },
    row("[ 주석 항목 ]", blank(), { depth: 0, isSubtotal: true }),
    row("EBITDA", ebitda),
    row("성장률 (YoY)", yoy(ebitda), { numberFormat: "pct", depth: 2 }),
    row("EBIT (영업이익)", opIncome),
    row("성장률 (YoY)", yoy(opIncome), { numberFormat: "pct", depth: 2 }),
    row("매출총이익률", pct(grossProfit), { numberFormat: "pct" }),
    row("영업이익률", pct(opIncome), { numberFormat: "pct" }),
    row("순이익률", pct(netIncome), { numberFormat: "pct" }),
    row("감가상각비", da),
    row("배당금 총액", divPaid),
    row("성장률 (YoY)", yoy(divPaid), { numberFormat: "pct", depth: 2 }),
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
    source: "SEC EDGAR · 표준화 재분류",
  };
}
