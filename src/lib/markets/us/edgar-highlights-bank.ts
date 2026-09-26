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
import { buildShareResolver } from "./edgar-shares";
import { fiscalYearOf, instantOn, ltmAnchor, ltmFlowOf } from "./edgar-series";
import {
  fyEps,
  ltmEpsOf,
  netIncomeAnnualByYear,
  netIncomeToParentEntries,
  parentEquityOf,
} from "./edgar-pershare";
import type { FinancialHighlights, HighlightColumn, HighlightRow, HighlightEstimatePeriod } from "./edgar-highlights";
import {
  FIN_NONINTEREST_EXPENSE as NONINTEREST_EXPENSE,
  FIN_PROVISION as PROVISION,
  isFinancialCompany,
} from "./edgar-financial";
import { revAnnualEnds, revAnnualMap, revAnnualYears, revLtm } from "./fin-revenue";

const ANNUAL_FORMS = ["10-K", "10-K/A", "20-F", "20-F/A"];
const DEPOSITS = ["Deposits"];

export { isFinancialCompany };

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}
function isFullYear(e: FactUnitEntry): boolean {
  if (!e.start) return false;
  const d = daysBetween(e.start, e.end);
  return d >= 300 && d <= 400;
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
function annualSeries(entries: FactUnitEntry[]): { year: number; val: number; end: string }[] {
  const m = new Map<number, { val: number; end: string; filed: string }>();
  for (const e of entries) {
    if (e.fp !== "FY" || !isFullYear(e) || !ANNUAL_FORMS.includes(e.form)) continue;
    const year = fiscalYearOf(e.end);
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

function latestInstantEnd(entries: FactUnitEntry[]): string | null {
  let best: string | null = null;
  for (const e of entries) {
    if (e.start) continue;
    if (!best || e.end > best) best = e.end;
  }
  return best;
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
export function buildUsBankHighlights(
  facts: CompanyFacts,
  bars: QuoteBar[],
  estimates: HighlightEstimatePeriod[],
  /** Yahoo 현재 주식수 힌트 — ADR 비율 판정에만(주식수 값으로 대신 쓰지 않음, edgar-shares.ts) */
  fallbackShares?: number | null,
): FinancialHighlights {
  const notes: string[] = [];
  // LTM 흐름 — edgar-series.ts 단일 함수(550일 규칙·분기 누락 공란 포함 — 예전 은행 사본엔 550일 규칙이 없었다)
  const anchor = ltmAnchor(facts);
  // 순수익 = 재무 5층 구조 매출 지표(fin-revenue.ts, 은행 유형 규칙) — 손익계산서·재무분석과 같은 값·같은 연도 열
  const revEnds = revAnnualEnds(facts.revenue);
  const revSeries = [...revAnnualMap(facts.revenue)]
    .map(([year, val]) => ({ year, val, end: revEnds.get(year) ?? `${year}-12-31` }))
    .sort((a, b) => a.year - b.year);
  const fyYears = revAnnualYears(facts.revenue, 5);
  const fyEndByYear = revEnds;
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

  const S = {
    netRevenue: revSeries,
    noninterestExpense: annualSeries(firstEntries(facts, NONINTEREST_EXPENSE)),
    provision: annualSeries(firstEntries(facts, PROVISION)),
    // 순이익 행은 지배주주 순이익(손익계산서·재무분석·컨센서스와 같은 값). EPS 는
    // 보통주 귀속 순이익 기준(ltmEps·fyEps) — 은행은 우선주 배당이 커서 둘이 다르다.
    netIncome: [...netIncomeAnnualByYear(facts)]
      .map(([year, val]) => ({ year, val, end: `${year}-12-31` }))
      .sort((a, b) => a.year - b.year),
    eps: annualSeries(unitEntries(facts, "EarningsPerShareDiluted", "USD/shares")),
  };
  const E = {
    noninterestExpense: firstEntries(facts, NONINTEREST_EXPENSE),
    provision: firstEntries(facts, PROVISION),
    netIncome: netIncomeToParentEntries(facts),
    eps: unitEntries(facts, "EarningsPerShareDiluted", "USD/shares"),
  };
  const depositsE = firstEntries(facts, DEPOSITS);
  const assetsE = unitEntries(facts, "Assets", "USD");
  // 주식수·자기자본·EPS — 일반 하이라이트·재무분석과 같은 공통 기준(edgar-shares·
  // edgar-pershare). 예전엔 자체 주식수(분할 보정 없음)·흐름식 LTM EPS 를 써서 JPM
  // LTM PER 이 재무분석과 4.6% 달랐다(검증 체계 2층, 2026-09-23).
  const shareRes = buildShareResolver(facts, { sharesHint: fallbackShares });

  const flowVal = (
    ser: { year: number; val: number }[],
    entries: FactUnitEntry[],
    col: HighlightColumn,
  ): number | null => {
    if (col.kind === "fy") return annualAt(ser, Number(col.key.slice(2)));
    if (col.kind === "ltm") return ltmFlowOf(entries, anchor).value;
    return null;
  };
  const ltmIdxC = columns.findIndex((c) => c.kind === "ltm");
  /** LTM 칸 사유(흐름이 비었을 때) */
  const ltmNote = (entries: FactUnitEntry[]): (string | null)[] => {
    const o: (string | null)[] = Array(nCol).fill(null);
    const r = ltmFlowOf(entries, anchor);
    if (ltmIdxC >= 0 && r.value == null && r.reason) o[ltmIdxC] = r.reason;
    return o;
  };

  // ── 규모 지표 (시가총액/자기자본/예금/자산) ──────────────────────
  const marketCap = blank();
  const equity = blank();
  const deposits = blank();
  const assets = blank();
  const priceByCol = blank();
  const sharesByCol = blank();
  const nMktcap: (string | null)[] = Array(nCol).fill(null);
  const nEquity: (string | null)[] = Array(nCol).fill(null);
  const nBal: (string | null)[] = Array(nCol).fill(null);

  columns.forEach((col, i) => {
    if (col.kind === "estimate") return;
    const asOf = col.date;
    const isLtm = col.kind === "ltm";
    const price = isLtm ? (lastBar?.close ?? null) : closeOnOrBefore(bars, asOf);
    priceByCol[i] = price;
    const eq = parentEquityOf(facts, asOf);
    equity[i] = eq.value;
    if (eq.value == null) nEquity[i] = eq.reason;
    // 예금·자산 — 그 기준일(±6일) 값만(이전 가장 최근 값으로 대신하지 않음 — 그림자 채우기 금지)
    deposits[i] = instantOn(depositsE, asOf);
    assets[i] = instantOn(assetsE, asOf);
    if (deposits[i] == null && depositsE.length) nBal[i] = `재무상태표에 없음(${asOf})`;
    const shares = isLtm
      ? shareRes.current()
      : shareRes.atFiscalYearEnd(Number(col.key.slice(2)), asOf);
    nMktcap[i] = isLtm ? shareRes.currentNote() : shareRes.yearEndNote(Number(col.key.slice(2)));
    if (price == null) nMktcap[i] = "주가 없음";
    sharesByCol[i] = shares;
    marketCap[i] = price != null && shares != null ? price * shares : null;
  });

  // 현재 주식수 — 공통 기준만(Yahoo 힌트로 대신하지 않음)
  const currentShares = shareRes.current();

  // ── 손익 (순수익 → 충당금전이익 → 영업이익 → 순이익) ─────────────
  const netRevenue = columns.map((col) =>
    col.kind === "estimate"
      ? (estCols.find((e) => `FY${e.year}E` === col.key)?.period.revenueAvg ?? null)
      : col.kind === "fy"
        ? annualAt(S.netRevenue, Number(col.key.slice(2)))
        : col.kind === "ltm"
          ? revLtm(facts.revenue)
          : null,
  );
  const noninterestExpense = columns.map((col) => flowVal(S.noninterestExpense, E.noninterestExpense, col));
  const preProvision = netRevenue.map((v, i) =>
    v != null && noninterestExpense[i] != null ? v - noninterestExpense[i]! : null,
  );
  const provision = columns.map((col) => flowVal(S.provision, E.provision, col));
  const opIncome = preProvision.map((v, i) => (v != null && provision[i] != null ? v - provision[i]! : null));
  const nNetIncome = ltmNote(E.netIncome);
  const netIncome = columns.map((col, i) => {
    if (col.kind === "estimate") {
      // 예상 순이익 = 무료 컨센서스 없음. "예상 EPS × 현재 주식수"로 대신하지 않는다(그림자 채우기 금지)
      nNetIncome[i] = "예상 순이익: 무료 컨센서스 없음(EPS × 현재 주식수로 대신하지 않음)";
      return null;
    }
    return flowVal(S.netIncome, E.netIncome, col);
  });
  const nEps: (string | null)[] = Array(nCol).fill(null);
  const eps = columns.map((col, i) => {
    if (col.kind === "estimate")
      return estCols.find((e) => `FY${e.year}E` === col.key)?.period.epsAvg ?? null;
    if (col.kind === "ltm") {
      const le = ltmEpsOf(facts, currentShares);
      nEps[i] = le.value == null ? le.reason : shareRes.currentNote();
      return le.value;
    }
    const r = fyEps(facts, Number(col.key.slice(2)), {
      fyShares: sharesByCol[i],
      fyNetIncome: netIncome[i],
    });
    nEps[i] = r.note; // 원인별 라벨(근사·클래스 등, G4)
    return r.eps;
  });

  const firstFy = columns[0]?.kind === "fy" ? Number(columns[0].key.slice(2)) : null;
  const seq = (a: (number | null)[], series?: { year: number; val: number }[]) =>
    a.map((v, i) => {
      if (i > 0) return yoy(v, a[i - 1]);
      if (firstFy == null || !series) return null;
      return yoy(v, annualAt(series, firstFy - 1));
    });

  const nNie = ltmNote(E.noninterestExpense);
  const nProv = ltmNote(E.provision);
  const inherit = (vals: (number | null)[], ...srcs: (string | null)[][]): (string | null)[] =>
    vals.map((v, i) => (v != null ? null : (srcs.map((x) => x[i]).find((x) => x) ?? null)));
  const rows: HighlightRow[] = [
    { key: "mktcap", label: "시가총액", format: "money", values: marketCap, cellNotes: nMktcap },
    { key: "equity", label: "자기자본 장부가치", format: "money", values: equity, cellNotes: nEquity },
    { key: "deposits", label: "총예금", format: "money", values: deposits, cellNotes: nBal },
    { key: "assets", label: "자산총계", format: "money", emphasis: true, values: assets },
    { key: "sp1", label: "", format: "money", spacer: true, values: blank() },
    { key: "net_revenue", label: "순수익", format: "money", values: netRevenue },
    { key: "net_revenue_yoy", label: "성장률 % YoY", format: "pct", indent: true, values: seq(netRevenue, S.netRevenue) },
    { key: "pre_provision", label: "충당금전이익", format: "money", values: preProvision, cellNotes: inherit(preProvision, nNie) },
    { key: "pre_provision_m", label: "마진 %", format: "pct", indent: true, values: preProvision.map((v, i) => margin(v, netRevenue[i])) },
    { key: "op_income", label: "영업이익", format: "money", values: opIncome, cellNotes: inherit(opIncome, nNie, nProv) },
    { key: "op_income_m", label: "마진 %", format: "pct", indent: true, values: opIncome.map((v, i) => margin(v, netRevenue[i])) },
    { key: "ni", label: "순이익", format: "money", values: netIncome, cellNotes: nNetIncome },
    { key: "ni_m", label: "마진 %", format: "pct", indent: true, values: netIncome.map((v, i) => margin(v, netRevenue[i])) },
    { key: "eps", label: "EPS (희석)", format: "eps", values: eps, cellNotes: nEps },
    { key: "eps_yoy", label: "성장률 % YoY", format: "pct", indent: true, values: seq(eps, S.eps) },
  ];

  const ltmIdx = columns.findIndex((c) => c.kind === "ltm");
  const curMcap = ltmIdx >= 0 ? marketCap[ltmIdx] : null;
  const ratio = (num: number | null, den: number | null): number | null =>
    num != null && den != null && den > 0 ? num / den : null;
  const per = columns.map((col, i) => ratio(col.kind === "estimate" ? priceByCol[ltmIdx] : priceByCol[i], eps[i]));
  const pbr = columns.map((col, i) => (col.kind === "estimate" ? null : ratio(marketCap[i], equity[i])));
  const psr = columns.map((col, i) => ratio(col.kind === "estimate" ? curMcap : marketCap[i], netRevenue[i]));
  const labelOrWhy = (vals: (number | null)[], lab: (string | null)[], whys: (string | null)[][]) =>
    vals.map((v, i) => lab[i] ?? (v == null ? (whys.map((w) => w[i]).find((x) => x) ?? null) : null));
  const mcLab = nMktcap.map((n, i) => (marketCap[i] != null ? n : null));
  const valuationRows: HighlightRow[] = [
    { key: "per", label: "PER", format: "mult", values: per, cellNotes: labelOrWhy(per, nEps.map((n, i) => (eps[i] != null ? n : null)), [nEps]) },
    { key: "pbr", label: "PBR", format: "mult", values: pbr, cellNotes: labelOrWhy(pbr, mcLab, [nMktcap, nEquity]) },
    { key: "psr", label: "PSR (순수익 기준)", format: "mult", values: psr, cellNotes: labelOrWhy(psr, mcLab, [nMktcap]) },
  ];

  notes.push("금융회사(은행·카드사) 전용 레이아웃 — 순수익=매출−이자비용(GAAP RevenuesNetOfInterestExpense)");
  notes.push("충당금전이익 = 순수익 − 총이자외비용, 영업이익 = 충당금전이익 − 대손충당금");
  notes.push("순이익 = 지배주주 순이익(손익계산서·재무분석·컨센서스와 같은 값) · EPS·PER 은 보통주 귀속 순이익(우선주배당 차감 후) 기준");
  notes.push(
    "총대출채권·Tier1/총자본비율은 SEC EDGAR companyfacts 에 세그먼트 차원(Card Member loans 등)으로만 태깅되어 있어 " +
      "무차원 API 로는 조회 불가 — 이 표에서 제공하지 않음 (구조적 한계)",
  );
  if (estCols.length)
    notes.push("예상(수익·EPS): yahoo-finance2 컨센서스 · 나머지 항목은 무료 컨센서스 없음");

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
