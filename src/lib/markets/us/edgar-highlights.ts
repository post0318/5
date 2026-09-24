/**
 * 미국 재무 하이라이트 표 (블룸버그 "BBG 조정 하이라이트" 근사).
 * EV 브릿지 + 손익·현금흐름 5개년 + 현재/LTM + 차기 2개년 추정.
 *
 * - 실적·재무상태표·현금흐름: SEC EDGAR companyfacts (GAAP 보고치, "조정" 아님)
 * - 과거 시가총액: 각 회계연도말 종가 × 기말 발행주식수
 * - 추정(수익·EPS): yahoo-finance2 earningsTrend
 */

import type { CompanyFacts, FactUnitEntry } from "./edgar";
import type { QuoteBar } from "../types";
import { isStaleAnnual, splitFactorsByYear, fiscalYearOf, LTM_INTERIM_FORMS, ttmCombine, vintageOrder } from "./edgar-series";
import { yahooLtm } from "./edgar-yahoo-quarters";
import { buildShareResolver } from "./edgar-shares";
import {
  ltmEps,
  ltmNetIncome,
  netIncomeAnnualByYear,
  netIncomeToParentEntries,
  parentEquityAt,
  fyEps,
  positiveRatio,
} from "./edgar-pershare";
import {
  buildEvResolver,
  daAnnualByYear,
  daTtm,
  opIncomeIsDerived,
  SYN_OP_INCOME,
  type EvBlocker,
  type EvContext,
} from "./edgar-ev";
import {
  classALatest,
  type ClassAFacts,
} from "./edgar-classfacts";

export interface HighlightColumn {
  key: string;
  label: string; // "2021Y" | "현재/LTM" | "2026Y 예상"
  date: string; // "2021-09-25"
  kind: "fy" | "ltm" | "estimate";
}
export interface HighlightRow {
  key: string;
  label: string;
  format: "money" | "pct" | "eps" | "mult";
  /** 마진%/증가율% 등 들여쓴 보조행 */
  indent?: boolean;
  /** 소계 강조 (기업가치) */
  emphasis?: boolean;
  /** 구분용 빈 행 */
  spacer?: boolean;
  values: (number | null)[];
}
export interface FinancialHighlights {
  currency: string;
  unitLabel: string;
  asOfLtm: string;
  columns: HighlightColumn[];
  rows: HighlightRow[];
  /** 투자지표(밸류에이션) — 동일 컬럼 */
  valuationRows: HighlightRow[];
  notes: string[];
  source: string;
}

export interface HighlightEstimatePeriod {
  period: string; // "0y" | "+1y" | "+2y"
  endDate: string | null;
  epsAvg: number | null;
  revenueAvg: number | null;
}

const ANNUAL_FORMS = ["10-K", "10-K/A", "20-F", "20-F/A"];
// LTM 조합 전용 — 10-Q + 20-F 발행사 Yahoo 분기 LTM(edgar-yahoo-quarters.ts)
const INTERIM_FORMS = LTM_INTERIM_FORMS;

const REVENUE = [
  // 총매출(손익계산서 첫 줄)을 먼저 — 고객계약 매출(ASC 606)은 회원비·리스 매출 등을 빼 WMT·BE 가
  // 인포맥스·Yahoo·SEC 총매출보다 1~7% 작았다(오너 결정 2026-09-24).
  "OperatingRevenueExcludingNonoperatingDerived", // 총수익 − 지분법·기타수익(XOM, edgar-revenue-dims.ts)
  "Revenues",
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "SalesRevenueNet",
  // 증권사·투자은행(GS·MS)은 순수익만 공시 — 없으면 연도 열이 빠지거나(GS) 옛 연도에 멈췄다(MS 2010~2014, 검증 2026-09-24)
  "RevenuesNetOfInterestExpense",
];
// 영업이익 태그 자체가 없는 회사(XOM 등 — 매출→세전이익 구조) 최후 폴백.
const PRETAX_CONCEPTS = [
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesAndExtraordinaryItemsNoncontrollingInterest",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndEquityMethodInvestments",
];
const CAPEX_CONCEPTS = [
  "PaymentsToAcquirePropertyPlantAndEquipment",
  "PaymentsToAcquireProductiveAssets",
];

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}
/** 온전한 1개 회계연도(약 300~400일)인지 — 90일 분기에도 fp="FY" 붙이는 기업(NVIDIA) 대응. */
function isFullYear(e: FactUnitEntry): boolean {
  if (!e.start) return false;
  const d = daysBetween(e.start, e.end);
  return d >= 300 && d <= 400;
}
function shiftYear(iso: string, n: number): string {
  const [y, m, d] = iso.split("-");
  return `${Number(y) + n}-${m}-${d}`;
}

function unitEntries(facts: CompanyFacts, concept: string, unit: string): FactUnitEntry[] {
  return facts.facts["us-gaap"]?.[concept]?.units?.[unit] ?? [];
}

/** 사업연도(FY, 10-K) duration 값 → {year, val, end}[]. */
function annualSeries(entries: FactUnitEntry[]): { year: number; val: number; end: string }[] {
  const m = new Map<number, { val: number; end: string; filed: string }>();
  for (const e of entries) {
    if (e.fp !== "FY" || !isFullYear(e) || !ANNUAL_FORMS.includes(e.form)) continue;
    const year = fiscalYearOf(e.end);
    const prev = m.get(year);
    const filed = e.filed ?? "";
    // 최신 종료일, 동률이면 최신 공시(액면분할 등 소급 재작성) 우선
    if (!prev || e.end > prev.end || (e.end === prev.end && filed >= prev.filed))
      m.set(year, { val: e.val, end: e.end, filed });
  }
  return [...m.entries()]
    .map(([year, v]) => ({ year, val: v.val, end: v.end }))
    .sort((a, b) => a.year - b.year);
}
function annualAt(series: { year: number; val: number }[], year: number): number | null {
  return series.find((s) => s.year === year)?.val ?? null;
}
/** 여러 개념을 연도별로 병합 (앞 개념 우선) — 태그가 시기별로 바뀌는 기업(NVIDIA) 대응. */
function annualSeriesMerged(
  facts: CompanyFacts,
  concepts: string[],
  unit = "USD",
): { year: number; val: number; end: string }[] {
  const byYear = new Map<number, { year: number; val: number; end: string }>();
  for (const c of concepts)
    for (const s of annualSeries(unitEntries(facts, c, unit)))
      if (!byYear.has(s.year)) byYear.set(s.year, s);
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}

/** 흐름 계정 TTM = 최근 FY + 당기누적 − 전년동기누적. */
function ttm(entries: FactUnitEntry[]): number | null {
  const annuals = entries
    .filter((e) => e.fp === "FY" && isFullYear(e) && ANNUAL_FORMS.includes(e.form))
    .sort((a, b) => b.end.localeCompare(a.end) || vintageOrder(a, b));
  const fy = annuals[0];
  if (!fy?.start) return null;
  // 태그를 중단한 개념의 옛 연간값을 "최근 12개월"로 쓰지 않는다(감사 2026-09-23:
  // GE 는 OperatingIncomeLoss 를 몇 년 전에 끊었는데 그 마지막 연간값이 LTM 으로
  // 잡혀 EBITDA 가 3배로 나왔다). 최근 사업연도 종료가 550일보다 오래됐으면 없음.
  if (isStaleAnnual(fy.end)) return null;
  const interims = entries.filter((e) => e.start && INTERIM_FORMS.includes(e.form));
  const cur = interims
    .filter((e) => Math.abs(daysBetween(fy.end, e.start!)) <= 12 && e.end > fy.end)
    .sort((a, b) => b.end.localeCompare(a.end) || vintageOrder(a, b))[0];
  if (!cur?.start) return ttmCombine(fy);
  const wS = shiftYear(cur.start, -1);
  const wE = shiftYear(cur.end, -1);
  const prior = interims
    .filter(
      (e) =>
        e.start &&
        Math.abs(daysBetween(wS, e.start)) <= 12 &&
        Math.abs(daysBetween(wE, e.end)) <= 12,
    )
    .sort((a, b) => Math.abs(daysBetween(wE, a.end)) - Math.abs(daysBetween(wE, b.end)) || vintageOrder(a, b, cur.filed))[0];
  if (!prior) return ttmCombine(fy);
  return ttmCombine(fy, cur, prior);
}

function closeOnOrBefore(bars: QuoteBar[], iso: string): number | null {
  let best: number | null = null;
  for (const b of bars) {
    if (b.date <= iso && b.close != null) best = b.close;
  }
  return best;
}

function yoy(cur: number | null, prev: number | null): number | null {
  if (cur == null || prev == null || prev === 0) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}
function margin(part: number | null, whole: number | null): number | null {
  if (part == null || whole == null || whole === 0) return null;
  return (part / whole) * 100;
}

export function buildUsHighlights(
  facts: CompanyFacts,
  bars: QuoteBar[],
  estimates: HighlightEstimatePeriod[],
  /** 듀얼클래스 종목(EDGAR 에 undimensioned 주식수 없음)용 Yahoo 컨센서스 발행주식수 — LTM 컬럼 폴백. */
  fallbackShares?: number | null,
  /** 10-K XBRL 인스턴스에서 뽑은 Class A EPS·주식수 실측(Visa 등). */
  classFacts?: ClassAFacts | null,
  /** EV 브릿지 맥락(금융 자회사·UP-REIT 파트너 지분) — edgar-ev.ts */
  evCtx?: EvContext,
): FinancialHighlights {
  const cf = classFacts ?? null;
  const notes: string[] = [];
  // 발행주식수 단일 기준 — edgar-analysis.ts 와 같은 모듈을 쓴다.
  const shareRes = buildShareResolver(facts, { classFacts: cf, sharesHint: fallbackShares });
  // EV 브릿지·감가상각비 단일 기준 — edgar-analysis.ts·multiples·컨센서스와 공유.
  const evRes = buildEvResolver(facts, evCtx ?? {});
  // 금융 자회사 보유로 EV 를 비우는 회사도 차입금·현금은 연결 기준으로 보여준다 — 대차대조표 주석
  // (edgar-balance.ts, 같은 무맥락 resolver)과 같은 값. 예전엔 EV 와 함께 이 행들까지 비워
  // 화면끼리 한쪽만 빈칸이었다(GM·F, 검증 2026-09-24).
  const evResConsolidated = buildEvResolver(facts);
  let consolidatedShown = false;

  // ── 컬럼 구성 ────────────────────────────────────────────────────
  const revSeries = annualSeriesMerged(facts, REVENUE);
  const fyYears = revSeries.map((s) => s.year).slice(-5);
  const fyEndByYear = new Map(revSeries.map((s) => [s.year, s.end]));
  const lastFy = fyYears[fyYears.length - 1] ?? new Date().getFullYear();

  const lastBar = [...bars].reverse().find((b) => b.close != null);
  const priceDate = lastBar?.date ?? new Date().toISOString().slice(0, 10);
  // LTM 컬럼 기준일 = 최근 분기 재무상태표 기준일 (블룸버그 표기와 동일).
  // 자산총계 기준 — 예전엔 현금 태그 날짜를 썼는데 GE(2017)·SBUX(2022)처럼
  // 그 태그를 중단한 회사는 LTM 기준일이 몇 년 전으로 잡혔다(감사 2026-09-23).
  // 20-F Yahoo 분기 LTM(edgar-yahoo-quarters.ts) — LTM 열 기준일 = Yahoo 최신 분기말
  const yl = yahooLtm(facts);
  const mrqEnd = yl?.through ?? evRes.latestBalanceDate() ?? priceDate;
  const ltmDate = mrqEnd;

  const columns: HighlightColumn[] = fyYears.map((y) => ({
    key: `FY${y}`,
    label: `${y}Y`,
    date: fyEndByYear.get(y) ?? `${y}-12-31`,
    kind: "fy",
  }));
  columns.push({ key: "LTM", label: "현재/LTM", date: ltmDate, kind: "ltm" });

  const estCols: { period: HighlightEstimatePeriod; year: number }[] = [];
  for (const p of estimates) {
    if (!["0y", "+1y", "+2y"].includes(p.period)) continue;
    const year = p.endDate ? fiscalYearOf(p.endDate) : null;
    if (year == null || year <= lastFy) continue;
    if (estCols.some((e) => e.year === year)) continue;
    estCols.push({ period: p, year });
  }
  estCols.sort((a, b) => a.year - b.year);
  for (const e of estCols.slice(0, 2)) {
    columns.push({
      key: `FY${e.year}E`,
      label: `${e.year}Y 예상`,
      date: e.period.endDate ?? `${e.year}-12-31`,
      kind: "estimate",
    });
  }

  const nCol = columns.length;
  const blank = (): (number | null)[] => Array(nCol).fill(null);

  // ── 계정 시리즈 ──────────────────────────────────────────────────
  /**
   * 후보 개념들을 하나로 합치되 **앞 개념이 이미 채운 기간은 뒤 개념이
   * 덮지 못하게** 한다.
   *
   * 단순 flatMap 이던 것을 고침(오너 지적 2026-09-23 — "wmt 재무하이라이트랑
   * 손익계산서랑 당기순이익금액이 안맞음"). 월마트는 같은 회계연도에
   * `NetIncomeLoss`(지배주주 귀속)와 `ProfitLoss`(비지배지분 포함 연결)를
   * 둘 다 태깅하는데, 합친 배열에서 뒤쪽 항목이 이기는 tiebreak(`filed >=`)
   * 때문에 연결 기준이 지배주주 기준을 덮어써 FY2024 순이익이 하이라이트
   * 162.7억 달러 / 손익계산서 155.1억 달러로 갈렸다. 같은 이유로 자기자본도
   * NCI 포함값이 이길 수 있어 PBR 이 틀어진다.
   *
   * 기간을 (start|end|form|fp) 로 잡아 **개념 경계에서만** 걸러서, 한 개념
   * 안의 소급 재작성본(같은 기간·다른 filed)은 그대로 남기고 "앞 개념이 안
   * 다루는 기간을 뒤 개념이 메우는" 태그 전환 대응은 유지한다.
   */
  const concat = (concepts: string[], unit = "USD"): FactUnitEntry[] => {
    const out: FactUnitEntry[] = [];
    const claimed = new Set<string>();
    const keyOf = (e: FactUnitEntry) => `${e.start ?? ""}|${e.end}|${e.form}|${e.fp}`;
    for (const c of concepts) {
      const mine = new Set<string>();
      for (const e of unitEntries(facts, c, unit)) {
        const k = keyOf(e);
        if (claimed.has(k)) continue;
        out.push(e);
        mine.add(k);
      }
      for (const k of mine) claimed.add(k);
    }
    return out;
  };
  const gpS = annualSeries(unitEntries(facts, "GrossProfit", "USD"));
  // 영업이익 — edgar-ev.ts 단일 기준 시계열(공시 → 세전+이자 → 세전). 로더가 합성
  // 개념으로 끼워 넣어 두었다 — 재무분석·손익계산서·개요 멀티플과 같은 값.
  const usedPretaxAsOpIncome = opIncomeIsDerived(facts);
  const opIncS = annualSeries(unitEntries(facts, SYN_OP_INCOME, "USD"));
  // 감가상각비 — edgar-ev.ts 규칙(합계 태그 최댓값, 무형상각 누락 시 구성항목 합).
  // "앞 태그 우선"이던 예전 방식은 MCD 등에서 일부 항목만 담긴 태그를 집었다.
  const daS = [...daAnnualByYear(facts)]
    .map(([year, val]) => ({ year, val, end: `${year}-12-31` }))
    .sort((a, b) => a.year - b.year);
  const S = {
    revenue: annualSeriesMerged(facts, REVENUE),
    grossProfit: gpS,
    opIncome: opIncS,
    da: daS,
    // 지배주주 순이익 — edgar-pershare.ts 공통 규칙(NetIncomeLoss 없으면 ProfitLoss − 비지배지분)
    netIncome: [...netIncomeAnnualByYear(facts)]
      .map(([year, val]) => ({ year, val, end: `${year}-12-31` }))
      .sort((a, b) => a.year - b.year),
    eps: annualSeries(unitEntries(facts, "EarningsPerShareDiluted", "USD/shares")),
    ocf: annualSeries(
      unitEntries(facts, "NetCashProvidedByUsedInOperatingActivities", "USD"),
    ),
    capex: annualSeriesMerged(facts, CAPEX_CONCEPTS),
    dps: (() => {
      const a = annualSeries(
        unitEntries(facts, "CommonStockDividendsPerShareDeclared", "USD/shares"),
      );
      return a.length
        ? a
        : annualSeries(
            unitEntries(facts, "CommonStockDividendsPerShareCashPaid", "USD/shares"),
          );
    })(),
  };
  const E = {
    revenue: concat(REVENUE),
    grossProfit: unitEntries(facts, "GrossProfit", "USD"),
    opIncome: unitEntries(facts, SYN_OP_INCOME, "USD"),
    pretax: concat(PRETAX_CONCEPTS),
    netIncome: netIncomeToParentEntries(facts),
    eps: unitEntries(facts, "EarningsPerShareDiluted", "USD/shares"),
    ocf: unitEntries(facts, "NetCashProvidedByUsedInOperatingActivities", "USD"),
    capex: concat(CAPEX_CONCEPTS),
    dps: concat(
      ["CommonStockDividendsPerShareDeclared", "CommonStockDividendsPerShareCashPaid"],
      "USD/shares",
    ),
  };
  // 자기자본 — edgar-pershare.ts 단일 기준(재작성본 우선, 없으면 자산 − 부채).
  const equityAt = (asOf: string): number | null => parentEquityAt(facts, asOf);
  // 현금·차입금·우선주·비지배지분은 edgar-ev.ts(evRes)가 계산한다.
  // 발행주식수(기말·현재·듀얼클래스 폴백)는 전부 edgar-shares.ts 의
  // buildShareResolver 로 옮겼다 — 이 파일과 edgar-analysis.ts 가 각자
  // 우선순위를 두면서 같은 종목의 시가총액이 갈렸기 때문(위 shareRes 참고).

  // 컬럼별 helper
  const flowVal = (
    ser: { year: number; val: number }[],
    entries: FactUnitEntry[],
    col: HighlightColumn,
  ): number | null => {
    if (col.kind === "fy") return annualAt(ser, Number(col.key.slice(2)));
    if (col.kind === "ltm") return ttm(entries);
    return null;
  };

  // ── EV 브릿지 ────────────────────────────────────────────────────
  const marketCap = blank();
  const cash = blank();
  const preferred = blank();
  const debt = blank();
  const ev = blank();
  const equity = blank();
  const priceByCol = blank();
  const sharesByCol = blank();
  const opUnitValue = blank();
  let approxPerShare = false;
  const blockers = new Set<EvBlocker>();
  let staleEv = false;
  let partialDebt = false;
  let captiveExcluded = false;

  columns.forEach((col, i) => {
    if (col.kind === "estimate") return;
    const asOf = col.date; // 재무상태표 기준일 (LTM = 최근 분기말)
    const isLtm = col.kind === "ltm";
    const price = isLtm ? (lastBar?.close ?? null) : closeOnOrBefore(bars, asOf);
    priceByCol[i] = price;
    equity[i] = equityAt(asOf);
    // 시총용 주식수: 공용 기준(edgar-shares.ts)으로 통일 — 소스 우선순위도,
    // 분할 보정(시세는 분할 소급 반영인데 공시 주식수는 as-reported)도 거기
    // 한 곳에서 처리한다. 예전엔 이 파일과 edgar-analysis.ts 가 서로 다른
    // 우선순위를 써서 같은 종목 PBR·PSR·EV 가 화면마다 달랐다(오너 지적
    // 2026-09-23, WMT).
    const disclosed = isLtm
      ? shareRes.current()
      : shareRes.atFiscalYearEnd(Number(col.key.slice(2)), asOf);
    const shares = disclosed;
    // 공시 주식수가 없어 힌트(시총÷주가 등)로 대체됐는지는 resolver 가 안다
    // — 클래스별로만 태깅하는 종목(Visa 등)에 붙는 "근사" 주석용.
    if (shareRes.usedHint()) approxPerShare = true;
    sharesByCol[i] = shares;
    const mc = price != null && shares != null ? price * shares : null;
    marketCap[i] = mc;

    // EV 브릿지 — edgar-ev.ts 단일 기준(운용리스 제외, 장기투자자산 미차감,
    // 금융 자회사 차입금 제외, UP-REIT 파트너 지분 시가 반영).
    const block = evRes.blocker(asOf);
    if (block) blockers.add(block);
    const b0 = evRes.bridgeAt(asOf);
    // Yahoo 분기 LTM: EV 구성요소가 전부 같은 기준일로 채워졌을 때만(아니면 LTM EV·순차입금 공란)
    const b = b0 && isLtm && yl && (!yl.evComplete || b0.stale || b0.balanceDate !== yl.through) ? null : b0;
    if (b) {
      cash[i] = b.cash;
      debt[i] = b.debt;
      preferred[i] = b.preferred + b.nci;
      if (b.stale) staleEv = true;
      if (b.debtPartial) partialDebt = true;
      if (b.captiveDebtExcluded != null) captiveExcluded = true;
      const opv = evCtx?.opUnits && price != null ? evCtx.opUnits * price : null;
      opUnitValue[i] = opv;
      ev[i] = evRes.evAt(asOf, mc, price);
    } else if (block === "captive-unsplit") {
      const cb = evResConsolidated.bridgeAt(asOf);
      if (cb) {
        cash[i] = cb.cash;
        debt[i] = cb.debt;
        preferred[i] = cb.preferred + cb.nci;
        consolidatedShown = true;
      }
    }
  });

  // ── 손익 ────────────────────────────────────────────────────────
  const revenue = columns.map((col) =>
    col.kind === "estimate"
      ? (estCols.find((e) => `FY${e.year}E` === col.key)?.period.revenueAvg ?? null)
      : flowVal(S.revenue, E.revenue, col),
  );
  const ebitda = columns.map((col) => {
    if (col.kind === "fy") {
      const y = Number(col.key.slice(2));
      const oi = annualAt(S.opIncome, y);
      const d = annualAt(S.da, y);
      return oi != null ? oi + (d ?? 0) : null;
    }
    if (col.kind === "ltm") {
      const oi = ttm(E.opIncome);
      const d = daTtm(facts);
      // Yahoo 분기 LTM 에서 감가상각비를 못 채웠으면 EBITDA 도 공란(0 으로 보지 않음)
      if (yl && d == null) return null;
      return oi != null ? oi + (d ?? 0) : null;
    }
    return null;
  });
  // 현재 발행주식수도 같은 공용 기준을 쓴다(시총·추정 순이익·LTM EPS 공통).
  const currentShares = shareRes.current();
  const netIncome = columns.map((col) => {
    if (col.kind === "estimate") {
      const eps = estCols.find((e) => `FY${e.year}E` === col.key)?.period.epsAvg ?? null;
      return eps != null && currentShares != null ? eps * currentShares : null;
    }
    // LTM 순이익은 공통 함수(재무분석·개요 멀티플과 같은 값)
    if (col.kind === "ltm") return ltmNetIncome(facts);
    return flowVal(S.netIncome, E.netIncome, col);
  });
  // 액면분할 보정 (소급 재작성 안 된 과거 연도 주당 지표를 최신 기준으로 환산)
  const splitF = splitFactorsByYear(facts);
  const sf = (y: number) => splitF.get(y) ?? 1;
  const eps = columns.map((col, i) => {
    if (col.kind === "estimate")
      return estCols.find((e) => `FY${e.year}E` === col.key)?.period.epsAvg ?? null;
    const derive = (): number | null => {
      const sh = col.kind === "ltm" ? currentShares : sharesByCol[i];
      if (netIncome[i] != null && sh) {
        approxPerShare = true;
        return netIncome[i]! / sh;
      }
      return null;
    };
    if (col.kind === "ltm") {
      // LTM EPS 는 ttm() 의 "최근 FY + 당기누적 − 전년동기누적" 식으로 구하지
      // 않는다 — 그 식은 더하고 빼도 되는 흐름(매출·순이익)에만 성립하고,
      // 분모(주식수)가 기간마다 다른 주당 지표에는 안 맞아 순이익과 부호가
      // 어긋난다(실측 2026-09-23 — Bloom Energy: LTM 순이익 +996만 달러인데
      // 개요 재무하이라이트 EPS 는 -0.04 로 표시. 같은 문제를
      // edgar-income.ts·edgar.ts 에서도 각각 고쳤다). LTM 순이익 ÷ 현재
      // 주식수로 직접 계산하고, 그마저 불가능할 때만 옛 경로로 폴백한다.
      // 공통 함수(보통주 귀속 LTM 순이익 ÷ 현재 주식수) — 재무분석·개요·은행과 동일
      const le = ltmEps(facts, currentShares);
      if (le != null) return le;
      return ttm(E.eps) ?? derive() ?? classALatest(cf)?.epsDiluted ?? null;
    }
    // 사업연도 EPS 는 공통 함수(재무분석·컨센서스·은행과 같은 규칙)
    const r = fyEps(facts, Number(col.key.slice(2)), {
      classFacts: cf,
      fyShares: sharesByCol[i],
      fyNetIncome: netIncome[i],
    });
    if (r.approx) approxPerShare = true;
    return r.eps;
  });
  const dps = columns.map((col) => {
    if (col.kind === "estimate") return null;
    if (col.kind === "ltm") return ttm(E.dps);
    const y = Number(col.key.slice(2));
    const v = annualAt(S.dps, y);
    return v == null ? null : v * sf(y);
  });
  const divYield = dps.map((d, i) =>
    d != null && priceByCol[i] != null && priceByCol[i]! > 0 ? (d / priceByCol[i]!) * 100 : null,
  );

  // ── 현금흐름 ────────────────────────────────────────────────────
  const ocf = columns.map((col) => flowVal(S.ocf, E.ocf, col));
  const capex = columns.map((col) => {
    const v = flowVal(S.capex, E.capex, col);
    return v == null ? null : -Math.abs(v);
  });
  const fcf = columns.map((_, i) =>
    ocf[i] != null && capex[i] != null ? ocf[i]! + capex[i]! : null,
  );

  // 첫 FY 컬럼(예 2021)의 YoY 는 직전 컬럼이 없으므로 companyfacts 전체 시계열의
  // 전년(2020) 값을 끌어와 계산.
  const firstFy = columns[0]?.kind === "fy" ? Number(columns[0].key.slice(2)) : null;
  const seq = (
    a: (number | null)[],
    series?: { year: number; val: number }[],
  ) =>
    a.map((v, i) => {
      if (i > 0) return yoy(v, a[i - 1]);
      if (firstFy == null || !series) return null;
      return yoy(v, annualAt(series, firstFy - 1));
    });

  const rows: HighlightRow[] = [
    { key: "mktcap", label: "시가총액", format: "money", values: marketCap },
    ...(opUnitValue.some((v) => v != null)
      ? [{ key: "opunits", label: "+ 운영 파트너십 지분 (시가)", format: "money" as const, values: opUnitValue }]
      : []),
    { key: "cash", label: "− 현금·단기투자·장기 투자증권", format: "money", values: cash.map((v) => (v == null ? null : -v)) },
    { key: "debt", label: "+ 차입금", format: "money", values: debt },
    { key: "pref_nci", label: "+ 우선주·비지배지분", format: "money", values: preferred },
    { key: "ev", label: "기업가치 (EV)", format: "money", emphasis: true, values: ev },
    { key: "sp1", label: "", format: "money", spacer: true, values: blank() },
    { key: "revenue", label: "매출액", format: "money", values: revenue },
    { key: "revenue_yoy", label: "성장률 % YoY", format: "pct", indent: true, values: seq(revenue, S.revenue) },
    { key: "ebitda", label: "EBITDA", format: "money", values: ebitda },
    { key: "ebitda_m", label: "마진 %", format: "pct", indent: true, values: ebitda.map((v, i) => margin(v, revenue[i])) },
    { key: "ni", label: "순이익", format: "money", values: netIncome },
    { key: "ni_m", label: "마진 %", format: "pct", indent: true, values: netIncome.map((v, i) => margin(v, revenue[i])) },
    { key: "eps", label: "EPS (희석)", format: "eps", values: eps },
    { key: "eps_yoy", label: "성장률 % YoY", format: "pct", indent: true, values: seq(eps, S.eps) },
    { key: "dps", label: "DPS", format: "eps", values: dps },
    { key: "divyield", label: "배당수익률 %", format: "pct", indent: true, values: divYield },
    { key: "sp2", label: "", format: "money", spacer: true, values: blank() },
    { key: "ocf", label: "영업활동 현금흐름", format: "money", values: ocf },
    { key: "capex", label: "자본지출", format: "money", values: capex },
    { key: "fcf", label: "잉여현금흐름", format: "money", values: fcf },
  ];

  // ── 투자지표 (밸류에이션) ───────────────────────────────────────
  const ltmIdx = columns.findIndex((c) => c.kind === "ltm");
  const curMcap = ltmIdx >= 0 ? marketCap[ltmIdx] : null;
  const curPrice = ltmIdx >= 0 ? priceByCol[ltmIdx] : null;
  // 분모 0 이하면 비운다 — edgar-pershare.ts 공통 부호 규칙
  const ratio = positiveRatio;
  // PER = 회계연도말 종가 ÷ 보고 희석 EPS (컨센서스 표와 동일 기준).
  // 예상 열은 현재가 ÷ 추정 EPS.
  const per = columns.map((col, i) =>
    ratio(col.kind === "estimate" ? curPrice : priceByCol[i], eps[i]),
  );
  const pbr = columns.map((col, i) =>
    col.kind === "estimate" ? null : ratio(marketCap[i], equity[i]),
  );
  const psr = columns.map((col, i) =>
    ratio(col.kind === "estimate" ? curMcap : marketCap[i], revenue[i]),
  );
  const evEbitda = columns.map((col, i) =>
    col.kind === "estimate" ? null : ratio(ev[i], ebitda[i]),
  );
  const valuationRows: HighlightRow[] = [
    { key: "per", label: "PER", format: "mult", values: per },
    { key: "pbr", label: "PBR", format: "mult", values: pbr },
    { key: "psr", label: "PSR", format: "mult", values: psr },
    { key: "ev_ebitda", label: "EV/EBITDA", format: "mult", values: evEbitda },
  ];

  notes.push("실적·재무상태표·현금흐름: SEC EDGAR companyfacts (GAAP 보고치)");
  if (facts.reportingCurrency && facts.reportingCurrency !== "USD")
    notes.push(`외화 공시(${facts.reportingCurrency}${facts.ifrsMapped ? " · IFRS" : ""}) → USD 환산: 손익·현금흐름은 기간 평균 환율, 재무상태표는 기말 환율 (Yahoo 일별 환율 — 인포맥스와 같은 방식)`);
  if (facts.nonopInRevenues)
    notes.push("매출·영업이익: 공시 총수익에서 지분법 이익·기타수익을 뺀 값(10-K·10-Q 원본의 제품·서비스 구분) — 인포맥스·MarketScreener·Yahoo 매출과 같은 기준");
  if (facts.opIncomeFromStructure)
    notes.push(`영업이익: 손익계산서에 영업이익 소계가 없어 세전이익에서 영업외 항목(이자·지분법·영업외손익)을 뺀 값(공시 계산 구조 그대로, 구조조정·손상은 영업 항목)${facts.segmentOpIncomeOnly ? " — 공시의 영업이익 태그는 부문 영업이익 합계(주석)라 쓰지 않음" : ""}`);
  if (facts.segmentOpIncomeOnly && !facts.opIncomeFromStructure)
    notes.push("영업이익: 공시의 영업이익 태그가 손익계산서가 아닌 부문·조정 이익이라 쓰지 않고 세전이익 기준(금융업은 이자가 본업)");
  if (facts.contentAmortization)
    notes.push("감가상각비·EBITDA 에 콘텐츠 상각 포함(10-K·10-Q 원본의 회사 고유 태그) — 인포맥스·Yahoo 와 같은 기준");
  if (facts.adrRatio && facts.adrRatio !== 1)
    notes.push(`ADR 기준: 1 ADR = 보통주 ${Number(facts.adrRatio.toPrecision(4))}주 — 주식수·주당 값은 ADR 1주 기준`);
  notes.push(
    "과거 시가총액: 각 회계연도말 종가 × 기말 발행주식수 (클래스 간 전환 구조 종목(Visa 등)은 10-K 전환 기준(as-converted) 보통주 합계)",
  );
  notes.push(
    "차입금 = 이자부 차입금(장·단기·CP) + 금융리스 — 운용리스는 제외(리스비용이 이미 EBITDA 에 반영돼 있어 이중 계산 방지)",
  );
  notes.push("현금 = 현금·단기투자·장기 투자증권 — 보험 투자자산·지분법 투자(장기투자자산)는 빼지 않음");
  if (blockers.has("captive-unsplit"))
    notes.push(
      "EV·EV/EBITDA 미표시: 금융 자회사(할부금융) 보유 — 연결 차입금·EBITDA 에 금융 자회사분이 섞여 산정 기준 확정 전까지 비움",
    );
  if (consolidatedShown)
    notes.push("차입금·현금·우선주·비지배지분: 연결 기준(금융 자회사 포함, 대차대조표 주석과 같은 값) — EV 만 비움");
  if (blockers.has("debt-untagged"))
    notes.push("EV·EV/EBITDA 미표시: 차입금이 표준 태그로 공시되지 않음");
  if (captiveExcluded)
    notes.push("금융 자회사(할부금융) 차입금 제외 — 제조 부문 차입금만 반영");
  if (staleEv)
    notes.push("일부 열의 현금·차입금: 분기 공시에 없어 직전 사업연도말 값 사용");
  if (partialDebt) notes.push("차입금 일부(개별 대출 건별로만 공시된 기간대출 등) 미집계 — EV 과소 가능");
  if (opUnitValue.some((v) => v != null))
    notes.push(
      "운영 파트너십 지분: 보통주로 교환 가능한 외부 파트너 지분을 시가로 반영(수량 출처: Yahoo implied shares)",
    );
  if (estCols.length)
    notes.push("예상(수익·EPS): yahoo-finance2 컨센서스 · 나머지 항목은 무료 컨센서스 없음");
  notes.push("EBITDA = 보고 영업이익 + 감가상각비·무형자산상각비 (블룸버그 '조정'과 다를 수 있음)");
  if (usedPretaxAsOpIncome)
    notes.push("영업이익 태그가 없는 회사(BMY·XOM 등) — 세전이익 + 이자비용 − 지분법 이익(EBIT)으로 근사(기타 비영업 손익 포함 가능)");
  if (approxPerShare)
    notes.push(
      "EPS·시가총액·PER·PBR: 발행주식수를 클래스별로만 공시(Visa 등) → 현재 주식수(시총÷주가) 기준 근사",
    );

  return {
    currency: "USD",
    unitLabel: "USD 백만",
    asOfLtm: ltmDate,
    columns,
    rows,
    valuationRows,
    notes,
    source: "SEC EDGAR + yahoo-finance2",
  };
}
