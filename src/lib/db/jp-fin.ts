import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";
import type { JpFinModel } from "@/lib/markets/jp/statements";

/**
 * **일본 재무제표 조립 저장본**(오너 결정 2026-10-08 — 디스크캐시 + DB, "DB 용량 반드시 고려"). 종목당 1건.
 *  _id = "jp:{티커}", ev = 조립 엔진판(statements.ts JP_FIN_ENGINE), sig = 쓴 서류 목록 서명(판독판 + docID 정렬) — 둘 다 같아야 유효.
 *  m = 화면용 압축 꼴(줄 [id, 이름표, 들여쓰기, 표시], 값 줄 × 열, 칸 주석 사전) — XBRL 원본·사실 전체는 저장하지 않는다(원본은 디스크).
 *  한 건 ≈ 30~60KB. 조회된 종목만 생긴다(전 종목 일괄 생성 안 함). 너무 크면(256KB 초과) 저장하지 않고 경고만.
 */
export interface JpFinDoc {
  _id: string;
  ev: number;
  sig: string;
  at: Date;
  m: JpFinModel;
}
const MAX_BYTES = 256 * 1024;

export async function jpFinCol(): Promise<Collection<JpFinDoc>> {
  return (await getDb()).collection<JpFinDoc>("jp_fin");
}

/** 저장본 — 엔진판·서명이 같을 때만. DB 조회 실패는 던진다 */
export async function getJpFinStored(id: string, ev: number, sig: string): Promise<JpFinModel | null> {
  const d = await (await jpFinCol()).findOne({ _id: id, ev, sig }, { projection: { m: 1 } });
  return d?.m ?? null;
}

/** 저장(교체). 크기 초과는 저장하지 않고 경고. 쓰기 실패는 화면 결과와 무관 — 경고만 남기고 다음 요청이 다시 조립 */
export async function saveJpFin(id: string, ev: number, sig: string, m: JpFinModel): Promise<void> {
  const size = Buffer.byteLength(JSON.stringify(m));
  if (size > MAX_BYTES) {
    console.warn(`[jp_fin] ${id} 저장 안 함 — ${Math.round(size / 1024)}KB > ${MAX_BYTES / 1024}KB`);
    return;
  }
  try {
    await (await jpFinCol()).replaceOne({ _id: id }, { ev, sig, at: new Date(), m }, { upsert: true });
  } catch (e) {
    console.warn(`[jp_fin] ${id} 저장 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
}
