import "server-only";
import type { MarketId } from "@/lib/markets/types";
import { listUniverse } from "@/lib/universe/repo";
import { fetchStockNews as fetchCredibleStockNews } from "@/lib/markets/news";
import { findUniverseNewsDuplicates } from "@/lib/llm/claude";
import { isBudgetExceeded, incUsage } from "@/lib/db/llm-usage";

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

  return dedupeUniverseNewsWithLlm(linkDeduped);
}

/** LLM로 같은 사건 중복을 묶어 대표 1건만 남긴다. 키 미설정·예산초과·호출
 * 실패 시 조용히 원본 그대로 반환(뉴스 기능 자체가 죽지 않게 — 다른 LLM
 * 폴백들과 동일 원칙). */
async function dedupeUniverseNewsWithLlm(items: NewsItem[]): Promise<NewsItem[]> {
  if (items.length < 2 || !process.env.ANTHROPIC_API_KEY) return items;
  try {
    if (await isBudgetExceeded()) return items;
    const candidates = items.map((it, i) => ({
      id: String(i),
      title: it.titleKo,
      stockName: it.name,
    }));
    const { duplicateGroups, costUsd } = await findUniverseNewsDuplicates(candidates);
    await incUsage(costUsd);
    if (duplicateGroups.length === 0) return items;
    const drop = new Set<number>();
    for (const group of duplicateGroups) {
      const indices = group.map(Number).sort((a, b) => a - b);
      for (const idx of indices.slice(1)) drop.add(idx); // 그룹 내 첫 항목(유니버스 순서상 앞선 것)만 남김
    }
    return items.filter((_, i) => !drop.has(i));
  } catch (err) {
    console.error("[news] 유니버스통합뉴스 LLM 중복 판정 실패, 원본 그대로 표시:", err);
    return items;
  }
}
