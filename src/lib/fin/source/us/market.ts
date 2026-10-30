import "server-only";
import { fetchYahooFundamentals, type YahooFundamentalsRow } from "../../../markets/quote/yahoo";
import { fetchH10, type H10Series } from "../../../markets/quote/fred-fx";
// H.10 창 규칙(순수 함수 — 기간 평균·기말·미고시 사유). 1층 read/fx.ts 가 이 창구로만 받는다
export { h10Avg, h10At, h10Pending } from "../../../markets/quote/fred-fx";
import { loadUsCurrentShares } from "../../../markets/us/current-shares";
import { trimIncompleteYahooQuarters } from "../../../markets/us/edgar-yahoo-quarters";

/**
 * 0층 — SEC 밖의 원천(Yahoo 분기, 연준 H.10 환율, 인포맥스 현재 주식수). 기존 모듈을 그대로 부른다(외부 호출 경로를 0층 한 곳으로
 * 모으기 위한 얇은 창구). 실패는 예외로 올린다 — 1층이 Gap 비트로 남긴다.
 */

export type { YahooFundamentalsRow };

export async function yahooQuarters(symbol: string): Promise<{ quarterly: YahooFundamentalsRow[]; annual: YahooFundamentalsRow[] }> {
  // 항목이 덜 실린 뒤쪽 분기는 자른다 — 화면(edgar)과 같은 최근 12개월 끝(오너 결정 2026-10-31 나안)
  return trimIncompleteYahooQuarters(await fetchYahooFundamentals(symbol));
}

/** 통화 → USD 일별 환율(연준 H.10 — markets/quote/fred-fx.ts, 12시간 캐시). 실패는 예외(Yahoo 로 대체하지 않는다) */
export async function fxDaily(cur: string): Promise<H10Series> {
  return fetchH10(cur);
}

/** 현재 ADR 기준 주식수(인포맥스 → Yahoo). 없으면 null */
export async function currentQuoteShares(symbol: string): Promise<number | null> {
  return (await loadUsCurrentShares(symbol))?.val ?? null;
}
