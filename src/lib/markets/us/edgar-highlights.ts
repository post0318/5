/**
 * 미국 재무 하이라이트 표 (블룸버그 "BBG 조정 하이라이트" 근사).
 * EV 브릿지 + 손익·현금흐름 5개년 + 현재/LTM + 차기 2개년 추정.
 *
 * - 실적·재무상태표·현금흐름: SEC EDGAR companyfacts (GAAP 보고치, "조정" 아님)
 * - 과거 시가총액: 각 회계연도말 종가 × 기말 발행주식수
 * - 추정(수익·EPS): yahoo-finance2 earningsTrend
 */

import { unavailableNote } from "./sec-unavailable";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import type { QuoteBar } from "../types";
import { splitFactorsByYear, fiscalYearOf, ltmAnchor, ltmFlowOf } from "./edgar-series";
import { yahooLtm } from "./edgar-yahoo-quarters";
import { revAnnualEnds, revAnnualMap, revAnnualYears, revLtm } from "./fin-revenue";
import { buildShareResolver } from "./edgar-shares";
import {
  ltmEpsOf,
  ltmNetIncomeOf,
  netIncomeAnnualByYear,
  netIncomeToParentEntries,
  parentEquityOf,
  fyEps,
  positiveRatio,
} from "./edgar-pershare";
import {
  buildEvResolver,
  daAnnualByYear,
  daTtmCell,
  daTtm,
  opIncomeAnnualCells,
  opIncomeIsDerived,
  opIncomeLtm,
  opIncomeSynthNote,
  opIncomeViaFin,
  SYN_OP_INCOME,
  type EvBlocker,
  type EvContext,
} from "./edgar-ev";
import type { ClassAFacts } from "./edgar-classfacts";

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
  /** 칸 주석(values 와 같은 순서) — 빈칸의 사유 또는 근사값 라벨(그림자 채우기 금지, 2026-09-27). 화면이 ※번호로 표시 */
  cellNotes?: (string | null)[];
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
  /** Yahoo 현재 주식수 힌트 — ADR 비율 판정에만 쓴다(주식수 값으로 대신 쓰지 않음, edgar-shares.ts) */
  fallbackShares?: number | null,
  /** 10-K XBRL 인스턴스에서 뽑은 Class A EPS·주식수 실측(Visa 등). */
  classFacts?: ClassAFacts | null,
  /** EV 브릿지 맥락(금융 자회사·UP-REIT 파트너 지분) — edgar-ev.ts */
  evCtx?: EvContext,
): FinancialHighlights {
  const cf = classFacts ?? null;
  const notes: string[] = [];
  // LTM 흐름 — edgar-series.ts 단일 함수(사업연도 뒤 분기가 있는데 누적이 없으면 공란 + 사유)
  const anchor = ltmAnchor(facts);
  const ltm = (entries: FactUnitEntry[]) => ltmFlowOf(entries, anchor);
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
  // 매출 = 재무 5층 구조 매출 지표(fin-revenue.ts) — 연도 열도 그 연도를 따른다(손익계산서·재무분석과 같은 열)
  const revEnds = revAnnualEnds(facts.revenue);
  const revSeries = [...revAnnualMap(facts.revenue)]
    .map(([year, val]) => ({ year, val, end: revEnds.get(year) ?? `${year}-12-31` }))
    .sort((a, b) => a.year - b.year);
  const fyYears = revAnnualYears(facts.revenue, 5);
  const fyEndByYear = revEnds;
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
  // 영업이익 — 재무 5층 구조 영업이익 지표(edgar-ev.ts opIncomeAnnualCells·opIncomeLtm — fin 열, 본표 소계 · 없으면 공시 계산
  // 구조 합성). 재무분석·손익계산서·개요 멀티플·컨센서스와 같은 값. 금융사(fin 유형)만 옛 단일 기준 시계열(로더 합성 개념)
  const opViaFin = opIncomeViaFin(facts);
  const usedPretaxAsOpIncome = opIncomeIsDerived(facts);
  const opCells = opIncomeAnnualCells(facts);
  const opLtm = opIncomeLtm(facts);
  const opIncS = opViaFin
    ? [...opCells].flatMap(([year, c]) => (c.v == null ? [] : [{ year, val: c.v, end: `${year}-12-31` }])).sort((a, b) => a.year - b.year)
    : annualSeries(unitEntries(facts, SYN_OP_INCOME, "USD"));
  // 감가상각비 — edgar-ev.ts 규칙(합계 태그 최댓값, 무형상각 누락 시 구성항목 합).
  // "앞 태그 우선"이던 예전 방식은 MCD 등에서 일부 항목만 담긴 태그를 집었다.
  const daS = [...daAnnualByYear(facts)]
    .map(([year, val]) => ({ year, val, end: `${year}-12-31` }))
    .sort((a, b) => a.year - b.year);
  const S = {
    revenue: revSeries,
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
    if (col.kind === "ltm") return ltm(entries).value;
    return null;
  };
  /** LTM 칸 주석 — 흐름이 비었을 때 사유 */
  const ltmIdxC = columns.findIndex((c) => c.kind === "ltm");
  const ltmNote = (entries: FactUnitEntry[]): (string | null)[] => {
    const o: (string | null)[] = Array(nCol).fill(null);
    const r = ltm(entries);
    if (ltmIdxC >= 0 && r.value == null && r.reason) o[ltmIdxC] = r.reason;
    return o;
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
  // 칸 주석 — 시가총액(주식수 근사·공란 사유), EV 브릿지(구성요소가 그 기준일 공시에 없음)
  const nMktcap: (string | null)[] = Array(nCol).fill(null);
  const nBridge: (string | null)[] = Array(nCol).fill(null);
  const nEquity: (string | null)[] = Array(nCol).fill(null);
  const blockers = new Set<EvBlocker>();
  let partialDebt = false;
  let captiveExcluded = false;

  columns.forEach((col, i) => {
    if (col.kind === "estimate") return;
    const asOf = col.date; // 재무상태표 기준일 (LTM = 최근 분기말)
    const isLtm = col.kind === "ltm";
    const price = isLtm ? (lastBar?.close ?? null) : closeOnOrBefore(bars, asOf);
    priceByCol[i] = price;
    const eqR = parentEquityOf(facts, asOf);
    equity[i] = eqR.value;
    if (eqR.value == null) nEquity[i] = eqR.reason;
    // 시총용 주식수: 공용 기준(edgar-shares.ts)으로 통일 — 소스 우선순위도,
    // 분할 보정(시세는 분할 소급 반영인데 공시 주식수는 as-reported)도 거기
    // 한 곳에서 처리한다. 예전엔 이 파일과 edgar-analysis.ts 가 서로 다른
    // 우선순위를 써서 같은 종목 PBR·PSR·EV 가 화면마다 달랐다(오너 지적
    // 2026-09-23, WMT).
    const disclosed = isLtm
      ? shareRes.current()
      : shareRes.atFiscalYearEnd(Number(col.key.slice(2)), asOf);
    const shares = disclosed;
    // 주식수 칸 주석 — 근사(오너 승인: 결산일 표지·가중평균 / 현재 Yahoo) 라벨, 공란이면 사유
    nMktcap[i] = isLtm ? shareRes.currentNote() : shareRes.yearEndNote(Number(col.key.slice(2)));
    sharesByCol[i] = shares;
    const mc = price != null && shares != null ? price * shares : null;
    marketCap[i] = mc;
    if (mc == null && price == null) nMktcap[i] = "주가 없음";

    // EV 브릿지 — edgar-ev.ts 단일 기준(운용리스 제외, 장기투자자산 미차감,
    // 금융 자회사 차입금 제외, UP-REIT 파트너 지분 시가 반영).
    const block = evRes.blocker(asOf);
    if (block) blockers.add(block);
    const b0 = evRes.bridgeAt(asOf);
    // Yahoo 분기 LTM: EV 구성요소가 전부 같은 기준일로 채워졌을 때만(아니면 LTM EV·순차입금 공란)
    const b = b0 && isLtm && yl && (!yl.evComplete || b0.balanceDate !== yl.through) ? null : b0;
    if (!b && !block) nBridge[i] = b0 && yl ? (yl.evReason ?? "Yahoo 분기 EV 구성요소 불완전") : evRes.bridgeReason(asOf);
    if (b) {
      cash[i] = b.cash;
      debt[i] = b.debt;
      preferred[i] = b.preferred + b.nci;
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
      : col.kind === "fy"
        ? annualAt(S.revenue, Number(col.key.slice(2)))
        : col.kind === "ltm"
          ? revLtm(facts.revenue)
          : null,
  );
  const ebitda = columns.map((col) => {
    if (col.kind === "fy") {
      const y = Number(col.key.slice(2));
      const oi = annualAt(S.opIncome, y);
      const d = annualAt(S.da, y);
      // 감가상각비 구성요소가 없으면(매핑 누락 — IFRS 20-F 등) EBITDA 도 공란
      // (0 으로 보지 않음, LTM 과 같은 원칙 — 독립 감사 지적 2026-09-25 NVO·SAP)
      return oi != null && d != null ? oi + d : null;
    }
    if (col.kind === "ltm") {
      const oi = opViaFin ? opLtm.value : ltm(E.opIncome).value;
      const d = daTtm(facts);
      // 감가상각비를 못 채웠으면 EBITDA 도 공란(0 으로 보지 않음) — Yahoo 분기
      // LTM 여부와 무관(독립 감사 지적 2026-09-25, 예전엔 yl 있을 때만 비웠다)
      if (d == null) return null;
      return oi != null ? oi + d : null;
    }
    return null;
  });
  // 현재 발행주식수도 같은 공용 기준을 쓴다(시총·추정 순이익·LTM EPS 공통).
  const currentShares = shareRes.current();
  const niLtm = ltmNetIncomeOf(facts);
  const nNetIncome: (string | null)[] = Array(nCol).fill(null);
  const netIncome = columns.map((col, i) => {
    if (col.kind === "estimate") {
      // 예상 순이익 = 무료 컨센서스 없음. "예상 EPS × 현재 주식수"는 다른 정의라 쓰지 않는다(그림자 채우기 금지)
      nNetIncome[i] = "예상 순이익: 무료 컨센서스 없음(EPS × 현재 주식수로 대신하지 않음)";
      return null;
    }
    // LTM 순이익은 공통 함수(재무분석·개요 멀티플과 같은 값)
    if (col.kind === "ltm") {
      if (niLtm.value == null) nNetIncome[i] = niLtm.reason;
      return niLtm.value;
    }
    return flowVal(S.netIncome, E.netIncome, col);
  });
  // 액면분할 보정 (소급 재작성 안 된 과거 연도 주당 지표를 최신 기준으로 환산)
  const splitF = splitFactorsByYear(facts);
  const sf = (y: number) => splitF.get(y) ?? 1;
  const nEps: (string | null)[] = Array(nCol).fill(null);
  const eps = columns.map((col, i) => {
    if (col.kind === "estimate")
      return estCols.find((e) => `FY${e.year}E` === col.key)?.period.epsAvg ?? null;
    if (col.kind === "ltm") {
      // LTM EPS 는 ttm() 의 "최근 FY + 당기누적 − 전년동기누적" 식으로 구하지
      // 않는다 — 그 식은 더하고 빼도 되는 흐름(매출·순이익)에만 성립하고,
      // 분모(주식수)가 기간마다 다른 주당 지표에는 안 맞아 순이익과 부호가
      // 어긋난다(실측 2026-09-23 — Bloom Energy: LTM 순이익 +996만 달러인데
      // 개요 재무하이라이트 EPS 는 -0.04 로 표시. 같은 문제를
      // edgar-income.ts·edgar.ts 에서도 각각 고쳤다). LTM 순이익 ÷ 현재
      // 주식수로 직접 계산하고, 그마저 불가능할 때만 옛 경로로 폴백한다.
      // 공통 함수(보통주 귀속 LTM 순이익 ÷ 현재 주식수) — 재무분석·개요·은행과 동일
      // 없으면 공란 + 사유 — 흐름식 EPS·다른 주식수·Class A 최근 연간값으로 대신하지 않는다(그림자 채우기 금지)
      const le = ltmEpsOf(facts, currentShares);
      if (le.value == null) nEps[i] = le.reason;
      return le.value;
    }
    // 사업연도 EPS 는 공통 함수(재무분석·컨센서스·은행과 같은 규칙)
    const r = fyEps(facts, Number(col.key.slice(2)), {
      classFacts: cf,
      fyShares: sharesByCol[i],
      fyNetIncome: netIncome[i],
    });
    // 원인별 칸 주석(Class A 기준·근사 등 — G4·G5)
    nEps[i] = r.note;
    return r.eps;
  });
  const dps = columns.map((col) => {
    if (col.kind === "estimate") return null;
    if (col.kind === "ltm") return ltm(E.dps).value;
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

  // 파생 행 칸 주석 — 구성 행의 사유를 그대로(값이 빈 칸만)
  const inherit = (vals: (number | null)[], ...srcs: (string | null)[][]): (string | null)[] =>
    vals.map((v, i) => (v != null ? null : (srcs.map((s) => s[i]).find((x) => x) ?? null)));
  const nEbitda = (() => {
    const o: (string | null)[] = Array(nCol).fill(null);
    if (ltmIdxC >= 0 && ebitda[ltmIdxC] == null) {
      const oi = opViaFin ? opLtm : ltm(E.opIncome);
      o[ltmIdxC] = oi.value == null ? oi.reason : daTtm(facts) == null ? daTtmCell(facts).reason : null;
    }
    // LTM 감가상각비를 종전 식으로 낸 경우(분기 기준 혼합 — edgar-ev.ts DA_LTM_FALLBACK) 칸 주석
    else if (ltmIdxC >= 0) o[ltmIdxC] = daTtmCell(facts).note ?? null;
    // 사업연도 열 — fin 영업이익이 빈칸이면 그 사유(정의 대기 등)
    if (opViaFin)
      columns.forEach((c, i) => {
        if (c.kind !== "fy" || ebitda[i] != null) return;
        const oc = opCells.get(Number(c.key.slice(2)));
        if (oc?.v == null) o[i] = oc?.note ?? "영업이익 없음(fin)";
      });
    return o;
  })();
  const nOcf = ltmNote(E.ocf);
  const nCapex = ltmNote(E.capex);
  const nDps = ltmNote(E.dps);
  const rows: HighlightRow[] = [
    { key: "mktcap", label: "시가총액", format: "money", values: marketCap, cellNotes: nMktcap },
    ...(opUnitValue.some((v) => v != null)
      ? [{ key: "opunits", label: "+ 운영 파트너십 지분 (시가)", format: "money" as const, values: opUnitValue }]
      : []),
    { key: "cash", label: "− 현금·단기투자·장기 투자증권", format: "money", values: cash.map((v) => (v == null ? null : -v)), cellNotes: nBridge },
    { key: "debt", label: "+ 차입금", format: "money", values: debt, cellNotes: nBridge },
    { key: "pref_nci", label: "+ 우선주·비지배지분", format: "money", values: preferred, cellNotes: nBridge },
    { key: "ev", label: "기업가치 (EV)", format: "money", emphasis: true, values: ev, cellNotes: inherit(ev, nBridge, nMktcap) },
    { key: "sp1", label: "", format: "money", spacer: true, values: blank() },
    { key: "revenue", label: "매출액", format: "money", values: revenue },
    { key: "revenue_yoy", label: "성장률 % YoY", format: "pct", indent: true, values: seq(revenue, S.revenue) },
    { key: "ebitda", label: "EBITDA", format: "money", values: ebitda, cellNotes: nEbitda },
    { key: "ebitda_m", label: "마진 %", format: "pct", indent: true, values: ebitda.map((v, i) => margin(v, revenue[i])) },
    { key: "ni", label: "순이익", format: "money", values: netIncome, cellNotes: nNetIncome },
    { key: "ni_m", label: "마진 %", format: "pct", indent: true, values: netIncome.map((v, i) => margin(v, revenue[i])) },
    { key: "eps", label: "EPS (희석)", format: "eps", values: eps, cellNotes: nEps },
    { key: "eps_yoy", label: "성장률 % YoY", format: "pct", indent: true, values: seq(eps, S.eps) },
    { key: "dps", label: "DPS", format: "eps", values: dps, cellNotes: nDps },
    { key: "divyield", label: "배당수익률 %", format: "pct", indent: true, values: divYield },
    { key: "sp2", label: "", format: "money", spacer: true, values: blank() },
    { key: "ocf", label: "영업활동 현금흐름", format: "money", values: ocf, cellNotes: nOcf },
    { key: "capex", label: "자본지출", format: "money", values: capex, cellNotes: nCapex },
    { key: "fcf", label: "잉여현금흐름", format: "money", values: fcf, cellNotes: inherit(fcf, nOcf, nCapex) },
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
  // 배수 칸 주석 — 근사 라벨은 값이 있어도(분모·분자 근사), 사유는 값이 빈 칸만
  const labelOrWhy = (vals: (number | null)[], labels: (string | null)[][], whys: (string | null)[][]) =>
    vals.map((v, i) => labels.map((l) => l[i]).find((x) => x) ?? (v == null ? (whys.map((w) => w[i]).find((x) => x) ?? null) : null));
  const valuationRows: HighlightRow[] = [
    { key: "per", label: "PER", format: "mult", values: per, cellNotes: labelOrWhy(per, [nEps.map((n, i) => (eps[i] != null ? n : null))], [nEps]) },
    { key: "pbr", label: "PBR", format: "mult", values: pbr, cellNotes: labelOrWhy(pbr, [nMktcap.map((n, i) => (marketCap[i] != null ? n : null))], [nMktcap, nEquity]) },
    { key: "psr", label: "PSR", format: "mult", values: psr, cellNotes: labelOrWhy(psr, [nMktcap.map((n, i) => (marketCap[i] != null ? n : null))], [nMktcap]) },
    { key: "ev_ebitda", label: "EV/EBITDA", format: "mult", values: evEbitda, cellNotes: inherit(evEbitda, nBridge, nMktcap, nEbitda) },
  ];

  // SEC 원본 조회 실패로 공란이 된 값(대체 계산 없음 — sec-unavailable.ts)
  const unavailable = unavailableNote(facts);
  if (unavailable) notes.push(unavailable);
  notes.push("실적·재무상태표·현금흐름: SEC EDGAR companyfacts (GAAP 보고치)");
  if (facts.reportingCurrency && facts.reportingCurrency !== "USD")
    notes.push(`외화 공시(${facts.reportingCurrency}${facts.ifrsMapped ? " · IFRS" : ""}) → USD 환산: 손익·현금흐름은 기간 평균 환율, 재무상태표는 기말 환율 (연준 H.10 공식 일별 환율 — FRED, 평균 = 기간 고시값 산술평균·기말 = 그날 이전 마지막 고시)`);
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
  if (blockers.has("captive-unknown"))
    notes.push(
      "EV·EV/EBITDA 미표시: 금융 자회사 여부를 판별할 최신 공시 조회 실패(일시적 오류일 수 있음) — 금융 자회사 없음으로 단정하지 않음",
    );
  if (consolidatedShown)
    notes.push("차입금·현금·우선주·비지배지분: 연결 기준(금융 자회사 포함, 대차대조표 주석과 같은 값) — EV 만 비움");
  if (blockers.has("debt-untagged"))
    notes.push("EV·EV/EBITDA 미표시: 차입금이 표준 태그로 공시되지 않음");
  if (captiveExcluded)
    notes.push("금융 자회사(할부금융) 차입금 제외 — 제조 부문 차입금만 반영");
  if (partialDebt) notes.push("차입금 일부(개별 대출 건별로만 공시된 기간대출 등) 미집계 — EV 과소 가능");
  if (opUnitValue.some((v) => v != null))
    notes.push(
      "운영 파트너십 지분: 보통주로 교환 가능한 외부 파트너 지분을 시가로 반영(수량 출처: Yahoo implied shares)",
    );
  if (estCols.length)
    notes.push("예상(수익·EPS): yahoo-finance2 컨센서스 · 나머지 항목은 무료 컨센서스 없음");
  notes.push("EBITDA = 보고 영업이익 + 감가상각비·무형자산상각비 (블룸버그 '조정'과 다를 수 있음)");
  {
    // fin 영업이익 합성 열(본표 영업이익 소계 없음 — IBM·XOM 등) 표기
    const syn = opIncomeSynthNote(facts, columns.filter((c) => c.kind === "fy").map((c) => Number(c.key.slice(2))), true);
    if (syn) notes.push(`영업이익 ${syn} — 본표에 영업이익 소계가 없는 회사(IBM·XOM 등): 세전이익에서 이자·지분법·기타 영업외손익 줄을 뺀 값`);
  }
  if (usedPretaxAsOpIncome) {
    // 산식을 실제로 쓴 것만 적는다(G6) — 이자비용 태그가 없는 기간은 세전이익 그대로라 "세전 + 이자" 문구가 틀렸다
    const shown = new Set(columns.filter((c) => c.kind === "fy").map((c) => Number(c.key.slice(2))));
    const basis = new Set(
      E.opIncome.filter((e) => e.synBasis && e.fp === "FY" && shown.has(fiscalYearOf(e.end))).map((e) => e.synBasis),
    );
    if (basis.has("ebit") || basis.size === 0)
      notes.push("영업이익 태그가 없는 회사(BMY·XOM 등) — 세전이익 + 이자비용 − 지분법 이익(EBIT)으로 근사(기타 비영업 손익 포함 가능)");
    if (basis.has("pretax"))
      notes.push("영업이익 태그·이자비용 태그가 모두 없는 기간 — 세전이익 그대로(이자·지분법 미조정 근사)");
  }

  // 보조행(마진%·성장률%)의 빈칸 — 바로 위 기준 행의 칸 사유를 물려준다(빈칸 사유가 화면에서 빠지지 않게)
  {
    let base: HighlightRow | null = null;
    for (const r of rows) {
      if (r.spacer) continue;
      if (!r.indent) {
        base = r;
        continue;
      }
      if (!base?.cellNotes) continue;
      const bn = base.cellNotes;
      r.cellNotes = r.values.map((v, i) => r.cellNotes?.[i] ?? (v == null ? (bn[i] ?? null) : null));
    }
  }
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
