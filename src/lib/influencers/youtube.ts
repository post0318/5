import "server-only";
import { createHash } from "node:crypto";
import { isDbConfigured } from "@/lib/db";
import { getYoutubeVideosByChannel, upsertYoutubeVideos } from "@/lib/db/youtube-videos";

/**
 * YouTube Data API v3(공식, 개인용 무료 쿼터) — 채널의 "업로드" 재생목록에서
 * 최신 영상 목록만 가져온다(자막/본문 스크래핑 아님). 채널 URL(@핸들 또는
 * /channel/UC...)을 채널ID로 변환 → 업로드 재생목록ID 조회 → 최신 영상.
 */

const API_BASE = "https://www.googleapis.com/youtube/v3";

function apiKey(): string | null {
  return process.env.YOUTUBE_API_KEY ?? null;
}

export interface YoutubeVideo {
  title: string;
  link: string;
  publishedAt: string;
}

interface ChannelRef {
  channelId?: string;
  handle?: string;
}

/** /channel/UC... 또는 /@handle 형식만 지원(레거시 /c/, /user/ 커스텀 URL은 미지원) */
function extractChannelRef(youtubeUrl: string): ChannelRef | null {
  const chMatch = youtubeUrl.match(/youtube\.com\/channel\/(UC[\w-]+)/);
  if (chMatch) return { channelId: chMatch[1] };
  // 핸들은 한글 등 유니코드도 허용됨(예: @한경글로벌마켓) — \w 는 ASCII만
  // 매칭해서 이런 핸들을 놓쳤음 (2026-09 수정). 다음 경로 구분자 전까지 전부.
  const handleMatch = youtubeUrl.match(/youtube\.com\/@([^/?#]+)/);
  if (handleMatch) return { handle: decodeURIComponent(handleMatch[1]) };
  return null;
}

/** 핸들→채널ID(및 업로드 재생목록ID) 매핑은 거의 안 바뀌므로 24시간 캐시 */
async function resolveUploadsPlaylistId(ref: ChannelRef, key: string): Promise<string | null> {
  const qs = new URLSearchParams({ part: "contentDetails", key });
  if (ref.channelId) qs.set("id", ref.channelId);
  else if (ref.handle) qs.set("forHandle", `@${ref.handle}`);
  else return null;
  try {
    const res = await fetch(`${API_BASE}/channels?${qs.toString()}`, {
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 60 * 60 * 24 },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      items?: { contentDetails?: { relatedPlaylists?: { uploads?: string } } }[];
    };
    return j.items?.[0]?.contentDetails?.relatedPlaylists?.uploads ?? null;
  } catch {
    return null;
  }
}

/** 채널 URL → 채널ID·업로드 재생목록ID(업로드 재생목록 "UU…" 의 뒤쪽이 채널ID "UC…" 와 같다) */
export async function resolveYoutubeChannel(youtubeUrl: string): Promise<{ channelId: string; uploads: string } | null> {
  const key = apiKey();
  if (!key) return null;
  const ref = extractChannelRef(youtubeUrl);
  if (!ref) return null;
  const uploads = await resolveUploadsPlaylistId(ref, key);
  if (!uploads?.startsWith("UU")) return null;
  return { channelId: `UC${uploads.slice(2)}`, uploads };
}

/** 공식 API 로 업로드 재생목록 최신 영상(videoId 포함) — 화면 폴백·하루 1회 동기화용 */
export async function fetchYoutubeVideosApi(
  uploads: string,
  limit = 10,
): Promise<{ videoId: string; title: string; publishedAt: string }[]> {
  const key = apiKey();
  if (!key) return [];
  try {
    const qs = new URLSearchParams({ part: "snippet", playlistId: uploads, maxResults: String(limit), key });
    const res = await fetch(`${API_BASE}/playlistItems?${qs.toString()}`, {
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 900 },
    });
    if (!res.ok) return [];
    const j = (await res.json()) as {
      items?: { snippet?: { title?: string; publishedAt?: string; resourceId?: { videoId?: string } } }[];
    };
    return (j.items ?? [])
      .map((it) => ({
        videoId: it.snippet?.resourceId?.videoId ?? "",
        title: it.snippet?.title ?? "",
        publishedAt: it.snippet?.publishedAt ?? "",
      }))
      .filter((v) => v.videoId && v.title && v.publishedAt)
      .slice(0, limit);
  } catch {
    return [];
  }
}

const toVideo = (v: { _id?: string; videoId?: string; title: string; publishedAt: string }): YoutubeVideo => ({
  title: v.title,
  link: `https://www.youtube.com/watch?v=${v.videoId ?? v._id}`,
  publishedAt: v.publishedAt,
});

/**
 * 화면용 최신 영상 — DB(youtube_videos, 새 영상 알림이 즉시 채움) 를 먼저 읽고, 비어 있으면 공식 API(15분 캐시)로 받아 저장한다
 * (2026-10-03 오너 지시 "즉시 적용").
 */
export async function fetchYoutubeVideos(youtubeUrl: string, limit = 10): Promise<YoutubeVideo[]> {
  const ch = await resolveYoutubeChannel(youtubeUrl);
  if (!ch) return [];
  if (isDbConfigured()) {
    const docs = await getYoutubeVideosByChannel(ch.channelId, limit).catch(() => []);
    if (docs.length) return docs.map(toVideo);
  }
  const live = await fetchYoutubeVideosApi(ch.uploads, limit);
  if (isDbConfigured() && live.length) {
    await upsertYoutubeVideos(live.map((v) => ({ _id: v.videoId, channelId: ch.channelId, title: v.title, publishedAt: v.publishedAt }))).catch(() => 0);
  }
  return live.map(toVideo);
}

/** 새 영상 알림(WebSub) 서명 비밀값 — CRON_SECRET 에서 파생(따로 관리할 비밀값을 늘리지 않는다). 없으면 알림을 받지 않는다 */
export function youtubeHubSecret(): string | null {
  const base = process.env.CRON_SECRET;
  if (!base) return null;
  return createHash("sha256").update(`youtube-websub:${base}`).digest("hex").slice(0, 40);
}
