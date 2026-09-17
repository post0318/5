import "server-only";
import { getAdapter } from "./registry";
import { fetchStockNewsBySide, type NewsItem } from "./news";
import type { MarketId } from "./types";
import {
  ageMs,
  getCachedStockNews,
  setCachedStockNews,
  type StockNewsDoc,
} from "@/lib/db/stock-news";

/**
 * 종목뉴스 읽기 경로 — DB 캐시 우선(2026-09-17).
 *
 * 화면은 `stock_news` 컬렉션을 읽고, 크론(`/api/cron/stock-news`)이 유니버스
 * 종목을 미리 채워둔다. 유니버스 밖 종목만 이 자리에서 실시간으로 긁는다.
 *
 * 신선도 3단계 — 실시간 조회가 4.5~9.3초라(실측) 조금 묵은 값을 곧바로 주고
 * 뒤에서 갱신하는 편이 사용자 입장에서 낫다.
 *  · FRESH 안 : DB 값 그대로
 *  · FRESH~STALE_MAX : DB 값을 곧바로 주고, 갱신은 응답 뒤로 미룬다(after)
 *  · 없거나 STALE_MAX 초과 : 어쩔 수 없이 기다렸다 긁는다
 */

/** KST 09~17시는 뉴스 흐름이 빨라 더 자주 갱신 — 기존 s-maxage 정책과 같은 기준 */
export function freshMs(): number {
  const kstHour = (new Date().getUTCHours() + 9) % 24;
  return kstHour >= 9 && kstHour < 17 ? 30 * 60_000 : 60 * 60_000;
}

/** 이보다 오래되면 묵은 값을 그냥 주지 않고 기다렸다 새로 긁는다 */
const STALE_MAX_MS = 24 * 3600_000;

export interface StockNewsPayload {
  domestic: NewsItem[];
  overseas: NewsItem[];
  companyName: string | null;
  relevance: string;
  rawDomestic: number;
  rawOverseas: number;
  fetchedAt: string;
}

/** 실제로 긁어서 DB에 저장하고 결과를 돌려준다. 크론과 실시간 폴백이 함께 쓴다. */
export async function refreshStockNews(
  market: MarketId,
  symbol: string,
): Promise<StockNewsPayload> {
  const adapter = getAdapter(market);
  const sym = adapter.normalizeSymbol(symbol);

  let companyName: string | null = null;
  try {
    companyName = (await adapter.getCompanyProfile(sym))?.name ?? null;
  } catch {
    // 이름 못 가져오면 심볼로 검색 — fetchStockNewsBySide 가 폴백
  }

  const { domestic, overseas, debug } = await fetchStockNewsBySide(
    market,
    sym,
    companyName,
  );
  const payload: StockNewsPayload = {
    domestic,
    overseas,
    companyName,
    relevance: debug.relevance,
    rawDomestic: debug.rawDomestic,
    rawOverseas: debug.rawOverseas,
    fetchedAt: new Date().toISOString(),
  };
  await setCachedStockNews({ market, symbol: sym, ...payload });
  return payload;
}

function fromDoc(doc: StockNewsDoc): StockNewsPayload {
  return {
    domestic: doc.domestic,
    overseas: doc.overseas,
    companyName: doc.companyName,
    relevance: doc.relevance,
    rawDomestic: doc.rawDomestic,
    rawOverseas: doc.rawOverseas,
    fetchedAt: doc.fetchedAt,
  };
}

export interface StockNewsRead {
  payload: StockNewsPayload;
  /** DB 에서 꺼냈는지 — 진단용 */
  source: "db" | "live";
  /** 묵은 값을 주고 뒤에서 갱신해야 하는가 */
  refreshInBackground: boolean;
}

export async function readStockNews(
  market: MarketId,
  symbol: string,
): Promise<StockNewsRead> {
  const sym = getAdapter(market).normalizeSymbol(symbol);
  const doc = await getCachedStockNews(market, sym);
  const age = ageMs(doc);

  if (doc && age < freshMs()) {
    return { payload: fromDoc(doc), source: "db", refreshInBackground: false };
  }
  if (doc && age < STALE_MAX_MS) {
    // 묵었지만 쓸 만하다 — 곧바로 주고 갱신은 응답 뒤로
    return { payload: fromDoc(doc), source: "db", refreshInBackground: true };
  }

  try {
    return {
      payload: await refreshStockNews(market, sym),
      source: "live",
      refreshInBackground: false,
    };
  } catch (err) {
    // 실시간 조회가 깨졌는데 아주 묵은 값이라도 있으면 그거라도 보여준다
    if (doc) {
      return { payload: fromDoc(doc), source: "db", refreshInBackground: false };
    }
    throw err;
  }
}
