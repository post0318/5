import "server-only";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import type { FinancialStatement, FinancialLineItem, FinancialPeriod } from "../types";
import type { QuoteBar } from "../types";
import {
  annualByYear,
  annualEnds,
  days,
  entriesOf,
  firstConcept,
  instantByYear,
  latestInstant,
  shiftYear,
  splitFactorsByYear,
  ttmOf,
} from "./edgar-series";
import {
  classAEps,
  classALatest,
  classAOutstanding,
  classAOutstandingLatest,
  classAShares,
  type ClassAFacts,
} from "./edgar-classfacts";
import {
  FIN_NET_REVENUE,
  FIN_NONINTEREST_EXPENSE,
  FIN_PROVISION,
  isFinancialCompany,
} from "./edgar-financial";

/**
 * 미국 분석 지표 — 밸류에이션·수익성·현금창출·재무건전성·주주환원·성장성.
 * SEC EDGAR companyfacts + 시세(bars). 컬럼: 최근 5개 사업연도 + 현재/LTM.
 */

const LTM = "현재/LTM";
const REV = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "Revenues",
];
// 당기순이익 — CAT 등은 NetIncomeLoss 대신 ProfitLoss 사용
const NI_C = [
  "NetIncomeLoss",
  "ProfitLoss",
  "NetIncomeLossAvailableToCommonStockholdersBasic",
];
const DA = [
  "DepreciationDepletionAndAmortization",
  "DepreciationAmortizationAndAccretionNet",
  "DepreciationAndAmortization",
];
const PRETAX_C = [
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesAndExtraordinaryItemsNoncontrollingInterest",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndEquityMethodInvestments",
];
const INT_EXP = [
  "InterestExpense",
  "InterestExpenseNonoperating",
  "InterestExpenseOperating",
  "InterestAndDebtExpense",
  "InterestExpenseNet",
  "InterestExpenseDebt",
];
// 총이자 개념이 없을 때 현금 이자지급액을 대용 (DAL·CAT 등)
const INT_EXP_PROXY = ["InterestPaidNet", "InterestPaid"];
// 총차입금 = 이자부 차입금 + 리스부채 (블룸버그 'Total Debt' 기준, IFRS16/ASC842).
// ※ 한국식 '부채비율'의 부채총계(Liabilities)와 다름 — 이건 이자 내는 빚만.
// (실제 개념 목록은 debtComponent/sumParts 로 유동·비유동 분리/미분류 폴백 처리)
const CASH_C = [
  "CashAndCashEquivalentsAtCarryingValue",
  "MarketableSecuritiesCurrent",
  "ShortTermInvestments",
  "DebtSecuritiesCurrent",
  "DebtSecuritiesAvailableForSaleExcludingAccruedInterestCurrent",
  "MarketableSecuritiesNoncurrent",
  "LongTermInvestments",
  "DebtSecuritiesNoncurrent",
];
// 유동성 지표용 현금 (장기 투자자산 제외 — 순부채용 CASH_C 와 다름)
const CASH_CUR = [
  "CashAndCashEquivalentsAtCarryingValue",
  "MarketableSecuritiesCurrent",
  "ShortTermInvestments",
  "DebtSecuritiesCurrent",
  "DebtSecuritiesAvailableForSaleExcludingAccruedInterestCurrent",
];

function closeOnOrBefore(bars: QuoteBar[], iso: string): number | null {
  let best: number | null = null;
  for (const b of bars) if (b.date <= iso && b.close != null) best = b.close;
  return best;
}

export function buildUsAnalysis(
  facts: CompanyFacts,
  bars: QuoteBar[],
  opts: { sharesHint?: number | null; classFacts?: ClassAFacts | null; sic?: string | null } = {},
): FinancialStatement {
  // EPS·발행주식수를 클래스별로만 태깅해 undimensioned 값이 없는 기업(Visa 등)은
  // 10-K XBRL 인스턴스에서 뽑은 Class A 실측값(classFacts) 우선, 없으면
  // 현재 시가총액÷주가(또는 quote.sharesOutstanding)를 "현재 주식수" 근사로 사용.
  const sharesHint = opts.sharesHint ?? null;
  const classFacts = opts.classFacts ?? null;
  // 금융회사(은행·카드사) — 매출 대신 순수익(이자비용 차감), 매출총이익 대신 충당금전이익 사용.
  const isFin = isFinancialCompany(facts, opts.sic ?? null);
  const revConcepts = isFin ? FIN_NET_REVENUE : REV;
  let approxPerShare = false;
  // 개념 태그가 시기에 따라 바뀌는 기업(NVIDIA: RevenueFromContract…→Revenues,
  // 메타: InterestExpense→InterestExpenseNonoperating 등)이 많아, 단일 개념이 아니라
  // 나열된 개념들을 "연도별로 첫 유효값" 규칙으로 병합한다.
  const mergedAnnual = (concepts: string[], unit = "USD"): Map<number, number> => {
    const maps = concepts.map((c) => annualByYear(entriesOf(facts, c, unit)));
    const out = new Map<number, number>();
    for (const m of maps) for (const [y, v] of m) if (!out.has(y)) out.set(y, v);
    return out;
  };
  const mergedEnds = (concepts: string[], unit = "USD"): Map<number, string> => {
    const out = new Map<number, string>();
    for (const c of concepts)
      for (const [y, d] of annualEnds(entriesOf(facts, c, unit))) if (!out.has(y)) out.set(y, d);
    return out;
  };

  const years = [...mergedAnnual(revConcepts).keys()].sort((a, b) => a - b).slice(-5);
  const ends = mergedEnds(revConcepts);
  const lastBar = [...bars].reverse().find((b) => b.close != null);
  const nowIso = lastBar?.date ?? new Date().toISOString().slice(0, 10);

  const periods: FinancialPeriod[] = years.map((y) => ({
    label: `${y}Y`,
    fiscalYear: y,
    fiscalQuarter: null,
    endDate: ends.get(y) ?? `${y}-12-31`,
  }));
  periods.push({ label: LTM, fiscalYear: (years.at(-1) ?? 0) + 1, fiscalQuarter: null, endDate: nowIso });
  const labels = periods.map((p) => p.label);
  const blank = (): Record<string, number | null> => Object.fromEntries(labels.map((l) => [l, null]));

  // 여러 개념 중 가장 최근 데이터가 있는 개념의 TTM (태그 이전 후 과거 개념의 옛 FY값이
  // 잡히는 것 방지 — NVIDIA RevenueFromContract… 는 FY2022 에서 끊김)
  const bestTtm = (concepts: string[], unit = "USD"): number | null => {
    let best: number | null = null;
    let bestEnd = "";
    for (const c of concepts) {
      const es = entriesOf(facts, c, unit);
      if (!es.length) continue;
      const maxEnd = es.reduce((m, e) => (e.end > m ? e.end : m), "");
      if (maxEnd > bestEnd) {
        bestEnd = maxEnd;
        best = ttmOf(es);
      }
    }
    return best;
  };
  // 흐름값: FY → 연간(개념 병합), LTM → TTM(최근 개념)
  const flow = (concepts: string[], unit = "USD"): Record<string, number | null> => {
    const ann = mergedAnnual(concepts, unit);
    const o = blank();
    for (const y of years) o[`${y}Y`] = ann.get(y) ?? null;
    o[LTM] = bestTtm(concepts, unit);
    return o;
  };
  const flowM = flow;
  /** 전체 연도 시계열 (CAGR용). */
  const fullAnnual = (concepts: string[], unit = "USD") => mergedAnnual(concepts, unit);
  // 잔액값 (단일 개념 우선 목록)
  const stock = (concepts: string[]): Record<string, number | null> => {
    const e = firstConcept(facts, concepts);
    const ann = instantByYear(e);
    const o = blank();
    for (const y of years) o[`${y}Y`] = ann.get(y) ?? null;
    o[LTM] = latestInstant(e);
    return o;
  };
  const stockSum = (list: string[]): Record<string, number | null> => {
    const o = blank();
    for (const c of list) {
      const v = stock([c]);
      for (const l of labels) if (v[l] != null) o[l] = (o[l] ?? 0) + v[l]!;
    }
    return o;
  };
  /**
   * 유동/비유동으로 분리 태깅하는 회사는 분리값 합, 미분류(단일 총액)로만 태깅하는
   * 회사(금융사 등 — LongTermDebt·OperatingLeaseLiability 단일 라인)는 그 총액으로 폴백.
   * 기간별로 독립 판정 — 같은 회사도 연도에 따라 태깅 방식이 바뀔 수 있어서.
   */
  const debtComponent = (
    splitConcepts: string[],
    unclassifiedConcept: string,
  ): Record<string, number | null> => {
    const split = stockSum(splitConcepts);
    const total = stock([unclassifiedConcept]);
    const o = blank();
    for (const l of labels) o[l] = split[l] ?? total[l];
    return o;
  };

  // 액면분할 보정 계수 (소급 재작성 안 된 과거 연도의 주당 지표를 최신 연도 기준으로 환산)
  const splitF = splitFactorsByYear(facts);
  const adjPerShare = (o: Record<string, number | null>): Record<string, number | null> => {
    const r = { ...o };
    for (const y of years) {
      const f = splitF.get(y);
      if (f != null && f !== 1 && r[`${y}Y`] != null) r[`${y}Y`] = r[`${y}Y`]! * f;
    }
    return r;
  };
  const adjMap = (m: Map<number, number>): Map<number, number> => {
    const out = new Map<number, number>();
    for (const [y, v] of m) out.set(y, v * (splitF.get(y) ?? 1));
    return out;
  };

  // 여러 개념을 기간별로 합산 (Depreciation + AmortizationOfIntangibleAssets 등).
  const combineFlow = (concepts: string[], unit = "USD") => {
    const o = blank();
    for (const c of concepts) {
      const v = flow([c], unit);
      for (const l of labels) if (v[l] != null) o[l] = (o[l] ?? 0) + v[l]!;
    }
    return o;
  };

  const revenue = flow(revConcepts);
  const grossProfitRaw = flow(["GrossProfit"]);
  const cogs0 = flowM(["CostOfGoodsAndServicesSold", "CostOfRevenue", "CostOfGoodsSold"]);
  const sga = flow([
    "SellingGeneralAndAdministrativeExpense",
    "GeneralAndAdministrativeExpense",
    "SellingGeneralAndAdministrativeExpenses",
  ]);
  const rnd = flow(["ResearchAndDevelopmentExpense"]);
  // 금융회사(은행·카드사): 매출총이익 대신 충당금전이익(=순수익 − 총이자외비용).
  const finNoninterestExpense = flow(FIN_NONINTEREST_EXPENSE);
  const finProvision = flow(FIN_PROVISION);
  const grossProfit0 = blank();
  for (const l of labels)
    grossProfit0[l] = isFin
      ? (revenue[l] != null && finNoninterestExpense[l] != null
          ? revenue[l]! - finNoninterestExpense[l]!
          : null)
      : (grossProfitRaw[l] ??
        (revenue[l] != null && cogs0[l] != null ? revenue[l]! - Math.abs(cogs0[l]!) : null));
  // 영업이익: 금융회사는 충당금전이익 − 대손충당금. 그 외는 공시 태그,
  // 없으면 매출총이익 − 판관비 − 연구개발비 (IBM 등)
  const opIncome = (() => {
    const o = blank();
    if (isFin) {
      for (const l of labels)
        if (grossProfit0[l] != null) o[l] = grossProfit0[l]! - (finProvision[l] ?? 0);
      return o;
    }
    const primary = flow(["OperatingIncomeLoss", "OperatingIncomeLossBeforeUnusualItems"]);
    for (const l of labels) {
      if (primary[l] != null) { o[l] = primary[l]; continue; }
      if (grossProfit0[l] != null && (sga[l] != null || rnd[l] != null))
        o[l] = grossProfit0[l]! - (sga[l] ?? 0) - (rnd[l] ?? 0);
    }
    return o;
  })();
  const netIncome = flow(NI_C);
  const EPS_C = [
    "EarningsPerShareDiluted",
    "IncomeLossFromContinuingOperationsPerDilutedShare",
    "EarningsPerShareBasicAndDiluted",
    "EarningsPerShareBasic",
  ];
  // 희석주식수 (EPS 태그가 클래스 차원에만 있는 기업[Visa 등] 파생용)
  const dilSharesF = fullAnnual(
    ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfSharesOutstandingBasic"],
    "shares",
  );
  const eps = (() => {
    const o = adjPerShare(flow(EPS_C, "USD/shares"));
    const niF = fullAnnual(NI_C);
    for (const l of labels) {
      if (o[l] != null) continue;
      if (l === LTM) {
        // LTM 은 TTM 순이익 ÷ 최신 주식수 (Class A as-converted 우선)
        const ni = netIncome[LTM];
        const dcl =
          dilSharesF.get(years.at(-1) ?? 0) ?? classALatest(classFacts)?.dilShares ?? null;
        const sh = dcl ?? sharesHint;
        if (ni != null && sh) {
          o[l] = ni / sh;
          if (dcl == null) approxPerShare = true;
        }
        continue;
      }
      const y = Number(l.replace("Y", ""));
      // Class A 공시 EPS (실측) — 근사 아님
      const ca = classAEps(classFacts, y, "diluted");
      if (ca != null) {
        o[l] = ca;
        continue;
      }
      const dcl = dilSharesF.get(y) ?? classAShares(classFacts, y);
      const sh = dcl ?? sharesHint;
      if (niF.get(y) != null && sh) {
        o[l] = niF.get(y)! / sh;
        if (dcl == null) approxPerShare = true;
      }
    }
    return o;
  })();
  const epsFull = (() => {
    const m = adjMap(fullAnnual(EPS_C, "USD/shares"));
    if (m.size) return m;
    const niF = fullAnnual(NI_C);
    const out = new Map<number, number>();
    for (const [y, ni] of niF) {
      const ca = classAEps(classFacts, y, "diluted");
      if (ca != null) {
        out.set(y, ca);
        continue;
      }
      const sh = dilSharesF.get(y) ?? classAShares(classFacts, y) ?? sharesHint;
      if (sh) out.set(y, ni / sh);
    }
    return out;
  })();
  const revFull = fullAnnual(revConcepts);
  // D&A: 통합 태그 없으면 감가상각 + 무형자산상각 합산 (IBM 등)
  const da = (() => {
    const primary = flow(DA);
    const fb = combineFlow(["Depreciation", "AmortizationOfIntangibleAssets"]);
    const o = blank();
    for (const l of labels) o[l] = primary[l] ?? (fb[l] ?? null);
    return o;
  })();
  const ocf = flow(["NetCashProvidedByUsedInOperatingActivities"]);
  const CAPEX_C = [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsToAcquireProductiveAssets",
    "PaymentsForCapitalImprovements",
    "PaymentsToAcquireOtherProductiveAssets",
  ];
  const capexRaw = flow(CAPEX_C);
  // 1년 성장률 첫 해(표시 첫 컬럼) 보정용 전체 시계열 — 전년 값 소스
  const opIncFull = (() => {
    if (isFin) {
      // 금융회사: 순수익 − 총이자외비용 − 대손충당금 (전체 연도)
      const rev = fullAnnual(FIN_NET_REVENUE);
      const nie = fullAnnual(FIN_NONINTEREST_EXPENSE);
      const prov = fullAnnual(FIN_PROVISION);
      const out = new Map<number, number>();
      for (const [y, v] of rev) if (nie.has(y)) out.set(y, v - nie.get(y)! - (prov.get(y) ?? 0));
      return out;
    }
    const m = fullAnnual(["OperatingIncomeLoss"]);
    if (m.size) return m;
    // 파생: GrossProfit − SG&A − R&D
    const gp = fullAnnual(["GrossProfit"]);
    const s = fullAnnual(["SellingGeneralAndAdministrativeExpense", "GeneralAndAdministrativeExpense"]);
    const r = fullAnnual(["ResearchAndDevelopmentExpense"]);
    const out = new Map<number, number>();
    for (const [y, v] of gp) if (s.has(y) || r.has(y)) out.set(y, v - (s.get(y) ?? 0) - (r.get(y) ?? 0));
    return out;
  })();
  const niFull = fullAnnual(NI_C);
  const daFull = (() => {
    const m = fullAnnual(DA);
    if (m.size) return m;
    const dep = fullAnnual(["Depreciation"]);
    const am = fullAnnual(["AmortizationOfIntangibleAssets"]);
    const out = new Map<number, number>();
    for (const y of new Set([...dep.keys(), ...am.keys()])) out.set(y, (dep.get(y) ?? 0) + (am.get(y) ?? 0));
    return out;
  })();
  const ocfFull = fullAnnual(["NetCashProvidedByUsedInOperatingActivities"]);
  const capexFull = fullAnnual(CAPEX_C);
  const ebitdaFull = new Map<number, number>();
  for (const [y, v] of opIncFull) ebitdaFull.set(y, v + (daFull.get(y) ?? 0));
  const fcfFull = new Map<number, number>();
  for (const [y, v] of ocfFull) {
    const cx = capexFull.get(y);
    if (cx != null) fcfFull.set(y, v - Math.abs(cx));
  }
  const dividends = flow(["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"]);
  const buyback = flow(["PaymentsForRepurchaseOfCommonStock"]);
  const INT_PAID_C = ["InterestPaidNet", "InterestPaid"];
  const intPaid = flow(INT_PAID_C); // 현금 이자 지급액
  // 차입금·리스 구성요소 — 분리(유동/비유동) 우선, 없으면 미분류 총액 폴백 (AXP 등 금융사).
  const ltdComp = debtComponent(["LongTermDebtNoncurrent", "LongTermDebtCurrent"], "LongTermDebt");
  const opLeaseComp = debtComponent(
    ["OperatingLeaseLiabilityNoncurrent", "OperatingLeaseLiabilityCurrent"],
    "OperatingLeaseLiability",
  );
  const finLeaseComp = debtComponent(
    ["FinanceLeaseLiabilityNoncurrent", "FinanceLeaseLiabilityCurrent"],
    "FinanceLeaseLiability",
  );
  const sumParts = (...parts: Record<string, number | null>[]): Record<string, number | null> => {
    const o = blank();
    for (const l of labels) {
      const vs = parts.map((p) => p[l]).filter((v): v is number => v != null);
      if (vs.length) o[l] = vs.reduce((s, v) => s + v, 0);
    }
    return o;
  };
  // 장기 부채(비유동 차입금 + 비유동 리스, 미분류 회사는 총액) — 블룸버그 '장기채무'
  const ltDebt = sumParts(ltdComp, opLeaseComp, finLeaseComp);
  const intExp = flowM(INT_EXP);
  // 순이자 개념이 잡혀 음수(순이자수익)면 이자보상 지표에 무의미 → 공란
  for (const l of labels) if (intExp[l] != null && intExp[l]! <= 0) intExp[l] = null;
  // 총이자 태그 없는 기간은 현금이자지급액(절대값)으로 대용
  {
    const proxy = flowM(INT_EXP_PROXY);
    for (const l of labels)
      if (intExp[l] == null && proxy[l] != null && proxy[l]! > 0) intExp[l] = Math.abs(proxy[l]!);
  }
  // 이자비용 개념이 최근 500일 내 태깅이 끊긴 경우(예: AAPL FY2024~ 별도표시 중단)
  // 오래된 값으로 비율 왜곡 방지 → 해당 컬럼 공란
  {
    const recentIso = new Date(Date.now() - 500 * 864e5).toISOString().slice(0, 10);
    const freshOf = (cs: string[]) =>
      cs.some((c) => entriesOf(facts, c).some((e) => e.end >= recentIso));
    if (!freshOf(INT_EXP)) intExp[LTM] = null;
    if (!freshOf(INT_PAID_C)) intPaid[LTM] = null;
  }
  // 현금이자 미공시 기간은 발생주의 이자비용으로 대체 (NVIDIA FY2026~ 등)
  const intCash = blank();
  for (const l of labels) intCash[l] = intPaid[l] ?? intExp[l];
  const taxExp = flow(["IncomeTaxExpenseBenefit"]);
  const pretax = (() => {
    const o = flow(PRETAX_C);
    // 최후 폴백: 당기순이익 + 법인세비용
    for (const l of labels)
      if (o[l] == null && netIncome[l] != null && taxExp[l] != null)
        o[l] = netIncome[l]! + taxExp[l]!;
    return o;
  })();
  // 영업이익도 못 구했으면 세전이익으로 근사 (통합 정유사·금융 등 — 이자 미미)
  for (const l of labels) if (opIncome[l] == null && pretax[l] != null) opIncome[l] = pretax[l];
  // opIncFull(전체 연도 시계열 — 첫 표시연도 YoY 의 "전년" 소스)도 동일 폴백 반영.
  // 위 for 문은 표시 컬럼(labels)만 패치하므로, 전체 시계열이 비어 있으면(OperatingIncomeLoss
  // 미태깅 기업 — 금융사 등) 첫 컬럼 성장률이 항상 공란이 되는 버그가 있었다.
  {
    const taxFull = fullAnnual(["IncomeTaxExpenseBenefit"]);
    const pretaxFull = (() => {
      const m = fullAnnual(PRETAX_C);
      if (m.size) return m;
      const out = new Map<number, number>();
      for (const [y, v] of niFull) if (taxFull.has(y)) out.set(y, v + taxFull.get(y)!);
      return out;
    })();
    for (const [y, v] of pretaxFull) if (!opIncFull.has(y)) opIncFull.set(y, v);
    for (const [y, v] of opIncFull) if (!ebitdaFull.has(y)) ebitdaFull.set(y, v + (daFull.get(y) ?? 0));
  }

  const assets = stock(["Assets"]);
  const liabAndEquity = stock(["LiabilitiesAndStockholdersEquity"]);
  const equity = (() => {
    const o = stock([
      "StockholdersEquity",
      "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ]);
    // 파생: 자산 − 부채총계
    const liab0 = stock(["Liabilities"]);
    for (const l of labels)
      if (o[l] == null && (liabAndEquity[l] ?? assets[l]) != null && liab0[l] != null)
        o[l] = (liabAndEquity[l] ?? assets[l])! - liab0[l]!;
    return o;
  })();
  const curAssets = stock(["AssetsCurrent"]);
  const curLiab = stock(["LiabilitiesCurrent"]);
  // 이자부 차입금 — 장기(분리/미분류 폴백) + 단기(CP·단기차입금)
  const debt = sumParts(ltdComp, stockSum(["CommercialPaper", "ShortTermBorrowings"]));
  const debtTotal = sumParts(debt, opLeaseComp, finLeaseComp); // 차입금 + 리스부채
  const cash = stockSum(CASH_C);
  const cashCur = stockSum(CASH_CUR); // 유동성 지표용 (장기투자 제외)
  const ar = stock([
    "AccountsReceivableNetCurrent",
    "ReceivablesNetCurrent",
    "AccountsAndOtherReceivablesNetCurrent",
    "AccountsAndNotesReceivableNet",
  ]); // 매출채권(당좌비율용)
  const retained = stock([
    "RetainedEarningsAccumulatedDeficit",
    "RetainedEarningsAppropriated",
  ]);
  const cogs = cogs0;
  const grossProfit = grossProfit0;
  const wc = blank(); // 운전자본 = 유동자산 − 유동부채
  for (const l of labels) if (curAssets[l] != null && curLiab[l] != null) wc[l] = curAssets[l]! - curLiab[l]!;
  const sharesDei = (() => {
    const e = (facts.facts.dei?.["EntityCommonStockSharesOutstanding"]?.units?.shares ??
      []) as FactUnitEntry[];
    const o = blank();
    for (const p of periods) {
      let best: { v: number; d: number; filed: string } | null = null;
      for (const x of e) {
        const dd = Math.abs(Date.parse(p.endDate ?? "") - Date.parse(x.end));
        const filed = x.filed ?? "";
        // 가까운 기준일, 동률이면 최신 공시(소급 재작성본) 우선
        if (!best || dd < best.d || (dd === best.d && filed >= best.filed))
          best = { v: x.val, d: dd, filed };
      }
      // 550일 넘게 떨어진 값은 무시 (Visa: dei 주식수가 2010년치만 태깅돼 있음)
      o[p.label] = best && best.d <= 550 * 864e5 ? best.v : null;
    }
    return o;
  })();
  // 기말 발행주식수 (unit="shares"). instantByYear = 최신 종료일·동률이면 최신
  // 공시(액면분할 소급 재작성본) 우선 → AMZN·GOOG 분할 전 잔존 태그 회피.
  const sharesEndByYear = instantByYear(
    entriesOf(facts, "CommonStockSharesOutstanding", "shares"),
  );
  const sharesEnd = (() => {
    const o = blank();
    for (const y of years) o[`${y}Y`] = sharesEndByYear.get(y) ?? null;
    o[LTM] = latestInstant(entriesOf(facts, "CommonStockSharesOutstanding", "shares"));
    return o;
  })();
  // 이중 클래스(메타 등)는 기말 발행주식수를 클래스별로만 태깅 → undimensioned 값 없음.
  // 가중평균 희석주식수(연간)로 대체해 시총·PBR·EV 를 근사.
  const wavgDil = fullAnnual(["WeightedAverageNumberOfDilutedSharesOutstanding"], "shares");
  const wavgBasic = fullAnnual(["WeightedAverageNumberOfSharesOutstandingBasic"], "shares");
  const wavgAt = (y: number): number | null =>
    wavgDil.get(y) ?? wavgBasic.get(y) ?? classAShares(classFacts, y) ?? null;
  const latestWavg = (() => {
    const ys = [...wavgDil.keys(), ...wavgBasic.keys()];
    if (ys.length) {
      const my = Math.max(...ys);
      return wavgDil.get(my) ?? wavgBasic.get(my) ?? null;
    }
    return classALatest(classFacts)?.dilShares ?? classALatest(classFacts)?.basicShares ?? null;
  })();
  const shares = blank();
  for (const l of labels) {
    // 과거 FY: 재무상태표 기말주식수(소급 재작성본) 우선 — 액면분할 전 태그가
    //          잔존하는 dei 보다 신뢰도 높음. Visa 는 classFacts 기말주식수.
    // LTM/현재: 최근 dei(현재 시점) 우선.
    const y = l === LTM ? 0 : Number(l.replace("Y", ""));
    const s =
      l === LTM
        ? (sharesDei[l] ??
          sharesEnd[l] ??
          classAOutstandingLatest(classFacts) ??
          latestWavg)
        : (sharesEnd[l] ??
          classAOutstanding(classFacts, y) ??
          sharesDei[l] ??
          wavgAt(y));
    shares[l] = s ?? sharesHint; // 최후: 공시 주식수 전무 시 현재 주식수(quote) 근사
    if (s == null && sharesHint != null) approxPerShare = true;
  }

  // 주당배당금 (DPS) — 배당 총액 ÷ 주식수, 액면분할 보정. 성장률 계산용.
  const DIV_C = ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"];
  const dps = adjPerShare(
    (() => {
      const o = blank();
      for (const l of labels)
        if (dividends[l] != null && shares[l]) o[l] = Math.abs(dividends[l]!) / shares[l]!;
      return o;
    })(),
  );
  const dpsFull = adjMap(
    (() => {
      const m = new Map<number, number>();
      for (const [y, v] of fullAnnual(DIV_C)) {
        const sh = wavgAt(y);
        if (sh) m.set(y, Math.abs(v) / sh);
      }
      return m;
    })(),
  );

  // 파생
  const ebitda = blank();
  for (const l of labels) if (opIncome[l] != null) ebitda[l] = opIncome[l]! + (da[l] ?? 0);
  const fcf = blank();
  for (const l of labels) if (ocf[l] != null && capexRaw[l] != null) fcf[l] = ocf[l]! - Math.abs(capexRaw[l]!);
  const netDebt = blank();
  for (const l of labels) if (debt[l] != null || cash[l] != null) netDebt[l] = (debt[l] ?? 0) - (cash[l] ?? 0);
  // 순차입금(총차입금 − 현금·투자) — 블룸버그 신용지표 기준
  const netDebtT = blank();
  for (const l of labels)
    if (debtTotal[l] != null || cash[l] != null) netDebtT[l] = (debtTotal[l] ?? 0) - (cash[l] ?? 0);
  const nopat = blank();
  for (const l of labels) {
    if (opIncome[l] == null) continue;
    const rate = pretax[l] && taxExp[l] != null ? taxExp[l]! / pretax[l]! : 0.21;
    nopat[l] = opIncome[l]! * (1 - Math.min(Math.max(rate, 0), 0.4));
  }
  const liabTotal = (() => {
    const o = stock(["Liabilities"]);
    // 파생: (부채와자본 총계 또는 자산) − 자기자본
    for (const l of labels)
      if (o[l] == null && (liabAndEquity[l] ?? assets[l]) != null && equity[l] != null)
        o[l] = (liabAndEquity[l] ?? assets[l])! - equity[l]!;
    return o;
  })();

  // 잔액 평균 = (기초 + 기말) / 2 — 블룸버그 ROE·ROA·회전율 방식.
  // FY: 전년말·당해말 평균 / LTM: 최근 분기말·1년 전 동시점 평균 (TTM 흐름과 짝).
  const avgStock = (concepts: string[]): Record<string, number | null> => {
    const full = new Map<number, number>();
    for (const c of concepts)
      for (const [y, v] of instantByYear(entriesOf(facts, c)))
        if (!full.has(y)) full.set(y, v);
    const o = blank();
    for (const y of years) {
      const cur = full.get(y);
      const prev = full.get(y - 1);
      o[`${y}Y`] = cur != null && prev != null ? (cur + prev) / 2 : (cur ?? null);
    }
    const insts = concepts
      .flatMap((c) => entriesOf(facts, c))
      .filter((e) => !e.start)
      .sort((a, b) => (a.end < b.end ? 1 : -1));
    if (insts.length) {
      const latest = insts[0];
      const target = shiftYear(latest.end, -1);
      const prevE = insts.find((e) => Math.abs(days(e.end, target)) <= 25);
      o[LTM] = prevE ? (latest.val + prevE.val) / 2 : latest.val;
    }
    return o;
  };
  const avgStockSum = (concepts: string[]): Record<string, number | null> => {
    const o = blank();
    for (const c of concepts) {
      const a = avgStock([c]);
      for (const l of labels) if (a[l] != null) o[l] = (o[l] ?? 0) + a[l]!;
    }
    return o;
  };
  const equityAvg = (() => {
    const o = avgStock([
      "StockholdersEquity",
      "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ]);
    for (const l of labels) if (o[l] == null && equity[l] != null) o[l] = equity[l];
    return o;
  })();
  const assetsAvg = avgStock(["Assets"]);
  // 투하자본 = 총자산 − 비이자 유동부채 (= 총차입금 + 자기자본 + 비유동 비이자부채).
  // 블룸버그 ROIC 기준. 순현금 기업이라도 음수화 안 됨.
  const curLiabAvg = avgStock(["LiabilitiesCurrent"]);
  const curDebtAvg = avgStockSum([
    "LongTermDebtCurrent",
    "CommercialPaper",
    "ShortTermBorrowings",
    "FinanceLeaseLiabilityCurrent",
  ]);
  const investedCapAvg = blank();
  for (const l of labels) {
    if (assetsAvg[l] == null || curLiabAvg[l] == null) continue;
    investedCapAvg[l] = assetsAvg[l]! - (curLiabAvg[l]! - (curDebtAvg[l] ?? 0));
  }

  // 주가·시총
  const price = blank();
  const mktcap = blank();
  for (const p of periods) {
    const px = p.label === LTM ? (lastBar?.close ?? null) : closeOnOrBefore(bars, p.endDate ?? "");
    price[p.label] = px;
    const sh = p.label === LTM ? shares[LTM] : sharesEnd[p.label] ?? shares[p.label];
    mktcap[p.label] = px != null && sh != null ? px * sh : null;
  }
  const curMktcap = mktcap[LTM];

  const ratio = (a: Record<string, number | null>, b: Record<string, number | null>, mul = 1) => {
    const o = blank();
    for (const l of labels) if (a[l] != null && b[l]) o[l] = (a[l]! / b[l]!) * mul;
    return o;
  };
  const perShare = (a: Record<string, number | null>) => {
    const o = blank();
    for (const l of labels) if (a[l] != null && shares[l]) o[l] = a[l]! / shares[l]!;
    return adjPerShare(o); // 분모(주식수)가 소급 재작성 안 된 과거 연도 → 분할 계수로 환산
  };
  // CAGR: 전체 연도 시계열에서 각 컬럼 대비 n년 전 값.
  // 현재/LTM 은 최근 FY 보다 약 1년 뒤 시점 → 분자는 TTM 값, 기준연도도 1 앞으로
  // (예: 5년 CAGR 이면 마지막 FY 열은 FY-5, LTM 열은 FY-4 를 기준으로).
  const cagr = (full: Map<number, number>, n: number, ltm?: number | null) => {
    const o = blank();
    const lastY = years.at(-1) ?? 0;
    for (const p of periods) {
      const isLtm = p.label === LTM;
      const anchorY = isLtm ? lastY + 1 : p.fiscalYear;
      const cur = isLtm ? (ltm ?? full.get(lastY) ?? null) : (full.get(anchorY) ?? null);
      const base = full.get(anchorY - n);
      if (cur != null && base != null && base > 0 && cur > 0)
        o[p.label] = (Math.pow(cur / base, 1 / n) - 1) * 100;
    }
    return o;
  };
  const fwdMktcap = () => {
    const o = blank();
    for (const l of labels) o[l] = l === LTM ? curMktcap : mktcap[l];
    return o;
  };
  // 1년 성장률: 표시 첫 해(예 2021)는 직전 컬럼이 없으므로
  // companyfacts 전체 시계열(이미 받아온 payload)에서 전년(2020) 값을 끌어와 채운다.
  const yoy1 = (a: Record<string, number | null>, full?: Map<number, number>) => {
    const o = blank();
    for (let i = 0; i < labels.length; i++) {
      const c = a[labels[i]];
      let p = i >= 1 ? a[labels[i - 1]] : null;
      if (p == null && full && labels[i] !== LTM) {
        p = full.get(Number(labels[i].replace("Y", "")) - 1) ?? null;
      }
      if (c != null && p != null && p !== 0) o[labels[i]] = ((c - p) / Math.abs(p)) * 100;
    }
    return o;
  };
  const combine3 = (
    a: Record<string, number | null>,
    b: Record<string, number | null>,
    c: Record<string, number | null>,
  ) => {
    const o = blank();
    for (const l of labels)
      if (a[l] != null && b[l] != null && c[l] != null) o[l] = a[l]! + b[l]! - c[l]!;
    return o;
  };

  const R = (
    label: string,
    values: Record<string, number | null>,
    nf?: FinancialLineItem["numberFormat"],
    opts: Partial<FinancialLineItem> = {},
  ): FinancialLineItem => ({
    accountName: label,
    accountId: `an:${label}`,
    depth: 1,
    isSubtotal: false,
    isHighlight: false,
    values,
    numberFormat: nf,
    ...opts,
  });
  const HEAD = (label: string): FinancialLineItem => ({
    accountName: label,
    accountId: `an:h:${label}`,
    depth: 0,
    isSubtotal: true,
    isHighlight: false,
    values: blank(),
  });
  const SP = (k: string): FinancialLineItem => ({
    accountName: "",
    accountId: `an:sp:${k}`,
    depth: 0,
    isSubtotal: false,
    isHighlight: false,
    values: blank(),
  });

  const per = ratio(price, eps);
  const pbrV = blank();
  for (const l of labels) if (mktcap[l] != null && equity[l]) pbrV[l] = mktcap[l]! / equity[l]!;
  const psrV = blank();
  for (const l of labels) {
    const mc = l === LTM ? curMktcap : mktcap[l];
    if (mc != null && revenue[l]) psrV[l] = mc / revenue[l]!;
  }
  const evV = blank();
  for (const l of labels) {
    const mc = l === LTM ? curMktcap : mktcap[l];
    if (mc != null && netDebt[l] != null) evV[l] = mc + netDebt[l]!;
  }
  const evEbitda = ratio(evV, ebitda);
  // PEG: 분모는 3년(부족 시 2년) EPS CAGR% — 1년 YoY 는 변동이 커 왜곡 심함
  const epsCagr3 = cagr(epsFull, 3, eps[LTM]);
  const epsCagr2 = cagr(epsFull, 2, eps[LTM]);
  const peg = blank();
  for (const l of labels) {
    const g = epsCagr3[l] ?? epsCagr2[l];
    if (per[l] != null && per[l]! > 0 && g != null && g >= 1) peg[l] = per[l]! / g;
  }

  const effTax = ratio(taxExp, pretax, 100);
  // 듀퐁 분해: ROE(%) = 순이익률(%) × 총자산회전율 × 재무레버리지 (잔액은 평균)
  const duTurnover = ratio(revenue, assetsAvg);
  const duLeverage = ratio(assetsAvg, equityAvg);
  // 당좌비율 = (현금·현금성 + 단기투자 + 매출채권) / 유동부채 (엄격 정의, 블룸버그와 동일)
  const quick = (() => {
    const o = blank();
    for (const l of labels) {
      if (!curLiab[l]) continue;
      const qa = (cashCur[l] ?? 0) + (ar[l] ?? 0);
      if (qa > 0) o[l] = qa / curLiab[l]!;
    }
    return o;
  })();
  const cogsAbs = (() => {
    const o = blank();
    for (const l of labels) if (cogs[l] != null) o[l] = Math.abs(cogs[l]!);
    return o;
  })();
  const arAvg = avgStock(["AccountsReceivableNetCurrent", "ReceivablesNetCurrent"]);
  const invAvg = avgStock(["InventoryNet", "AirlineRelatedInventoryNet", "EnergyRelatedInventory", "RetailRelatedInventoryMerchandise"]);
  const apAvg = avgStock([
    "AccountsPayableCurrent",
    "AccountsPayableTradeCurrent",
    "AccountsPayableAndAccruedLiabilitiesCurrent",
  ]);
  const dso = (() => {
    const o = blank();
    for (const l of labels) if (arAvg[l] != null && revenue[l]) o[l] = (arAvg[l]! / revenue[l]!) * 365;
    return o;
  })();
  // 재고 태그가 없으면 재고 0 (플랫폼·서비스) → DIO 0, CCC 계산 가능
  const dio = (() => {
    const o = blank();
    for (const l of labels) if (cogsAbs[l]) o[l] = ((invAvg[l] ?? 0) / cogsAbs[l]!) * 365;
    return o;
  })();
  const dpo = ratio(apAvg, cogsAbs, 365);
  const ccc = combine3(dso, dio, dpo);
  const altZ = (() => {
    const o = blank();
    for (const l of labels) {
      const mc = l === LTM ? curMktcap : mktcap[l];
      if (
        assets[l] &&
        wc[l] != null &&
        retained[l] != null &&
        opIncome[l] != null &&
        mc != null &&
        liabTotal[l] &&
        revenue[l] != null
      )
        o[l] =
          1.2 * (wc[l]! / assets[l]!) +
          1.4 * (retained[l]! / assets[l]!) +
          3.3 * (opIncome[l]! / assets[l]!) +
          0.6 * (mc / liabTotal[l]!) +
          1.0 * (revenue[l]! / assets[l]!);
    }
    return o;
  })();

  // ── 레버리지·커버리지 파생 ──
  const capexAbs = blank();
  for (const l of labels) if (capexRaw[l] != null) capexAbs[l] = Math.abs(capexRaw[l]!);
  const ebitdaLessCapex = blank();
  for (const l of labels)
    if (ebitda[l] != null && capexAbs[l] != null) ebitdaLessCapex[l] = ebitda[l]! - capexAbs[l]!;
  // 재무레버리지 정도 (DFL) = EBIT / (EBIT − 이자비용). 이자비용 없으면 공란.
  const dfl = blank();
  for (const l of labels)
    if (opIncome[l] != null && intExp[l] != null && opIncome[l]! - intExp[l]! !== 0)
      dfl[l] = opIncome[l]! / (opIncome[l]! - intExp[l]!);

  const items: FinancialLineItem[] = [
    HEAD("밸류에이션"),
    R("PER", per, "mult"),
    R("PBR", pbrV, "mult"),
    R("PSR", psrV, "mult"),
    R("EV/EBITDA", evEbitda, "mult"),
    R("주가 / FCF", ratio(fwdMktcap(), fcf), "mult"),
    R("PEG (EPS 3Y CAGR)", peg, "mult"),
    SP("1"),
    HEAD("수익성"),
    R("ROE (%)", ratio(netIncome, equityAvg, 100), "pct"),
    R("순이익률 (%)", ratio(netIncome, revenue, 100), "pct", { depth: 2 }),
    R("× 총자산회전율 (회)", duTurnover, "mult", { depth: 2 }),
    R("× 재무레버리지 (배)", duLeverage, "mult", { depth: 2 }),
    R("ROA (%)", ratio(netIncome, assetsAvg, 100), "pct"),
    R("ROIC (%)", ratio(nopat, investedCapAvg, 100), "pct"),
    R("FCF 마진 (%)", ratio(fcf, revenue, 100), "pct"),
    R(isFin ? "충당금전이익률 (%)" : "매출총이익률 (%)", ratio(grossProfit, revenue, 100), "pct"),
    R("영업이익률 (%)", ratio(opIncome, revenue, 100), "pct"),
    R("유효세율 (%)", effTax, "pct"),
    SP("2"),
    HEAD("현금창출"),
    R("FCF 수익률 (%)", ratio(fcf, fwdMktcap(), 100), "pct"),
    R("영업현금흐름 / 순이익", ratio(ocf, netIncome), "mult"),
    R("주당 FCF", perShare(fcf), "eps"),
    SP("3"),
    HEAD("레버리지"),
    R("부채비율 (%)", ratio(liabTotal, equity, 100), "pct"),
    R("총차입금 / 자기자본 (%)", ratio(debtTotal, equity, 100), "pct"),
    R("총차입금 / 총자산 (%)", ratio(debtTotal, assets, 100), "pct"),
    R("장기차입금 / 자기자본 (%)", ratio(ltDebt, equity, 100), "pct"),
    R("장기차입금 / 총자산 (%)", ratio(ltDebt, assets, 100), "pct"),
    R("순차입금 / 자기자본 (%)", ratio(netDebtT, equity, 100), "pct"),
    R("재무레버리지 정도 (DFL)", dfl, "mult"),
    SP("4"),
    HEAD("재무건전성"),
    R("총차입금 / EBITDA", ratio(debtTotal, ebitda), "mult"),
    R("순차입금 / EBITDA", ratio(netDebtT, ebitda), "mult"),
    R("영업이익 / 총차입금", ratio(opIncome, debtTotal), "mult"),
    R("이자보상배율 (EBIT/이자)", ratio(opIncome, intExp), "mult"),
    R("EBITDA / 이자비용", ratio(ebitda, intExp), "mult"),
    R("(EBITDA−CapEx) / 이자비용", ratio(ebitdaLessCapex, intExp), "mult"),
    R("EBIT / 현금이자", ratio(opIncome, intCash), "mult"),
    R("EBITDA / 현금이자", ratio(ebitda, intCash), "mult"),
    R("CFO / 총차입금", ratio(ocf, debtTotal), "mult"),
    R("FCF / 총차입금", ratio(fcf, debtTotal), "mult"),
    R("알트만 Z-스코어", altZ, "eps"),
    SP("4a"),
    HEAD("유동성"),
    R("유동비율", ratio(curAssets, curLiab), "mult"),
    R("당좌비율", quick, "mult"),
    R("현금비율", ratio(cashCur, curLiab), "mult"),
    R("CFO / 유동부채", ratio(ocf, curLiabAvg), "mult"),
    SP("4b"),
    HEAD("운전자본"),
    R("매출채권 회전일수 (DSO)", dso, "eps"),
    R("재고자산 회전일수 (DIO)", dio, "eps"),
    R("매입채무 회전일수 (DPO)", dpo, "eps"),
    R("현금전환주기 (CCC)", ccc, "eps"),
    SP("4c"),
    HEAD("주주환원"),
    R("배당성향 (%)", (() => {
      const o = blank();
      for (const l of labels)
        if (dividends[l] != null && netIncome[l]) o[l] = (Math.abs(dividends[l]!) / netIncome[l]!) * 100;
      return o;
    })(), "pct"),
    R("총주주환원율 (%)", (() => {
      const o = blank();
      for (const l of labels) {
        const ret = (dividends[l] != null ? Math.abs(dividends[l]!) : 0) + (buyback[l] != null ? Math.abs(buyback[l]!) : 0);
        if (netIncome[l]) o[l] = (ret / netIncome[l]!) * 100;
      }
      return o;
    })(), "pct"),
    SP("5"),
    HEAD("성장률 (1년 YoY)"),
    R("매출액", yoy1(revenue, revFull), "pct"),
    R("EBITDA", yoy1(ebitda, ebitdaFull), "pct"),
    R("영업이익", yoy1(opIncome, opIncFull), "pct"),
    R("순이익", yoy1(netIncome, niFull), "pct"),
    R("희석 EPS", yoy1(eps, epsFull), "pct"),
    R("주당배당금", yoy1(dps, dpsFull), "pct"),
    R("영업활동 현금흐름", yoy1(ocf, ocfFull), "pct"),
    R("자본지출", yoy1(capexRaw, capexFull), "pct"),
    R("잉여현금흐름", yoy1(fcf, fcfFull), "pct"),
    SP("6"),
    HEAD("성장률 (3년 CAGR)"),
    R("매출액", cagr(revFull, 3, revenue[LTM]), "pct"),
    R("EPS", cagr(epsFull, 3, eps[LTM]), "pct"),
    R("주당배당금", cagr(dpsFull, 3, dps[LTM]), "pct"),
  ];

  if (approxPerShare) {
    items.push(SP("note"));
    items.push(
      R(
        "※ EPS·주당·PER: 발행주식수를 클래스별로만 공시(Visa 등) → 현재 주식수 기준 근사",
        blank(),
        undefined,
        { italic: true },
      ),
    );
  }

  return {
    symbol: "",
    market: "us",
    periodType: "annual",
    unit: "USD",
    currency: "USD",
    consolidation: "consolidated",
    periods,
    sections: [{ title: "분석 지표", items }],
    source: "SEC EDGAR + 시세 · 자체 계산",
  };
}
