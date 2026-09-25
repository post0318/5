import "server-only";
import { fetchFxToUsdDaily, fetchYahooFundamentals, type YahooFundamentalsRow } from "../../../markets/quote/yahoo";
import { loadUsCurrentShares } from "../../../markets/us/current-shares";

/**
 * 0층 — SEC 밖의 원천(Yahoo 분기·환율, 인포맥스 현재 주식수). 기존 모듈을 그대로 부른다(외부 호출 경로를 0층 한 곳으로
 * 모으기 위한 얇은 창구). 실패는 예외로 올린다 — 1층이 Gap 비트로 남긴다.
 */

export type { YahooFundamentalsRow };

export async function yahooQuarters(symbol: string): Promise<{ quarterly: YahooFundamentalsRow[]; annual: YahooFundamentalsRow[] }> {
  return fetchYahooFundamentals(symbol);
}

const fxMem = new Map<string, { at: number; data: { date: string; rate: number }[] }>();
/** 통화 → USD 일별 환율(Yahoo). 12시간 메모리 캐시 */
export async function fxDaily(cur: string): Promise<{ date: string; rate: number }[]> {
  const hit = fxMem.get(cur);
  if (hit && Date.now() - hit.at < 1000 * 60 * 60 * 12) return hit.data;
  const data = await fetchFxToUsdDaily(cur);
  fxMem.set(cur, { at: Date.now(), data });
  return data;
}

/** 현재 ADR 기준 주식수(인포맥스 → Yahoo). 없으면 null */
export async function currentQuoteShares(symbol: string): Promise<number | null> {
  return (await loadUsCurrentShares(symbol))?.val ?? null;
}
