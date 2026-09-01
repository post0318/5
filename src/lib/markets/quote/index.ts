/**
 * L2 EOD 시세 오케스트레이터 (prd.md §4.1)
 * Stooq(주) → 실패 시 Yahoo(개인용 폴백).
 */

import { MARKET_CURRENCY, type EodQuote, type MarketId, type QuoteBar } from "../types";
import { fetchStooqEod } from "./stooq";
import { fetchYahooEod } from "./yahoo";

function buildQuote(
  market: MarketId,
  symbol: string,
  bars: QuoteBar[],
  source: string,
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
  };
}

export async function getEodQuote(
  market: MarketId,
  symbol: string,
  opts: { from?: string; to?: string; yahooOverride?: string | null } = {},
): Promise<EodQuote> {
  try {
    const bars = await fetchStooqEod(market, symbol, opts);
    if (bars.length > 0) return buildQuote(market, symbol, bars, "Stooq");
  } catch {
    // Stooq 실패 → Yahoo 폴백
  }
  const bars = await fetchYahooEod(market, symbol, opts);
  return buildQuote(market, symbol, bars, "Yahoo Finance · 개인용");
}
