import "server-only";
import type { FinancialStatement, FinancialLineItem, QuoteBar, TtmFlows } from "../types";
import { type KrFacts, type KrDaInput, annualSeries, annualSumByPattern, daAndAmortSeries } from "./dart-facts";

/**
 * 한국 분석 지표 — `edgar-analysis.ts` 미러 (섹션·라벨 동일, 개요 요약칩 호환).
 * DART 전체재무제표 + 시세. 컬럼: 최근 5개 사업연도 + 현재/LTM.
 * EBITDA = 영업이익 + 감가상각비(유·무형자산 증감 기반 근사 — DART 미분리).
 * 이자비용 = CF '이자의 지급'.
 */

const LTM = "현재/LTM";
const IS = ["IS", "CIS"];

const C = {
  rev: { ids: ["ifrs-full_Revenue", "dart_Revenue"], names: ["매출액", "수익(매출액)", "영업수익"] },
  gross: { ids: ["ifrs-full_GrossProfit"], names: ["매출총이익"] },
  opInc: { ids: ["dart_OperatingIncomeLoss"], names: ["영업이익"] },
  pretax: { ids: ["ifrs-full_ProfitLossBeforeTax"], names: ["법인세비용차감전순이익"] },
  tax: { ids: ["ifrs-full_IncomeTaxExpenseContinuingOperations", "ifrs-full_IncomeTaxExpenseBenefit"], names: ["법인세비용"] },
  ni: { ids: ["ifrs-full_ProfitLoss"], names: ["당기순이익", "분기순이익", "반기순이익"] },
  eps: {
    ids: [
      "ifrs-full_DilutedEarningsLossPerShare",
      "ifrs-full_BasicEarningsLossPerShare",
      "ifrs-full_DilutedEarningsLossPerShareFromContinuingOperations",
      "ifrs-full_BasicEarningsLossPerShareFromContinuingOperations",
    ],
    names: ["희석주당이익", "희석주당순이익", "기본주당이익", "기본주당순이익", "보통주기본주당이익", "계속영업기본주당이익"],
  },
  assets: { ids: ["ifrs-full_Assets"], names: ["자산총계"] },
  curAssets: { ids: ["ifrs-full_CurrentAssets"], names: ["유동자산"] },
  curLiab: { ids: ["ifrs-full_CurrentLiabilities"], names: ["유동부채"] },
  liab: { ids: ["ifrs-full_Liabilities"], names: ["부채총계"] },
  equity: { ids: ["ifrs-full_Equity"], names: ["자본총계"] },
  retained: { ids: ["ifrs-full_RetainedEarnings"], names: ["이익잉여금"] },
  cash: { ids: ["ifrs-full_CashAndCashEquivalents"], names: ["현금및현금성자산"] },
  stInv: { ids: ["ifrs-full_ShorttermDepositsNotClassifiedAsCashEquivalents"], names: ["단기금융상품"] },
  ar: { ids: ["ifrs-full_CurrentTradeReceivables", "ifrs-full_TradeAndOtherCurrentReceivables", "dart_ShortTermTradeReceivable"], names: ["매출채권", "매출채권및기타채권"] },
  inv: { ids: ["ifrs-full_Inventories"], names: ["재고자산"] },
  ap: { ids: ["ifrs-full_TradeAndOtherCurrentPayablesToTradeSuppliers", "ifrs-full_TradeAndOtherCurrentPayables", "dart_ShortTermTradePayables"], names: ["매입채무", "매입채무및기타채무"] },
  ppe: { ids: ["ifrs-full_PropertyPlantAndEquipment"], names: ["유형자산"] },
  intang: { ids: ["ifrs-full_IntangibleAssetsAndGoodwill", "ifrs-full_IntangibleAssetsOtherThanGoodwill"], names: ["무형자산"] },
  ocf: { ids: ["ifrs-full_CashFlowsFromUsedInOperatingActivities"], names: ["영업활동현금흐름"] },
  capex: { ids: ["ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities"], names: ["유형자산의 취득"] },
  intangAcq: { ids: ["ifrs-full_PurchaseOfIntangibleAssetsClassifiedAsInvestingActivities"], names: ["무형자산의 취득"] },
  intPaid: { ids: ["ifrs-full_InterestPaidClassifiedAsOperatingActivities"], names: ["이자의 지급"] },
  divPaid: { ids: ["ifrs-full_DividendsPaidClassifiedAsFinancingActivities"], names: ["배당금의지급", "배당금지급"] },
};

function closeOnOrBefore(bars: QuoteBar[], iso: string): number | null {
  let best: number | null = null;
  for (const b of bars) if (b.date <= iso && b.close != null) best = b.close;
  return best;
}

export interface KrAnalysisInput {
  facts: KrFacts;
  bars: QuoteBar[];
  fyCloseByYear?: Map<number, number>;
  sharesOutstanding: number | null;
  currentPrice: number | null;
  currentMarketCap: number | null;
  ttm: TtmFlows | null;
  daDoc?: KrDaInput | null;
}

export function buildKrAnalysis(input: KrAnalysisInput): FinancialStatement {
  const { facts, bars, fyCloseByYear, sharesOutstanding: shares, currentPrice, currentMarketCap, ttm, daDoc = null } = input;
  const years = facts.periods.map((p) => p.year);
  const labels = [...years.map((y) => `${y}Y`), LTM];
  const blank = (): Record<string, number | null> => Object.fromEntries(labels.map((l) => [l, null]));

  const A = (c: { ids: string[]; names: string[] }, sj?: string | string[]) =>
    annualSeries(facts, c.ids, c.names, sj);
  const aDebt = annualSumByPattern(facts, /차입금|사채|리스부채/, "BS", /리스채권|투자|자산|받을|대여/);

  // 연간 시계열 (6개년) → 라벨 맵 (5개년 + LTM)
  const rev0 = A(C.rev, IS);
  const gross0 = A(C.gross, IS);
  const opInc0 = A(C.opInc, IS);
  const pretax0 = A(C.pretax, IS);
  const tax0 = A(C.tax, IS);
  const ni0 = A(C.ni, IS);
  const eps0 = A(C.eps, IS);
  const assets0 = A(C.assets, "BS");
  const curAssets0 = A(C.curAssets, "BS");
  const curLiab0 = A(C.curLiab, "BS");
  const liab0 = A(C.liab, "BS");
  const equity0 = A(C.equity, "BS");
  const retained0 = A(C.retained, "BS");
  const cash0 = A(C.cash, "BS");
  const stInv0 = A(C.stInv, "BS");
  const ar0 = A(C.ar, "BS");
  const inv0 = A(C.inv, "BS");
  const ap0 = A(C.ap, "BS");
  const ocf0 = A(C.ocf, "CF");
  const capex0 = A(C.capex, "CF");
  const intPaid0 = A(C.intPaid, "CF");
  const divPaid0 = A(C.divPaid, "CF");

  const map = (m: Map<number, number>, ltm?: number | null): Record<string, number | null> => {
    const o = blank();
    for (const y of years) o[`${y}Y`] = m.get(y) ?? null;
    o[LTM] = ltm ?? m.get(years[years.length - 1]) ?? null;
    return o;
  };
  const rev = map(rev0, ttm?.revenue);
  const gross = map(gross0);
  const opInc = map(opInc0, ttm?.opIncome);
  const pretax = map(pretax0);
  const tax = map(tax0);
  const ni = map(ni0, ttm?.netIncome);
  const eps = map(eps0, ttm?.eps);
  const assets = map(assets0);
  const curAssets = map(curAssets0);
  const curLiab = map(curLiab0);
  const liab = map(liab0);
  const equity = map(equity0);
  const retained = map(retained0);
  const cash = map(cash0);
  const stInv = map(stInv0);
  const ar = map(ar0);
  const ocf = map(ocf0);
  const capexAbs = (() => {
    const o = map(capex0);
    for (const l of labels) if (o[l] != null) o[l] = Math.abs(o[l]!);
    return o;
  })();
  const intPaid = (() => {
    const o = map(intPaid0);
    for (const l of labels) if (o[l] != null) o[l] = Math.abs(o[l]!);
    return o;
  })();
  const divPaid = (() => {
    const o = map(divPaid0);
    for (const l of labels) if (o[l] != null) o[l] = Math.abs(o[l]!);
    return o;
  })();
  const debt = map(aDebt);

  // 현금성 (순차입금용): 현금 + 단기금융상품
  const cashTot = blank();
  for (const l of labels)
    if (cash[l] != null || stInv[l] != null) cashTot[l] = (cash[l] ?? 0) + (stInv[l] ?? 0);
  const netDebt = blank();
  for (const l of labels) if (debt[l] != null || cashTot[l] != null) netDebt[l] = (debt[l] ?? 0) - (cashTot[l] ?? 0);

  // 감가상각비: 사업보고서 XBRL 주석 실측(daDoc) + 이전 연도는 유·무형자산 롤포워드 보정
  const daS = daAndAmortSeries(facts, daDoc);
  const daEst = blank();
  for (const y of years) daEst[`${y}Y`] = daS.byYear.get(y) ?? null;
  daEst[LTM] = daS.ltm;
  const ebitda = blank();
  for (const l of labels) if (opInc[l] != null && daEst[l] != null) ebitda[l] = opInc[l]! + daEst[l]!;

  // 평균잔액
  const avg = (m: Map<number, number>): Record<string, number | null> => {
    const o = blank();
    for (const y of years) {
      const cur = m.get(y);
      const prev = m.get(y - 1);
      o[`${y}Y`] = cur != null && prev != null ? (cur + prev) / 2 : (cur ?? null);
    }
    o[LTM] = o[`${years[years.length - 1]}Y`];
    return o;
  };
  const equityAvg = avg(equity0);
  const assetsAvg = avg(assets0);
  const arAvg = avg(ar0);
  const invAvg = avg(inv0);
  const apAvg = avg(ap0);

  // 시가총액
  const mktcap = blank();
  for (const y of years) {
    const px = closeOnOrBefore(bars, `${y}-12-31`) ?? fyCloseByYear?.get(y) ?? null;
    mktcap[`${y}Y`] = px != null && shares != null ? px * shares : null;
  }
  const curMktcap = currentMarketCap ?? (currentPrice != null && shares != null ? currentPrice * shares : null);
  mktcap[LTM] = curMktcap;
  const priceByLabel = blank();
  for (const y of years) priceByLabel[`${y}Y`] = closeOnOrBefore(bars, `${y}-12-31`) ?? fyCloseByYear?.get(y) ?? null;
  priceByLabel[LTM] = currentPrice;

  // ── helpers ──
  const R = (
    label: string,
    values: Record<string, number | null>,
    fmt: FinancialLineItem["numberFormat"] = "mult",
    opts: Partial<FinancialLineItem> = {},
  ): FinancialLineItem => ({
    accountName: label,
    accountId: `an:${label}`,
    depth: 1,
    isSubtotal: false,
    isHighlight: false,
    values,
    numberFormat: fmt,
    ...opts,
  });
  const HEAD = (t: string): FinancialLineItem => ({
    accountName: t,
    accountId: `an:h:${t}`,
    depth: 0,
    isSubtotal: true,
    isHighlight: false,
    values: blank(),
  });
  const SP = (k: string): FinancialLineItem => ({ accountName: "", accountId: `an:sp:${k}`, depth: 0, isSubtotal: false, isHighlight: false, values: blank() });

  const ratio = (n: Record<string, number | null>, d: Record<string, number | null>, k = 1): Record<string, number | null> => {
    const o = blank();
    for (const l of labels) if (n[l] != null && d[l] != null && d[l] !== 0) o[l] = (n[l]! / d[l]!) * k;
    return o;
  };
  const yoySeries = (m: Map<number, number>, ltm?: number | null): Record<string, number | null> => {
    const o = blank();
    for (let i = 0; i < years.length; i++) {
      const y = years[i];
      const cur = m.get(y);
      const prev = m.get(y - 1);
      o[`${y}Y`] = cur != null && prev != null && prev !== 0 ? ((cur - prev) / Math.abs(prev)) * 100 : null;
    }
    const lastY = years[years.length - 1];
    const prev = m.get(lastY);
    // LTM YoY 는 별도 TTM 값이 있을 때만 (없으면 최근 FY 와 동일 → 0% 표시 방지)
    o[LTM] = ltm != null && prev != null && prev !== 0 ? ((ltm - prev) / Math.abs(prev)) * 100 : null;
    return o;
  };
  const cagrN = (m: Map<number, number>, n: number, ltm?: number | null): Record<string, number | null> => {
    const o = blank();
    for (let i = 0; i < years.length; i++) {
      const y = years[i];
      const cur = m.get(y);
      const base = m.get(y - n);
      o[`${y}Y`] = cur != null && base != null && base > 0 && cur > 0 ? (Math.pow(cur / base, 1 / n) - 1) * 100 : null;
    }
    const lastY = years[years.length - 1];
    const cur = ltm ?? m.get(lastY);
    const base = m.get(lastY + 1 - n);
    o[LTM] = cur != null && base != null && base > 0 && cur > 0 ? (Math.pow(cur / base, 1 / n) - 1) * 100 : null;
    return o;
  };

  // ── 밸류에이션 ──
  const per = ratio(priceByLabel, eps);
  const pbr = ratio(mktcap, equity);
  const psr = ratio(mktcap, rev);
  const evV = blank();
  for (const l of labels) if (mktcap[l] != null && netDebt[l] != null) evV[l] = mktcap[l]! + netDebt[l]!;
  const evEbitda = ratio(evV, ebitda);
  const fcf = blank();
  for (const l of labels) if (ocf[l] != null && capexAbs[l] != null) fcf[l] = ocf[l]! - capexAbs[l]!;
  const epsCagr3 = cagrN(eps0, 3, ttm?.eps);
  const peg = blank();
  for (const l of labels) {
    const g = epsCagr3[l];
    if (per[l] != null && per[l]! > 0 && g != null && g >= 1) peg[l] = per[l]! / g;
  }

  // ── 수익성 ──
  const roe = ratio(ni, equityAvg, 100);
  const niMargin = ratio(ni, rev, 100);
  const assetTurn = ratio(rev, assetsAvg);
  const finLev = ratio(assetsAvg, equityAvg);
  const roa = ratio(ni, assetsAvg, 100);
  // ROIC ≈ NOPAT / 투하자본. NOPAT = 영업이익 × (1 − 유효세율)
  const effTax = ratio(tax, pretax);
  const nopat = blank();
  for (const l of labels) if (opInc[l] != null) nopat[l] = opInc[l]! * (1 - (effTax[l] ?? 0.25));
  const investedCap = blank();
  for (const l of labels) if (equity[l] != null || debt[l] != null) investedCap[l] = (equity[l] ?? 0) + (debt[l] ?? 0);
  const roic = ratio(nopat, avg2(investedCap), 100);
  const fcfMargin = ratio(fcf, rev, 100);
  const grossMargin = ratio(gross, rev, 100);
  const opMargin = ratio(opInc, rev, 100);
  const effTaxPct = ratio(tax, pretax, 100);

  // ── 레버리지 ──
  const debtRatio = ratio(liab, equity, 100); // 부채비율 = 부채총계 / 자기자본
  const debtToEquity = ratio(debt, equity, 100);
  const debtToAssets = ratio(debt, assets, 100);
  const netDebtToEquity = ratio(netDebt, equity, 100);

  // ── 재무건전성 ──
  const debtEbitda = ratio(debt, ebitda);
  const netDebtEbitda = ratio(netDebt, ebitda);
  const opToDebt = ratio(opInc, debt);
  const intCov = ratio(opInc, intPaid); // 이자보상배율 (EBIT/이자)
  const cfoToDebt = ratio(ocf, debt);
  const fcfToDebt = ratio(fcf, debt);
  const wc = blank();
  for (const l of labels) if (curAssets[l] != null && curLiab[l] != null) wc[l] = curAssets[l]! - curLiab[l]!;
  const altZ = blank();
  for (const l of labels) {
    const mc = mktcap[l];
    if (assets[l] && wc[l] != null && retained[l] != null && opInc[l] != null && mc != null && liab[l] && rev[l] != null)
      altZ[l] =
        1.2 * (wc[l]! / assets[l]!) +
        1.4 * (retained[l]! / assets[l]!) +
        3.3 * (opInc[l]! / assets[l]!) +
        0.6 * (mc / liab[l]!) +
        1.0 * (rev[l]! / assets[l]!);
  }

  // ── 유동성 ──
  const curRatio = ratio(curAssets, curLiab);
  const quick = blank();
  for (const l of labels) {
    if (!curLiab[l]) continue;
    const qa = (cash[l] ?? 0) + (stInv[l] ?? 0) + (ar[l] ?? 0);
    if (qa > 0) quick[l] = qa / curLiab[l]!;
  }
  const cashRatio = (() => {
    const o = blank();
    for (const l of labels) if (curLiab[l]) o[l] = ((cash[l] ?? 0) + (stInv[l] ?? 0)) / curLiab[l]!;
    return o;
  })();
  const cfoToCurLiab = ratio(ocf, avg2(curLiab));

  // ── 운전자본 ──
  const dso = ratio(arAvg, rev, 365);
  const cogsAbs = (() => {
    const o = blank();
    for (const l of labels) {
      const c = rev[l] != null && gross[l] != null ? rev[l]! - gross[l]! : null;
      if (c != null) o[l] = Math.abs(c);
    }
    return o;
  })();
  const dio = ratio(invAvg, cogsAbs, 365);
  const dpo = ratio(apAvg, cogsAbs, 365);
  const ccc = blank();
  for (const l of labels)
    if (dso[l] != null && dio[l] != null && dpo[l] != null) ccc[l] = dso[l]! + dio[l]! - dpo[l]!;

  // ── 주주환원 ──
  const payout = ratio(divPaid, ni, 100);

  const items: FinancialLineItem[] = [
    HEAD("밸류에이션"),
    R("PER", per, "mult"),
    R("PBR", pbr, "mult"),
    R("PSR", psr, "mult"),
    R("EV/EBITDA", evEbitda, "mult"),
    R("PEG (EPS 3Y CAGR)", peg, "mult"),
    SP("1"),
    HEAD("수익성"),
    R("ROE (%)", roe, "pct"),
    R("순이익률 (%)", niMargin, "pct", { depth: 2 }),
    R("× 총자산회전율 (회)", assetTurn, "mult", { depth: 2 }),
    R("× 재무레버리지 (배)", finLev, "mult", { depth: 2 }),
    R("ROA (%)", roa, "pct"),
    R("ROIC (%)", roic, "pct"),
    R("FCF 마진 (%)", fcfMargin, "pct"),
    R("매출총이익률 (%)", grossMargin, "pct"),
    R("영업이익률 (%)", opMargin, "pct"),
    R("유효세율 (%)", effTaxPct, "pct"),
    SP("2"),
    HEAD("현금창출"),
    R("영업현금흐름 / 순이익", ratio(ocf, ni), "mult"),
    R("주당 FCF", (() => {
      const o = blank();
      for (const l of labels) if (fcf[l] != null && shares) o[l] = fcf[l]! / shares;
      return o;
    })(), "eps"),
    SP("3"),
    HEAD("레버리지"),
    R("부채비율 (%)", debtRatio, "pct"),
    R("총차입금 / 자기자본 (%)", debtToEquity, "pct"),
    R("총차입금 / 총자산 (%)", debtToAssets, "pct"),
    R("순차입금 / 자기자본 (%)", netDebtToEquity, "pct"),
    SP("4"),
    HEAD("재무건전성"),
    R("총차입금 / EBITDA", debtEbitda, "mult"),
    R("순차입금 / EBITDA", netDebtEbitda, "mult"),
    R("영업이익 / 총차입금", opToDebt, "mult"),
    R("이자보상배율 (EBIT/이자)", intCov, "mult"),
    R("CFO / 총차입금", cfoToDebt, "mult"),
    R("FCF / 총차입금", fcfToDebt, "mult"),
    R("알트만 Z-스코어", altZ, "pct"),
    SP("4a"),
    HEAD("유동성"),
    R("유동비율", curRatio, "mult"),
    R("당좌비율", quick, "mult"),
    R("현금비율", cashRatio, "mult"),
    R("CFO / 유동부채", cfoToCurLiab, "mult"),
    SP("4b"),
    HEAD("운전자본"),
    R("매출채권 회전일수 (DSO)", dso, "pct"),
    R("재고자산 회전일수 (DIO)", dio, "pct"),
    R("매입채무 회전일수 (DPO)", dpo, "pct"),
    R("현금전환주기 (CCC)", ccc, "pct"),
    SP("4c"),
    HEAD("주주환원"),
    R("배당성향 (%)", payout, "pct"),
    SP("5"),
    HEAD("성장률 (1년 YoY)"),
    R("매출액", yoySeries(rev0, ttm?.revenue), "pct"),
    R("영업이익", yoySeries(opInc0, ttm?.opIncome), "pct"),
    R("순이익", yoySeries(ni0, ttm?.netIncome), "pct"),
    R("희석 EPS", yoySeries(eps0, ttm?.eps), "pct"),
    R("영업활동 현금흐름", yoySeries(ocf0), "pct"),
    R("잉여현금흐름", yoySeries(fcfSeries(ocf0, capex0)), "pct"),
    SP("6"),
    HEAD("성장률 (3년 CAGR)"),
    R("매출액", cagrN(rev0, 3, ttm?.revenue), "pct"),
    R("EPS", cagrN(eps0, 3, ttm?.eps), "pct"),
  ];

  return {
    symbol: "",
    market: "kr",
    periodType: "annual",
    unit: "원",
    currency: "KRW",
    consolidation: facts.fsDiv === "CFS" ? "consolidated" : "separate",
    periods: [
      ...years.map((y) => ({ label: `${y}Y`, fiscalYear: y, fiscalQuarter: null, endDate: `${y}-12-31` })),
      { label: LTM, fiscalYear: (years.at(-1) ?? 0) + 1, fiscalQuarter: null, endDate: bars.at(-1)?.date ?? new Date().toISOString().slice(0, 10) },
    ],
    sections: [{ title: "분석 지표", items }],
    source: facts.source + " + 시세 · 자체 계산",
  };

  function avg2(m: Record<string, number | null>): Record<string, number | null> {
    // 라벨 맵의 인접 평균 (연간 시계열이 아니므로 근사: 현재값 그대로)
    return m;
  }
  function fcfSeries(ocfM: Map<number, number>, capexM: Map<number, number>): Map<number, number> {
    const o = new Map<number, number>();
    for (const [y, v] of ocfM) {
      const cx = capexM.get(y);
      if (cx != null) o.set(y, v - Math.abs(cx));
    }
    return o;
  }
}
