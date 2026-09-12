"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/query";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { ShinhanResearchDoc } from "@/lib/db/shinhan-research";

const PAGE_SIZE = 10;

function fmtAgo(iso: string): string {
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "오늘";
  return `${days}일 전`;
}

/** 증권사마다 제각각인 표기(영문 Buy/Hold, "강력매수" 등)를 5단계 한글로 통일. */
function normalizeOpinion(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  if (/강력\s*매수|strong\s*buy/i.test(s)) return "강력매수";
  if (/강력\s*매도|strong\s*sell/i.test(s)) return "강력매도";
  if (/매수|^buy$|overweight|positive/i.test(s)) return "매수";
  if (/매도|^sell$|underweight|negative/i.test(s)) return "매도";
  if (/중립|^hold$|neutral|market\s*perform/i.test(s)) return "중립";
  return s; // Not Rated 등은 원문 그대로(색상 없음)
}

/** 한국 종목 전용 기능이라 등락 색상 관행(상승=빨강·하락=파랑)을 그대로 매수/매도에 적용. */
const OPINION_CLASS: Record<string, string> = {
  강력매수: "text-kr-up",
  매수: "text-kr-up",
  중립: "text-muted-foreground",
  매도: "text-kr-down",
  강력매도: "text-kr-down",
};

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

type Category = "전체" | "기업" | "산업";

/**
 * 증권사 리서치(기업분석) 리포트 — 한국 종목만, DB만 읽음(로컬 스크립트가 수집,
 * CLAUDE.md 예외 참고). 여러 증권사를 합쳐 보여주는 걸 전제로 만들어서 항목마다
 * 출처(source)를 표시한다. 기업/산업 구분(2026-09 추가) — 현재 모든 수집기가
 * 기업분석만 수집해 "산업" 탭은 당장은 항상 비어있음(수집기 확장은 후속 과제).
 */
export function ShinhanResearch({ symbol }: { symbol: string }) {
  const [category, setCategory] = useState<Category>("전체");
  const [page, setPage] = useState(1);

  const q = useQuery({
    queryKey: ["shinhan-research", symbol],
    queryFn: () =>
      apiFetch<{ items: ShinhanResearchDoc[] }>(
        `/api/markets/kr/${encodeURIComponent(symbol)}/research`,
      ),
    enabled: Boolean(symbol),
    staleTime: 30 * 60_000,
  });

  const filtered = useMemo(() => {
    const items = q.data?.items ?? [];
    return category === "전체" ? items : items.filter((it) => it.category === category);
  }, [q.data, category]);

  const pageCount = Math.ceil(filtered.length / PAGE_SIZE) || 1;
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function changeCategory(c: Category) {
    setCategory(c);
    setPage(1);
  }

  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
          증권사 리서치
          {q.data && <span className="text-muted-foreground text-xs font-normal">({filtered.length})</span>}
          <span className="text-muted-foreground ml-auto text-[11px] font-normal">
            최근 3개월(없으면 최신순) · 개인용 참고자료
          </span>
        </CardTitle>
        <div className="flex gap-1 pt-1">
          {(["전체", "기업", "산업"] as const).map((c) => (
            <Button
              key={c}
              size="sm"
              variant={category === c ? "secondary" : "ghost"}
              className="h-6 px-2 text-xs"
              onClick={() => changeCategory(c)}
            >
              {c}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
      {q.isLoading && <Skeleton className="h-40 w-full" />}
      {q.isError && (
        <p className="text-destructive text-xs">
          {q.error instanceof ApiError ? q.error.message : "리서치를 불러오지 못했습니다."}
        </p>
      )}
      {q.data && filtered.length === 0 && (
        <p className="text-muted-foreground py-4 text-sm">
          {category === "산업" ? "산업분석은 아직 수집하지 않습니다." : "아직 수집된 리포트가 없습니다."}
        </p>
      )}
      {q.data && filtered.length > 0 && (
        <>
          <ul className="divide-y">
            {paged.map((it) => {
              const opinion = normalizeOpinion(it.opinion);
              return (
                <li key={it._id} className="py-2.5 first:pt-0 last:pb-0">
                  <a href={it.pdfUrl ?? undefined} target="_blank" rel="noreferrer" className="group block">
                    <div className="flex items-start justify-between gap-2">
                      <div className="group-hover:text-primary text-sm leading-snug font-medium">
                        {it.title}
                      </div>
                      {opinion && (
                        <span className={cn("shrink-0 text-xs font-semibold", OPINION_CLASS[opinion] ?? "")}>
                          {opinion}
                        </span>
                      )}
                    </div>
                    <p className="text-muted-foreground mt-1 line-clamp-1 text-xs leading-snug">
                      {it.summary}
                    </p>
                    <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 text-xs">
                      <span className="bg-muted rounded px-1.5 py-0.5 font-medium">{it.source}</span>
                      <span>{it.analyst}</span>
                      <span>·</span>
                      <span className="tnum">{fmtAgo(it.date)}</span>
                    </div>
                  </a>
                </li>
              );
            })}
          </ul>
          <Pager page={page} pageCount={pageCount} onChange={setPage} />
        </>
      )}
      </CardContent>
    </Card>
  );
}
