import "server-only";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import type { FinancialStatement, FinancialLineItem, FinancialPeriod } from "../types";
import type { QuoteBar } from "../types";
import {
  annualByYear,
  annualEnds,
  firstConcept,
  instantByYear,
  latestInstant,
  ttmOf,
} from "./edgar-series";

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
const DA = [
  "DepreciationDepletionAndAmortization",
  "DepreciationAmortizationAndAccretionNet",
  "DepreciationAndAmortization",
];
const INT_EXP = ["InterestExpense", "InterestExpenseNonoperating", "InterestAndDebtExpense"];
const DEBT_C = ["LongTermDebtNoncurrent", "LongTermDebtCurrent", "CommercialPaper", "ShortTermBorrowings"];
const CASH_C = [
  "CashAndCashEquivalentsAtCarryingValue",
  "MarketableSecuritiesCurrent",
  "ShortTermInvestments",
  "MarketableSecuritiesNoncurrent",
  "LongTermInvestments",
];

function closeOnOrBefore(bars: QuoteBar[], iso: string): number | null {
  let best: number | null = null;
  for (const b of bars) if (b.date <= iso && b.close != null) best = b.close;
  return best;
}

export function buildUsAnalysis(facts: CompanyFacts, bars: QuoteBar[]): FinancialStatement {
  const revEntries = firstConcept(facts, REV);
  const years = [...annualByYear(revEntries).keys()].sort((a, b) => a - b).slice(-5);
  const ends = annualEnds(revEntries);
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

  // 흐름값: FY → 연간, LTM → TTM
  const flow = (concepts: string[]): Record<string, number | null> => {
    const e = firstConcept(facts, concepts);
    const ann = annualByYear(e);
    const o = blank();
    for (const y of years) o[`${y}Y`] = ann.get(y) ?? null;
    o[LTM] = ttmOf(e);
    return o;
  };
  // 잔액값: FY말 → 그 해, LTM → 최신
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

  const revenue = flow(REV);
  const grossProfit = flow(["GrossProfit"]);
  const opIncome = flow(["OperatingIncomeLoss"]);
  const netIncome = flow(["NetIncomeLoss"]);
  const eps = flow(["EarningsPerShareDiluted"]);
  const da = flow(DA);
  const ocf = flow(["NetCashProvidedByUsedInOperatingActivities"]);
  const capexRaw = flow(["PaymentsToAcquirePropertyPlantAndEquipment"]);
  const dividends = flow(["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"]);
  const buyback = flow(["PaymentsForRepurchaseOfCommonStock"]);
  const intExp = flow(INT_EXP);
  const taxExp = flow(["IncomeTaxExpenseBenefit"]);
  const pretax = flow([
    "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
  ]);

  const equity = stock(["StockholdersEquity"]);
  const assets = stock(["Assets"]);
  const curAssets = stock(["AssetsCurrent"]);
  const curLiab = stock(["LiabilitiesCurrent"]);
  const debt = stockSum(DEBT_C);
  const cash = stockSum(CASH_C);
  const sharesDei = (() => {
    const e = (facts.facts.dei?.["EntityCommonStockSharesOutstanding"]?.units?.shares ??
      []) as FactUnitEntry[];
    const o = blank();
    for (const p of periods) {
      let best: { v: number; d: number } | null = null;
      for (const x of e) {
        const dd = Math.abs(Date.parse(p.endDate ?? "") - Date.parse(x.end));
        if (!best || dd < best.d) best = { v: x.val, d: dd };
      }
      o[p.label] = best?.v ?? null;
    }
    return o;
  })();
  const sharesEnd = stock(["CommonStockSharesOutstanding"]);
  const shares = blank();
  for (const l of labels) shares[l] = sharesDei[l] ?? sharesEnd[l];

  // 파생
  const ebitda = blank();
  for (const l of labels) if (opIncome[l] != null) ebitda[l] = opIncome[l]! + (da[l] ?? 0);
  const fcf = blank();
  for (const l of labels) if (ocf[l] != null && capexRaw[l] != null) fcf[l] = ocf[l]! - Math.abs(capexRaw[l]!);
  const netDebt = blank();
  for (const l of labels) if (debt[l] != null || cash[l] != null) netDebt[l] = (debt[l] ?? 0) - (cash[l] ?? 0);
  const nopat = blank();
  for (const l of labels) {
    if (opIncome[l] == null) continue;
    const rate = pretax[l] && taxExp[l] != null ? taxExp[l]! / pretax[l]! : 0.21;
    nopat[l] = opIncome[l]! * (1 - Math.min(Math.max(rate, 0), 0.4));
  }
  const investedCap = blank();
  for (const l of labels)
    if (debt[l] != null && equity[l] != null)
      investedCap[l] = debt[l]! + equity[l]! - (cash[l] ?? 0);

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
    return o;
  };
  const cagr = (a: Record<string, number | null>, n: number) => {
    const o = blank();
    for (let i = 0; i < labels.length; i++) {
      const cur = a[labels[i]];
      const base = a[labels[i - n]];
      if (cur != null && base != null && base > 0 && cur > 0)
        o[labels[i]] = (Math.pow(cur / base, 1 / n) - 1) * 100;
    }
    return o;
  };
  const fwdMktcap = () => {
    const o = blank();
    for (const l of labels) o[l] = l === LTM ? curMktcap : mktcap[l];
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
  const epsGrowth = blank();
  for (let i = 1; i < labels.length; i++) {
    const c = eps[labels[i]];
    const p = eps[labels[i - 1]];
    if (c != null && p && p > 0) epsGrowth[labels[i]] = ((c - p) / p) * 100;
  }
  const peg = blank();
  for (const l of labels)
    if (per[l] != null && epsGrowth[l] && epsGrowth[l]! > 0) peg[l] = per[l]! / epsGrowth[l]!;

  const items: FinancialLineItem[] = [
    HEAD("밸류에이션"),
    R("PER", per, "mult"),
    R("PBR", pbrV, "mult"),
    R("PSR", psrV, "mult"),
    R("EV/EBITDA", evEbitda, "mult"),
    R("PEG", peg, "mult"),
    SP("1"),
    HEAD("수익성"),
    R("ROE (%)", ratio(netIncome, equity, 100), "pct"),
    R("ROA (%)", ratio(netIncome, assets, 100), "pct"),
    R("ROIC (%)", ratio(nopat, investedCap, 100), "pct"),
    R("매출총이익률 (%)", ratio(grossProfit, revenue, 100), "pct"),
    R("영업이익률 (%)", ratio(opIncome, revenue, 100), "pct"),
    R("순이익률 (%)", ratio(netIncome, revenue, 100), "pct"),
    SP("2"),
    HEAD("현금창출"),
    R("잉여현금흐름 (FCF)", fcf),
    R("FCF 마진 (%)", ratio(fcf, revenue, 100), "pct"),
    R("FCF 수익률 (%)", ratio(fcf, fwdMktcap(), 100), "pct"),
    R("주가 / FCF", ratio(fwdMktcap(), fcf), "mult"),
    R("영업현금흐름 / 순이익", ratio(ocf, netIncome), "mult"),
    R("주당 FCF", perShare(fcf), "eps"),
    SP("3"),
    HEAD("재무건전성"),
    R("순부채 / EBITDA", ratio(netDebt, ebitda), "mult"),
    R("이자보상배율", ratio(opIncome, intExp), "mult"),
    R("유동비율", ratio(curAssets, curLiab), "mult"),
    R("부채비율 (%)", ratio(debt, equity, 100), "pct"),
    SP("4"),
    HEAD("주주환원"),
    R("배당수익률 (%)", (() => {
      const o = blank();
      for (const l of labels) {
        const dps = dividends[l] != null && shares[l] ? Math.abs(dividends[l]!) / shares[l]! : null;
        if (dps != null && price[l]) o[l] = (dps / price[l]!) * 100;
      }
      return o;
    })(), "pct"),
    R("배당성향 (%)", (() => {
      const o = blank();
      for (const l of labels)
        if (dividends[l] != null && netIncome[l]) o[l] = (Math.abs(dividends[l]!) / netIncome[l]!) * 100;
      return o;
    })(), "pct"),
    R("자사주 매입", (() => {
      const o = blank();
      for (const l of labels) if (buyback[l] != null) o[l] = -Math.abs(buyback[l]!);
      return o;
    })()),
    R("총주주환원율 (%)", (() => {
      const o = blank();
      for (const l of labels) {
        const ret = (dividends[l] != null ? Math.abs(dividends[l]!) : 0) + (buyback[l] != null ? Math.abs(buyback[l]!) : 0);
        if (netIncome[l]) o[l] = (ret / netIncome[l]!) * 100;
      }
      return o;
    })(), "pct"),
    SP("5"),
    HEAD("성장성 (CAGR)"),
    R("매출 3년", cagr(revenue, 3), "pct"),
    R("매출 5년", cagr(revenue, 5), "pct"),
    R("EPS 3년", cagr(eps, 3), "pct"),
    R("EPS 5년", cagr(eps, 5), "pct"),
    R("FCF 3년", cagr(fcf, 3), "pct"),
  ];

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
