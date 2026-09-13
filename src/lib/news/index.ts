import "server-only";
import type { MarketId } from "@/lib/markets/types";
import { listUniverse } from "@/lib/universe/repo";
import { fetchStockNews as fetchCredibleStockNews } from "@/lib/markets/news";

export interface NewsItem {
  titleKo: string;
  titleOrig: string;
  /** 원문이 이미 한국어면 true (번역 안 함, 배지 불필요) */
  isKorean: boolean;
  /** 왕복검증 통과 여부 (영문만 검증. 실패해도 원문 그대로 노출이라 안전) */
  translationOk: boolean;
  link: string;
  source: string;
  publishedAt: string;
  /** 종목 뉴스일 때만: 어느 종목 기사인지 */
  symbol?: string;
  name?: string;
}

/** 이 그룹명을 가진 종목들을 목록 맨 앞으로 (표시 순서 고정 요청). */
const PINNED_GROUP = "더블S";

/** 유니버스통합뉴스는 최신 정보만 — 30일 넘은 기사는 정보가치 없다고 보고 제외. */
const UNIVERSE_NEWS_MAX_AGE_MS = 30 * 24 * 3600_000;

/**
 * 유니버스 전체 종목 뉴스 — 공신력 있는 언론사(한국: NAVER 뉴스검색, 미국·일본:
 * Yahoo Finance, src/lib/markets/news.ts) 기반. 종목마다 최신 1건씩, 전 종목을
 * 빠짐없이 담는다(개수 제한 없음 — 화면 2분할 레이아웃이 종목수 기준으로
 * 나눠 표시). 순서는 유니버스 그룹 단위 유지 + PINNED_GROUP 을 맨 앞으로.
 * 동시성·시간예산을 제한해(POOL·DEADLINE) 종목이 많아도 오래 걸리지 않게 한다.
 */
export async function fetchUniverseNews(market: MarketId): Promise<NewsItem[]> {
  const all = await listUniverse({ market, activeOnly: true });
  const pinned = all.filter((u) => u.groupName === PINNED_GROUP);
  const rest = all.filter((u) => u.groupName !== PINNED_GROUP);
  const universe = [...pinned, ...rest];
  if (universe.length === 0) return [];

  const perStock: (NewsItem | null)[] = new Array(universe.length).fill(null);
  const POOL = 6;
  const DEADLINE_MS = 20000;
  const deadline = Date.now() + DEADLINE_MS;
  let next = 0;

  async function worker() {
    while (next < universe.length && Date.now() < deadline) {
      const i = next++;
      const u = universe[i];
      const items = await fetchCredibleStockNews(market, u.symbol, u.name ?? null).catch(() => []);
      const latest = [...items].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0];
      if (!latest) continue;
      if (Date.now() - new Date(latest.publishedAt).getTime() > UNIVERSE_NEWS_MAX_AGE_MS) continue;
      perStock[i] = {
        titleKo: latest.titleKo,
        titleOrig: latest.title,
        isKorean: market === "kr",
        translationOk: true,
        link: latest.naverUrl ?? latest.url,
        source: latest.publisher,
        publishedAt: latest.publishedAt,
        symbol: latest.symbol,
        name: u.name ?? undefined,
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(POOL, universe.length) }, worker));

  return perStock.filter((it): it is NewsItem => it != null);
}
