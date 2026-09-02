import "server-only";
import YahooFinancePkg from "yahoo-finance2";
import { getAdapter } from "./registry";
import type { MarketId } from "./types";

const YF = (YahooFinancePkg as { default?: unknown }).default ?? YahooFinancePkg;

type YFInstance = {
  search: (q: string, o: Record<string, unknown>) => Promise<{ quotes?: RawQuote[] }>;
};
interface RawQuote {
  symbol?: string;
  shortname?: string;
  longname?: string;
  quoteType?: string;
  exchange?: string;
  exchDisp?: string;
}

let instance: YFInstance | null = null;
function yf(): YFInstance {
  if (!instance) {
    const Ctor = YF as new (o: Record<string, unknown>) => YFInstance;
    instance = new Ctor({ suppressNotices: ["yahooSurvey"], validation: { logErrors: false } });
  }
  return instance;
}

export interface SearchHit {
  /** 시장 내부 정규화 심볼 */
  symbol: string;
  name: string;
  exchange?: string;
  /** Yahoo 심볼 (KR .KS/.KQ, JP .T 등) — 시세/컨센서스 조회용 */
  yahooSymbol?: string;
}

/** 시장별 Yahoo 심볼 접미사 판정 */
function matchesMarket(market: MarketId, symbol: string): boolean {
  switch (market) {
    case "kr":
      return /\.(KS|KQ)$/i.test(symbol);
    case "jp":
      return /\.T$/i.test(symbol);
    case "us":
      return !symbol.includes("."); // 미국 상장은 접미사 없음
  }
}

async function yahooSearch(market: MarketId, query: string): Promise<SearchHit[]> {
  let res: Awaited<ReturnType<YFInstance["search"]>>;
  try {
    res = await yf().search(query, { newsCount: 0, quotesCount: 10, enableFuzzyQuery: true });
  } catch {
    return []; // 한글 쿼리 등에서 BadRequest 가능 → 조용히 빈 결과
  }
  const adapter = getAdapter(market);
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const q of res.quotes ?? []) {
    if (!q.symbol || q.quoteType !== "EQUITY") continue;
    if (!matchesMarket(market, q.symbol)) continue;
    const internal = adapter.normalizeSymbol(q.symbol);
    if (seen.has(internal)) continue;
    seen.add(internal);
    hits.push({
      symbol: internal,
      name: q.shortname ?? q.longname ?? internal,
      exchange: q.exchDisp ?? q.exchange,
      yahooSymbol: market === "us" ? undefined : q.symbol.toUpperCase(),
    });
  }
  return hits;
}

/** 미국: SEC EDGAR 티커 맵에서 이름/티커로 검색 */
async function edgarSearch(query: string): Promise<SearchHit[]> {
  const { searchEdgarTickers } = await import("./us/edgar");
  return (await searchEdgarTickers(query)).map((r) => ({
    symbol: r.ticker,
    name: r.title,
    exchange: "US",
  }));
}

/** 일본: EDINET 코드 목록에서 일문/영문/코드로 검색 (키 불필요) */
async function edinetSearch(query: string): Promise<SearchHit[]> {
  try {
    const { searchEdinet } = await import("./jp/edinetcode");
    return (await searchEdinet(query)).map((e) => ({
      symbol: e.ticker,
      name: e.name,
      exchange: "JPX",
      yahooSymbol: `${e.ticker}.T`,
    }));
  } catch {
    return [];
  }
}

/** 한국: OpenDART corpCode 목록에서 한글/영문/코드로 검색 */
async function dartSearch(query: string): Promise<SearchHit[]> {
  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) return [];
  try {
    const { searchCorps } = await import("./kr/corpcode");
    return (await searchCorps(apiKey, query)).map((e) => ({
      symbol: e.stockCode,
      name: e.corpName,
      exchange: "KRX",
    }));
  } catch {
    return [];
  }
}

export async function searchSymbols(market: MarketId, rawQuery: string): Promise<SearchHit[]> {
  const query = rawQuery.trim();
  if (query.length < 1) return [];

  const results: SearchHit[] = [];
  if (market === "us") {
    results.push(...(await edgarSearch(query)));
  } else if (market === "kr") {
    results.push(...(await dartSearch(query)));
  } else if (market === "jp") {
    results.push(...(await edinetSearch(query)));
  }
  const yahoo = await yahooSearch(market, query);

  const seen = new Set(results.map((r) => r.symbol));
  for (const h of yahoo) {
    if (seen.has(h.symbol)) {
      // EDGAR 결과에 Yahoo 심볼 보강
      const existing = results.find((r) => r.symbol === h.symbol);
      if (existing && !existing.yahooSymbol) existing.yahooSymbol = h.yahooSymbol;
      continue;
    }
    seen.add(h.symbol);
    results.push(h);
  }
  return results.slice(0, 10);
}
