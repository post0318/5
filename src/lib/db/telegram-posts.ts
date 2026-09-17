import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";

/**
 * 텔레그램 채널 게시물 — 개인 계정 세션(scripts/collect-telegram-posts.mjs,
 * 로컬 전용)으로 수집한 결과만 저장. 세션 자체는 계정 전체 권한이라 배포
 * 앱에는 절대 안 들어가고, 여기 이 컬렉션 읽기만 노출됨(다른 리서치 소스와
 * 동일한 "로컬 수집 → DB 적재 → 배포 앱은 조회만" 구조, 2026-09).
 * 원문 전체가 아니라 짧은 발췌만 저장(다른 리서치 소스와 동일 정책).
 */
export interface TelegramPostDoc {
  _id: string; // `${channelUsername}:${messageId}`
  channelUsername: string;
  channelTitle: string;
  text: string;
  link: string;
  publishedAt: string; // ISO
  collectedAt: string;
}

const MAX_AGE_MS = 90 * 24 * 3600_000;

export async function telegramPostsCol(): Promise<Collection<TelegramPostDoc>> {
  const db = await getDb();
  const col = db.collection<TelegramPostDoc>("telegram_posts");
  await col.createIndex({ channelUsername: 1, publishedAt: -1 }).catch(() => {});
  return col;
}

export async function upsertTelegramPosts(docs: TelegramPostDoc[]): Promise<{ upserted: number; pruned: number }> {
  const col = await telegramPostsCol();
  let upserted = 0;
  if (docs.length > 0) {
    const result = await col.bulkWrite(
      docs.map((d) => ({
        replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true },
      })),
      { ordered: false },
    );
    upserted = result.upsertedCount + result.modifiedCount;
  }
  const cutoff = new Date(Date.now() - MAX_AGE_MS).toISOString();
  const del = await col.deleteMany({ publishedAt: { $lt: cutoff } });
  return { upserted, pruned: del.deletedCount ?? 0 };
}

/**
 * 채널별로 이미 받아 둔 **가장 큰 글 번호**. 수집 스크립트가 그 뒤부터만
 * 이어받도록 커서로 쓴다(오너 지시 2026-09-17 — 실행이 밀린 사이 최신 N건을
 * 넘어선 글이 영구 누락되던 문제).
 *
 * `_id` 가 `${channelUsername}:${messageId}` 라 messageId 를 따로 저장하지
 * 않는다 — _id 뒤쪽을 잘라 숫자로 비교한다. 문자열 최대값은 자릿수가 다르면
 * 틀리므로(예: "9" > "10") 반드시 숫자로 변환해 비교한다.
 */
export async function getTelegramCursors(): Promise<Record<string, number>> {
  const col = await telegramPostsCol();
  const rows = await col
    .find({}, { projection: { _id: 1, channelUsername: 1 } })
    .toArray();
  const out: Record<string, number> = {};
  for (const r of rows) {
    const id = Number(String(r._id).split(":").pop());
    if (!Number.isFinite(id)) continue;
    const ch = r.channelUsername;
    if (!out[ch] || id > out[ch]) out[ch] = id;
  }
  return out;
}

export async function getTelegramPostsByChannel(
  channelUsername: string,
  limit = 10,
): Promise<TelegramPostDoc[]> {
  const col = await telegramPostsCol();
  return col.find({ channelUsername }).sort({ publishedAt: -1 }).limit(limit).toArray();
}
