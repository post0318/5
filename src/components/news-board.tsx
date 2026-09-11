"use client";

import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { apiFetch } from "@/lib/query";
import type { MarketId } from "@/lib/markets/types";
import type { NewsItem } from "@/lib/news";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { NewsList } from "@/components/news-list";

function NewsSection({
  title,
  hint,
  queryKey,
  url,
  showStock,
  split,
}: {
  title?: string;
  hint?: string;
  queryKey: unknown[];
  url: string;
  showStock?: boolean;
  split?: boolean;
}) {
  const q = useQuery({
    queryKey,
    queryFn: () => apiFetch<{ items: NewsItem[] }>(url),
    staleTime: 10 * 60_000,
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div>
          {title && <CardTitle className="text-sm">{title}</CardTitle>}
          {hint && <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p>}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => q.refetch()}
          disabled={q.isFetching}
        >
          <RefreshCw className={q.isFetching ? "size-3.5 animate-spin" : "size-3.5"} />
        </Button>
      </CardHeader>
      <CardContent>
        {q.isLoading && <Skeleton className="h-64 w-full" />}
        {q.isError && (
          <p className="text-destructive text-sm">{(q.error as Error).message}</p>
        )}
        {q.data && <NewsList items={q.data.items} showStock={showStock} split={split} />}
      </CardContent>
    </Card>
  );
}

export function NewsBoard({ market }: { market: MarketId }) {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">유니버스통합 뉴스</h1>
      </div>
      <NewsSection
        hint="유니버스 등록 종목 관련 뉴스. 정확한 내용은 원문 링크에서 확인하세요."
        queryKey={["news-universe", market]}
        url={`/api/news/universe?market=${market}`}
        showStock
        split
      />
      <p className="text-muted-foreground text-xs">
        출처: 공신력 있는 언론사만(한국: NAVER 뉴스검색, 미국·일본: Yahoo Finance), 헤드라인은
        한국어 자동 번역.
      </p>
    </div>
  );
}
