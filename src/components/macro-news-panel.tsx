"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/query";
import type { NewsItem } from "@/lib/news";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { NewsList } from "@/components/news-list";

const MAX_ITEMS = 7;

function MacroNewsColumn({ title, market }: { title: string; market: "kr" | "us" }) {
  const q = useQuery({
    queryKey: ["news-market", market],
    queryFn: () => apiFetch<{ items: NewsItem[] }>(`/api/news/market?market=${market}`),
    staleTime: 10 * 60_000,
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {q.isLoading && <Skeleton className="h-48 w-full" />}
        {q.isError && <p className="text-destructive text-sm">뉴스를 불러오지 못했습니다.</p>}
        {q.data && (
          <NewsList items={q.data.items.slice(0, MAX_ITEMS)} emptyText="관련 뉴스가 없습니다." />
        )}
      </CardContent>
    </Card>
  );
}

/** 거시경제 관련 뉴스 — 국내/해외 2열, 각 최대 7건(Google 뉴스 RSS 기반, 헤드라인 번역). */
export function MacroNewsPanel() {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">시장 뉴스</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        <MacroNewsColumn title="국내" market="kr" />
        <MacroNewsColumn title="해외" market="us" />
      </div>
    </section>
  );
}
