"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, ApiError } from "@/lib/query";
import { cn, toHttps } from "@/lib/utils";
import type { MarketId } from "@/lib/markets/types";
import type { ShinhanResearchDoc } from "@/lib/db/shinhan-research";
import { SECTOR_LABELS, classifySector } from "@/lib/research-sector";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const PAGE_SIZE = 10;

const TOPICS = [
  { key: "all", label: "전체" },
  { key: "산업분석", label: "산업분석" },
  { key: "투자전략(주식)", label: "투자전략(주식)" },
  { key: "투자전략(채권)", label: "투자전략(채권)" },
  { key: "시황", label: "시황" },
  { key: "해외리서치", label: "해외리서치" },
] as const;
type TopicKey = (typeof TOPICS)[number]["key"];

// 업종 필터 노출 대상(오너 지시, 2026-09-22 — "산업분석 중 산업분석과
// 전체에만 업종선택을 넣는다"): 전체·산업분석 탭에서만 보이고, 투자전략
// (주식)/(채권)·시황·해외리서치에서는 숨긴다. 업종 분류값 자체는 한국·미국
// 공통(`research-sector.ts` SECTOR_LABELS, 오너 확인 — "업종구분은 미국과
// 동일하다").
const SECTOR_FILTER_SHOWN: ReadonlySet<TopicKey> = new Set(["all", "산업분석"]);

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
  // 디폴트 분류값은 "전체"가 아니라 "산업분석"(오너 지시, 2026-09).
  const [topic, setTopic] = useState<TopicKey>("산업분석");
  // 업종 필터(오너 지시, 2026-09-19 — "너무 섹터가 다양해서 섹터별로 선택
  // 조회가 가능하거나" → "산업분석 분류값을 너무 엉터리도 해두었네..
  // 섹터 분류값은 한국지수와 미국지수 분류값을 섞어서"). 수집기마다 제각각인
  // 원문 stockName을 그대로 나열하는 대신 표준 섹터(`research-sector.ts`
  // — KOSPI200/KOSDAQ150/미국 SPDR 실제 지수 체계 기반)로 분류해서 보여준다.
  // 별도 API 호출 없이 이미 받아온 목록에서 클라이언트 분류.
  const [sector, setSector] = useState<string>("all");

  const q = useQuery({
    queryKey: ["industry-research", market, topic],
    queryFn: () =>
      apiFetch<{ items: ShinhanResearchDoc[] }>(
        `/api/research/industry?market=${market}${topic === "all" ? "" : `&topic=${encodeURIComponent(topic)}`}`,
      ),
    staleTime: 30 * 60_000,
  });

  const allItems = q.data?.items ?? [];
  // 미분류(표준 섹터 규칙에 안 걸리는 항목 — 수집기 기본값 "산업"/"시장",
  // 게시판 라벨 등)는 "기타"로 묶어 따로 걸러볼 수 있게 한다(오너 지시,
  // 2026-09-19 — "기타로 분류해줘").
  const OTHER = "기타";
  const sectorCounts = new Map<string, number>();
  for (const it of allItems) {
    const s = classifySector(it) ?? OTHER;
    sectorCounts.set(s, (sectorCounts.get(s) ?? 0) + 1);
  }
  const sectors = [...SECTOR_LABELS.filter((s) => sectorCounts.has(s)), ...(sectorCounts.has(OTHER) ? [OTHER] : [])].map(
    (s) => [s, sectorCounts.get(s)!] as const,
  );
  const items =
    sector === "all" ? allItems : allItems.filter((it) => (classifySector(it) ?? OTHER) === sector);
  const pageCount = Math.ceil(items.length / PAGE_SIZE) || 1;
  const clampedPage = Math.min(page, pageCount);
  const paged = items.slice((clampedPage - 1) * PAGE_SIZE, clampedPage * PAGE_SIZE);

  function selectTopic(t: TopicKey) {
    setTopic(t);
    setSector("all");
    setPage(1);
  }

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-xl font-semibold">산업분석</h1>
      </div>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
          <CardTitle className="text-sm">
            {market === "kr" ? "국내 산업분석" : "해외 리서치"}
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
        {sectors.length > 1 && SECTOR_FILTER_SHOWN.has(topic) && (
          <div className="flex items-center gap-2 px-6 pb-1">
            <label htmlFor="sector-filter" className="text-muted-foreground text-xs">
              업종
            </label>
            <select
              id="sector-filter"
              value={sector}
              onChange={(e) => {
                setSector(e.target.value);
                setPage(1);
              }}
              className="border-input bg-background h-7 rounded-md border px-2 text-xs"
            >
              <option value="all">전체 ({allItems.length})</option>
              {sectors.map(([name, count]) => (
                <option key={name} value={name}>
                  {name} ({count})
                </option>
              ))}
            </select>
          </div>
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
                    <a href={toHttps(it.pdfUrl)} target="_blank" rel="noreferrer" className="group block">
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
