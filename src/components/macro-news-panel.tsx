"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/query";
import { cn } from "@/lib/utils";
import type { NewsItem } from "@/lib/markets/news";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface NewsResponse {
  items: NewsItem[];
}

const PAGE_SIZE = 5;
const MAX_PAGES = 6; // 종목뉴스 탭과 동일 — 최대 30건까지 노출

/** 요약 없는 항목(해외뉴스)의 자리 채움 — stock-news.tsx 와 동일한 이유로
 * line-clamp-2 가 계산하는 실제 두 줄 높이에 정확히 맞춘다. */
const blankTwoLines = (
  <>
    {" "}
    <br />
    {" "}
  </>
);

function fmtAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "방금";
  if (mins < 60) return `${mins}분 전`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}시간 전`;
  return `${Math.round(hrs / 24)}일 전`;
}

function Pager({
  page,
  pageCount,
  onChange,
}: {
  page: number;
  pageCount: number;
  onChange: (p: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="mt-2 flex justify-center gap-1">
      {Array.from({ length: pageCount }, (_, i) => i + 1).map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          className={cn(
            "tnum size-6 rounded text-xs",
            p === page
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted",
          )}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

function NewsColumn({
  title,
  items,
  emptyText,
}: {
  title: string;
  items: NewsItem[];
  emptyText: string;
}) {
  const [page, setPage] = useState(1);
  const pageCount = Math.min(MAX_PAGES, Math.ceil(items.length / PAGE_SIZE)) || 1;
  const paged = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="min-w-0">
      <h4 className="mb-2 text-xs font-semibold">
        {title} <span className="text-muted-foreground font-normal">({items.length})</span>
      </h4>
      {items.length === 0 ? (
        <p className="text-muted-foreground py-4 text-sm">{emptyText}</p>
      ) : (
        <>
          <ul className="divide-y">
            {paged.map((it) => (
              <li key={it.id} className="py-2.5 first:pt-0 last:pb-0">
                <a
                  href={it.naverUrl ?? it.url}
                  target="_blank"
                  rel="noreferrer"
                  className="group flex min-w-0 flex-1 items-start gap-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="group-hover:text-primary line-clamp-1 text-sm leading-snug font-medium">
                      {it.titleKo}
                    </div>
                    <div className="text-muted-foreground mt-0.5 truncate text-xs">
                      {it.titleKo !== it.title ? it.title : " "}
                    </div>
                    <p className="text-muted-foreground mt-1 line-clamp-2 text-xs leading-snug">
                      {it.excerpt ? it.excerpt : blankTwoLines}
                    </p>
                    <div className="text-muted-foreground mt-1 flex items-center gap-x-2 text-xs">
                      <span>{it.publisher}</span>
                      <span>·</span>
                      <span className="tnum">{fmtAgo(it.publishedAt)}</span>
                    </div>
                  </div>
                </a>
              </li>
            ))}
          </ul>
          <Pager page={page} pageCount={pageCount} onChange={setPage} />
        </>
      )}
    </div>
  );
}

function MacroNewsSide({ title, market }: { title: string; market: "kr" | "us" }) {
  const q = useQuery({
    queryKey: ["news-market", market],
    queryFn: () => apiFetch<NewsResponse>(`/api/news/market?market=${market}`),
    staleTime: 10 * 60_000,
  });

  if (q.isLoading) return <Skeleton className="h-48 w-full" />;
  if (q.isError) {
    return (
      <p className="text-destructive text-sm">
        {q.error instanceof ApiError ? q.error.message : "뉴스를 불러오지 못했습니다."}
      </p>
    );
  }
  return (
    <NewsColumn
      title={title}
      items={q.data?.items ?? []}
      emptyText="관련 뉴스가 없습니다."
    />
  );
}

/**
 * 거시경제(시황) 뉴스 — 종목뉴스 탭(stock-news.tsx)과 동일한 레이아웃·소스
 * 전략(공신력 있는 언론사 화이트리스트, 국내는 발췌 포함)을 공유하되, 종목이
 * 아니라 시장 전반(국내 시황/해외 시황)을 검색어로 쓴다(오너 확인, 2026-09).
 */
export function MacroNewsPanel() {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">시장 뉴스</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-muted-foreground/80 text-[11px]">
          공신력 있는 언론사·최근 1주일 기사만 표시합니다(헤드라인 무료 자동 번역).
        </p>
        <div className="grid grid-cols-1 gap-x-6 gap-y-6 md:grid-cols-2">
          <MacroNewsSide title="국내 시황" market="kr" />
          <MacroNewsSide title="해외 시황" market="us" />
        </div>
      </CardContent>
    </Card>
  );
}
