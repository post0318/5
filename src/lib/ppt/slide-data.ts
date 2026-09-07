import "server-only";
import YahooFinancePkg from "yahoo-finance2";
import { getStockOverview } from "@/lib/markets/service";
import type { FinancialStatement, MarketId } from "@/lib/markets/types";

/**
 * 종목 소개 PPT 슬라이드용 데이터 조립.
 * L1 재무(실적) + yahoo 컨센서스(추정) + yahoo 일봉(주가 차트).
 * yahoo 사용 → 개인용/비상업 한정 (prd.md §4.3).
 */

const YahooFinance = (YahooFinancePkg as { default?: unknown }).default ?? YahooFinancePkg;
type YF = { chart: (s: string, o: Record<string, unknown>) => Promise<{ quotes: RawBar[] }> };
interface RawBar {
  date: Date | string;
  close?: number | null;
  adjclose?: number | null;
}
let yf: YF | null = null;
function yfi(): YF {
  if (!yf) {
    const C = YahooFinance as new (o: Record<string, unknown>) => YF;
    yf = new C({ suppressNotices: ["yahooSurvey"], validation: { logErrors: false } });
  }
  return yf;
}

const ACCT = {
  revenue: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "매출액",
    "수익(매출액)",
    "매출",
    "영업수익",
    "売上高",
    "営業収益",
  ],
  netIncome: [
    "NetIncomeLoss",
    "ProfitLoss",
    "당기순이익",
    "당기순이익(손실)",
    "분기순이익",
    "当期純利益",
    "親会社株主に帰属する当期純利益",
  ],
  eps: [
    "EarningsPerShareDiluted",
    "EarningsPerShareBasic",
    "희석주당이익",
    "기본주당이익",
    "주당순이익",
    "1株当たり当期純利益",
    "1株当たり当期純利益 (円)",
  ],
};

const norm = (s: string) => s.replace(/\s/g, "");

/** 연간 재무제표에서 한 계정의 연도별 값 시리즈 (fiscalYear → value) */
function seriesOf(
  fs: FinancialStatement | null,
  ids: string[],
): { year: number; value: number }[] {
  if (!fs) return [];
  const targets = new Set(ids.map(norm));
  const byLabel = new Map(fs.periods.map((p) => [p.label, p]));
  for (const section of fs.sections) {
    for (const item of section.items) {
      if (!targets.has(norm(item.accountId ?? item.accountName))) continue;
      const out: { year: number; value: number }[] = [];
      for (const [label, v] of Object.entries(item.values)) {
        const p = byLabel.get(label);
        if (p && v != null) out.push({ year: p.fiscalYear, value: v });
      }
      if (out.length) return out.sort((a, b) => a.year - b.year);
    }
  }
  return [];
}

export interface SlideFin {
  years: string[];
  revenue: (number | null)[];
  revenueGrowth: (number | null)[];
  netIncome: (number | null)[];
  netMargin: (number | null)[];
  eps: (number | null)[];
  per: (number | null)[];
}

export interface StockSlideData {
  market: MarketId;
  symbol: string;
  name: string;
  currency: string;
  sector: string | null;
  /** 재무 축약 단위 라벨 (한국 억원 / 미국 백만$ / 일본 천만엔) */
  unitLabel: string;
  /** 슬라이드 번호 표기 (기본 "02") */
  slideNo: string;
  /** 우측 하단 브랜드 문구 (기본 공란) */
  brand: string;
  /** 회사 로고 (data URI) — 도메인 기반 자동 조회 */
  logo: string | null;
  /** 사용자 입력 */
  overview: string;
  business: string[];
  marketShare: string[];
  price: { date: string; close: number }[];
  /** 벤치마크(나스닥) — 우측 축 비교용 */
  bench: { date: string; close: number }[];
  benchLabel: string;
  priceLabel: string;
  fin: SlideFin;
  asOf: string;
  sources: { financials: string; price: string; consensus: string | null };
}

const UNIT_DIV: Record<MarketId, number> = { kr: 1e8, us: 1e6, jp: 1e7 };
const UNIT_LABEL: Record<MarketId, string> = { kr: "억원", us: "백만$", jp: "천만엔" };

const lines = (v?: string | string[]) =>
  (Array.isArray(v) ? v : (v ?? "").split(/\r?\n/)).map((x) => x.trim()).filter(Boolean);

/** 홈페이지 도메인 → 로고 data URI (Clearbit → Google 파비콘 폴백) */
async function fetchLogo(homepage?: string | null): Promise<string | null> {
  if (!homepage) return null;
  let domain: string;
  try {
    domain = new URL(homepage.startsWith("http") ? homepage : `https://${homepage}`).hostname.replace(
      /^www\./,
      "",
    );
  } catch {
    return null;
  }
  const urls = [
    `https://logo.clearbit.com/${domain}?size=200`,
    `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
  ];
  for (const u of urls) {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const ct = res.headers.get("content-type") ?? "image/png";
      if (!ct.startsWith("image/")) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) continue;
      return `data:${ct};base64,${buf.toString("base64")}`;
    } catch {
      /* 다음 소스 */
    }
  }
  return null;
}

export async function getStockSlideData(
  market: MarketId,
  symbol: string,
  opts: {
    yahoo?: string | null;
    overview?: string;
    business?: string[] | string;
    marketShare?: string[] | string;
    priceYears?: number;
    slideNo?: string;
    brand?: string;
  } = {},
): Promise<StockSlideData> {
  const ov = await getStockOverview(market, symbol, opts.yahoo, { skipQuarterly: true });

  // 연도별 시리즈가 필요해 원본 연간 재무제표를 별도 조회
  const { getAdapter } = await import("@/lib/markets/registry");
  const adapter = getAdapter(market);
  const nsym = adapter.normalizeSymbol(symbol);
  const fs = await adapter.getFinancials(nsym, "annual").catch(() => null);

  const revSeries = seriesOf(fs, ACCT.revenue);
  const niSeries = seriesOf(fs, ACCT.netIncome);
  const epsSeries = seriesOf(fs, ACCT.eps);

  const lastRev = revSeries.at(-1) ?? null;
  const prevRev = revSeries.length >= 2 ? revSeries[revSeries.length - 2] : null;
  const lastNi = niSeries.at(-1) ?? null;
  const lastEps = epsSeries.at(-1) ?? null;
  const baseYear = lastRev?.year ?? lastNi?.year ?? new Date().getFullYear() - 1;

  const shares = ov.multiples?.inputs?.shares ?? null;
  const price = ov.quote?.last ?? null;
  // yahoo 어댑터가 period 라벨을 변환함: "당해년도(FY)" / "차년도(FY+1)" / "FY+2"
  const est = ov.consensus?.estimates ?? [];
  const est0 = est.find((e) => e.period.includes("당해") || e.period === "FY");
  const est1 = est.find((e) => e.period.includes("차년") || e.period === "FY+1");
  const est2 = est.find((e) => e.period === "FY+2" || e.period.includes("+2"));

  const div = UNIT_DIV[market];
  const scale = (v: number | null | undefined) => (v == null ? null : v / div);
  const pct = (a: number | null, b: number | null) =>
    a != null && b != null && b !== 0 ? (a - b) / Math.abs(b) : null;
  const perOf = (eps: number | null) => (price != null && eps != null && eps !== 0 ? price / eps : null);
  const niFromEps = (eps: number | null) => (eps != null && shares ? eps * shares : null);

  // 4개년: 전년(실적) · 올해(E) · 예상(E) · 예상(E)
  const revenue = [
    lastRev?.value ?? null,
    est0?.revenueAvg ?? null,
    est1?.revenueAvg ?? null,
    est2?.revenueAvg ?? null,
  ];
  const eps = [
    lastEps?.value ?? ov.multiples?.inputs?.epsDiluted ?? null,
    est0?.epsAvg ?? null,
    est1?.epsAvg ?? null,
    est2?.epsAvg ?? null,
  ];
  const netIncome = [lastNi?.value ?? null, niFromEps(eps[1]), niFromEps(eps[2]), niFromEps(eps[3])];

  const fin: SlideFin = {
    years: [
      `FY${baseYear}`,
      `FY${baseYear + 1}(E)`,
      `FY${baseYear + 2}(E)`,
      `FY${baseYear + 3}(E)`,
    ],
    revenue: revenue.map(scale),
    revenueGrowth: revenue.map((v, i) =>
      i === 0 ? pct(v, prevRev?.value ?? null) : pct(v, revenue[i - 1]),
    ),
    netIncome: netIncome.map(scale),
    netMargin: netIncome.map((v, i) => (v != null && revenue[i] ? v / (revenue[i] as number) : null)),
    eps,
    per: eps.map(perOf),
  };

  // 주가 차트 (yahoo 일봉) — 종목 + 나스닥 벤치마크. 기본 최근 3년
  const years = opts.priceYears ?? 3;
  const from = new Date();
  from.setMonth(from.getMonth() - years * 12);
  const period1 = from.toISOString().slice(0, 10);
  const ysym = opts.yahoo ?? yahooGuess(market, nsym);
  const dailySeries = async (sym: string) => {
    try {
      const res = await yfi().chart(sym, { period1, interval: "1d" });
      return (res.quotes ?? [])
        .map((q) => ({
          date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10),
          close: (q.adjclose ?? q.close) ?? NaN,
        }))
        .filter((p) => Number.isFinite(p.close));
    } catch {
      return [];
    }
  };
  const [priceRows, benchRows, logo] = await Promise.all([
    dailySeries(ysym),
    dailySeries("^IXIC"),
    fetchLogo(ov.profile?.homepage).catch(() => null),
  ]);

  return {
    market,
    symbol: nsym,
    name: ov.profile?.name ?? nsym,
    currency: ov.quote?.currency ?? ov.multiples?.currency ?? "USD",
    sector: ov.profile?.industry ?? ov.profile?.sector ?? null,
    unitLabel: UNIT_LABEL[market],
    slideNo: (opts.slideNo ?? "02").trim() || "02",
    brand: (opts.brand ?? "").trim(),
    logo,
    overview: (opts.overview ?? "").trim(),
    business: lines(opts.business),
    marketShare: lines(opts.marketShare),
    price: priceRows,
    bench: benchRows,
    benchLabel: "나스닥 (우)",
    priceLabel: `주가 추이 (최근 ${years}년)`,
    fin,
    asOf: ov.quote?.lastDate ?? new Date().toISOString().slice(0, 10),
    sources: {
      financials: fs?.source ?? "재무 API",
      price: "Yahoo Finance",
      consensus: ov.consensus?.source ?? null,
    },
  };
}

function yahooGuess(market: MarketId, sym: string): string {
  if (market === "us") return sym;
  if (market === "jp") return `${sym}.T`;
  return `${sym}.KS`;
}
