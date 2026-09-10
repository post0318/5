"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/query";
import type { MarketId } from "@/lib/markets/types";
import type { NewsItem } from "@/lib/news";
import { Skeleton } from "@/components/ui/skeleton";
import { NewsList } from "@/components/news-list";

/** 종목분석 "주요 코멘트" 탭 — 해당 종목 관련 뉴스(제목 한글 번역). */
export function StockComments({
  market,
  symbol,
  name,
}: {
  market: MarketId;
  symbol: string;
  name?: string | null;
}) {
  const q = useQuery({
    queryKey: ["news-stock", market, symbol],
    queryFn: () =>
      apiFetch<{ items: NewsItem[] }>(
        `/api/news/stock?market=${market}&symbol=${encodeURIComponent(symbol)}` +
          (name ? `&name=${encodeURIComponent(name)}` : ""),
      ),
    enabled: Boolean(symbol),
    staleTime: 10 * 60_000,
  });

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground/80 text-[11px]">
        Google 뉴스 공개 피드에서 이 종목 관련 최신 기사를 모았습니다. 제목은
        한국어로 자동 번역(무료 번역 API) — 요약이 아닌 헤드라인이며, 상세·특정
        이슈 판단은 원문 링크에서 확인하세요.
      </p>
      {q.isLoading && <Skeleton className="h-48 w-full" />}
      {q.isError && (
        <p className="text-destructive text-sm">{(q.error as Error).message}</p>
      )}
      {q.data && (
        <NewsList items={q.data.items} emptyText="최근 관련 뉴스가 없습니다." />
      )}
    </div>
  );
}
