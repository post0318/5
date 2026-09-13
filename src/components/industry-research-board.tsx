"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/query";
import { cn } from "@/lib/utils";
import type { MarketId } from "@/lib/markets/types";
import type { ShinhanResearchDoc } from "@/lib/db/shinhan-research";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const PAGE_SIZE = 10;

const TOPICS = [
  { key: "all", label: "전체" },
  { key: "산업분석", label: "산업분석" },
  { key: "투자전략", label: "투자전략" },
  { key: "시황", label: "시황" },
] as const;
type TopicKey = (typeof TOPICS)[number]["key"];

function fmtAgo(iso: string): string {
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "오늘";
  return `${days}일 전`;
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
    <div className="mt-3 flex justify-center gap-1">
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

/**
 * 산업분석/투자전략 리포트 — 종목 무관, 시장 전체용 새 탭(`/[market]/research`,
 * 오너 지시 2026-09 — "종목분석 옆에 새 최상위 탭"). `ShinhanResearchDoc`의
 * `category:"산업"` 문서(symbol 항상 null)를 그대로 보여준다. 목표주가·투자
 * 의견은 이 카테고리에선 수집기가 애초에 추출을 건너뛰므로(CLAUDE.md 참고)
 * 표시하지 않는다 — 종목별 "증권사 리서치" 카드(ShinhanResearch)와는 별개.
 */
export function IndustryResearchBoard({ market }: { market: MarketId }) {
  const [page, setPage] = useState(1);
  const [topic, setTopic] = useState<TopicKey>("all");

  const q = useQuery({
    queryKey: ["industry-research", market, topic],
    queryFn: () =>
      apiFetch<{ items: ShinhanResearchDoc[] }>(
        `/api/research/industry?market=${market}${topic === "all" ? "" : `&topic=${encodeURIComponent(topic)}`}`,
      ),
    staleTime: 30 * 60_000,
  });

  const items = q.data?.items ?? [];
  const pageCount = Math.ceil(items.length / PAGE_SIZE) || 1;
  const clampedPage = Math.min(page, pageCount);
  const paged = items.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

  function selectTopic(t: TopicKey) {
    setTopic(t);
    setPage(1);
  }

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-xl font-semibold">산업분석·투자전략</h1>
      </div>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
          <CardTitle className="text-sm">
            {market === "kr" ? "국내" : "해외"} 산업분석·투자전략
            {q.data && <span className="text-muted-foreground ml-1.5 text-xs font-normal">({items.length})</span>}
          </CardTitle>
          <div className="flex gap-1">
            {TOPICS.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => selectTopic(t.key)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  topic === t.key
                    ? "bg-secondary text-secondary-foreground"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </CardHeader>
        {topic !== "all" && (
          <p className="text-muted-foreground/80 -mt-1 px-6 text-[11px]">
            제목·라벨 키워드로 자동 구분한 결과라 완전히 정확하지 않을 수 있습니다.
          </p>
        )}
        <CardContent>
          {q.isLoading && <Skeleton className="h-64 w-full" />}
          {q.isError && (
            <p className="text-destructive text-sm">
              {q.error instanceof ApiError ? q.error.message : "리포트를 불러오지 못했습니다."}
            </p>
          )}
          {q.data && items.length === 0 && (
            <p className="text-muted-foreground py-4 text-sm">아직 수집된 리포트가 없습니다.</p>
          )}
          {q.data && items.length > 0 && (
            <>
              <ul className="divide-y">
                {paged.map((it) => (
                  <li key={it._id} className="py-2.5 first:pt-0 last:pb-0">
                    <a href={it.pdfUrl ?? undefined} target="_blank" rel="noreferrer" className="group block">
                      <div className="group-hover:text-primary text-sm leading-snug font-medium">
                        {it.stockName && it.stockName !== it.title && (
                          <span className="text-muted-foreground mr-1.5">[{it.stockName}]</span>
                        )}
                        {it.title}
                      </div>
                      {it.summary && (
                        <p className="text-muted-foreground mt-1 line-clamp-1 text-xs leading-snug">
                          {it.summary}
                        </p>
                      )}
                      <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 text-xs">
                        <span className="bg-muted rounded px-1.5 py-0.5 font-medium">{it.source}</span>
                        {it.analyst && <span>{it.analyst}</span>}
                        <span>·</span>
                        <span className="tnum">{fmtAgo(it.date)}</span>
                      </div>
                    </a>
                  </li>
                ))}
              </ul>
              <Pager page={clampedPage} pageCount={pageCount} onChange={setPage} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
