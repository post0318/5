import "server-only";
import type { CompanyFacts } from "./edgar";
import type { FinancialStatement, FinancialLineItem, FinancialPeriod } from "../types";
import {
  annualByYear,
  annualEnds,
  entriesOf,
  firstConcept,
  recentQuarters,
  singleQuarter,
  splitFactorsByYear,
  ttmOf,
} from "./edgar-series";
import {
  classAEps,
  classALatest,
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
const NET_INCOME = ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"];
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
  opts: { sharesHint?: number | null; classFacts?: ClassAFacts | null; sic?: string | null } = {},
): FinancialStatement {
  const quarterly = mode === "quarter";
  const sharesHint = opts.sharesHint ?? null;
  const classFacts = opts.classFacts ?? null;
  // 금융회사(은행·카드사) — 매출 대신 순수익(이자비용 차감), 매출총이익 대신 충당금전이익.
  const isFin = isFinancialCompany(facts, opts.sic ?? null);
  const revConcepts = isFin ? FIN_NET_REVENUE : REVENUE;

  // 개념 태그가 시기별로 바뀌는 기업(NVIDIA 등) → 나열 개념을 연도별로 병합
  const mergedAnnual = (concepts: string[], unit = "USD"): Map<number, number> => {
    const out = new Map<number, number>();
    for (const c of concepts)
      for (const [y, v] of annualByYear(entriesOf(facts, c, unit))) if (!out.has(y)) out.set(y, v);
    return out;
  };
  const mergedEnds = (concepts: string[]): Map<number, string> => {
    const out = new Map<number, string>();
    for (const c of concepts)
      for (const [y, d] of annualEnds(entriesOf(facts, c))) if (!out.has(y)) out.set(y, d);
    return out;
  };
  const allRevEntries = revConcepts.flatMap((c) => entriesOf(facts, c));

  const years = [...mergedAnnual(revConcepts).keys()].sort((a, b) => a - b).slice(-5);
  const ends = mergedEnds(revConcepts);
  const lastFy = years[years.length - 1] ?? new Date().getFullYear();
  // 6개 확보 → 가장 오래된 1개는 YTD 차감용 prev 로만 쓰고 표시는 5개
  const qCols = quarterly ? [...recentQuarters(allRevEntries, 6)].reverse() : [];
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
    const out = blank();
    if (quarterly) {
      qCols.forEach((q, i) => {
        if (i === 0) return; // prev 전용
        for (const c of concepts) {
          const v = singleQuarter(entriesOf(facts, c, unit), q, qCols[i - 1]);
          if (v != null) { out[q.label] = v; break; }
        }
      });
      return out;
    }
    const ann = mergedAnnual(concepts, unit);
    for (const y of years) out[fyKey(y)] = ann.get(y) ?? null;
    // 가장 최근 데이터가 있는 개념의 TTM (태그 이전 후 과거 개념 옛 FY값 방지)
    let ttmEnd = "";
    for (const c of concepts) {
      const es = entriesOf(facts, c, unit);
      if (!es.length) continue;
      const maxEnd = es.reduce((m, e) => (e.end > m ? e.end : m), "");
      if (maxEnd > ttmEnd) { ttmEnd = maxEnd; out[LTM] = ttmOf(es); }
    }
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

  const revenue = val(revConcepts);
  const cogs = val(COGS);
  // 금융회사: 매출총이익 대신 충당금전이익(=순수익 − 총이자외비용), 대손충당금 별도.
  const finNoninterestExpense = val(FIN_NONINTEREST_EXPENSE);
  const finProvision = val(FIN_PROVISION);
  const grossProfit = (() => {
    if (isFin) {
      const g = blank();
      for (const l of labels)
        if (revenue[l] != null && finNoninterestExpense[l] != null)
          g[l] = revenue[l]! - finNoninterestExpense[l]!;
      return g;
    }
    const g = val(["GrossProfit"]);
    for (const l of labels)
      if (g[l] == null && revenue[l] != null && cogs[l] != null) g[l] = revenue[l]! - cogs[l]!;
    return g;
  })();
  const sga = val(SGA);
  const rnd = val(RND);
  const opex = val(OPEX);
  const pretax = val(PRETAX);
  // 영업이익: 금융회사는 충당금전이익 − 대손충당금. 그 외는 공시 태그,
  // 없으면 매출총이익 − 판관비 − 연구개발비 (IBM 등), 그래도 없으면 세전이익으로
  // 근사(XOM 등 영업이익 태그 자체가 없는 회사 — 비영업 손익 포함될 수 있음)
  const opIncome = (() => {
    if (isFin) {
      const o = blank();
      for (const l of labels)
        if (grossProfit[l] != null) o[l] = Math.round(grossProfit[l]! - (finProvision[l] ?? 0));
      return o;
    }
    const o = val(OP_INCOME);
    for (const l of labels) {
      if (o[l] != null) continue;
      if (grossProfit[l] != null && (sga[l] != null || rnd[l] != null)) {
        o[l] = Math.round(grossProfit[l]! - (sga[l] ?? 0) - (rnd[l] ?? 0));
        continue;
      }
      if (pretax[l] != null) o[l] = pretax[l];
    }
    return o;
  })();
  // 기타 영업비용 = OPEX − SGA − RND, 없으면 GrossProfit − OpIncome − SGA − RND
  const otherOpex = (() => {
    const base = labels.some((l) => opex[l] != null)
      ? opex
      : diff(grossProfit, opIncome);
    return diff(base, sga, rnd);
  })();
  // (−)영업외손익 = 세전이익 − 영업이익 (부호 반전). 워터폴 정합을 위해 항상 이 정의 우선.
  // NonoperatingIncomeExpense 태그는 일부 항목만 담는 기업(IBM 등)이 많아 사용 안 함.
  const nonOpLoss = (() => {
    const nonop = val(NONOP);
    const out = blank();
    for (const l of labels) {
      if (pretax[l] != null && opIncome[l] != null) out[l] = -(pretax[l]! - opIncome[l]!);
      else if (nonop[l] != null) out[l] = -nonop[l]!;
    }
    return out;
  })();
  // 순이자손익(−) = 이자비용 − 이자수익 (양수 = 순이자 부담, 음수 = 순이자 이익).
  // 금융회사는 이자비용이 이미 순수익(매출)에 반영된 영업비용이라 영업외손익 하위
  // 각주로 표시하지 않는다(이중계상 오인 방지).
  const intInc = val(INT_INC);
  const intExp = val(INT_EXP);
  const netIntCost = blank();
  if (!isFin) {
    for (const l of labels) {
      if (intExp[l] == null && intInc[l] == null) continue;
      netIntCost[l] = (intExp[l] ?? 0) - (intInc[l] ?? 0);
    }
  }
  // 최근 데이터가 없으면(예: 회사가 이자 항목 별도 표시 중단) LTM 공란
  const recentIso = new Date(Date.now() - 500 * 864e5).toISOString().slice(0, 10);
  const intFresh = [...INT_EXP, ...INT_INC].some((c) =>
    firstConcept(facts, [c]).some((e) => e.end >= recentIso),
  );
  if (!intFresh && LTM in netIntCost) netIntCost[LTM] = null;
  const hasInterest = !isFin && labels.some((l) => netIntCost[l] != null);
  const tax = val(TAX);
  const netIncome = val([...NET_INCOME, "ProfitLoss"]);
  // (−) 기타 = (세전이익 − 법인세비용) − 공시 당기순이익 (중단사업·소수주주지분 등)
  const otherToNi = blank();
  for (const l of labels)
    if (pretax[l] != null && tax[l] != null && netIncome[l] != null)
      otherToNi[l] = Math.round(pretax[l]! - tax[l]! - netIncome[l]!);
  // 액면분할 보정: 소급 재작성 안 된 과거 연도 EPS 를 최신 연도 기준으로 환산
  const splitF = splitFactorsByYear(facts);
  const adjEps = (o: Record<string, number | null>): Record<string, number | null> => {
    if (quarterly) return o;
    const r = { ...o };
    for (const y of years) {
      const f = splitF.get(y);
      if (f != null && f !== 1 && r[fyKey(y)] != null) r[fyKey(y)] = r[fyKey(y)]! * f;
    }
    return r;
  };
  // EPS: 공시 태그 우선. 클래스별로만 태깅하는 기업(Visa)은 순이익÷주식수로 산출.
  const wavgShares = val(
    ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfSharesOutstandingBasic"],
    "shares",
  );
  let epsApprox = false;
  const yearOf = (l: string): number => Number(l.replace(/[^0-9]/g, "")) || 0;
  const deriveEps = (
    o: Record<string, number | null>,
    kind: "basic" | "diluted",
  ): Record<string, number | null> => {
    const r = { ...o };
    for (const l of labels) {
      if (r[l] != null) continue;
      // Class A 공시값(실측) 우선 — 근사 아님
      const ca = quarterly ? null : classAEps(classFacts, yearOf(l), kind);
      if (ca != null) {
        r[l] = ca;
        continue;
      }
      const dcl =
        wavgShares[l] ??
        (quarterly
          ? null
          : l === LTM
            ? (classALatest(classFacts)?.dilShares ?? null)
            : classAShares(classFacts, yearOf(l)));
      const sh = dcl ?? sharesHint;
      if (netIncome[l] != null && sh) {
        r[l] = netIncome[l]! / sh;
        if (dcl == null) epsApprox = true;
      }
    }
    return r;
  };
  const epsBasic = deriveEps(adjEps(val(EPS_BASIC, "USD/shares")), "basic");
  const epsDil = deriveEps(adjEps(val(EPS_DIL, "USD/shares")), "diluted");

  const da = (() => {
    const o = val(DA);
    // 통합 태그 없으면 감가상각 + 무형자산상각 합산 (IBM 등)
    if (labels.every((l) => o[l] == null)) {
      const dep = val(["Depreciation"]);
      const am = val(["AmortizationOfIntangibleAssets"]);
      for (const l of labels)
        if (dep[l] != null || am[l] != null) o[l] = (dep[l] ?? 0) + (am[l] ?? 0);
    }
    return o;
  })();
  const ebitda = blank();
  for (const l of labels)
    if (opIncome[l] != null) ebitda[l] = opIncome[l]! + (da[l] ?? 0);

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

  // 매출원가·매출총이익 구조가 없는 업종(항공·호텔·서비스·정유 등)은
  // 매출액 → (−)영업비용 총계 → 영업이익 으로 축약
  const hasGross = labels.some((l) => grossProfit[l] != null);
  const totalOpex = (() => {
    const o = blank();
    for (const l of labels)
      if (revenue[l] != null && opIncome[l] != null) o[l] = revenue[l]! - opIncome[l]!;
    return o;
  })();

  const items: FinancialLineItem[] = [
    row(isFin ? "순수익" : "매출액", revenue, { depth: 0, isSubtotal: true, isHighlight: true }),
    ...(isFin
      ? [
          row("(−) 총이자외비용", finNoninterestExpense),
          row("충당금전이익", grossProfit, { depth: 0, isSubtotal: true, isHighlight: true }),
          row("(−) 대손충당금", finProvision),
        ]
      : hasGross
        ? [
            row("(−) 매출원가", cogs),
            row("매출총이익", grossProfit, { depth: 0, isSubtotal: true, isHighlight: true }),
            row("(−) 판매관리비", sga),
            row("(−) 연구개발비", rnd),
            row("(−) 기타 영업비용", otherOpex),
          ]
        : [row("(−) 영업비용", totalOpex)]),
    row("영업이익", opIncome, { depth: 0, isSubtotal: true, isHighlight: true }),
    row("(−) 영업외손익", nonOpLoss),
    ...(hasInterest
      ? [row("(순이자비용)", netIntCost, { depth: 2, italic: true, paren: true })]
      : []),
    row("세전이익", pretax, { depth: 0, isSubtotal: true, isHighlight: true }),
    row("(−) 법인세비용", tax),
    row("(−) 기타", otherToNi),
    row("당기순이익", netIncome, { depth: 0, isSubtotal: true, isHighlight: true }),
    row("기본 EPS", epsBasic, { numberFormat: "eps" }),
    row("희석 EPS", epsDil, { numberFormat: "eps" }),
    { accountName: "", accountId: "is:sp", depth: 0, isSubtotal: false, isHighlight: false, values: blank() },
    row("[ 주석 항목 ]", blank(), { depth: 0, isSubtotal: true }),
    row("EBITDA", ebitda),
    row("감가상각비", da),
  ];

  if (epsApprox && !quarterly)
    items.push(
      row("※ EPS: 클래스별로만 공시(Visa 등) → 순이익÷주식수 근사", blank(), {
        depth: 1,
        italic: true,
      }),
    );

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
