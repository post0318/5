import "server-only";
import type { MarketId } from "@/lib/markets/types";
import { listUniverse } from "@/lib/universe/repo";
import { fetchGoogleNewsRss, googleNewsUrl, NOISE, type RawNewsItem } from "./googleNews";
import { translateTitles } from "./translate";

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

interface MarketLocale {
  locale: string; // hl=..&gl=..&ceid=..
  sl: "ko" | "en" | "ja";
  macroQuery: string;
}

const LOCALE: Record<MarketId, MarketLocale> = {
  kr: {
    locale: "hl=ko&gl=KR&ceid=KR:ko",
    sl: "ko",
    macroQuery:
      '(코스피 OR 금리 OR 한국은행 OR 원달러 환율 OR 물가 OR 수출 OR 반도체 업황 OR 증시)',
  },
  us: {
    locale: "hl=en-US&gl=US&ceid=US:en",
    sl: "en",
    macroQuery:
      '(Fed OR "interest rate" OR inflation OR "stock market" OR "S&P 500" OR Nasdaq OR "Wall Street" OR earnings season) markets',
  },
  jp: {
    locale: "hl=ja&gl=JP&ceid=JP:ja",
    sl: "ja",
    macroQuery: "(日銀 OR 金利 OR 為替 OR 物価 OR 日経平均 OR 株式市場)",
  },
};

function stockQuery(market: MarketId, name: string | null, symbol: string): string {
  const key = name ? `"${name}"` : symbol;
  if (market === "kr") return `${key} (주가 OR 실적 OR 공시)`;
  if (market === "jp") return `${key} (株価 OR 決算)`;
  return `${key} (stock OR earnings OR shares)`;
}

async function toNewsItems(
  raw: RawNewsItem[],
  sl: "ko" | "en" | "ja",
  extra?: { symbol?: string; name?: string },
): Promise<NewsItem[]> {
  const filtered = raw.filter((r) => !NOISE.test(r.title));
  const translated = await translateTitles(filtered, sl, (r) => r.title);
  return filtered.map((r, i) => ({
    titleKo: translated[i].titleKo,
    titleOrig: r.title,
    isKorean: sl === "ko",
    translationOk: translated[i].translationOk,
    link: r.link,
    source: r.source,
    publishedAt: r.publishedAt,
    ...extra,
  }));
}

function dedupe(items: NewsItem[]): NewsItem[] {
  const seenLink = new Set<string>();
  const seenTitle = new Set<string>();
  const out: NewsItem[] = [];
  for (const it of items) {
    const tkey = it.titleOrig.toLowerCase().slice(0, 40);
    if (seenLink.has(it.link) || seenTitle.has(tkey)) continue;
    seenLink.add(it.link);
    seenTitle.add(tkey);
    out.push(it);
  }
  return out;
}

/** 시장(매크로) 뉴스. Google 뉴스 RSS(공개 피드) — 본문 없이 제목·출처·링크만. */
export async function fetchMacroNews(market: MarketId, limit = 20): Promise<NewsItem[]> {
  const cfg = LOCALE[market];
  const raw = await fetchGoogleNewsRss(
    googleNewsUrl(`search?q=${encodeURIComponent(cfg.macroQuery)}`, cfg.locale),
  );
  const items = dedupe(await toNewsItems(raw, cfg.sl));
  return items
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, limit);
}

/** 특정 한 종목의 뉴스 (종목분석 "주요 코멘트" 탭용). */
export async function fetchStockNews(
  market: MarketId,
  symbol: string,
  name: string | null,
  limit = 10,
): Promise<NewsItem[]> {
  const cfg = LOCALE[market];
  const raw = await fetchGoogleNewsRss(
    googleNewsUrl(`search?q=${encodeURIComponent(stockQuery(market, name, symbol))}`, cfg.locale),
  );
  const items = dedupe(await toNewsItems(raw, cfg.sl, { symbol, name: name ?? undefined }));
  return items
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, limit);
}

/**
 * 유니버스 전체 종목 뉴스 — 종목별로 라운드로빈해 한쪽 종목이 몰리지 않게 섞는다.
 * 동시성·시간예산을 제한해(POOL·DEADLINE) 종목이 많아도 라우트가 오래 걸리지 않게 한다.
 */
export async function fetchUniverseNews(market: MarketId, limit = 20): Promise<NewsItem[]> {
  const universe = (await listUniverse({ market, activeOnly: true })).slice(0, 30);
  if (universe.length === 0) return [];

  const cfg = LOCALE[market];
  const perStock: NewsItem[][] = new Array(universe.length).fill(null).map(() => []);
  const POOL = 6;
  const DEADLINE_MS = 15000;
  const deadline = Date.now() + DEADLINE_MS;
  let next = 0;

  async function worker() {
    while (next < universe.length && Date.now() < deadline) {
      const i = next++;
      const u = universe[i];
      const raw = await fetchGoogleNewsRss(
        googleNewsUrl(
          `search?q=${encodeURIComponent(stockQuery(market, u.name ?? null, u.symbol))}`,
          cfg.locale,
        ),
      );
      perStock[i] = dedupe(
        await toNewsItems(raw.slice(0, 6), cfg.sl, { symbol: u.symbol, name: u.name ?? undefined }),
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(POOL, universe.length) }, worker));

  // 라운드로빈으로 종목 간 균형 있게 뽑는다
  const queues = perStock.map((list) => [...list].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)));
  const seenLink = new Set<string>();
  const picked: NewsItem[] = [];
  let progressed = true;
  while (picked.length < limit && progressed) {
    progressed = false;
    for (const q of queues) {
      if (picked.length >= limit) break;
      const item = q.shift();
      if (!item) continue;
      progressed = true;
      if (seenLink.has(item.link)) continue;
      seenLink.add(item.link);
      picked.push(item);
    }
  }
  return picked;
}
