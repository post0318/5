/**
 * L2 EOD 시세 오케스트레이터 (prd.md §4.1)
 * 한국: KRX(키 있으면) → Stooq → Yahoo
 * 미국·일본: Stooq → Yahoo(개인용)
 */

import { MARKET_CURRENCY, type EodQuote, type MarketId, type QuoteBar } from "../types";
import { fetchStooqEod } from "./stooq";
import { fetchYahooEod } from "./yahoo";
import { fetchKrxEod, hasKrxKey } from "./krx";

interface BuildExtra {
  sharesOutstanding?: number | null;
  marketCap?: number | null;
}

function buildQuote(
  market: MarketId,
  symbol: string,
  bars: QuoteBar[],
  source: string,
  extra: BuildExtra = {},
): EodQuote {
  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));
  const last = sorted.at(-1) ?? null;
  const prev = sorted.at(-2) ?? null;
  const change =
    last?.close != null && prev?.close != null ? last.close - prev.close : null;
  const changePct =
    change != null && prev?.close ? (change / prev.close) * 100 : null;
  return {
    symbol,
    market,
    currency: MARKET_CURRENCY[market],
    last: last?.close ?? null,
    lastDate: last?.date ?? null,
    change,
    changePct,
    bars: sorted,
    source,
    sharesOutstanding: extra.sharesOutstanding ?? null,
    marketCap: extra.marketCap ?? null,
  };
}

export async function getEodQuote(
  market: MarketId,
  symbol: string,
  opts: { from?: string; to?: string; yahooOverride?: string | null } = {},
): Promise<EodQuote> {
  if (market === "kr" && hasKrxKey()) {
    try {
      const krx = await fetchKrxEod(symbol);
      if (krx.bars.length > 0) {
        return buildQuote(market, symbol, krx.bars, "KRX 정보데이터시스템", {
          sharesOutstanding: krx.listedShares,
          marketCap: krx.marketCap,
        });
      }
    } catch {
      // KRX 실패 → 폴백
    }
  }

  try {
    const bars = await fetchStooqEod(market, symbol, opts);
    if (bars.length > 0) return buildQuote(market, symbol, bars, "Stooq");
  } catch {
    // Stooq 실패 → Yahoo 폴백
  }

  const bars = await fetchYahooEod(market, symbol, opts);
  return buildQuote(market, symbol, bars, "Yahoo Finance · 개인용");
}
