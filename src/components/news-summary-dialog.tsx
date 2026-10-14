"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/query";
import type { NewsItem } from "@/lib/markets/news";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface Summary {
  titleKo: string;
  bullets: string[];
  url: string;
  /** other = 원문을 못 읽어 같은 사건의 다른 매체 기사로 요약 */
  basis?: "article" | "other" | "link";
  sources?: { url: string; source: string }[];
}

type SummaryResponse = { ok: true; summary: Summary } | { ok: false; reason: string; summary?: Summary };

const REASON_TEXT: Record<string, string> = {
  pending: "요약을 준비 중입니다(30분마다 새 기사를 요약합니다). 잠시 후 다시 열어 보세요.",
  unreadable: "원문을 읽을 수 없는 기사입니다(유료 구독·접근 차단 등).",
};

/**
 * 해외 시황 기사 팝업(2026-10-14, post0318/4 NewsSummaryModal 과 같은 내용) — 저장된 한글 제목 + 요약 + 원문 링크.
 * 요약은 1호기 예약 작업이 무료 Gemini 키로 미리 만든다(`/api/cron/news-summary`). 여기서는 읽기만 한다.
 */
export function NewsSummaryDialog({ item, onClose }: { item: NewsItem | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["news-summary", item?.url],
    queryFn: () => apiFetch<SummaryResponse>(`/api/news/summary?url=${encodeURIComponent(item!.url)}`),
    enabled: !!item,
    staleTime: 5 * 60_000,
  });
  const data = q.data;
  const summary = data?.ok ? data.summary : null;
  const href = summary?.url ?? (data && !data.ok ? data.summary?.url : undefined) ?? item?.url;

  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm leading-snug">{summary?.titleKo ?? item?.titleKo}</DialogTitle>
          <DialogDescription className="text-[11px]">
            {item?.publisher}
            {item && item.titleKo !== item.title ? <span className="mt-0.5 block truncate">{item.title}</span> : null}
          </DialogDescription>
        </DialogHeader>

        <div className="text-xs">
          {q.isLoading && <p className="text-muted-foreground">요약을 불러오는 중…</p>}
          {q.isError && <p className="text-muted-foreground">요약을 불러오지 못했습니다.</p>}
          {summary?.basis === "other" && (
            <p className="mb-2 rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
              원문(유료 구독·접근 차단)을 읽을 수 없어 같은 사건을 다룬 다른 매체 보도로 요약했습니다
              {summary.sources?.length ? (
                <>
                  {" — "}
                  {summary.sources.map((s, i) => (
                    <span key={s.url}>
                      {i > 0 && ", "}
                      <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline">
                        {s.source}
                      </a>
                    </span>
                  ))}
                </>
              ) : null}
            </p>
          )}
          {summary && (
            <ul className="space-y-1.5">
              {summary.bullets.map((b, i) => (
                <li key={i} className="flex gap-1.5">
                  <span className="text-muted-foreground">•</span>
                  <span>{b}</span>
                </li>
              ))}
            </ul>
          )}
          {data && !data.ok && <p className="text-muted-foreground">{REASON_TEXT[data.reason] ?? REASON_TEXT.pending}</p>}
        </div>

        <p className="text-muted-foreground border-t pt-2 text-[11px]">
          {summary && "AI 요약(Gemini) — 원문과 다를 수 있습니다. "}
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            원문 보기 →
          </a>
        </p>
      </DialogContent>
    </Dialog>
  );
}
