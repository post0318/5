import "server-only";
import { createHash } from "node:crypto";
import type { Collection } from "mongodb";
import { getDb } from "./index";

/**
 * 뉴스 헤드라인 번역 결과 캐시 — MongoDB 영속화(2026-09 추가).
 *
 * translate.ts 의 인메모리 Map 캐시만으로는 서버리스 인스턴스가 바뀌거나
 * (Vercel Fluid Compute도 콜드스타트는 있음) `/api/news/market` 의 HTTP
 * s-maxage 캐시가 실제로는 안 먹히는 경우(오너 지적, 2026-09 — "새로고침할
 * 때마다 번역이 달라지는데 LLM 비용이 계속 쓰는거 아닌가?" — 같은 헤드라인이
 * 매 요청마다 새로 번역되고 있었다는 뜻, LLM 폴백 특성상 매번 문구도 살짝
 * 달라짐) 같은 헤드라인을 반복해서 무료 API·LLM에 다시 요청하게 된다 —
 * 무료 API는 낭비, LLM 폴백은 실제 비용. DB에 한 번 성공한 번역을 영속
 * 저장해 인스턴스·캐시 상태와 무관하게 항상 재사용한다.
 *
 * 실패는 저장하지 않음(대부분 일시적 오류 — 다음 요청에서 재시도 되게).
 * _id 는 원문이 길 수 있어 그대로 안 쓰고 해시.
 */
export interface TranslationCacheDoc {
  _id: string; // sha256(`${sl}:${text}`)
  sl: "en" | "ja";
  text: string; // 디버깅용 원문 보존(짧으니 그대로)
  ko: string;
  ok: boolean;
  createdAt: string;
}

// 90일이면 뉴스 헤드라인 재사용 목적엔 충분하고 컬렉션이 무한정 안 커짐.
const MAX_AGE_MS = 90 * 24 * 3600_000;

function cacheKey(sl: "en" | "ja", text: string): string {
  return createHash("sha256").update(`${sl}:${text}`).digest("hex");
}

export async function translationCacheCol(): Promise<Collection<TranslationCacheDoc>> {
  const db = await getDb();
  return db.collection<TranslationCacheDoc>("translation_cache");
}

export async function getCachedTranslation(
  sl: "en" | "ja",
  text: string,
): Promise<{ ko: string; ok: boolean } | null> {
  try {
    const col = await translationCacheCol();
    const doc = await col.findOne({ _id: cacheKey(sl, text) });
    if (!doc) return null;
    return { ko: doc.ko, ok: doc.ok };
  } catch {
    return null; // DB 장애로 캐시 조회가 안 되면 번역 자체는 계속 시도(무료 API 폴백)
  }
}

export async function setCachedTranslation(
  sl: "en" | "ja",
  text: string,
  ko: string,
  ok: boolean,
): Promise<void> {
  try {
    const col = await translationCacheCol();
    await col.updateOne(
      { _id: cacheKey(sl, text) },
      { $set: { sl, text, ko, ok, createdAt: new Date().toISOString() } },
      { upsert: true },
    );
    // 정리는 쓰기 시점에 가끔 곁들이는 정도로 충분(트래픽이 크지 않은 개인용 앱).
    const cutoff = new Date(Date.now() - MAX_AGE_MS).toISOString();
    await col.deleteMany({ createdAt: { $lt: cutoff } });
  } catch {
    // 캐시 저장 실패는 무시 — 다음 요청에서 다시 번역 시도될 뿐 기능 자체는 안전.
  }
}
