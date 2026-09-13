import "server-only";
import YahooFinancePkg from "yahoo-finance2";

/**
 * yahoo-finance2 클라이언트 싱글톤 — indices.ts/index-chart.ts/kr/batch.ts 가
 * 각자 동일한 부트스트랩(default export 언래핑 + suppressNotices 옵션)을
 * 복붙하고 있었음(kr/batch.ts 는 호출마다 새 인스턴스까지 생성). 한 곳으로
 * 모아 인스턴스 하나만 재사용 (2026-09 정리).
 */

interface RawQuote {
  symbol: string;
  regularMarketPrice?: number;
  regularMarketChange?: number;
  regularMarketChangePercent?: number;
  regularMarketTime?: Date | string | number;
}
interface RawBar {
  date: Date | string;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  adjclose?: number | null;
}

export interface YahooFinanceClient {
  quote: (symbols: string[]) => Promise<RawQuote[]>;
  chart: (symbol: string, opts: Record<string, unknown>) => Promise<{ quotes: RawBar[] }>;
}

let client: YahooFinanceClient | null = null;

export function getYahooFinance(): YahooFinanceClient {
  if (!client) {
    const Ctor = ((YahooFinancePkg as { default?: unknown }).default ?? YahooFinancePkg) as new (
      o: Record<string, unknown>,
    ) => YahooFinanceClient;
    client = new Ctor({ suppressNotices: ["yahooSurvey"], validation: { logErrors: false } });
  }
  return client;
}
