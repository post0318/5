import "server-only";
import type { QuoteBar, TtmFlows } from "../types";
import type {
  FinancialHighlights,
  HighlightColumn,
  HighlightRow,
} from "../us/edgar-highlights";
import { type KrFacts, type KrDaInput, annualSeries, annualSumByPattern, daAndAmortSeries } from "./dart-facts";

/**
 * 한국 재무 하이라이트 (개요) — `edgar-highlights.ts` 미러.
 * EV 브릿지 + 5개년 손익·현금흐름 + LTM + 차기 추정 1개년(네이버 컨센서스) + 투자지표.
 * EBITDA = 영업이익 + 감가상각비(사업보고서 XBRL 주석 실측, daDoc — dart-analysis.ts 와 동일 로직).
 */

const IS = ["IS", "CIS"];
const REV = { ids: ["ifrs-full_Revenue", "dart_Revenue"], names: ["매출액", "수익(매출액)", "영업수익"] };
const OPI = { ids: ["dart_OperatingIncomeLoss", "ifrs-full_ProfitLossFromOperatingActivities"], names: ["영업이익"] };
const NI = { ids: ["ifrs-full_ProfitLoss"], names: ["당기순이익", "분기순이익", "반기순이익"] };
const EPS = {
  ids: [
    "ifrs-full_DilutedEarningsLossPerShare",
    "ifrs-full_BasicEarningsLossPerShare",
    "ifrs-full_DilutedEarningsLossPerShareFromContinuingOperations",
    "ifrs-full_BasicEarningsLossPerShareFromContinuingOperations",
  ],
  names: ["희석주당이익", "희석주당순이익", "기본주당이익", "기본주당순이익", "보통주기본주당이익", "계속영업기본주당이익"],
};
const OCF = { ids: ["ifrs-full_CashFlowsFromUsedInOperatingActivities"], names: ["영업활동현금흐름"] };
const CAPEX = { ids: ["ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities"], names: ["유형자산의 취득"] };
const CASH = { ids: ["ifrs-full_CashAndCashEquivalents"], names: ["현금및현금성자산"] };
const STINV = { ids: ["ifrs-full_ShorttermDepositsNotClassifiedAsCashEquivalents"], names: ["단기금융상품"] };
const EQUITY = { ids: ["ifrs-full_Equity"], names: ["자본총계"] };


export interface KrHighlightInput {
  facts: KrFacts; // annual
  bars: QuoteBar[]; // Stooq (다년) — 회계연도말 종가
  fyCloseByYear?: Map<number, number>; // KRX 회계연도말 종가 폴백
  sharesOutstanding: number | null; // KRX 현재 상장주식수
  currentMarketCap: number | null;
  currentPrice: number | null;
  ttm: TtmFlows | null;
  /** 연도별 주당배당금 (원). alotMatter. */
  dpsByYear: Map<number, number>;
  payoutByYear: Map<number, number>; // 배당성향 %
  /** 최근 12개월(366일) 배당기준일 합산 주당배당금 — 있으면 LTM 열에 우선 사용. */
  dpsTtm?: number | null;
  /** 감가상각비 실측(사업보고서 XBRL 주석) — 있으면 EBITDA = 영업이익 + 감가상각비. */
  daDoc?: KrDaInput | null;
  consensus: {
    estYear: number | null;
    /** 네이버 컨센서스 매출액·영업이익·순이익 (억원, 네이버 표시 단위 그대로) */
    estRevenue?: number | null;
    estOpIncome?: number | null;
    estNetIncome?: number | null;
    estEps: number | null;
    estPer: number | null;
    estPbr: number | null;
  } | null;
}

/** 네이버 컨센서스는 억원 단위 — 이 파일의 원(KRW) 단위로 환산. */
const fromEokwon = (v: number | null | undefined): number | null =>
  v == null ? null : v * 1e8;

function closeOnOrBefore(bars: QuoteBar[], iso: string): number | null {
  let best: number | null = null;
  for (const b of bars) if (b.date <= iso && b.close != null) best = b.close;
  return best;
}
const yoy = (cur: number | null, prev: number | null): number | null =>
  cur == null || prev == null || prev === 0 ? null : ((cur - prev) / Math.abs(prev)) * 100;
const margin = (part: number | null, whole: number | null): number | null =>
  part == null || whole == null || whole === 0 ? null : (part / whole) * 100;
const ratio = (n: number | null, d: number | null): number | null =>
  n != null && d != null && d > 0 ? n / d : null;

export function buildKrHighlights(input: KrHighlightInput): FinancialHighlights {
  const { facts, bars, fyCloseByYear, sharesOutstanding: shares, currentMarketCap, currentPrice, ttm, dpsByYear, dpsTtm, daDoc, consensus } = input;

  const fyYears = facts.periods.map((p) => p.year);
  const lastFy = fyYears[fyYears.length - 1] ?? new Date().getFullYear();
  const lastBar = [...bars].reverse().find((b) => b.close != null);
  const ltmDate = lastBar?.date ?? new Date().toISOString().slice(0, 10);

  const columns: HighlightColumn[] = fyYears.map((y) => ({
    key: `FY${y}`,
    label: `${y}Y`,
    date: `${y}-12-31`,
    kind: "fy",
  }));
  columns.push({ key: "LTM", label: "현재/LTM", date: ltmDate, kind: "ltm" });
  const estYear = consensus?.estYear && consensus.estYear > lastFy ? consensus.estYear : null;
  if (estYear) columns.push({ key: `FY${estYear}E`, label: `${estYear}Y 예상`, date: `${estYear}-12-31`, kind: "estimate" });

  const nCol = columns.length;
  const blank = (): (number | null)[] => Array(nCol).fill(null);

  const aRev = annualSeries(facts, REV.ids, REV.names, IS);
  const aOpi = annualSeries(facts, OPI.ids, OPI.names, IS);
  const aNi = annualSeries(facts, NI.ids, NI.names, IS);
  const aEps = annualSeries(facts, EPS.ids, EPS.names, IS);
  const aOcf = annualSeries(facts, OCF.ids, OCF.names, "CF");
  const aCapex = annualSeries(facts, CAPEX.ids, CAPEX.names, "CF");
  const aCash = annualSeries(facts, CASH.ids, CASH.names, "BS");
  const aStInv = annualSeries(facts, STINV.ids, STINV.names, "BS");
  const aEquity = annualSeries(facts, EQUITY.ids, EQUITY.names, "BS");
  const aDebt = annualSumByPattern(facts, /차입금|사채|리스부채/, "BS", /리스채권|투자|자산|받을|대여/);

  const at = (m: Map<number, number>, y: number): number | null => m.get(y) ?? null;
  const cy = (c: HighlightColumn): number => Number(c.key.replace(/[^0-9]/g, ""));

  // ── 컬럼별 값 ──
  const priceByCol = columns.map((c) =>
    c.kind === "ltm"
      ? (currentPrice ?? lastBar?.close ?? null)
      : c.kind === "estimate"
        ? (currentPrice ?? null)
        : (closeOnOrBefore(bars, c.date) ?? fyCloseByYear?.get(cy(c)) ?? null),
  );
  const marketCap = columns.map((c, i) => {
    if (c.kind === "ltm") return currentMarketCap ?? (priceByCol[i] != null && shares != null ? priceByCol[i]! * shares : null);
    if (c.kind === "estimate") return null;
    return priceByCol[i] != null && shares != null ? priceByCol[i]! * shares : null;
  });
  const cashCol = columns.map((c) => {
    if (c.kind === "estimate") return null;
    const y = c.kind === "fy" ? cy(c) : lastFy;
    const a = at(aCash, y);
    const b = at(aStInv, y);
    return a != null || b != null ? (a ?? 0) + (b ?? 0) : null;
  });
  const debtCol = columns.map((c) => (c.kind === "estimate" ? null : at(aDebt, c.kind === "fy" ? cy(c) : lastFy)));
  const equityCol = columns.map((c) => (c.kind === "estimate" ? null : at(aEquity, c.kind === "fy" ? cy(c) : lastFy)));
  const ev = columns.map((_, i) =>
    marketCap[i] != null ? marketCap[i]! - (cashCol[i] ?? 0) + (debtCol[i] ?? 0) : null,
  );

  // 추정(estimate) 열은 네이버 컨센서스 매출액·영업이익·순이익을 그대로 쓴다(우선순위)
  // — 예전엔 순이익을 "추정 EPS × 발행주식수"로 역산했는데, 애널리스트 순이익
  // 컨센서스는 EPS 컨센서스와 독립 집계라 두 값이 달라(주식수 가정 차이 등)
  // 역산값이 실제 네이버 순이익 컨센서스와 10%대 오차가 났다.
  const revenue = columns.map((c) =>
    c.kind === "ltm" ? (ttm?.revenue ?? null) : c.kind === "estimate" ? fromEokwon(consensus?.estRevenue) : at(aRev, cy(c)),
  );
  const opInc = columns.map((c) =>
    c.kind === "ltm" ? (ttm?.opIncome ?? null) : c.kind === "estimate" ? fromEokwon(consensus?.estOpIncome) : at(aOpi, cy(c)),
  );
  const netIncome = columns.map((c) => {
    if (c.kind === "ltm") return ttm?.netIncome ?? null;
    if (c.kind === "estimate") {
      return (
        fromEokwon(consensus?.estNetIncome) ??
        (consensus?.estEps != null && shares != null ? consensus.estEps * shares : null)
      );
    }
    return at(aNi, cy(c));
  });
  const eps = columns.map((c) => {
    if (c.kind === "ltm") return ttm?.eps ?? null;
    if (c.kind === "estimate") return consensus?.estEps ?? null;
    return at(aEps, cy(c));
  });
  // LTM 배당금 = 최근 12개월(366일) 배당기준일 합산(공공데이터포털 배당정보,
  // rights-schedule.ts fetchKrAnnualDps) — 없으면 최근 완결 사업연도값으로 폴백.
  const dps = columns.map((c) =>
    c.kind === "fy" ? (dpsByYear.get(cy(c)) ?? null) : c.kind === "ltm" ? (dpsTtm ?? dpsByYear.get(lastFy) ?? null) : null,
  );
  const divYield = dps.map((d, i) => (d != null && priceByCol[i] ? (d / priceByCol[i]!) * 100 : null));
  // OCF/CapEx 는 TTM 미보유 → LTM 컬럼은 최근 사업연도값
  const ocf = columns.map((c) => (c.kind === "ltm" ? at(aOcf, lastFy) : c.kind === "estimate" ? null : at(aOcf, cy(c))));
  const capex = columns.map((c) => {
    const v = c.kind === "fy" ? at(aCapex, cy(c)) : c.kind === "ltm" ? at(aCapex, lastFy) : null;
    return v == null ? null : -Math.abs(v);
  });
  const fcf = columns.map((_, i) => (ocf[i] != null && capex[i] != null ? ocf[i]! + capex[i]! : null));

  const firstFy = columns[0]?.kind === "fy" ? cy(columns[0]) : null;
  const seq = (a: (number | null)[], src?: Map<number, number>) =>
    a.map((v, i) => {
      if (i > 0) return yoy(v, a[i - 1]);
      if (firstFy != null && src) return yoy(v, src.get(firstFy - 1) ?? null);
      return null;
    });

  // 감가상각비 실측(사업보고서 XBRL 주석) — EBITDA = 영업이익 + 감가상각비
  const daS = daAndAmortSeries(facts, daDoc ?? null);
  const ebitda = columns.map((c, i) => {
    if (opInc[i] == null) return null;
    const da = c.kind === "fy" ? (daS.byYear.get(cy(c)) ?? null) : c.kind === "ltm" ? daS.ltm : null;
    return da != null ? opInc[i]! + da : null;
  });

  const rows: HighlightRow[] = [
    { key: "mktcap", label: "시가총액", format: "money", values: marketCap },
    { key: "cash", label: "− 현금 및 단기금융상품", format: "money", values: cashCol.map((v) => (v == null ? null : -v)) },
    { key: "debt", label: "+ 총차입금", format: "money", values: debtCol },
    { key: "ev", label: "기업가치 (EV)", format: "money", emphasis: true, values: ev },
    { key: "sp1", label: "", format: "money", spacer: true, values: blank() },
    { key: "revenue", label: "매출액", format: "money", values: revenue },
    { key: "revenue_yoy", label: "성장률 % YoY", format: "pct", indent: true, values: seq(revenue, aRev) },
    { key: "opinc", label: "영업이익", format: "money", values: opInc },
    { key: "opinc_m", label: "마진 %", format: "pct", indent: true, values: opInc.map((v, i) => margin(v, revenue[i])) },
    { key: "ebitda", label: "EBITDA", format: "money", values: ebitda },
    { key: "ni", label: "순이익", format: "money", values: netIncome },
    { key: "ni_m", label: "마진 %", format: "pct", indent: true, values: netIncome.map((v, i) => margin(v, revenue[i])) },
    { key: "eps", label: "EPS (희석)", format: "eps", values: eps },
    { key: "eps_yoy", label: "성장률 % YoY", format: "pct", indent: true, values: seq(eps, aEps) },
    { key: "dps", label: "DPS", format: "eps", values: dps },
    { key: "divyield", label: "배당수익률 %", format: "pct", indent: true, values: divYield },
    { key: "sp2", label: "", format: "money", spacer: true, values: blank() },
    { key: "ocf", label: "영업활동 현금흐름", format: "money", values: ocf },
    { key: "capex", label: "자본지출", format: "money", values: capex },
    { key: "fcf", label: "잉여현금흐름", format: "money", values: fcf },
  ];

  const per = columns.map((c, i) => {
    if (c.kind === "estimate") return consensus?.estPer ?? ratio(priceByCol[i], eps[i]);
    return ratio(priceByCol[i], eps[i]);
  });
  const pbr = columns.map((c, i) => {
    if (c.kind === "estimate") return consensus?.estPbr ?? null;
    return ratio(marketCap[i], equityCol[i]);
  });
  // 추정 열은 marketCap 이 null(현금·부채 미보유라 EV 계열은 계산 안 함)이라
  // PSR 만 현재 시가총액 기준으로 별도 산출(원가/부채 불필요 — 매출액만 있으면 됨).
  const estMarketCap = currentMarketCap ?? (currentPrice != null && shares != null ? currentPrice * shares : null);
  const psr = columns.map((c, i) =>
    c.kind === "estimate" ? ratio(estMarketCap, revenue[i]) : ratio(marketCap[i], revenue[i]),
  );
  const evEbitda = columns.map((c, i) => (c.kind === "estimate" ? null : ratio(ev[i], ebitda[i])));

  const valuationRows: HighlightRow[] = [
    { key: "per", label: "PER", format: "mult", values: per },
    { key: "pbr", label: "PBR", format: "mult", values: pbr },
    { key: "psr", label: "PSR", format: "mult", values: psr },
    { key: "ev_ebitda", label: "EV/EBITDA", format: "mult", values: evEbitda },
  ];

  const notes = [
    "실적·재무상태표·현금흐름: OpenDART 전체 재무제표 (연결)",
    "과거 시가총액: 각 회계연도말 종가 × 현재 상장주식수 (기간별 주식수 미반영 — 근사)",
    "총차입금 = 단기차입금 + 유동성장기부채 + 사채 + 장기차입금",
    "EBITDA 대신 영업이익 사용 (DART 전체재무제표에 감가상각비 미분리)",
  ];
  if (estYear) notes.push("예상: 네이버(FnGuide) 컨센서스 · 추정 EPS 기준");

  return {
    currency: "KRW",
    unitLabel: "KRW 십억",
    asOfLtm: ltmDate,
    columns,
    rows,
    valuationRows,
    notes,
    source: facts.source,
  };
}
