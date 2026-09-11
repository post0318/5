import "server-only";
import YahooFinancePkg from "yahoo-finance2";
import type { MarketId } from "./types";

/**
 * 종목뉴스(선택 번역·요약용) — 미국·일본만. 한국은 기존 "관련 뉴스" 딥링크
 * 유지(네이버 뉴스 검색이 2026-06 유료 종량제 NAVER API HUB 로 이관되며
 * 무료로 깔끔하게 쓸 소스가 없어짐 — 카카오 Daum 검색 API는 뉴스 검색 자체가
 * 없음). yahoo-finance2 는 이미 이 프로젝트가 쓰는 무료 소스라 신규 계정·
 * 비용 이슈 없음(prd.md §4.3).
 */

const YF = (YahooFinancePkg as { default?: unknown }).default ?? YahooFinancePkg;
type YFInstance = {
  search: (
    q: string,
    o: Record<string, unknown>,
  ) => Promise<{ news?: RawNews[] }>;
};
interface RawNews {
  uuid: string;
  title: string;
  publisher: string;
  link: string;
  providerPublishTime: Date | number;
}

let instance: YFInstance | null = null;
function yf(): YFInstance {
  if (!instance) {
    const Ctor = YF as new (o: Record<string, unknown>) => YFInstance;
    instance = new Ctor({ suppressNotices: ["yahooSurvey"], validation: { logErrors: false } });
  }
  return instance;
}

export interface NewsItem {
  id: string; // uuid
  title: string;
  publisher: string;
  url: string;
  publishedAt: string; // ISO
  market: MarketId;
  symbol: string;
}

/** 공신력 있는 언론사만 — yahoo `publisher` 필드 정확 매칭(대소문자 무시). */
const ALLOWED_PUBLISHERS = new Set(
  [
    "Reuters",
    "Bloomberg",
    "Associated Press",
    "AP News",
    "The Wall Street Journal",
    "Financial Times",
    "CNBC",
    "Barron's",
    "Barrons.com", // yahoo-finance2 실제 publisher 필드는 이 표기
    "MarketWatch",
    "Yahoo Finance",
    "Dow Jones Newswires",
    "Investor's Business Daily", // 실측: yahoo 검색 결과 빈도 높음
    "Nikkei Asia",
    "The Japan Times",
    "Kyodo News",
  ].map((p) => p.toLowerCase()),
);

const THREE_MONTHS_MS = 90 * 24 * 3600_000;

export async function fetchStockNews(
  market: MarketId,
  symbol: string,
  companyName?: string | null,
): Promise<NewsItem[]> {
  if (market === "kr") return []; // 한국은 기존 딥링크만 — 이 함수 자체를 호출하지 않는 게 정상 경로
  const query = companyName || symbol;
  let res: { news?: RawNews[] };
  try {
    res = await yf().search(query, { newsCount: 20, quotesCount: 0 });
  } catch {
    return [];
  }
  const cutoff = Date.now() - THREE_MONTHS_MS;
  const items: NewsItem[] = [];
  for (const n of res.news ?? []) {
    if (!n.title || !n.link || !n.publisher) continue;
    if (!ALLOWED_PUBLISHERS.has(n.publisher.toLowerCase())) continue;
    const t = new Date(n.providerPublishTime).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    items.push({
      id: n.uuid,
      title: n.title,
      publisher: n.publisher,
      url: n.link,
      publishedAt: new Date(t).toISOString(),
      market,
      symbol,
    });
  }
  return items;
}

/** 서버가 기사 1건을 재검증(클라이언트값 신뢰 안 함) — summarize 라우트에서 사용. */
export function isAllowedArticle(publisher: string, publishedAt: string): boolean {
  if (!ALLOWED_PUBLISHERS.has(publisher.toLowerCase())) return false;
  const t = Date.parse(publishedAt);
  if (!Number.isFinite(t)) return false;
  return t >= Date.now() - THREE_MONTHS_MS;
}
