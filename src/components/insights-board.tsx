"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/query";
import { cn, toHttps } from "@/lib/utils";
import type { MarketId } from "@/lib/markets/types";
import type { ShinhanResearchDoc } from "@/lib/db/shinhan-research";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const PAGE_SIZE = 10;

// lib/db/shinhan-research.ts 의 INSIGHT_SOURCES 와 동일(서버 전용 모듈이라
// 클라이언트에서 재import 불가 — TOPICS 처럼 화면단에 그대로 둠).
const US_SOURCES = [
  { key: "all", label: "전체" },
  { key: "BlackRock", label: "BlackRock" },
  { key: "Goldman Sachs", label: "Goldman Sachs" },
  { key: "J.P. Morgan", label: "J.P. Morgan" },
  { key: "Morgan Stanley", label: "Morgan Stanley" },
  { key: "PIMCO", label: "PIMCO" },
  { key: "BNP Paribas", label: "BNP Paribas" },
  { key: "Citigroup", label: "Citigroup" },
  { key: "Bank of America Institute", label: "BofA Institute" },
  { key: "HSBC", label: "HSBC" },
  { key: "Deutsche Bank Research", label: "Deutsche Bank" },
] as const;
// 국내는 해외 IB 인사이트가 없어(오너 지시, 2026-09-24 — "국내는 인사이트가
// 없다. 따라서 미국은 유지하나 한국은 인사이트를 비상장 리서치로 대체한다")
// 키움증권 CI 게시판의 비상장(프리IPO) 기업 리포트로 대체한다.
const KR_SOURCES = [
  { key: "all", label: "전체" },
  { key: "키움증권 비상장리서치", label: "키움증권" },
  { key: "KB증권 비상장리서치", label: "KB증권" },
  { key: "NH투자증권 비상장리서치", label: "NH투자증권" },
] as const;
type SourceKey = (typeof US_SOURCES)[number]["key"] | (typeof KR_SOURCES)[number]["key"];

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
 * 해외 IB/자산운용사 인사이트 — 산업분석 탭 옆 새 최상위 탭(오너 지시,
 * 2026-09-19 — "해외ib에서 발취되는 것은 산업분석에 빼서... 인사이트라고
 * 탭 만들도록 거기에 전체/각사별구분으로 넣자"). 골드만삭스·JP모간·
 * 모간스탠리·블랙록·PIMCO 등은 미국(market:"us")만 대상(`/api/research/insights`,
 * `getInsightResearch()` — 산업분석 탭과 서로 배타적).
 *
 * **국내는 비상장 리서치로 대체(오너 지시, 2026-09-24)**: 위 해외 IB
 * 소스는 전부 market:"us"뿐이라 국내 탭은 항상 비어 있었다 — 국내
 * (market:"kr")에서는 대신 키움증권의 비상장(프리IPO) 기업 리포트를
 * 보여준다. 같은 API·같은 인프라(`INSIGHT_SOURCES`)를 재사용하므로
 * 컴포넌트는 market에 따라 제목·소스탭·안내문구만 바꾼다.
 */
export function InsightsBoard({ market }: { market: MarketId }) {
  const [page, setPage] = useState(1);
  const isKr = market === "kr";
  const SOURCES = isKr ? KR_SOURCES : US_SOURCES;
  const [source, setSource] = useState<SourceKey>("all");

  const q = useQuery({
    queryKey: ["insights-research", market, source],
    queryFn: () =>
      apiFetch<{ items: ShinhanResearchDoc[] }>(
        `/api/research/insights?market=${market}${source === "all" ? "" : `&source=${encodeURIComponent(source)}`}`,
      ),
    staleTime: 30 * 60_000,
  });

  const items = q.data?.items ?? [];
  const pageCount = Math.ceil(items.length / PAGE_SIZE) || 1;
  const clampedPage = Math.min(page, pageCount);
  const paged = items.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

  function selectSource(s: SourceKey) {
    setSource(s);
    setPage(1);
  }

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-xl font-semibold">{isKr ? "비상장 리서치" : "인사이트"}</h1>
      </div>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
          <CardTitle className="text-sm">
            {isKr ? "비상장(프리IPO) 기업 리서치" : "주요 해외IB 리서치 (딜레이자료)"}
            {q.data && <span className="text-muted-foreground ml-1.5 text-xs font-normal">({items.length})</span>}
          </CardTitle>
          <div className="flex flex-wrap gap-1">
            {SOURCES.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => selectSource(s.key)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  source === s.key
                    ? "bg-secondary text-secondary-foreground"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
        </CardHeader>
        {!isKr && (
          <p className="text-muted-foreground/80 -mt-1 px-6 text-[11px]">
            영문 원문 그대로 표시됩니다(번역 없음).
          </p>
        )}
        <CardContent>
          {q.isLoading && <Skeleton className="h-64 w-full" />}
          {q.isError && (
            <p className="text-destructive text-sm">
              {q.error instanceof ApiError ? q.error.message : "인사이트를 불러오지 못했습니다."}
            </p>
          )}
          {q.data && items.length === 0 && (
            <p className="text-muted-foreground py-4 text-sm">
              {isKr ? "아직 수집된 비상장 리서치가 없습니다." : "아직 수집된 인사이트가 없습니다."}
            </p>
          )}
          {q.data && items.length > 0 && (
            <>
              <ul className="divide-y">
                {paged.map((it) => (
                  <li key={it._id} className="py-2.5 first:pt-0 last:pb-0">
                    <a href={toHttps(it.pdfUrl)} target="_blank" rel="noreferrer" className="group block">
                      <div className="group-hover:text-primary text-sm leading-snug font-medium">
                        {it.title}
                      </div>
                      {it.summary && (
                        <p className="text-muted-foreground mt-1 line-clamp-2 text-xs leading-snug">
                          {it.summary}
                        </p>
                      )}
                      <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 text-xs">
                        <span className="bg-muted rounded px-1.5 py-0.5 font-medium">{it.source}</span>
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
