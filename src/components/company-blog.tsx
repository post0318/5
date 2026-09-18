"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CompanyBlogItem } from "@/lib/news/companyBlog";

function fmtAgo(iso: string): string {
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "오늘";
  return `${days}일 전`;
}

/**
 * 기업 공식 블로그/뉴스룸 발표(오너 지시 2026-09-18 — "엔비디아처럼
 * 블로그등을 통해 공개하는 빅테크사"). 피드가 있는 티커(companyBlog.ts
 * 참고, 2026-09 기준 NVDA/AAPL/GOOGL/META)만 카드가 보이고, 없으면 아예
 * 렌더링 안 함(다른 종목 페이지에 빈 카드로 노출되지 않게).
 */
export function CompanyBlog({ symbol }: { symbol: string }) {
  const q = useQuery({
    queryKey: ["company-blog", symbol],
    queryFn: () => apiFetch<{ items: CompanyBlogItem[] }>(`/api/markets/us/${encodeURIComponent(symbol)}/company-blog`),
    staleTime: 15 * 60_000,
  });

  const items = q.data?.items ?? [];
  if (!q.isLoading && items.length === 0) return null;

  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-baseline gap-x-2 text-sm">
          기업 발표
          {q.data && <span className="text-muted-foreground text-xs font-normal">({items.length})</span>}
          <span className="text-muted-foreground ml-auto text-[11px] font-normal">기업 공식 블로그·뉴스룸</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {q.isLoading && <div className="text-muted-foreground text-sm">불러오는 중…</div>}
        <ul className="divide-y">
          {items.map((it) => (
            <li key={it.url} className="py-2.5 first:pt-0 last:pb-0">
              <a href={it.url} target="_blank" rel="noreferrer" className="group block">
                <div className="group-hover:text-primary text-sm leading-snug font-medium">{it.title}</div>
                {it.excerpt && (
                  <p className="text-muted-foreground mt-1 line-clamp-1 text-xs leading-snug">{it.excerpt}</p>
                )}
                <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 text-xs">
                  <span className="bg-muted rounded px-1.5 py-0.5 font-medium">{it.source}</span>
                  <span className="tnum">{fmtAgo(it.publishedAt)}</span>
                </div>
              </a>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
