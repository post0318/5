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

/**
 * 시장별 장중 판정(오너 지시 2026-10-01 — "한국종목은 한국시간으로 장중 30분, 미국종목은 미국시간으로 장중 30분(한국시간으로는 야간), 그 외 2시간").
 * 예전엔 시장 구분 없이 KST 09~17시만 장중으로 봐서, 미국 종목은 실제 장중(한국 새벽)에 2시간 간격으로만 갱신됐다.
 * 각 시장 현지 시각·평일로 판정한다(미국은 서머타임을 Intl 이 처리). 공휴일은 따로 보지 않는다(장이 닫혀도 30분 갱신 — 손해 없음).
 *  · kr: KST 09:00~17:30(기존 오너 지정 구간 — 정규장 15:30 뒤 공시·마감 기사까지)
 *  · us: 뉴욕 09:30~16:00(정규장)
 *  · jp: 도쿄 09:00~15:30
 */
const SESSION: Record<MarketId, { tz: string; open: number; close: number }> = {
  kr: { tz: "Asia/Seoul", open: 9 * 60, close: 17 * 60 + 30 },
  us: { tz: "America/New_York", open: 9 * 60 + 30, close: 16 * 60 },
  jp: { tz: "Asia/Tokyo", open: 9 * 60, close: 15 * 60 + 30 },
};

export function inSession(market: MarketId, now = new Date()): boolean {
  const s0 = SESSION[market];
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: s0.tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const m = Number(parts.hour) * 60 + Number(parts.minute);
  return m >= s0.open && m < s0.close;
}

/**
 * 이 시간보다 최근에 받은 뉴스는 다시 긁지 않는다(오너 지시 2026-10-03 — "네이버는 10분, 구글은 30분, 장외는 1시간").
 * 국내·해외 기사를 한 번에 받는 구조라 종목의 시장으로 나눈다: 한국 종목(주 소스 네이버 태깅) 장중 10분, 미국·일본 종목 장중 30분, 장외 1시간.
 */
export function freshMs(market: MarketId, now = new Date()): number {
  if (!inSession(market, now)) return 3600_000;
  return market === "kr" ? 10 * 60_000 : 30 * 60_000;
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
  let koName: string | null = null;
  let jaName: string | null = null;
  try {
    const p = await adapter.getCompanyProfile(sym);
    // 일본 종목 profile.name 은 화면용 한글명(2026-10-09 한국어화)이다. 뉴스는 이 이름을 해외(영문) 검색어·판정 기준으로 쓰므로 그대로 넘기면
    // 해외 기사가 0건이 된다(2026-10-10 실측 7203: 한글명 0건, 영문명 47건) — 영문명(없으면 일본어 원문)을 넘기고 한글명은 국내 판정용으로 따로.
    companyName = market === "jp" ? (p?.identifiers?.["영문명"] ?? p?.nameLocal ?? p?.name ?? null) : (p?.name ?? null);
    koName = market === "jp" ? (p?.name ?? null) : null;
    // 일본어 정식명 — 해외 칸의 일본어 기사(구글 뉴스 일본판) 검색·판정용(2026-10-10)
    jaName = market === "jp" ? (p?.nameLocal ?? null) : null;
  } catch {
    // 이름 못 가져오면 심볼로 검색 — fetchStockNewsBySide 가 폴백
  }

  const { domestic, overseas, debug } = await fetchStockNewsBySide(market, sym, companyName, { koName, jaName });
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

  if (doc && age < freshMs(market)) {
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
