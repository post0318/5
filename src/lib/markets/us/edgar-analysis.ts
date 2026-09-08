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

  const years = [...mergedAnnual(REV).keys()].sort((a, b) => a - b).slice(-5);
  const ends = mergedEnds(REV);
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

  const revenue = flow(REV);
  const grossProfitRaw = flow(["GrossProfit"]);
  const opIncome = flow(["OperatingIncomeLoss"]);
  const netIncome = flow(["NetIncomeLoss"]);
  const eps = adjPerShare(
    flow(["EarningsPerShareDiluted", "EarningsPerShareBasic"], "USD/shares"),
  );
  const epsFull = adjMap(
    fullAnnual(["EarningsPerShareDiluted", "EarningsPerShareBasic"], "USD/shares"),
  );
  const revFull = fullAnnual(REV);
  const da = flow(DA);
  const ocf = flow(["NetCashProvidedByUsedInOperatingActivities"]);
  const CAPEX_C = [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsToAcquireProductiveAssets",
  ];
  const capexRaw = flow(CAPEX_C);
  // 1년 성장률 첫 해(표시 첫 컬럼) 보정용 전체 시계열 — 전년 값 소스
  const opIncFull = fullAnnual(["OperatingIncomeLoss"]);
  const niFull = fullAnnual(["NetIncomeLoss"]);
  const daFull = fullAnnual(DA);
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
  const intExp = flowM(INT_EXP);
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
  const inv = stock(["InventoryNet"]);
  const retained = stock(["RetainedEarningsAccumulatedDeficit"]);
  const cogs = flowM(["CostOfGoodsAndServicesSold", "CostOfRevenue", "CostOfGoodsSold"]);
  // 매출총이익: 공시 태그(GrossProfit) 없으면 매출 − 매출원가 (메타 등)
  const grossProfit = blank();
  for (const l of labels)
    grossProfit[l] =
      grossProfitRaw[l] ??
      (revenue[l] != null && cogs[l] != null ? revenue[l]! - Math.abs(cogs[l]!) : null);
  const wc = blank(); // 운전자본 = 유동자산 − 유동부채
  for (const l of labels) if (curAssets[l] != null && curLiab[l] != null) wc[l] = curAssets[l]! - curLiab[l]!;
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
  // 이중 클래스(메타 등)는 기말 발행주식수를 클래스별로만 태깅 → undimensioned 값 없음.
  // 가중평균 희석주식수(연간)로 대체해 시총·PBR·EV 를 근사.
  const wavgDil = fullAnnual(["WeightedAverageNumberOfDilutedSharesOutstanding"], "shares");
  const wavgBasic = fullAnnual(["WeightedAverageNumberOfSharesOutstandingBasic"], "shares");
  const wavgAt = (y: number): number | null => wavgDil.get(y) ?? wavgBasic.get(y) ?? null;
  const latestWavg = (() => {
    const ys = [...wavgDil.keys(), ...wavgBasic.keys()];
    if (!ys.length) return null;
    const my = Math.max(...ys);
    return wavgDil.get(my) ?? wavgBasic.get(my) ?? null;
  })();
  const shares = blank();
  for (const l of labels)
    shares[l] =
      sharesDei[l] ??
      sharesEnd[l] ??
      (l === LTM ? latestWavg : wavgAt(Number(l.replace("Y", ""))));

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
  const nopat = blank();
  for (const l of labels) {
    if (opIncome[l] == null) continue;
    const rate = pretax[l] && taxExp[l] != null ? taxExp[l]! / pretax[l]! : 0.21;
    nopat[l] = opIncome[l]! * (1 - Math.min(Math.max(rate, 0), 0.4));
  }
  const investedCap = blank(); // 총차입금 + 자본 (순현금 기업 대비 음수 방지)
  for (const l of labels)
    if (debt[l] != null && equity[l] != null) investedCap[l] = debt[l]! + equity[l]!;
  const liabTotal = stock(["Liabilities"]);

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
  // CAGR: 전체 연도 시계열에서 각 컬럼 대비 n년 전 값
  const cagr = (full: Map<number, number>, n: number) => {
    const o = blank();
    for (const p of periods) {
      const endY = p.label === LTM ? (years.at(-1) ?? 0) : p.fiscalYear;
      const cur = full.get(endY);
      const base = full.get(endY - n);
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
  const epsCagr3 = cagr(epsFull, 3);
  const epsCagr2 = cagr(epsFull, 2);
  const peg = blank();
  for (const l of labels) {
    const g = epsCagr3[l] ?? epsCagr2[l];
    if (per[l] != null && per[l]! > 0 && g != null && g >= 1) peg[l] = per[l]! / g;
  }

  const effTax = ratio(taxExp, pretax, 100);
  const payoutR = (() => {
    const o = blank();
    for (const l of labels)
      if (dividends[l] != null && netIncome[l]) o[l] = Math.abs(dividends[l]!) / netIncome[l]!;
    return o;
  })();
  const roeR = ratio(netIncome, equity);
  // 듀퐁 3단계 분해: ROE = 순이익률 × 총자산회전율 × 재무레버리지 (모두 기말 기준)
  const duMargin = ratio(netIncome, revenue);
  const duTurnover = ratio(revenue, assets);
  const duLeverage = ratio(assets, equity);
  const dupontRoe = blank();
  for (const l of labels)
    if (duMargin[l] != null && duTurnover[l] != null && duLeverage[l] != null)
      dupontRoe[l] = duMargin[l]! * duTurnover[l]! * duLeverage[l]! * 100;
  const sgr = (() => {
    const o = blank();
    for (const l of labels)
      if (roeR[l] != null && payoutR[l] != null) o[l] = roeR[l]! * (1 - payoutR[l]!) * 100;
    return o;
  })();
  const quick = (() => {
    const o = blank();
    // 재고 태그가 없는 업종(플랫폼·서비스)은 재고 0 으로 간주 → 사실상 유동비율과 근접
    for (const l of labels)
      if (curAssets[l] != null && curLiab[l])
        o[l] = (curAssets[l]! - (inv[l] ?? 0)) / curLiab[l]!;
    return o;
  })();
  const cogsAbs = (() => {
    const o = blank();
    for (const l of labels) if (cogs[l] != null) o[l] = Math.abs(cogs[l]!);
    return o;
  })();
  // 회전일수용 잔액 = (기초 + 기말) / 2 평균 — 블룸버그 방식.
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
  const arAvg = avgStock(["AccountsReceivableNetCurrent", "ReceivablesNetCurrent"]);
  const invAvg = avgStock(["InventoryNet"]);
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

  const items: FinancialLineItem[] = [
    HEAD("밸류에이션"),
    R("PER", per, "mult"),
    R("PBR", pbrV, "mult"),
    R("PSR", psrV, "mult"),
    R("EV/EBITDA", evEbitda, "mult"),
    R("PEG (EPS 3Y CAGR)", peg, "mult"),
    SP("1"),
    HEAD("수익성"),
    R("ROE (%)", ratio(netIncome, equity, 100), "pct"),
    R("ROA (%)", ratio(netIncome, assets, 100), "pct"),
    R("ROIC (%)", ratio(nopat, investedCap, 100), "pct"),
    R("매출총이익률 (%)", ratio(grossProfit, revenue, 100), "pct"),
    R("영업이익률 (%)", ratio(opIncome, revenue, 100), "pct"),
    R("순이익률 (%)", ratio(netIncome, revenue, 100), "pct"),
    R("유효세율 (%)", effTax, "pct"),
    R("지속가능 성장률 (%)", sgr, "pct"),
    SP("2a"),
    HEAD("듀퐁 분석 (ROE 분해)"),
    R("순이익률 (%)", ratio(netIncome, revenue, 100), "pct"),
    R("총자산회전율 (회)", duTurnover, "mult"),
    R("재무레버리지 (배)", duLeverage, "mult"),
    R("= ROE (%)", dupontRoe, "pct", { isHighlight: true }),
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
    R("부채비율 (%)", ratio(liabTotal, equity, 100), "pct"),
    R("이자보상배율 (EBIT/이자)", ratio(opIncome, intExp), "mult"),
    R("EBITDA / 이자비용", ratio(ebitda, intExp), "mult"),
    R("CFO / 총부채", ratio(ocf, liabTotal), "mult"),
    R("FCF / 총차입금", ratio(fcf, debt), "mult"),
    R("알트만 Z-스코어", altZ, "eps"),
    SP("4"),
    HEAD("유동성"),
    R("유동비율", ratio(curAssets, curLiab), "mult"),
    R("당좌비율", quick, "mult"),
    R("현금비율", ratio(cash, curLiab), "mult"),
    SP("4b"),
    HEAD("운전자본"),
    R("매출채권 회전일수 (DSO)", dso, "eps"),
    R("재고자산 회전일수 (DIO)", dio, "eps"),
    R("매입채무 회전일수 (DPO)", dpo, "eps"),
    R("현금전환주기 (CCC)", ccc, "eps"),
    SP("4c"),
    HEAD("주주환원"),
    R("배당수익률 (%)", (() => {
      const o = blank();
      for (const l of labels) {
        const raw = dividends[l] != null && shares[l] ? Math.abs(dividends[l]!) / shares[l]! : null;
        const y = l === LTM ? years.at(-1) : Number(l.replace("Y", ""));
        const dps = raw != null ? raw * (splitF.get(y ?? 0) ?? 1) : null;
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
    HEAD("성장률 (CAGR)"),
    R("매출액 3년", cagr(revFull, 3), "pct"),
    R("매출액 5년", cagr(revFull, 5), "pct"),
    R("EPS 3년", cagr(epsFull, 3), "pct"),
    R("EPS 5년", cagr(epsFull, 5), "pct"),
    R("주당배당금 3년", cagr(dpsFull, 3), "pct"),
    R("주당배당금 5년", cagr(dpsFull, 5), "pct"),
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
