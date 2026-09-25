"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/query";
import { cn, toHttps } from "@/lib/utils";
import type { ShinhanResearchDoc } from "@/lib/db/shinhan-research";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const PAGE_SIZE = 10;

const SEGMENTS = [
  { key: "Daily", label: "Daily" },
  { key: "Monthly", label: "Monthly" },
  { key: "투자전략", label: "투자전략" },
] as const;
type SegmentKey = (typeof SEGMENTS)[number]["key"];

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
            p === page ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
          )}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

/**
 * 신규 "시황분석" 탭(`/macro/market-condition`, 오너 지시 2026-09-26 —
 * "거시경제 환율분석 오른쪽에 시황분석 탭 추가"). Daily/Monthly/투자전략
 * 3개 세그먼트로 구분 — 구 "시황"(→Daily/Monthly)·"투자전략(주식)"
 * (→투자전략)이 산업분석 탭에서 완전히 이동해 여기서 대신 보여준다.
 * `MacroIssuesBoard`와 같은 카드·목록 스타일이되, 구분 기준이 source(증권사)가
 * 아니라 segment(Daily/Monthly/투자전략)라는 점이 다르다.
 */
export function MarketConditionBoard() {
  const [page, setPage] = useState(1);
  const [segment, setSegment] = useState<SegmentKey>("Daily");

  const q = useQuery({
    queryKey: ["market-condition", segment],
    queryFn: () =>
      apiFetch<{ items: ShinhanResearchDoc[] }>(
        `/api/research/market-condition?segment=${encodeURIComponent(segment)}`,
      ),
    staleTime: 30 * 60_000,
  });

  const items = q.data?.items ?? [];
  const pageCount = Math.ceil(items.length / PAGE_SIZE) || 1;
  const clampedPage = Math.min(page, pageCount);
  const paged = items.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

  function selectSegment(s: SegmentKey) {
    setSegment(s);
    setPage(1);
  }

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-xl font-semibold">시황분석</h1>
      </div>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
          <CardTitle className="text-sm">
            시황분석
            {q.data && <span className="text-muted-foreground ml-1.5 text-xs font-normal">({items.length})</span>}
          </CardTitle>
          <div className="flex flex-wrap gap-1">
            {SEGMENTS.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => selectSegment(s.key)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  segment === s.key
                    ? "bg-secondary text-secondary-foreground"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
        </CardHeader>
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
                    <a href={toHttps(it.pdfUrl)} target="_blank" rel="noreferrer" className="group block">
                      <div className="group-hover:text-primary text-sm leading-snug font-medium">{it.title}</div>
                      {it.summary && (
                        <p className="text-muted-foreground mt-1 line-clamp-1 text-xs leading-snug">{it.summary}</p>
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
