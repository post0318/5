import "server-only";
import type { FinancialStatement, FinancialLineItem } from "../types";
import { type KrFacts, annualSeries, seriesOf, sumOf } from "./dart-facts";

/**
 * 한국 상세 손익계산서 — DART `fnlttSinglAcntAll` 정규화 재분류.
 * `edgar-income.ts` 의 행 구조·라벨을 그대로 따른다 (총괄 요약·재무분석 칩이 라벨에 의존).
 */

const C = {
  revenue: { ids: ["ifrs-full_Revenue", "dart_Revenue"], names: ["매출액", "수익(매출액)", "영업수익", "매출"] },
  cogs: { ids: ["ifrs-full_CostOfSales"], names: ["매출원가"] },
  gross: { ids: ["ifrs-full_GrossProfit"], names: ["매출총이익"] },
  sga: {
    ids: ["dart_TotalSellingGeneralAdministrativeExpenses", "ifrs-full_SellingGeneralAndAdministrativeExpense"],
    names: ["판매비와관리비", "판매비및관리비", "영업비용"],
  },
  opIncome: { ids: ["dart_OperatingIncomeLoss", "ifrs-full_ProfitLossFromOperatingActivities"], names: ["영업이익", "영업이익(손실)"] },
  finInc: { ids: ["ifrs-full_FinanceIncome"], names: ["금융수익"] },
  finCost: { ids: ["ifrs-full_FinanceCosts"], names: ["금융비용"] },
  pretax: {
    ids: ["ifrs-full_ProfitLossBeforeTax", "dart_ProfitLossBeforeTaxFromContinuingOperations"],
    names: ["법인세비용차감전순이익", "법인세비용차감전계속영업이익", "법인세비용차감전순이익(손실)"],
  },
  tax: { ids: ["ifrs-full_IncomeTaxExpenseContinuingOperations", "ifrs-full_IncomeTaxExpenseBenefit"], names: ["법인세비용", "법인세비용(수익)"] },
  netIncome: { ids: ["ifrs-full_ProfitLoss"], names: ["당기순이익", "당기순이익(손실)", "분기순이익", "반기순이익"] },
  niParent: { ids: ["ifrs-full_ProfitLossAttributableToOwnersOfParent"], names: ["지배기업 소유주지분", "지배기업의 소유주지분"] },
  epsBasic: {
    ids: ["ifrs-full_BasicEarningsLossPerShare"],
    names: ["기본주당이익", "기본주당이익(손실)", "기본주당순이익", "기본주당순이익(손실)", "기본및희석주당이익"],
  },
  epsDil: {
    ids: ["ifrs-full_DilutedEarningsLossPerShare"],
    names: ["희석주당이익", "희석주당이익(손실)", "희석주당순이익", "희석주당순이익(손실)"],
  },
  // 감가상각비: CF 조정 라인에서. 회사별 편차 큼.
  da: {
    ids: [
      "ifrs-full_DepreciationAndAmortisationExpense",
      "ifrs-full_AdjustmentsForDepreciationAndAmortisationExpense",
      "dart_DepreciationAndAmortizationExpensePropertyPlantAndEquipment",
    ],
    names: ["감가상각비와 무형자산상각비", "감가상각비", "유형자산감가상각비"],
  },
};

export function buildKrIncome(facts: KrFacts): FinancialStatement {
  const labels = facts.periods.map((p) => p.label);
  const blank = (): Record<string, number | null> => Object.fromEntries(labels.map((l) => [l, null]));
  const IS = ["IS", "CIS"];
  const S = (c: { ids: string[]; names: string[] }) => seriesOf(facts, c.ids, c.names, IS);

  const revenue = S(C.revenue);
  const cogs = S(C.cogs);
  const gross = (() => {
    const g = S(C.gross);
    for (const l of labels) if (g[l] == null && revenue[l] != null && cogs[l] != null) g[l] = revenue[l]! - cogs[l]!;
    return g;
  })();
  const sga = S(C.sga);
  const opIncome = S(C.opIncome);
  // 기타 영업비용 = 매출총이익 − 판관비 − 영업이익
  const otherOpex = (() => {
    const o = blank();
    for (const l of labels)
      if (gross[l] != null && sga[l] != null && opIncome[l] != null)
        o[l] = Math.round(gross[l]! - sga[l]! - opIncome[l]!);
    return o;
  })();
  const pretax = S(C.pretax);
  // (−)영업외손익 = 세전이익 − 영업이익 (부호 반전)
  const nonOpLoss = (() => {
    const o = blank();
    for (const l of labels) if (pretax[l] != null && opIncome[l] != null) o[l] = -(pretax[l]! - opIncome[l]!);
    return o;
  })();
  // 순이자비용(−) = 금융비용 − 금융수익
  const finInc = S(C.finInc);
  const finCost = S(C.finCost);
  const netIntCost = blank();
  for (const l of labels)
    if (finInc[l] != null || finCost[l] != null) netIntCost[l] = (finCost[l] ?? 0) - (finInc[l] ?? 0);
  const hasInterest = labels.some((l) => netIntCost[l] != null);
  const tax = S(C.tax);
  const netIncome = S(C.netIncome);
  const niParent = S(C.niParent);
  const otherToNi = blank();
  for (const l of labels)
    if (pretax[l] != null && tax[l] != null && netIncome[l] != null)
      otherToNi[l] = Math.round(pretax[l]! - tax[l]! - netIncome[l]!);

  const epsBasic = S(C.epsBasic);
  const epsDil = S(C.epsDil);

  let daApprox = false;
  const da = (() => {
    const d = seriesOf(facts, C.da.ids, C.da.names);
    // 폴백 1: CF 조정 세부 라인 합
    if (labels.every((l) => d[l] == null)) {
      const alt = sumOf(facts, [
        { ids: [], names: ["유형자산 감가상각비", "유형자산의 감가상각비", "감가상각비"] },
        { ids: [], names: ["무형자산 상각비", "무형자산의 상각비", "무형자산상각비"] },
        { ids: [], names: ["사용권자산 감가상각비"] },
      ]);
      for (const l of labels) if (alt[l] != null) d[l] = alt[l];
    }
    // 폴백 2: 유·무형자산 롤포워드 근사 (기초 + 취득 − 기말)
    if (labels.every((l) => d[l] == null)) {
      const ppe = annualSeries(facts, ["ifrs-full_PropertyPlantAndEquipment"], ["유형자산"], "BS");
      const intang = annualSeries(
        facts,
        ["ifrs-full_IntangibleAssetsAndGoodwill", "ifrs-full_IntangibleAssetsOtherThanGoodwill"],
        ["무형자산"],
        "BS",
      );
      const capex = annualSeries(
        facts,
        ["ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities"],
        ["유형자산의 취득"],
        "CF",
      );
      const intAcq = annualSeries(
        facts,
        ["ifrs-full_PurchaseOfIntangibleAssetsClassifiedAsInvestingActivities"],
        ["무형자산의 취득"],
        "CF",
      );
      for (const p of facts.periods) {
        const y = p.year;
        const beg = ppe.get(y - 1);
        const end = ppe.get(y);
        if (beg == null || end == null) continue;
        const v =
          beg + (intang.get(y - 1) ?? 0) + Math.abs(capex.get(y) ?? 0) + Math.abs(intAcq.get(y) ?? 0) -
          (end + (intang.get(y) ?? 0));
        if (v > 0) {
          d[p.label] = Math.round(v);
          daApprox = true;
        }
      }
    }
    return d;
  })();
  const ebitda = blank();
  for (const l of labels) if (opIncome[l] != null && da[l] != null) ebitda[l] = opIncome[l]! + da[l]!;

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

  const hasGross = labels.some((l) => gross[l] != null);
  const totalOpex = (() => {
    const o = blank();
    for (const l of labels) if (revenue[l] != null && opIncome[l] != null) o[l] = revenue[l]! - opIncome[l]!;
    return o;
  })();

  const items: FinancialLineItem[] = [
    row("매출액", revenue, { depth: 0, isSubtotal: true, isHighlight: true }),
    ...(hasGross
      ? [
          row("(−) 매출원가", cogs),
          row("매출총이익", gross, { depth: 0, isSubtotal: true, isHighlight: true }),
          row("(−) 판매관리비", sga),
          row("(−) 기타 영업비용", otherOpex),
        ]
      : [row("(−) 영업비용", totalOpex)]),
    row("영업이익", opIncome, { depth: 0, isSubtotal: true, isHighlight: true }),
    row("(−) 영업외손익", nonOpLoss),
    ...(hasInterest ? [row("(순이자비용)", netIntCost, { depth: 2, italic: true, paren: true })] : []),
    row("세전이익", pretax, { depth: 0, isSubtotal: true, isHighlight: true }),
    row("(−) 법인세비용", tax),
    row("(−) 기타", otherToNi),
    row("당기순이익", netIncome, { depth: 0, isSubtotal: true, isHighlight: true }),
    ...(labels.some((l) => niParent[l] != null) ? [row("(지배주주 귀속)", niParent, { depth: 2, italic: true, paren: true })] : []),
    row("기본 EPS", epsBasic, { numberFormat: "eps" }),
    row("희석 EPS", epsDil, { numberFormat: "eps" }),
    { accountName: "", accountId: "is:sp", depth: 0, isSubtotal: false, isHighlight: false, values: blank() },
    row("[ 주석 항목 ]", blank(), { depth: 0, isSubtotal: true }),
    row(daApprox ? "EBITDA (근사)" : "EBITDA", ebitda),
    row(daApprox ? "감가상각비 (근사)" : "감가상각비", da),
  ];

  return {
    symbol: "",
    market: "kr",
    periodType: facts.mode === "quarter" ? "quarter" : "annual",
    unit: "원",
    currency: "KRW",
    consolidation: facts.fsDiv === "CFS" ? "consolidated" : "separate",
    periods: facts.periods.map((p) => ({
      label: p.label,
      fiscalYear: p.year,
      fiscalQuarter: p.quarter,
      endDate: p.endDate,
    })),
    sections: [{ title: "손익계산서", items }],
    source:
      facts.source +
      " · 표준화 재분류" +
      (daApprox ? " · EBITDA·감가상각비는 유·무형자산 증감 기반 근사" : ""),
  };
}
