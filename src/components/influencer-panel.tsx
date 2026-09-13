"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { apiFetch, ApiError } from "@/lib/query";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface InfluencerSummary {
  id: string;
  name: string;
  hasBlog: boolean;
  hasYoutube: boolean;
  hasTelegram: boolean;
}
interface InfluencerListResponse {
  items: InfluencerSummary[];
}

type Platform = "blog" | "youtube" | "telegram";
interface FeedItem {
  platform: Platform;
  title: string;
  link: string;
  publishedAt: string;
}
interface FeedResponse {
  items: FeedItem[];
}

const PLATFORM_LABEL: Record<Platform, string> = {
  blog: "블로그",
  youtube: "유튜브",
  telegram: "텔레그램",
};

function fmtAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "방금";
  if (mins < 60) return `${mins}분 전`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}시간 전`;
  return `${Math.round(hrs / 24)}일 전`;
}

/** https://www.youtube.com/watch?v=XXXX → XXXX. 블로그(네이버)는 iframe 임베드를
 * 막아놔서(X-Frame-Options) 인라인으로 못 띄우지만, 유튜브는 공식 embed가
 * 있어 새 탭 이동 없이 화면 내에서 바로 재생 가능 (2026-09) */
function youtubeVideoId(link: string): string | null {
  try {
    return new URL(link).searchParams.get("v");
  } catch {
    return null;
  }
}

/**
 * 인플루언서(블로거/유튜버/텔레그램) 트래킹 — 좌측 인플루언서 목록, 우측에
 * 선택한 인플루언서의 최근 게시물(블로그·유튜브·텔레그램). 유튜브는 화면
 * 내 인라인 재생(공식 embed), 블로그/텔레그램은 새 탭으로 원문 이동. 목록은
 * markdown 파일(lib/influencers/influencers.md) 관리 — 오너 확인, 2026-09.
 */
export function InfluencerPanel() {
  const list = useQuery({
    queryKey: ["influencers"],
    queryFn: () => apiFetch<InfluencerListResponse>("/api/influencers"),
    staleTime: 60 * 60_000,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [expandedVideoId, setExpandedVideoId] = useState<string | null>(null);
  const activeId = selected ?? list.data?.items[0]?.id ?? null;

  const feed = useQuery({
    queryKey: ["influencer-feed", activeId],
    queryFn: () => apiFetch<FeedResponse>(`/api/influencers/${activeId}/feed`),
    enabled: activeId != null,
    staleTime: 10 * 60_000,
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">인플루언서</CardTitle>
      </CardHeader>
      <CardContent>
        {list.isLoading && <Skeleton className="h-48 w-full" />}
        {list.isError && (
          <p className="text-destructive text-sm">
            {list.error instanceof ApiError ? list.error.message : "목록을 불러오지 못했습니다."}
          </p>
        )}
        {list.data && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[160px_1fr]">
            <ul className="flex gap-1.5 overflow-x-auto pb-1 sm:flex-col sm:overflow-visible sm:pb-0">
              {list.data.items.map((inf) => (
                <li key={inf.id} className="shrink-0 sm:shrink">
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(inf.id);
                      setExpandedVideoId(null);
                    }}
                    className={cn(
                      "w-full rounded-md border px-2.5 py-1.5 text-left text-sm whitespace-nowrap transition-colors sm:whitespace-normal",
                      inf.id === activeId
                        ? "border-primary bg-secondary"
                        : "border-border hover:bg-muted/50",
                    )}
                  >
                    {inf.name}
                  </button>
                </li>
              ))}
              {list.data.items.length === 0 && (
                <li className="text-muted-foreground text-sm">등록된 인플루언서가 없습니다.</li>
              )}
            </ul>
            <div className="min-w-0">
              {feed.isLoading && <Skeleton className="h-40 w-full" />}
              {feed.isError && (
                <p className="text-destructive text-sm">
                  {feed.error instanceof ApiError ? feed.error.message : "피드를 불러오지 못했습니다."}
                </p>
              )}
              {feed.data && (
                <ul className="divide-y">
                  {feed.data.items.map((it) => {
                    const videoId = it.platform === "youtube" ? youtubeVideoId(it.link) : null;
                    const isExpanded = videoId != null && videoId === expandedVideoId;
                    return (
                      <li key={it.link} className="py-2.5 first:pt-0 last:pb-0">
                        {videoId ? (
                          <button
                            type="button"
                            onClick={() => setExpandedVideoId(isExpanded ? null : videoId)}
                            className="group flex w-full min-w-0 flex-1 items-start gap-2 text-left"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="group-hover:text-primary line-clamp-2 text-sm leading-snug font-medium">
                                {it.title}
                              </div>
                              <div className="text-muted-foreground mt-1 flex items-center gap-x-2 text-xs">
                                <span>{PLATFORM_LABEL[it.platform]}</span>
                                <span>·</span>
                                <span className="tnum">{fmtAgo(it.publishedAt)}</span>
                                <span>{isExpanded ? "접기 ▲" : "재생 ▼"}</span>
                              </div>
                            </div>
                          </button>
                        ) : (
                          <a
                            href={it.link}
                            target="_blank"
                            rel="noreferrer"
                            className="group flex min-w-0 flex-1 items-start gap-2"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="group-hover:text-primary line-clamp-2 text-sm leading-snug font-medium">
                                {it.title}
                              </div>
                              <div className="text-muted-foreground mt-1 flex items-center gap-x-2 text-xs">
                                <span>{PLATFORM_LABEL[it.platform]}</span>
                                <span>·</span>
                                <span className="tnum">{fmtAgo(it.publishedAt)}</span>
                                <ExternalLink className="size-3" />
                              </div>
                            </div>
                          </a>
                        )}
                        {isExpanded && (
                          <div className="mt-2 aspect-video w-full overflow-hidden rounded-md bg-black">
                            <iframe
                              src={`https://www.youtube.com/embed/${videoId}?autoplay=1`}
                              title={it.title}
                              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                              allowFullScreen
                              className="h-full w-full"
                            />
                          </div>
                        )}
                      </li>
                    );
                  })}
                  {feed.data.items.length === 0 && (
                    <li className="text-muted-foreground py-4 text-sm">최근 게시물이 없습니다.</li>
                  )}
                </ul>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
