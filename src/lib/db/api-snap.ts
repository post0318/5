import "server-only";
import type { Collection } from "mongodb";
import { getDb, isDbConfigured } from "./index";
import { ttmSnapVersion } from "./ttm-snap";

/**
 * 화면 응답 저장본(api_snap, 2026-10-02 — 배포마다 CDN 캐시가 비어 미국 하이라이트 첫 조회가 8초씩 걸리던 문제, 오너 지적 KO). TTM 저장본
 * (ttm-snap.ts)과 같은 방식: 24시간 안 저장본은 배포판이 달라도 먼저 바로 쓰고, 배포판이 다르거나 1시간이 지났으면 응답 뒤에 다시 계산해
 * 덮어쓴다(주가에 따라 바뀌는 시가총액·EV 가 하루 묵지 않게). 불완전한 결과(SEC 조회 경고)는 저장하지 않는다.
 */
export interface ApiSnapDoc {
  _id: string;
  v: string;
  at: Date;
  data: unknown;
}
const MAX_AGE_MS = 24 * 3_600_000;
const REFRESH_MS = 3_600_000;

async function col(): Promise<Collection<ApiSnapDoc>> {
  return (await getDb()).collection<ApiSnapDoc>("api_snap");
}

/** 24시간 안 저장본 — stale = 배포판이 다르거나 1시간 지남(응답 뒤 다시 계산할 것) */
export async function readApiSnap<T>(key: string): Promise<{ data: T; stale: boolean } | null> {
  if (!isDbConfigured()) return null;
  const d = await (await col()).findOne({ _id: key });
  if (!d) return null;
  // 운영과 로컬이 같은 DB 를 쓴다 — 다른 환경(로컬 ↔ 운영)이 쓴 저장본은 읽지 않는다(2026-10-02: 로컬 시험이 새 형식으로 쓴 저장본을
  // 운영 옛 코드가 읽어 MU 등 종목분석 화면이 깨졌다)
  if ((d.v === "local") !== (ttmSnapVersion() === "local")) return null;
  const age = Date.now() - d.at.getTime();
  if (age > MAX_AGE_MS) return null;
  return { data: d.data as T, stale: d.v !== ttmSnapVersion() || age > REFRESH_MS };
}

export async function writeApiSnap(key: string, data: unknown): Promise<void> {
  if (!isDbConfigured()) return;
  await (await col()).updateOne({ _id: key }, { $set: { v: ttmSnapVersion(), at: new Date(), data } }, { upsert: true });
}
