"use client";

import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { apiFetch, ApiError } from "@/lib/query";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import type { ShinhanResearchDoc } from "@/lib/db/shinhan-research";

function fmtAgo(iso: string): string {
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "오늘";
  return `${days}일 전`;
}

const OPINION_CLASS: Record<string, string> = {
  매수: "text-up",
  "강력매수": "text-up",
  중립: "text-muted-foreground",
  매도: "text-down",
  "강력매도": "text-down",
};

/**
 * 신한투자증권 "기업분석" 리포트 — 한국 종목만, DB만 읽음(로컬 스크립트가 수집,
 * CLAUDE.md 예외 참고). 종목뉴스 탭 오른쪽에 표시.
 */
export function ShinhanResearch({ symbol }: { symbol: string }) {
  const q = useQuery({
    queryKey: ["shinhan-research", symbol],
    queryFn: () =>
      apiFetch<{ items: ShinhanResearchDoc[] }>(
        `/api/markets/kr/${encodeURIComponent(symbol)}/research`,
      ),
    enabled: Boolean(symbol),
    staleTime: 30 * 60_000,
  });

  return (
    <div className="min-w-0">
      <h4 className="mb-2 text-xs font-semibold">
        신한투자증권 리서치{" "}
        {q.data && <span className="text-muted-foreground font-normal">({q.data.items.length})</span>}
      </h4>
      <p className="text-muted-foreground/70 mb-2 text-[11px]">최근 30일 · 개인용 참고자료</p>
      {q.isLoading && <Skeleton className="h-40 w-full" />}
      {q.isError && (
        <p className="text-destructive text-xs">
          {q.error instanceof ApiError ? q.error.message : "리서치를 불러오지 못했습니다."}
        </p>
      )}
      {q.data && q.data.items.length === 0 && (
        <p className="text-muted-foreground py-4 text-sm">최근 30일 내 리포트가 없습니다.</p>
      )}
      {q.data && q.data.items.length > 0 && (
        <ul className="divide-y">
          {q.data.items.map((it) => (
            <li key={it._id} className="py-2.5 first:pt-0 last:pb-0">
              <a
                href={it.pdfUrl ?? undefined}
                target="_blank"
                rel="noreferrer"
                className="group flex items-start gap-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="group-hover:text-primary text-sm leading-snug font-medium">
                    {it.title}
                  </div>
                  <p className="text-muted-foreground mt-1 line-clamp-2 text-xs leading-snug">
                    {it.summary}
                  </p>
                  <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 text-xs">
                    <span className={cn("font-medium", OPINION_CLASS[it.opinion] ?? "")}>
                      {it.opinion}
                    </span>
                    <span>·</span>
                    <span>{it.analyst}</span>
                    <span>·</span>
                    <span className="tnum">{fmtAgo(it.date)}</span>
                  </div>
                </div>
                {it.pdfUrl && (
                  <ExternalLink className="text-muted-foreground group-hover:text-primary mt-0.5 size-3.5 shrink-0" />
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
