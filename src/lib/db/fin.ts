import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";

/**
 * 재무 5층 구조 저장소(docs/metrics/architecture.md §3) — 유니버스 종목만. 압축형(짧은 필드명).
 *  - fin_sym  : 종목 메타 + 열 머리글(출처) + 지표 시계열
 *  - fin_stmt : 재무제표 × 주기의 줄 사전 + 열별 구조·값
 *  - fin_chg  : 바뀐 칸 1건 = 문서 1건(감사 추적, TTL 180일)
 */

/** 열 머리글 [열키, start, end, accn, form, filed, gaps] — 파생 열은 accn null, form "Q4D"|"QD"|"LTM" */
export type FinColTuple = [string, string, string, string | null, string, string | null, number];
export type FinExc = { d: [string, 1 | -1][] } | { k: "fx"; r: number } | { k: "yq"; t: string };

export interface FinSymDoc {
  _id: string; // "us:AAPL"
  ev: number;
  sv: number;
  at: Date;
  la: string | null;
  p: { t: string; fl: string; sic: number | null; cur: string; adr: number };
  g: number;
  c: FinColTuple[];
  m: Record<string, (number | null)[]>;
  x: Record<string, Record<string, FinExc>>;
  /** 배치가 "새 정기공시 없음"을 마지막으로 확인한 시각(/api/cron/fin-build) */
  ck?: Date;
  /**
   * 조립 항등식 불성립 [열키, 매출 경로 불성립(그 열 매출 비움), 매출 외 줄 불성립(값 유지), 매출 경로 판정 불완전(값 유지 ·
   * "항등식 미검증" — 엔진판 4부터, 없으면 빈 목록)] — 없으면 생략
   */
  i?: [string, string[], string[], string[]?][];
}

export interface FinStmtDoc {
  _id: string; // "us:AAPL:is:a"
  ev: number;
  l: [string, string][];
  c: string[];
  s: number[][];
  v: (number | null)[][];
}

export interface FinChgDoc {
  k: string;
  at: Date;
  ev: number;
  t: string;
  c: string;
  o: number | null;
  n: number | null;
  r: "ev" | "data";
}

let indexed = false;
async function ensureIndexes(): Promise<void> {
  if (indexed) return;
  const db = await getDb();
  await db.collection("fin_chg").createIndex({ k: 1, at: -1 }).catch(() => {});
  await db.collection("fin_chg").createIndex({ at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 180 }).catch(() => {});
  indexed = true;
}

export async function finSymCol(): Promise<Collection<FinSymDoc>> {
  return (await getDb()).collection<FinSymDoc>("fin_sym");
}
export async function finStmtCol(): Promise<Collection<FinStmtDoc>> {
  return (await getDb()).collection<FinStmtDoc>("fin_stmt");
}
export async function finChgCol(): Promise<Collection<FinChgDoc>> {
  await ensureIndexes();
  return (await getDb()).collection<FinChgDoc>("fin_chg");
}
