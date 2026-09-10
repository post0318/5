/**
 * 미국 금융회사(은행·카드사 등) 재무 하이라이트 — 블룸버그 "BBG 조정 하이라이트"(금융사판) 근사.
 *
 * 제조업 템플릿(매출→매출원가→매출총이익→영업이익)이 은행·카드사에는 맞지 않아
 * 별도 레이아웃으로 분리. AXP(아메리칸 익스프레스) BBG 스크린샷 기준 검증.
 *
 * 행 구조: 시가총액/자기자본장부가치/총예금/자산총계 (EV 브릿지 대신 규모 지표) →
 * 순수익(=매출−이자비용, GAAP)+성장률 / 충당금전이익(=순수익−총이자외비용)+마진% /
 * 영업이익(=충당금전이익−대손충당금)+마진% / 순이익+마진% / EPS(희석)+성장률.
 *
 * **알려진 한계**: 총대출채권(Card Member loans 등)과 Tier1·총자본비율은 SEC EDGAR
 * companyfacts 에 "회사 전체" 단일 태그가 없고 세그먼트(축·멤버) 차원으로만 태깅되어
 * (companyconcept API 는 무차원 컨텍스트만 반환) 이 표에서는 제공하지 않는다 — AXP
 * 영업이익률과 동일한 구조적 한계.
 */

import type { CompanyFacts, FactUnitEntry } from "./edgar";
import type { QuoteBar } from "../types";
import type { FinancialHighlights, HighlightColumn, HighlightRow, HighlightEstimatePeriod } from "./edgar-highlights";

const ANNUAL_FORMS = ["10-K", "10-K/A", "20-F", "20-F/A"];
const INTERIM_FORMS = ["10-Q", "10-Q/A"];

// 순수익(GAAP) — 은행·카드사는 이자비용을 매출에서 차감한 순액으로 표시.
const NET_REVENUE = ["RevenuesNetOfInterestExpense"];
const NONINTEREST_EXPENSE = ["NoninterestExpense"];
const PROVISION = [
  "ProvisionForLoanLossesExpensed",
  "ProvisionForLoanAndLeaseLosses",
  "ProvisionForLoanLeaseAndOtherLosses",
];
const DEPOSITS = ["Deposits"];

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}
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
function firstEntries(facts: CompanyFacts, concepts: string[], unit = "USD"): FactUnitEntry[] {
  for (const c of concepts) {
    const e = unitEntries(facts, c, unit);
    if (e.length) return e;
  }
  return [];
}
function deiEntries(facts: CompanyFacts, concept: string): FactUnitEntry[] {
  return facts.facts.dei?.[concept]?.units?.shares ?? [];
}

function annualSeries(entries: FactUnitEntry[]): { year: number; val: number; end: string }[] {
  const m = new Map<number, { val: number; end: string; filed: string }>();
  for (const e of entries) {
    if (e.fp !== "FY" || !isFullYear(e) || !ANNUAL_FORMS.includes(e.form)) continue;
    const year = Number(e.end.slice(0, 4));
    const prev = m.get(year);
    const filed = e.filed ?? "";
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

function instantAt(entries: FactUnitEntry[], asOf: string, maxStaleDays?: number): number | null {
  let best: { val: number; end: string; filed: string } | null = null;
  for (const e of entries) {
    if (e.start) continue;
    if (e.end > asOf) continue;
    if (maxStaleDays != null && daysBetween(e.end, asOf) > maxStaleDays) continue;
    const filed = e.filed ?? "";
    if (!best || e.end > best.end || (e.end === best.end && filed >= best.filed))
      best = { val: e.val, end: e.end, filed };
  }
  return best?.val ?? null;
}
function latestInstantEnd(entries: FactUnitEntry[]): string | null {
  let best: string | null = null;
  for (const e of entries) {
    if (e.start) continue;
    if (!best || e.end > best) best = e.end;
  }
  return best;
}
function ttm(entries: FactUnitEntry[]): number | null {
  const annuals = entries
    .filter((e) => e.fp === "FY" && isFullYear(e) && ANNUAL_FORMS.includes(e.form))
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
      (e) => e.start && Math.abs(daysBetween(wS, e.start)) <= 12 && Math.abs(daysBetween(wE, e.end)) <= 12,
    )
    .sort((a, b) => Math.abs(daysBetween(wE, a.end)) - Math.abs(daysBetween(wE, b.end)))[0];
  if (!prior) return fy.val;
  return fy.val + cur.val - prior.val;
}
function closeOnOrBefore(bars: QuoteBar[], iso: string): number | null {
  let best: number | null = null;
  for (const b of bars) if (b.date <= iso && b.close != null) best = b.close;
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

/** 금융회사(은행·카드사) 판정 — SIC 60xx(예금기관)·61xx(비예금 신용기관) + NoninterestExpense 태깅 여부. */
export function isFinancialCompany(facts: CompanyFacts, sic: string | null): boolean {
  if (!sic || !/^6[01]/.test(sic)) return false;
  return unitEntries(facts, "NoninterestExpense", "USD").length > 0;
}

export function buildUsBankHighlights(
  facts: CompanyFacts,
  bars: QuoteBar[],
  estimates: HighlightEstimatePeriod[],
  fallbackShares?: number | null,
): FinancialHighlights {
  const notes: string[] = [];

  const revSeries = annualSeries(firstEntries(facts, NET_REVENUE));
  const fyYears = revSeries.map((s) => s.year).slice(-5);
  const fyEndByYear = new Map(revSeries.map((s) => [s.year, s.end]));
  const lastFy = fyYears[fyYears.length - 1] ?? new Date().getFullYear();

  const lastBar = [...bars].reverse().find((b) => b.close != null);
  const priceDate = lastBar?.date ?? new Date().toISOString().slice(0, 10);
  const mrqEnd = latestInstantEnd(unitEntries(facts, "Assets", "USD")) ?? priceDate;
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

  const S = {
    netRevenue: revSeries,
    noninterestExpense: annualSeries(firstEntries(facts, NONINTEREST_EXPENSE)),
    provision: annualSeries(firstEntries(facts, PROVISION)),
    netIncome: annualSeries(firstEntries(facts, ["NetIncomeLoss", "ProfitLoss"])),
    eps: annualSeries(unitEntries(facts, "EarningsPerShareDiluted", "USD/shares")),
  };
  const E = {
    netRevenue: firstEntries(facts, NET_REVENUE),
    noninterestExpense: firstEntries(facts, NONINTEREST_EXPENSE),
    provision: firstEntries(facts, PROVISION),
    netIncome: firstEntries(facts, ["NetIncomeLoss", "ProfitLoss"]),
    eps: unitEntries(facts, "EarningsPerShareDiluted", "USD/shares"),
  };
  const equityE = unitEntries(facts, "StockholdersEquity", "USD");
  const depositsE = firstEntries(facts, DEPOSITS);
  const assetsE = unitEntries(facts, "Assets", "USD");
  const sharesEndE = unitEntries(facts, "CommonStockSharesOutstanding", "shares");
  const sharesDeiE = deiEntries(facts, "EntityCommonStockSharesOutstanding");

  const flowVal = (
    ser: { year: number; val: number }[],
    entries: FactUnitEntry[],
    col: HighlightColumn,
  ): number | null => {
    if (col.kind === "fy") return annualAt(ser, Number(col.key.slice(2)));
    if (col.kind === "ltm") return ttm(entries);
    return null;
  };

  // ── 규모 지표 (시가총액/자기자본/예금/자산) ──────────────────────
  const marketCap = blank();
  const equity = blank();
  const deposits = blank();
  const assets = blank();
  const priceByCol = blank();

  columns.forEach((col, i) => {
    if (col.kind === "estimate") return;
    const asOf = col.date;
    const isLtm = col.kind === "ltm";
    const price = isLtm ? (lastBar?.close ?? null) : closeOnOrBefore(bars, asOf);
    priceByCol[i] = price;
    equity[i] = instantAt(equityE, asOf);
    deposits[i] = instantAt(depositsE, asOf);
    assets[i] = instantAt(assetsE, asOf);
    const SS = 550;
    const shares = isLtm
      ? (instantAt(sharesDeiE, priceDate, SS) ?? instantAt(sharesEndE, priceDate, SS) ?? fallbackShares)
      : (instantAt(sharesEndE, asOf, SS) ?? instantAt(sharesDeiE, asOf, SS) ?? fallbackShares);
    marketCap[i] = price != null && shares != null ? price * shares : null;
  });

  const currentShares =
    instantAt(sharesDeiE, priceDate, 550) ?? instantAt(sharesEndE, priceDate, 550) ?? fallbackShares ?? null;

  // ── 손익 (순수익 → 충당금전이익 → 영업이익 → 순이익) ─────────────
  const netRevenue = columns.map((col) =>
    col.kind === "estimate"
      ? (estCols.find((e) => `FY${e.year}E` === col.key)?.period.revenueAvg ?? null)
      : flowVal(S.netRevenue, E.netRevenue, col),
  );
  const noninterestExpense = columns.map((col) => flowVal(S.noninterestExpense, E.noninterestExpense, col));
  const preProvision = netRevenue.map((v, i) =>
    v != null && noninterestExpense[i] != null ? v - noninterestExpense[i]! : null,
  );
  const provision = columns.map((col) => flowVal(S.provision, E.provision, col));
  const opIncome = preProvision.map((v, i) => (v != null && provision[i] != null ? v - provision[i]! : null));
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

  const firstFy = columns[0]?.kind === "fy" ? Number(columns[0].key.slice(2)) : null;
  const seq = (a: (number | null)[], series?: { year: number; val: number }[]) =>
    a.map((v, i) => {
      if (i > 0) return yoy(v, a[i - 1]);
      if (firstFy == null || !series) return null;
      return yoy(v, annualAt(series, firstFy - 1));
    });

  const rows: HighlightRow[] = [
    { key: "mktcap", label: "시가총액", format: "money", values: marketCap },
    { key: "equity", label: "자기자본 장부가치", format: "money", values: equity },
    { key: "deposits", label: "총예금", format: "money", values: deposits },
    { key: "assets", label: "자산총계", format: "money", emphasis: true, values: assets },
    { key: "sp1", label: "", format: "money", spacer: true, values: blank() },
    { key: "net_revenue", label: "순수익", format: "money", values: netRevenue },
    { key: "net_revenue_yoy", label: "성장률 % YoY", format: "pct", indent: true, values: seq(netRevenue, S.netRevenue) },
    { key: "pre_provision", label: "충당금전이익", format: "money", values: preProvision },
    { key: "pre_provision_m", label: "마진 %", format: "pct", indent: true, values: preProvision.map((v, i) => margin(v, netRevenue[i])) },
    { key: "op_income", label: "영업이익", format: "money", values: opIncome },
    { key: "op_income_m", label: "마진 %", format: "pct", indent: true, values: opIncome.map((v, i) => margin(v, netRevenue[i])) },
    { key: "ni", label: "순이익", format: "money", values: netIncome },
    { key: "ni_m", label: "마진 %", format: "pct", indent: true, values: netIncome.map((v, i) => margin(v, netRevenue[i])) },
    { key: "eps", label: "EPS (희석)", format: "eps", values: eps },
    { key: "eps_yoy", label: "성장률 % YoY", format: "pct", indent: true, values: seq(eps, S.eps) },
  ];

  const ltmIdx = columns.findIndex((c) => c.kind === "ltm");
  const curMcap = ltmIdx >= 0 ? marketCap[ltmIdx] : null;
  const ratio = (num: number | null, den: number | null): number | null =>
    num != null && den != null && den > 0 ? num / den : null;
  const per = columns.map((col, i) => ratio(col.kind === "estimate" ? priceByCol[ltmIdx] : priceByCol[i], eps[i]));
  const pbr = columns.map((col, i) => (col.kind === "estimate" ? null : ratio(marketCap[i], equity[i])));
  const psr = columns.map((col, i) => ratio(col.kind === "estimate" ? curMcap : marketCap[i], netRevenue[i]));
  const valuationRows: HighlightRow[] = [
    { key: "per", label: "PER", format: "mult", values: per },
    { key: "pbr", label: "PBR", format: "mult", values: pbr },
    { key: "psr", label: "PSR (순수익 기준)", format: "mult", values: psr },
  ];

  notes.push("금융회사(은행·카드사) 전용 레이아웃 — 순수익=매출−이자비용(GAAP RevenuesNetOfInterestExpense)");
  notes.push("충당금전이익 = 순수익 − 총이자외비용, 영업이익 = 충당금전이익 − 대손충당금");
  notes.push(
    "총대출채권·Tier1/총자본비율은 SEC EDGAR companyfacts 에 세그먼트 차원(Card Member loans 등)으로만 태깅되어 있어 " +
      "무차원 API 로는 조회 불가 — 이 표에서 제공하지 않음 (구조적 한계)",
  );
  if (estCols.length)
    notes.push("예상(수익·EPS): yahoo-finance2 컨센서스 · 나머지 항목은 무료 컨센서스 없음");

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
