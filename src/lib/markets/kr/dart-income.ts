import "server-only";
import type { FinancialStatement, FinancialLineItem } from "../types";
import { type KrFacts, type KrDaInput, daAndAmortSeries, krDaSourceNote, seriesOf, sumOf } from "./dart-facts";
import { KR_EPS_SUM_NOTE, krEpsSeries } from "./dart-ev";

/** 손익계산서 화면과 같은 계정 선택의 매출·영업이익·당기순이익(기간 라벨별) — LTM = 최근 4개 분기 열 합(opendart.ts)이 쓴다 */
export function krIsFlows(facts: KrFacts): { revenue: Record<string, number | null>; opIncome: Record<string, number | null>; netIncome: Record<string, number | null> } {
  const IS = ["IS", "CIS"];
  return {
    revenue: seriesOf(facts, C.revenue.ids, C.revenue.names, IS),
    opIncome: seriesOf(facts, C.opIncome.ids, C.opIncome.names, IS),
    netIncome: seriesOf(facts, C.netIncome.ids, C.netIncome.names, IS),
  };
}

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
  // EPS 는 dart-ev.ts krEpsSeries(전체 EPS — 미공시면 계속 + 중단영업 합, 하이라이트·재무분석과 같은 기준)
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

export function buildKrIncome(facts: KrFacts, daDoc: KrDaInput | null = null): FinancialStatement {
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
  // 비지배지분이 없는 회사는 DART 손익계산서에 "지배기업 소유주지분" 줄 자체를 생략한다(LS마린솔루션 전 기간·한전기술 2022 —
  // FnGuide 순이익(지배) = 당기순이익, 검증 2026-09-28). 그 기간에 비지배지분 순이익 줄도, 재무상태표 비지배지분 줄도 없을 때만
  // (없음 증명) 지배주주 귀속 = 당기순이익으로 채우고 칸 주석을 단다. 한쪽이라도 있으면 비운 그대로.
  const niNci = S({ ids: ["ifrs-full_ProfitLossAttributableToNonControllingInterests"], names: ["비지배지분"] });
  const bsNci = seriesOf(facts, ["ifrs-full_NoncontrollingInterests"], ["비지배지분"], "BS");
  const niParentNotes: Record<string, string> = {};
  for (const l of labels)
    if (niParent[l] == null && netIncome[l] != null && niNci[l] == null && !bsNci[l]) {
      niParent[l] = netIncome[l];
      niParentNotes[l] = "비지배지분 없음(손익·재무상태표에 비지배지분 줄 없음) — 당기순이익 = 지배주주 귀속";
    }
  const otherToNi = blank();
  for (const l of labels)
    if (pretax[l] != null && tax[l] != null && netIncome[l] != null)
      otherToNi[l] = Math.round(pretax[l]! - tax[l]! - netIncome[l]!);

  const eB = krEpsSeries(facts, "basic"), eD = krEpsSeries(facts, "diluted");
  const epsBasic = eB.values;
  const epsDil = eD.values;
  const epsNote = (sum: Set<string>): Record<string, string> => Object.fromEntries([...sum].map((l) => [l, KR_EPS_SUM_NOTE]));
  // 희석 EPS 를 따로 공시하지 않은 해(희석 증권 없음)는 기본 EPS 와 정의상 같다 — 하이라이트·
  // 재무분석·컨센서스가 쓰는 krEpsByYear(dart-ev.ts, 희석 → 기본 순)와 같은 값이 되게 채운다.
  // 예전엔 여기만 비워 LG에너지솔루션 2023~2025 가 화면마다 갈렸다(검증 2026-09-24).
  for (const l of labels) if (epsDil[l] == null && epsBasic[l] != null) epsDil[l] = epsBasic[l];

  let daNote: string | null = null;
  const da = (() => {
    // 연간: 하이라이트·재무분석과 같은 함수(daAndAmortSeries — 사업보고서 주석 영업비용 기준 → 공시 현금흐름 줄, 없으면 빈칸). 예전엔 여기만
    // DART 현금흐름 "감가상각비" 한 줄을 먼저 써서 LS ELECTRIC 2021 이 617.9억(하이라이트 1,014.6억)으로 갈렸다(2026-10-02)
    if (facts.mode !== "quarter") {
      const s = daAndAmortSeries(facts, daDoc);
      const d = blank();
      for (const p of facts.periods) if (p.kind === "fy") d[p.label] = s.byYear.get(p.year) ?? null;
      daNote = krDaSourceNote(s, facts.periods.filter((p) => p.kind === "fy").map((p) => p.year));
      return d;
    }
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
    // 분기: 공시 줄이 없으면 빈칸(연간 주석값을 분기 열에 넣지 않는다 — 예전 폴백은 사업연도 값을 그해 분기마다 넣었다, 2026-10-02)
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
  // 영업 안에 지분법손익이 있는 투자회사(SK스퀘어 — 영업수익 + 지분법손익 − 영업비용 = 영업이익): 회사 영업비용 줄과 지분법손익 줄을 그대로.
  // 예전엔 영업비용 = 매출 − 영업이익으로만 구해 −7.39조 같은 음수 영업비용이 나왔다(2026-10-02, FnGuide 대조). 그 식이 정확히 맞는 열만
  const compOpex = S({ ids: ["ifrs-full_OperatingExpense"], names: ["영업비용"] });
  const eqInOp = S({ ids: ["ifrs-full_AdjustmentsForUndistributedProfitsOfInvestmentsAccountedForUsingEquityMethod", "ifrs-full_ShareOfProfitLossOfAssociatesAndJointVenturesAccountedForUsingEquityMethod"], names: ["지분법손익"] });
  const eqOp = blank();
  const totalOpex = (() => {
    const o = blank();
    for (const l of labels) {
      if (revenue[l] == null || opIncome[l] == null) continue;
      if (compOpex[l] != null && eqInOp[l] != null && Math.round(revenue[l]! - compOpex[l]! + eqInOp[l]!) === Math.round(opIncome[l]!)) {
        o[l] = compOpex[l];
        eqOp[l] = eqInOp[l];
      } else o[l] = revenue[l]! - opIncome[l]!;
    }
    return o;
  })();
  const hasEqOp = labels.some((l) => eqOp[l] != null);

  const items: FinancialLineItem[] = [
    row("매출액", revenue, { depth: 0, isSubtotal: true, isHighlight: true }),
    ...(hasGross
      ? [
          row("(−) 매출원가", cogs),
          row("매출총이익", gross, { depth: 0, isSubtotal: true, isHighlight: true }),
          row("(−) 판매관리비", sga),
          row("(−) 기타 영업비용", otherOpex),
        ]
      : [row("(−) 영업비용", totalOpex), ...(hasEqOp ? [row("(+) 지분법손익(영업)", eqOp)] : [])]),
    row("영업이익", opIncome, { depth: 0, isSubtotal: true, isHighlight: true }),
    row("(−) 영업외손익", nonOpLoss),
    ...(hasInterest ? [row("(순이자비용)", netIntCost, { depth: 2, italic: true, paren: true })] : []),
    row("세전이익", pretax, { depth: 0, isSubtotal: true, isHighlight: true }),
    row("(−) 법인세비용", tax),
    row("(−) 기타", otherToNi),
    row("당기순이익", netIncome, {
      depth: 0,
      isSubtotal: true,
      isHighlight: true,
      // 손익계산서에 순이익 줄이 없어 지배 + 비지배 귀속으로 채운 해(dart-facts.ts niFromParts)
      ...(() => {
        const cn: Record<string, string> = {};
        for (const p of facts.periods) {
          const t = p.kind === "fy" ? facts.niFromParts?.get(p.year) : undefined;
          if (t && netIncome[p.label] != null) cn[p.label] = t;
        }
        return Object.keys(cn).length ? { cellNotes: cn } : {};
      })(),
    }),
    ...(labels.some((l) => niParent[l] != null)
      ? [row("(지배주주 귀속)", niParent, { depth: 2, italic: true, paren: true, ...(Object.keys(niParentNotes).length ? { cellNotes: niParentNotes } : {}) })]
      : []),
    row("기본 EPS", epsBasic, { numberFormat: "eps", ...(eB.summed.size ? { cellNotes: epsNote(eB.summed) } : {}) }),
    row("희석 EPS", epsDil, { numberFormat: "eps", ...(eD.summed.size || eB.summed.size ? { cellNotes: epsNote(new Set([...eD.summed, ...[...eB.summed].filter((l) => eD.values[l] == null || eD.summed.has(l))])) } : {}) }),
    { accountName: "", accountId: "is:sp", depth: 0, isSubtotal: false, isHighlight: false, values: blank() },
    row("[ 주석 항목 ]", blank(), { depth: 0, isSubtotal: true }),
    row("EBITDA", ebitda),
    row("감가·무형상각비", da),
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
      (daNote ? ` · ${daNote}` : ""),
  };
}
