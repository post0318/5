import { createHmac, timingSafeEqual } from "node:crypto";
import { isDbConfigured } from "@/lib/db";
import { upsertYoutubeVideos } from "@/lib/db/youtube-videos";
import { loadInfluencers } from "@/lib/influencers/store";
import { resolveYoutubeChannel, youtubeHubSecret } from "@/lib/influencers/youtube";

/**
 * 유튜브 새 영상 알림 받는 곳(WebSub/PubSubHubbub — 유튜브 공식, 무료). 2026-10-03 오너 지시 "즉시 적용".
 * 구독은 /api/cron/youtube-subscribe 가 하루 1회 갱신한다(구독 유효기간이 며칠이라). 메인 서버(오라클) 주소로만 구독한다.
 *  - GET : 구독 확인 — 우리 인플루언서 채널 주소일 때만 hub.challenge 를 그대로 돌려준다.
 *  - POST: 새 영상(Atom) — 구독 때 준 비밀값으로 서명(X-Hub-Signature, sha1)을 확인한 뒤 youtube_videos 에 저장.
 */
export const dynamic = "force-dynamic";

async function ourChannelIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const inf of await loadInfluencers()) {
    if (!inf.youtubeUrl) continue;
    const ch = await resolveYoutubeChannel(inf.youtubeUrl);
    if (ch) ids.add(ch.channelId);
  }
  return ids;
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const challenge = sp.get("hub.challenge");
  const topic = sp.get("hub.topic") ?? "";
  const channelId = topic.match(/channel_id=(UC[\w-]+)/)?.[1];
  if (!challenge || !channelId || !(await ourChannelIds()).has(channelId)) {
    return new Response("unknown topic", { status: 404 });
  }
  return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
}

const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1] ?? null;
const unescape = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

export async function POST(req: Request) {
  const body = await req.text();
  const secret = youtubeHubSecret();
  if (!secret) return new Response("not configured", { status: 503 });
  const sig = req.headers.get("x-hub-signature") ?? "";
  const expect = `sha1=${createHmac("sha1", secret).update(body).digest("hex")}`;
  const ok = sig.length === expect.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expect));
  // 서명이 틀려도 2xx 를 돌려준다(WebSub 규칙 — 허브가 재시도하지 않게). 저장만 하지 않는다.
  if (!ok) return new Response(null, { status: 202 });
  if (!isDbConfigured()) return new Response(null, { status: 202 });

  const ours = await ourChannelIds();
  const docs = [...body.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map(([, e]) => ({
      _id: tag(e, "yt:videoId") ?? "",
      channelId: tag(e, "yt:channelId") ?? "",
      title: unescape(tag(e, "title") ?? ""),
      publishedAt: tag(e, "published") ?? "",
    }))
    .filter((d) => d._id && d.title && d.publishedAt && ours.has(d.channelId));
  await upsertYoutubeVideos(docs).catch(() => 0);
  return new Response(null, { status: 204 });
}
