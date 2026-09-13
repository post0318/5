import "server-only";

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

export async function fetchYoutubeVideos(youtubeUrl: string, limit = 10): Promise<YoutubeVideo[]> {
  const key = apiKey();
  if (!key) return [];
  const ref = extractChannelRef(youtubeUrl);
  if (!ref) return [];
  const uploadsPlaylistId = await resolveUploadsPlaylistId(ref, key);
  if (!uploadsPlaylistId) return [];
  try {
    const qs = new URLSearchParams({
      part: "snippet",
      playlistId: uploadsPlaylistId,
      maxResults: String(limit),
      key,
    });
    const res = await fetch(`${API_BASE}/playlistItems?${qs.toString()}`, {
      signal: AbortSignal.timeout(8000),
      next: { revalidate: 900 },
    });
    if (!res.ok) return [];
    const j = (await res.json()) as {
      items?: { snippet?: { title?: string; publishedAt?: string; resourceId?: { videoId?: string } } }[];
    };
    return (j.items ?? [])
      .map((it) => {
        const videoId = it.snippet?.resourceId?.videoId;
        const title = it.snippet?.title;
        const publishedAt = it.snippet?.publishedAt;
        if (!videoId || !title || !publishedAt) return null;
        return { title, link: `https://www.youtube.com/watch?v=${videoId}`, publishedAt };
      })
      .filter((x): x is YoutubeVideo => x != null)
      .slice(0, limit);
  } catch {
    return [];
  }
}
