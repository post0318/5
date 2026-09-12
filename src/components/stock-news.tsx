"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/query";
import { cn } from "@/lib/utils";
import type { MarketId } from "@/lib/markets/types";
import type { NewsItem } from "@/lib/markets/news";
import { Skeleton } from "@/components/ui/skeleton";

interface NewsResponse {
  domestic: NewsItem[];
  overseas: NewsItem[];
}

const PAGE_SIZE = 5;
const MAX_PAGES = 6; // PAGE_SIZE 변경(10→5) 시에도 총 노출 건수(최대 30건)는 유지

/** 요약 없는 항목(해외뉴스)의 자리 채움 — line-clamp-2 가 실제로 계산하는 두 줄
 * 높이와 정확히 같아지도록 줄바꿈 포함 두 줄을 그대로 렌더링(em/rem 추정치
 * 방식은 실제 높이와 어긋나는 문제가 실측 확인됨). */
const blankTwoLines = (
  <>
    {" "}
    <br />
    {" "}
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
                    <div className="group-hover:text-primary text-sm leading-snug font-medium">
                      {it.titleKo}
                    </div>
                    <div className="text-muted-foreground mt-0.5 truncate text-xs">
                      {it.titleKo !== it.title ? it.title : " "}
                    </div>
                    {/* 국내는 실제 요약, 해외는 API에 스니펫이 없어 빈 자리만(행 높이 통일
                        목적). em/rem 값으로 2줄 높이를 추정한 min-height는 실측 결과
                        실제 2줄보다 작게 잡혀 어긋났음(오너 스크린샷 확인) — 대신 빈
                        경우 줄바꿈 포함 두 줄을 그대로 채워 line-clamp-2 가 계산하는
                        실제 높이와 항상 정확히 같아지게 한다. */}
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

/**
 * 종목뉴스 탭 — 좌: 국내(한국어 언론, 요약 발췌 포함) · 우: 해외(영미권 등 외국
 * 언론, 화이트리스트+LLM 관련성 판정). 종목의 상장 시장과 무관하게 항상 둘 다
 * 조회한다(예: 한국 종목도 로이터·블룸버그 보도가 있으면 우측에 표시). 공신력
 * 있는 언론사 + 최근 1주일 기사만, 각 최대 5개씩 페이지. 본문 번역·요약 저장
 * 기능은 여기서 제거(오너 결정, 2026-09 — 비용 부담. 대신 거시경제 뉴스 쪽에
 * 반영하기로 함) — 헤드라인 무료 자동 번역만 유지.
 */
export function StockNews({ market, symbol }: { market: MarketId; symbol: string }) {
  const q = useQuery({
    queryKey: ["stock-news", market, symbol],
    queryFn: () =>
      apiFetch<NewsResponse>(`/api/markets/${market}/${encodeURIComponent(symbol)}/news`),
    enabled: Boolean(symbol),
    staleTime: 30 * 60_000,
  });

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground/80 text-[11px]">
        공신력 있는 언론사·최근 1주일 기사만 표시합니다(헤드라인 무료 자동 번역).
      </p>

      {q.isLoading && <Skeleton className="h-48 w-full" />}
      {q.isError && (
        <p className="text-destructive text-sm">
          {q.error instanceof ApiError ? q.error.message : "뉴스를 불러오지 못했습니다."}
        </p>
      )}

      {q.data && (
        <div className="grid grid-cols-1 gap-x-6 gap-y-6 md:grid-cols-2">
          <NewsColumn
            title="국내뉴스"
            items={q.data.domestic}
            emptyText="최근 1주일 내 화이트리스트 언론사 기사가 없습니다."
          />
          <NewsColumn
            title="해외뉴스"
            items={q.data.overseas}
            emptyText="최근 1주일 내 화이트리스트 언론사 기사가 없습니다."
          />
        </div>
      )}
    </div>
  );
}
