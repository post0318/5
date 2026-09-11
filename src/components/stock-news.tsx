"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { apiFetch, ApiError } from "@/lib/query";
import { cn } from "@/lib/utils";
import type { MarketId } from "@/lib/markets/types";
import type { NewsItem } from "@/lib/markets/news";
import type { NewsSavedDoc } from "@/lib/db/news-saved";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

interface NewsResponse {
  items: (NewsItem & { saved: boolean })[];
  saved: NewsSavedDoc[];
}

function fmtAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "방금";
  if (mins < 60) return `${mins}분 전`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}시간 전`;
  return `${Math.round(hrs / 24)}일 전`;
}

/**
 * 종목뉴스 탭 — 공신력 있는 언론사 + 3개월 이내 기사 목록(헤드라인 무료 번역).
 * 체크한 기사만 본문 번역+요약(LLM, 월 과금 상한 있음) → "요약/번역"에서 조회.
 */
export function StockNews({ market, symbol }: { market: MarketId; symbol: string }) {
  const [view, setView] = useState<"all" | "saved">("all");
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ["stock-news", market, symbol],
    queryFn: () =>
      apiFetch<NewsResponse>(
        `/api/markets/${market}/${encodeURIComponent(symbol)}/news`,
      ),
    enabled: Boolean(symbol),
    staleTime: 5 * 60_000,
  });

  const summarize = useMutation({
    mutationFn: (item: NewsItem) =>
      apiFetch(`/api/markets/${market}/${encodeURIComponent(symbol)}/news/summarize`, {
        method: "POST",
        body: JSON.stringify({
          url: item.url,
          title: item.title,
          publisher: item.publisher,
          publishedAt: item.publishedAt,
        }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["stock-news", market, symbol] }),
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "요약 요청 실패");
    },
  });

  const unsave = useMutation({
    mutationFn: (url: string) =>
      apiFetch(
        `/api/markets/${market}/${encodeURIComponent(symbol)}/news/summarize?url=${encodeURIComponent(url)}`,
        { method: "DELETE" },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["stock-news", market, symbol] }),
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : "삭제 요청 실패");
    },
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground/80 text-[11px]">
          공신력 있는 언론사·3개월 이내 기사만 표시합니다. 헤드라인은 무료 자동
          번역, 체크한 기사만 본문 번역·요약(LLM, 예산 한도 있음)이 저장됩니다.
        </p>
        <div className="flex shrink-0 gap-1">
          <Button
            size="sm"
            variant={view === "all" ? "secondary" : "ghost"}
            onClick={() => setView("all")}
          >
            전체
          </Button>
          <Button
            size="sm"
            variant={view === "saved" ? "secondary" : "ghost"}
            onClick={() => setView("saved")}
          >
            요약/번역
          </Button>
        </div>
      </div>

      {q.isLoading && <Skeleton className="h-48 w-full" />}
      {q.isError && (
        <p className="text-destructive text-sm">
          {q.error instanceof ApiError ? q.error.message : "뉴스를 불러오지 못했습니다."}
        </p>
      )}

      {q.data && view === "all" && (
        <ul className="divide-y">
          {q.data.items.length === 0 && (
            <p className="text-muted-foreground py-4 text-sm">
              최근 3개월 내 화이트리스트 언론사 기사가 없습니다.
            </p>
          )}
          {q.data.items.map((it) => (
            <li key={it.id} className="flex items-start gap-2.5 py-2.5 first:pt-0 last:pb-0">
              <input
                type="checkbox"
                checked={it.saved}
                disabled={summarize.isPending || unsave.isPending}
                onChange={(e) => (e.target.checked ? summarize.mutate(it) : unsave.mutate(it.url))}
                className="mt-1 size-4 shrink-0 cursor-pointer"
                title="체크하면 본문 번역·요약을 저장합니다"
              />
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
                  {it.titleKo !== it.title && (
                    <div className="text-muted-foreground mt-0.5 truncate text-xs">{it.title}</div>
                  )}
                  <div className="text-muted-foreground mt-1 flex items-center gap-x-2 text-xs">
                    <span>{it.publisher}</span>
                    <span>·</span>
                    <span className="tnum">{fmtAgo(it.publishedAt)}</span>
                  </div>
                </div>
                <ExternalLink
                  className={cn(
                    "text-muted-foreground group-hover:text-primary mt-0.5 size-3.5 shrink-0",
                  )}
                />
              </a>
            </li>
          ))}
        </ul>
      )}

      {q.data && view === "saved" && (
        <ul className="space-y-3">
          {q.data.saved.length === 0 && (
            <p className="text-muted-foreground py-4 text-sm">
              체크해서 저장한 기사가 없습니다. &ldquo;전체&rdquo; 탭에서 기사를 체크해보세요.
            </p>
          )}
          {q.data.saved.map((s) => (
            <li key={s._id} className="rounded-md border p-3">
              <div className="flex items-start justify-between gap-2">
                <a
                  href={s.url}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-primary text-sm leading-snug font-medium"
                >
                  {s.translatedTitle || s.title}
                </a>
                <Button size="sm" variant="ghost" onClick={() => unsave.mutate(s.url)}>
                  해제
                </Button>
              </div>
              <div className="text-muted-foreground mt-1 text-xs">
                {s.publisher} · {fmtAgo(s.publishedAt)}
              </div>
              {s.summary && (
                <p className="mt-2 text-sm leading-relaxed whitespace-pre-line">{s.summary}</p>
              )}
              {s.translatedText && (
                <details className="mt-2">
                  <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-xs">
                    본문 번역 전체 보기
                  </summary>
                  <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-line">
                    {s.translatedText}
                  </p>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
