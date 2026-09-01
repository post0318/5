import type { MarketId } from "../types";

/** Stooq 심볼: 미국 aapl.us / 일본 7203.jp / 한국 005930.kr */
export function stooqSymbol(market: MarketId, symbol: string): string {
  switch (market) {
    case "us":
      return `${symbol.toLowerCase()}.us`;
    case "jp":
      return `${symbol.replace(/\.T$/i, "").toLowerCase()}.jp`;
    case "kr":
      return `${symbol.replace(/[^0-9]/g, "").padStart(6, "0").slice(-6)}.kr`;
  }
}

/**
 * Yahoo Finance 심볼: 미국 AAPL / 일본 7203.T / 한국 005930.KS (KOSPI 기본).
 * KOSDAQ 종목은 `.KQ` 를 명시적으로 넘겨야 한다 (universe 레코드의 yahooSymbol 우선).
 */
export function yahooSymbol(market: MarketId, symbol: string, override?: string | null): string {
  if (override) return override;
  switch (market) {
    case "us":
      return symbol.toUpperCase();
    case "jp":
      return `${symbol.replace(/\.T$/i, "")}.T`;
    case "kr":
      return `${symbol.replace(/[^0-9]/g, "").padStart(6, "0").slice(-6)}.KS`;
  }
}
