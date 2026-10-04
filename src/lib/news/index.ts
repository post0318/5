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
export async function fetchUniverseNews(
  ownerId: string,
  market: MarketId,
): Promise<NewsItem[]> {
  const all = await listUniverse({ ownerId, market, activeOnly: true });
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
      const items = await fetchCredibleStockNews(market, u.symbol, u.name ?? null, { limit: 1 }).catch(() => []);
      const latest = items[0];
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

  // 종목마다 최신 1건씩만 뽑아도, 같은 사건(계열사 공동 이슈·여러 종목이 함께
  // 언급된 시황 기사 등)이 서로 다른 종목의 "최신 기사"로 각각 집계되면
  // 사실상 같은 내용이 여러 줄로 중복 노출된다(오너 지적, 2026-09). 먼저
  // 원문 링크가 완전히 같은 경우를 무료로 정리하고, 남은 건 LLM으로 같은
  // 사건인지 판정해 묶는다.
  const seenLinks = new Set<string>();
  const linkDeduped = perStock.filter((it): it is NewsItem => {
    if (it == null) return false;
    if (seenLinks.has(it.link)) return false;
    seenLinks.add(it.link);
    return true;
  });

  return dedupeUniverseNewsByTitle(linkDeduped);
}

/**
 * 같은 사건 중복 묶기 — 규칙만(2026-10-03, 종목뉴스 LLM 금지). 한국어 제목의 글자 2-gram 유사도가 0.6 이상이고 48시간 안이면
 * 같은 사건으로 보고 앞선 항목(유니버스 순서상 먼저인 것)만 남긴다. 예전엔 Claude 가 화면을 열 때마다 전 종목 제목을 판정했다.
 */
function dedupeUniverseNewsByTitle(items: NewsItem[]): NewsItem[] {
  const norm = (t: string) => t.replace(/[s"'“”‘’.,·…[]()（）]/g, "").toLowerCase();
  const grams = items.map((it) => {
    const t = norm(it.titleKo || it.titleOrig);
    const g = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
    return g;
  });
  const sim = (a: Set<string>, b: Set<string>) => {
    if (!a.size || !b.size) return 0;
    let n = 0;
    for (const x of a) if (b.has(x)) n++;
    return n / (a.size + b.size - n);
  };
  const keep: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const dup = keep.some(
      (k) =>
        Math.abs(Date.parse(items[k].publishedAt) - Date.parse(items[i].publishedAt)) <= 48 * 3600_000 &&
        sim(grams[k], grams[i]) >= 0.6,
    );
    if (!dup) keep.push(i);
  }
  return keep.map((i) => items[i]);
}
