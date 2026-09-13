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

/** https://t.me/username/123 → "username/123". 텔레그램도 공개 채널 게시물은
 * 공식 포스트 위젯(telegram.org/js/telegram-widget.js)으로 인라인 임베드
 * 가능 — Twitter/X 임베드와 같은 방식(스크립트 태그가 자기 자리를 iframe으로
 * 교체) (2026-09) */
function telegramPostId(link: string): string | null {
  const m = link.match(/t\.me\/([\w.]+)\/(\d+)/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** telegram-widget.js 는 <script data-telegram-post> 를 직접 DOM에 넣어야
 * 실행된다 — dangerouslySetInnerHTML 로 넣은 <script> 는 브라우저가 실행하지
 * 않으므로 콜백 ref로 수동 삽입. 같은 postId 로 중복 삽입되는 것만 막는다. */
function mountTelegramWidget(container: HTMLDivElement, postId: string) {
  if (container.dataset.loadedPost === postId) return;
  container.innerHTML = "";
  const script = document.createElement("script");
  script.async = true;
  script.src = "https://telegram.org/js/telegram-widget.js?22";
  script.setAttribute("data-telegram-post", postId);
  script.setAttribute("data-width", "100%");
  container.appendChild(script);
  container.dataset.loadedPost = postId;
}

/**
 * 인플루언서(블로거/유튜버/텔레그램) 트래킹 — 좌측 인플루언서 목록, 우측에
 * 선택한 인플루언서의 최근 게시물(블로그·유튜브·텔레그램). 유튜브·텔레그램은
 * 화면 내 인라인 임베드(각각 공식 embed/위젯), 블로그(네이버)만 iframe이
 * 막혀 있어 새 탭으로 원문 이동. 목록은 markdown 파일
 * (lib/influencers/influencers.md) 관리 — 오너 확인, 2026-09.
 */
export function InfluencerPanel() {
  const list = useQuery({
    queryKey: ["influencers"],
    queryFn: () => apiFetch<InfluencerListResponse>("/api/influencers"),
    staleTime: 60 * 60_000,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [expandedLink, setExpandedLink] = useState<string | null>(null);
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
                      setExpandedLink(null);
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
                    const tgPostId = it.platform === "telegram" ? telegramPostId(it.link) : null;
                    const embeddable = videoId != null || tgPostId != null;
                    const isExpanded = embeddable && expandedLink === it.link;
                    return (
                      <li key={it.link} className="py-2.5 first:pt-0 last:pb-0">
                        {embeddable ? (
                          <button
                            type="button"
                            onClick={() => setExpandedLink(isExpanded ? null : it.link)}
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
                                <span>{isExpanded ? "접기 ▲" : "보기 ▼"}</span>
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
                        {isExpanded && videoId && (
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
                        {isExpanded && tgPostId && (
                          <div
                            className="mt-2 overflow-hidden rounded-md"
                            ref={(el) => {
                              if (el) mountTelegramWidget(el, tgPostId);
                            }}
                          />
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
