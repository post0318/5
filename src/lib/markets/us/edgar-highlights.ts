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

export interface HighlightColumn {
  key: string;
  label: string; // "2021Y" | "현재/LTM" | "2026Y 예상"
  date: string; // "2021-09-25"
  kind: "fy" | "ltm" | "estimate";
}
export interface HighlightRow {
  key: string;
  label: string;
  format: "money" | "pct" | "eps";
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
const INTERIM_FORMS = ["10-Q", "10-Q/A"];

const REVENUE = [
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
  "Revenues",
];

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}
function shiftYear(iso: string, n: number): string {
  const [y, m, d] = iso.split("-");
  return `${Number(y) + n}-${m}-${d}`;
}

function unitEntries(facts: CompanyFacts, concept: string, unit: string): FactUnitEntry[] {
  return facts.facts["us-gaap"]?.[concept]?.units?.[unit] ?? [];
}
function entriesAny(facts: CompanyFacts, concepts: string[], unit = "USD"): FactUnitEntry[] {
  for (const c of concepts) {
    const e = unitEntries(facts, c, unit);
    if (e.length) return e;
  }
  return [];
}
function deiEntries(facts: CompanyFacts, concept: string): FactUnitEntry[] {
  return facts.facts.dei?.[concept]?.units?.shares ?? [];
}

/** 사업연도(FY, 10-K) duration 값 → {year, val, end}[]. */
function annualSeries(entries: FactUnitEntry[]): { year: number; val: number; end: string }[] {
  const m = new Map<number, { val: number; end: string; filed: string }>();
  for (const e of entries) {
    if (e.fp !== "FY" || !e.start || !ANNUAL_FORMS.includes(e.form)) continue;
    const year = Number(e.end.slice(0, 4));
    const prev = m.get(year);
    if (!prev || e.end > prev.end) m.set(year, { val: e.val, end: e.end, filed: "" });
  }
  return [...m.entries()]
    .map(([year, v]) => ({ year, val: v.val, end: v.end }))
    .sort((a, b) => a.year - b.year);
}
function annualAt(series: { year: number; val: number }[], year: number): number | null {
  return series.find((s) => s.year === year)?.val ?? null;
}

/**
 * instant(재무상태표) 값 중 end ≤ asOf 이면서 가장 가까운 것.
 * maxStaleDays 지정 시 그보다 오래된 값은 무시 (분기마다 태깅되지 않는 계정용 — 리스 등).
 */
function instantAt(
  entries: FactUnitEntry[],
  asOf: string,
  maxStaleDays?: number,
): number | null {
  let best: { val: number; end: string } | null = null;
  for (const e of entries) {
    if (e.start) continue; // duration 제외
    if (e.end > asOf) continue;
    if (maxStaleDays != null && daysBetween(e.end, asOf) > maxStaleDays) continue;
    if (!best || e.end > best.end) best = { val: e.val, end: e.end };
  }
  return best?.val ?? null;
}

/** instant 엔트리 중 가장 최근 end 날짜 (최근 분기 기준일). */
function latestInstantEnd(entries: FactUnitEntry[]): string | null {
  let best: string | null = null;
  for (const e of entries) {
    if (e.start) continue;
    if (!best || e.end > best) best = e.end;
  }
  return best;
}

/** 흐름 계정 TTM = 최근 FY + 당기누적 − 전년동기누적. */
function ttm(entries: FactUnitEntry[]): number | null {
  const annuals = entries
    .filter((e) => e.fp === "FY" && e.start && ANNUAL_FORMS.includes(e.form))
    .sort((a, b) => b.end.localeCompare(a.end));
  const fy = annuals[0];
  if (!fy?.start) return null;
  const interims = entries.filter((e) => e.start && INTERIM_FORMS.includes(e.form));
  const cur = interims
    .filter((e) => Math.abs(daysBetween(fy.end, e.start!)) <= 12 && e.end > fy.end)
    .sort((a, b) => b.end.localeCompare(a.end))[0];
  if (!cur?.start) return fy.val;
  const wS = shiftYear(cur.start, -1);
  const wE = shiftYear(cur.end, -1);
  const prior = interims
    .filter(
      (e) =>
        e.start &&
        Math.abs(daysBetween(wS, e.start)) <= 12 &&
        Math.abs(daysBetween(wE, e.end)) <= 12,
    )
    .sort((a, b) => Math.abs(daysBetween(wE, a.end)) - Math.abs(daysBetween(wE, b.end)))[0];
  if (!prior) return fy.val;
  return fy.val + cur.val - prior.val;
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
): FinancialHighlights {
  const notes: string[] = [];

  // ── 컬럼 구성 ────────────────────────────────────────────────────
  const revSeries = annualSeries(entriesAny(facts, REVENUE));
  const fyYears = revSeries.map((s) => s.year).slice(-5);
  const fyEndByYear = new Map(revSeries.map((s) => [s.year, s.end]));
  const lastFy = fyYears[fyYears.length - 1] ?? new Date().getFullYear();

  const lastBar = [...bars].reverse().find((b) => b.close != null);
  const priceDate = lastBar?.date ?? new Date().toISOString().slice(0, 10);
  // LTM 컬럼 기준일 = 최근 분기 재무상태표 기준일 (블룸버그 표기와 동일)
  const mrqEnd =
    latestInstantEnd(unitEntries(facts, "CashAndCashEquivalentsAtCarryingValue", "USD")) ??
    priceDate;
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
    const year = p.endDate ? Number(p.endDate.slice(0, 4)) : null;
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
  const S = {
    revenue: annualSeries(entriesAny(facts, REVENUE)),
    grossProfit: annualSeries(unitEntries(facts, "GrossProfit", "USD")),
    opIncome: annualSeries(unitEntries(facts, "OperatingIncomeLoss", "USD")),
    da: annualSeries(
      entriesAny(facts, [
        "DepreciationDepletionAndAmortization",
        "DepreciationAmortizationAndAccretionNet",
        "DepreciationAndAmortization",
      ]),
    ),
    netIncome: annualSeries(unitEntries(facts, "NetIncomeLoss", "USD")),
    eps: annualSeries(unitEntries(facts, "EarningsPerShareDiluted", "USD/shares")),
    ocf: annualSeries(
      unitEntries(facts, "NetCashProvidedByUsedInOperatingActivities", "USD"),
    ),
    capex: annualSeries(
      unitEntries(facts, "PaymentsToAcquirePropertyPlantAndEquipment", "USD"),
    ),
  };
  const E = {
    revenue: entriesAny(facts, REVENUE),
    grossProfit: unitEntries(facts, "GrossProfit", "USD"),
    opIncome: unitEntries(facts, "OperatingIncomeLoss", "USD"),
    da: entriesAny(facts, [
      "DepreciationDepletionAndAmortization",
      "DepreciationAmortizationAndAccretionNet",
      "DepreciationAndAmortization",
    ]),
    netIncome: unitEntries(facts, "NetIncomeLoss", "USD"),
    eps: unitEntries(facts, "EarningsPerShareDiluted", "USD/shares"),
    ocf: unitEntries(facts, "NetCashProvidedByUsedInOperatingActivities", "USD"),
    capex: unitEntries(facts, "PaymentsToAcquirePropertyPlantAndEquipment", "USD"),
  };
  const cashE = unitEntries(facts, "CashAndCashEquivalentsAtCarryingValue", "USD");
  const mSecCurE = entriesAny(facts, ["MarketableSecuritiesCurrent", "ShortTermInvestments"]);
  const mSecNonCurE = entriesAny(facts, [
    "MarketableSecuritiesNoncurrent",
    "LongTermInvestments",
  ]);
  const debtNonCurE = unitEntries(facts, "LongTermDebtNoncurrent", "USD");
  const debtCurE = unitEntries(facts, "LongTermDebtCurrent", "USD");
  const cpE = unitEntries(facts, "CommercialPaper", "USD");
  const opLeaseNcE = unitEntries(facts, "OperatingLeaseLiabilityNoncurrent", "USD");
  const opLeaseCurE = unitEntries(facts, "OperatingLeaseLiabilityCurrent", "USD");
  const opLeaseTotE = unitEntries(facts, "OperatingLeaseLiability", "USD");
  const finLeaseNcE = unitEntries(facts, "FinanceLeaseLiabilityNoncurrent", "USD");
  const finLeaseCurE = unitEntries(facts, "FinanceLeaseLiabilityCurrent", "USD");
  const prefE = unitEntries(facts, "PreferredStockValue", "USD");
  const sharesEndE = unitEntries(facts, "CommonStockSharesOutstanding", "shares");
  const sharesDeiE = deiEntries(facts, "EntityCommonStockSharesOutstanding");

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

  columns.forEach((col, i) => {
    if (col.kind === "estimate") return;
    const asOf = col.date; // 재무상태표 기준일 (LTM = 최근 분기말)
    const isLtm = col.kind === "ltm";
    const price = isLtm ? (lastBar?.close ?? null) : closeOnOrBefore(bars, asOf);
    // 시총용 주식수: LTM 은 현재(가장 최근) 발행주식수, 과거는 기말 주식수
    const shares = isLtm
      ? (instantAt(sharesDeiE, priceDate) ??
        instantAt(sharesEndE, priceDate) ??
        instantAt(sharesDeiE, asOf))
      : (instantAt(sharesEndE, asOf) ?? instantAt(sharesDeiE, asOf));
    const mc = price != null && shares != null ? price * shares : null;
    marketCap[i] = mc;

    const c = instantAt(cashE, asOf);
    const sc = instantAt(mSecCurE, asOf);
    const snc = instantAt(mSecNonCurE, asOf);
    cash[i] = c != null || sc != null || snc != null ? (c ?? 0) + (sc ?? 0) + (snc ?? 0) : null;

    preferred[i] = mc != null ? (instantAt(prefE, asOf) ?? 0) : null;

    const dn = instantAt(debtNonCurE, asOf);
    const dc = instantAt(debtCurE, asOf);
    const cp = instantAt(cpE, asOf);
    const termDebt =
      dn != null || dc != null || cp != null ? (dn ?? 0) + (dc ?? 0) + (cp ?? 0) : null;
    // 리스부채 (블룸버그 총부채는 리스 포함). 매 분기 태깅되지 않으므로 ~100일 이내 값만.
    const FRESH = 100;
    const oln = instantAt(opLeaseNcE, asOf, FRESH);
    const olc = instantAt(opLeaseCurE, asOf, FRESH);
    const opLease =
      oln != null || olc != null
        ? (oln ?? 0) + (olc ?? 0)
        : instantAt(opLeaseTotE, asOf, FRESH);
    const fln = instantAt(finLeaseNcE, asOf, FRESH);
    const flc = instantAt(finLeaseCurE, asOf, FRESH);
    const finLease = fln != null || flc != null ? (fln ?? 0) + (flc ?? 0) : null;
    const leases = (opLease ?? 0) + (finLease ?? 0);
    debt[i] =
      termDebt != null ? termDebt + leases : leases > 0 ? leases : null;

    ev[i] =
      mc != null ? mc - (cash[i] ?? 0) + (preferred[i] ?? 0) + (debt[i] ?? 0) : null;
  });

  // ── 손익 ────────────────────────────────────────────────────────
  const revenue = columns.map((col) =>
    col.kind === "estimate"
      ? (estCols.find((e) => `FY${e.year}E` === col.key)?.period.revenueAvg ?? null)
      : flowVal(S.revenue, E.revenue, col),
  );
  const grossProfit = columns.map((col) => flowVal(S.grossProfit, E.grossProfit, col));
  const ebitda = columns.map((col) => {
    if (col.kind === "fy") {
      const y = Number(col.key.slice(2));
      const oi = annualAt(S.opIncome, y);
      const d = annualAt(S.da, y);
      return oi != null ? oi + (d ?? 0) : null;
    }
    if (col.kind === "ltm") {
      const oi = ttm(E.opIncome);
      const d = ttm(E.da);
      return oi != null ? oi + (d ?? 0) : null;
    }
    return null;
  });
  const currentShares =
    instantAt(sharesDeiE, priceDate) ?? instantAt(sharesEndE, priceDate);
  const netIncome = columns.map((col) => {
    if (col.kind === "estimate") {
      const eps = estCols.find((e) => `FY${e.year}E` === col.key)?.period.epsAvg ?? null;
      return eps != null && currentShares != null ? eps * currentShares : null;
    }
    return flowVal(S.netIncome, E.netIncome, col);
  });
  const eps = columns.map((col) => {
    if (col.kind === "estimate")
      return estCols.find((e) => `FY${e.year}E` === col.key)?.period.epsAvg ?? null;
    if (col.kind === "ltm") return ttm(E.eps);
    return annualAt(S.eps, Number(col.key.slice(2)));
  });

  // ── 현금흐름 ────────────────────────────────────────────────────
  const ocf = columns.map((col) => flowVal(S.ocf, E.ocf, col));
  const capex = columns.map((col) => {
    const v = flowVal(S.capex, E.capex, col);
    return v == null ? null : -Math.abs(v);
  });
  const fcf = columns.map((_, i) =>
    ocf[i] != null && capex[i] != null ? ocf[i]! + capex[i]! : null,
  );

  const seq = (a: (number | null)[]) => a.map((v, i) => (i === 0 ? null : yoy(v, a[i - 1])));

  const rows: HighlightRow[] = [
    { key: "mktcap", label: "시가총액", format: "money", values: marketCap },
    { key: "cash", label: "− 현금 및 현금등물", format: "money", values: cash.map((v) => (v == null ? null : -v)) },
    { key: "pref", label: "+ 우선주자본금 & 기타", format: "money", values: preferred },
    { key: "debt", label: "+ 총부채", format: "money", values: debt },
    { key: "ev", label: "기업가치 (EV)", format: "money", emphasis: true, values: ev },
    { key: "sp1", label: "", format: "money", spacer: true, values: blank() },
    { key: "revenue", label: "수익", format: "money", values: revenue },
    { key: "revenue_yoy", label: "성장률 % YoY", format: "pct", indent: true, values: seq(revenue) },
    { key: "gp", label: "매출총이익", format: "money", values: grossProfit },
    { key: "gp_m", label: "마진 %", format: "pct", indent: true, values: grossProfit.map((v, i) => margin(v, revenue[i])) },
    { key: "ebitda", label: "EBITDA", format: "money", values: ebitda },
    { key: "ebitda_m", label: "마진 %", format: "pct", indent: true, values: ebitda.map((v, i) => margin(v, revenue[i])) },
    { key: "ni", label: "순이익", format: "money", values: netIncome },
    { key: "ni_m", label: "마진 %", format: "pct", indent: true, values: netIncome.map((v, i) => margin(v, revenue[i])) },
    { key: "eps", label: "EPS (희석)", format: "eps", values: eps },
    { key: "eps_yoy", label: "성장률 % YoY", format: "pct", indent: true, values: seq(eps) },
    { key: "sp2", label: "", format: "money", spacer: true, values: blank() },
    { key: "ocf", label: "영업활동 현금흐름", format: "money", values: ocf },
    { key: "capex", label: "자본지출", format: "money", values: capex },
    { key: "fcf", label: "잉여현금흐름", format: "money", values: fcf },
  ];

  notes.push("실적·재무상태표·현금흐름: SEC EDGAR companyfacts (GAAP 보고치)");
  notes.push("과거 시가총액: 각 회계연도말 종가 × 기말 발행주식수");
  notes.push("총부채 = 차입금(장·단기) + CP + 리스부채");
  if (estCols.length)
    notes.push("예상(수익·EPS): yahoo-finance2 컨센서스 · 나머지 항목은 무료 컨센서스 없음");
  notes.push("EBITDA = 보고 영업이익 + 감가상각비·무형자산상각비 (블룸버그 '조정'과 다를 수 있음)");

  return {
    currency: "USD",
    unitLabel: "USD 백만",
    asOfLtm: ltmDate,
    columns,
    rows,
    notes,
    source: "SEC EDGAR + yahoo-finance2",
  };
}
