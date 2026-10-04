import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { upsertYoutubeVideos } from "@/lib/db/youtube-videos";
import { loadInfluencers } from "@/lib/influencers/store";
import { fetchYoutubeVideosApi, resolveYoutubeChannel, youtubeHubSecret } from "@/lib/influencers/youtube";

/**
 * 유튜브 새 영상 알림(WebSub) 구독 갱신 + 최신 목록 동기화 — 오라클 타이머가 하루 1회 부른다(2026-10-03).
 *  - 인플루언서 채널마다 Google 허브(pubsubhubbub.appspot.com)에 "새 영상이 올라오면 콜백 주소로 알려 달라"고 구독한다.
 *    구독은 며칠 뒤 만료되므로 매일 다시 건다(같은 구독을 다시 걸면 기간만 연장된다).
 *  - 알림을 놓쳤을 때를 대비해 공식 API 로 최신 10개를 받아 DB 에 맞춘다(채널당 API 1~2회 — 쿼터 하루 1만 중 극히 일부).
 * 콜백 주소는 APP_URL(메인 서버) — 없으면 요청 주소 기준.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const appPw = process.env.APP_PASSWORD;
  if (appPw && req.headers.get("x-app-token") === appPw) return true;
  if (secret) return req.headers.get("authorization") === `Bearer ${secret}`;
  return false;
}

const HUB = "https://pubsubhubbub.appspot.com/subscribe";

export async function GET(req: Request) {
  try {
    if (!authorized(req)) return Response.json({ error: "인증 필요" }, { status: 401 });
    const secret = youtubeHubSecret();
    if (!secret) return Response.json({ error: "CRON_SECRET 미설정" }, { status: 503 });
    const base = (process.env.PUBLIC_APP_URL || new URL(req.url).origin).replace(/\/+$/, "");
    const callback = `${base}/api/webhooks/youtube`;

    const results: { url: string; channelId?: string; subscribe?: number; synced?: number; error?: string }[] = [];
    for (const inf of await loadInfluencers()) {
      if (!inf.youtubeUrl) continue;
      const ch = await resolveYoutubeChannel(inf.youtubeUrl);
      if (!ch) {
        results.push({ url: inf.youtubeUrl, error: "채널 해석 실패" });
        continue;
      }
      const form = new URLSearchParams({
        "hub.callback": callback,
        "hub.topic": `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${ch.channelId}`,
        "hub.verify": "async",
        "hub.mode": "subscribe",
        "hub.secret": secret,
        "hub.lease_seconds": String(10 * 24 * 3600),
      });
      const sub = await fetch(HUB, { method: "POST", body: form, signal: AbortSignal.timeout(15_000) })
        .then((r) => r.status)
        .catch(() => 0);
      let synced = 0;
      if (isDbConfigured()) {
        const live = await fetchYoutubeVideosApi(ch.uploads, 10);
        synced = await upsertYoutubeVideos(
          live.map((v) => ({ _id: v.videoId, channelId: ch.channelId, title: v.title, publishedAt: v.publishedAt })),
        ).catch(() => 0);
      }
      results.push({ url: inf.youtubeUrl, channelId: ch.channelId, subscribe: sub, synced });
    }
    return ok({ callback, results });
  } catch (err) {
    return jsonError(err);
  }
}
