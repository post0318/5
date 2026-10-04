import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";

/**
 * 인플루언서 유튜브 영상 목록(제목·링크·게시 시각만 — 자막·본문 없음). 2026-10-03 오너 지시 "즉시 적용":
 * 유튜브 공식 알림(WebSub)이 새 영상을 /api/webhooks/youtube 로 바로 밀어주면 여기 저장하고, 화면은 DB 를 읽는다.
 * 하루 1회 구독 갱신(/api/cron/youtube-subscribe) 때 공식 API 로 최신 목록도 한 번 맞춰 둔다(알림을 놓쳐도 보충).
 * 세 서버(오라클·구글·Vercel)가 같은 DB 를 읽으므로 어느 쪽에서 봐도 같다.
 */
export interface YoutubeVideoDoc {
  _id: string; // videoId
  channelId: string;
  title: string;
  publishedAt: string; // ISO
  updatedAt: string;
}

const MAX_AGE_MS = 180 * 24 * 3600_000;

export async function youtubeVideosCol(): Promise<Collection<YoutubeVideoDoc>> {
  const col = (await getDb()).collection<YoutubeVideoDoc>("youtube_videos");
  await col.createIndex({ channelId: 1, publishedAt: -1 }).catch(() => {});
  return col;
}

export async function upsertYoutubeVideos(docs: Omit<YoutubeVideoDoc, "updatedAt">[]): Promise<number> {
  if (!docs.length) return 0;
  const col = await youtubeVideosCol();
  const now = new Date().toISOString();
  const r = await col.bulkWrite(
    docs.map((d) => ({ updateOne: { filter: { _id: d._id }, update: { $set: { ...d, updatedAt: now } }, upsert: true } })),
    { ordered: false },
  );
  await col.deleteMany({ publishedAt: { $lt: new Date(Date.now() - MAX_AGE_MS).toISOString() } });
  return r.upsertedCount + r.modifiedCount;
}

export async function getYoutubeVideosByChannel(channelId: string, limit: number): Promise<YoutubeVideoDoc[]> {
  const col = await youtubeVideosCol();
  return col.find({ channelId }).sort({ publishedAt: -1 }).limit(limit).toArray();
}
