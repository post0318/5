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
/**
 * 파생값 입력 1건(architecture.md §2.1·§3.2) — [참조, 부호, 역할, 시장값, asOf 번호, 환율 참조, 환율, 환율 asOf 번호]. 뒤쪽 null 은
 * 잘라 저장. asOf 번호 = FinDer.a 의 위치(같은 조회 시각을 한 번만 저장). 값 = Σ 부호 × 값(참조) × 환율.
 */
export type FinDerIn = [string, 1 | -1, (string | null)?, (number | null)?, (number | null)?, (string | null)?, (number | null)?, (number | null)?];
/**
 * 파생값 입력 — rev·cogs·gp·opinc·opex: 열키 → 그 지표 입력, ln: "열키|줄id" → 지표 입력이 참조한 파생 칸의 입력(재귀 전개), a: asOf 표,
 * at: 계산 시각. cogs·gp 는 엔진판 6부터(docs/metrics/cogs.md)
 */
export interface FinDer {
  rev: Record<string, FinDerIn[]>;
  cogs?: Record<string, FinDerIn[]>;
  gp?: Record<string, FinDerIn[]>;
  opinc?: Record<string, FinDerIn[]>;
  opex?: Record<string, FinDerIn[]>;
  /**
   * 같은 열 칸만 가리키는 입력 틀(엔진판 6부터, cogs·gp·opinc·opex) — 지표 키 → [틀, 열키[]][]. 틀의 참조 `c:*|줄id` 의 "*" 는 그 열
   * 키(예: 영업비용 = `c:*|us-gaap:GrossProfit` − `c:*|us-gaap:OperatingIncomeLoss`). 여기 묶인 열은 지표 키 사전(cogs 등)에 따로 없다
   */
  tp?: Record<string, [FinDerIn[], string[]][]>;
  ln?: Record<string, FinDerIn[]>;
  a?: string[];
  at: string;
}

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
  /** 파생값 입력(엔진판 5부터) — 없으면 파생값 없음 */
  d?: FinDer;
  /**
   * 지표 칸의 사유·주석(엔진판 6부터) — 지표 키(cogs·gp·opinc·opex) → [문구, 열키[]][]. 빈칸 사유("구성 규칙 대기 — …")와 값 있는 칸의 정의 메모
   * ("본표 소계 없음 · 매출 − 매출원가", "회사 공시 자체 — …")를 문구 한 번 + 열 목록으로 압축해 둔다
   */
  n?: Record<string, [string, string[]][]>;
  /** 배치가 "새 정기공시 없음"을 마지막으로 확인한 시각(/api/cron/fin-build) */
  ck?: Date;
  /**
   * 조립 항등식 불성립 [열키, 매출 경로 불성립(그 열 매출 비움), 매출 외 줄 불성립(값 유지), 매출 경로 판정 불완전(값 유지 ·
   * "항등식 미검증" — 엔진판 4부터, 없으면 빈 목록), 파생값 입력 자기 검사 불일치(값 유지 — 엔진판 5부터, 없으면 생략)] — 없으면 생략
   */
  i?: [string, string[], string[], string[]?, string[]?][];
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
