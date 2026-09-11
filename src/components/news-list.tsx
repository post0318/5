"use client";

import type { NewsItem } from "@/lib/news";

function fmtAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "방금";
  if (mins < 60) return `${mins}분 전`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}시간 전`;
  return `${Math.round(hrs / 24)}일 전`;
}

/** 좌/우 분할 개수 — 단순 반반(좌측이 홀수일 때 1개 더 가져감). */
function splitCounts(total: number): [number, number] {
  const left = Math.ceil(total / 2);
  return [left, total - left];
}

function NewsItemRow({ item, showStock }: { item: NewsItem; showStock: boolean }) {
  return (
    <a href={item.link} target="_blank" rel="noreferrer" className="group flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <div className="group-hover:text-primary text-sm leading-snug font-medium">
          {item.titleKo}
          {!item.isKorean && !item.translationOk && (
            <span
              className="text-muted-foreground ml-1.5 text-[10px] font-normal"
              title="번역 검증 불확실 — 원문 확인 권장"
            >
              (번역 확인필요)
            </span>
          )}
        </div>
        {!item.isKorean && item.titleKo !== item.titleOrig && (
          <div className="text-muted-foreground mt-0.5 truncate text-xs">{item.titleOrig}</div>
        )}
        <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          {showStock && item.name && (
            <span className="bg-muted rounded px-1.5 py-0.5 font-medium">{item.name}</span>
          )}
          <span>{item.source}</span>
          <span>·</span>
          <span className="tnum">{fmtAgo(item.publishedAt)}</span>
        </div>
      </div>
    </a>
  );
}

function NewsColumn({ items, showStock }: { items: NewsItem[]; showStock: boolean }) {
  return (
    <ul>
      {items.map((it, i) => (
        <li key={`${it.link}-${i}`} className="border-b py-2.5 last:border-b-0">
          <NewsItemRow item={it} showStock={showStock} />
        </li>
      ))}
    </ul>
  );
}

export function NewsList({
  items,
  emptyText = "표시할 뉴스가 없습니다.",
  showStock = false,
  split = false,
}: {
  items: NewsItem[];
  emptyText?: string;
  /** 종목명 배지 표시 (통합 종목 뉴스 목록에서 어느 종목 기사인지 구분용) */
  showStock?: boolean;
  /** 2단 분할 레이아웃 — 종목 수(=items.length) 기준 좌/우 개수 산정 */
  split?: boolean;
}) {
  if (items.length === 0) {
    return <p className="text-muted-foreground text-sm">{emptyText}</p>;
  }
  if (!split) {
    return (
      <ul className="divide-y">
        {items.map((it, i) => (
          <li key={`${it.link}-${i}`} className="py-2.5 first:pt-0 last:pb-0">
            <NewsItemRow item={it} showStock={showStock} />
          </li>
        ))}
      </ul>
    );
  }
  const [leftCount] = splitCounts(items.length);
  const left = items.slice(0, leftCount);
  const right = items.slice(leftCount);
  return (
    <div className="grid grid-cols-1 gap-x-6 md:grid-cols-2">
      <NewsColumn items={left} showStock={showStock} />
      {right.length > 0 && <NewsColumn items={right} showStock={showStock} />}
    </div>
  );
}
