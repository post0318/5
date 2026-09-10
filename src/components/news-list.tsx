"use client";

import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NewsItem } from "@/lib/news";

function fmtAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "방금";
  if (mins < 60) return `${mins}분 전`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}시간 전`;
  return `${Math.round(hrs / 24)}일 전`;
}

export function NewsList({
  items,
  emptyText = "표시할 뉴스가 없습니다.",
  showStock = false,
}: {
  items: NewsItem[];
  emptyText?: string;
  /** 종목명 배지 표시 (통합 종목 뉴스 목록에서 어느 종목 기사인지 구분용) */
  showStock?: boolean;
}) {
  if (items.length === 0) {
    return <p className="text-muted-foreground text-sm">{emptyText}</p>;
  }
  return (
    <ul className="divide-y">
      {items.map((it, i) => (
        <li key={`${it.link}-${i}`} className="py-2.5 first:pt-0 last:pb-0">
          <a
            href={it.link}
            target="_blank"
            rel="noreferrer"
            className="group flex items-start gap-2"
          >
            <div className="min-w-0 flex-1">
              <div className="group-hover:text-primary text-sm leading-snug font-medium">
                {it.titleKo}
                {!it.isKorean && !it.translationOk && (
                  <span
                    className="text-muted-foreground ml-1.5 text-[10px] font-normal"
                    title="번역 검증 불확실 — 원문 확인 권장"
                  >
                    (번역 확인필요)
                  </span>
                )}
              </div>
              {!it.isKorean && it.titleKo !== it.titleOrig && (
                <div className="text-muted-foreground mt-0.5 truncate text-xs">
                  {it.titleOrig}
                </div>
              )}
              <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                {showStock && it.name && (
                  <span className="bg-muted rounded px-1.5 py-0.5 font-medium">
                    {it.name}
                  </span>
                )}
                <span>{it.source}</span>
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
  );
}
