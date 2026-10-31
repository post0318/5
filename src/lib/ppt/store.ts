import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "@/lib/db";

/**
 * 발표자료 회사별 설정 — 공용(오너 2026-10-31 발표 6: 한 사람이 정하면 모두 같이 쓴다, 계정 무관).
 * 키 = 시장 + 종목코드. 바뀔 때마다 변경 기록(누가·언제·무엇을·어떤 방식)을 남긴다.
 *
 * 컬렉션
 *   ppt_company      종목별 설정 한 문서(_id "kr:005930")
 *   ppt_company_log  변경 기록(2년 TTL)
 *   ppt_ai_usage     Claude API 호출 기록 — 토큰·검색 수·추정 비용(400일 TTL), 월 상한 검사에 씀
 */

export type PptMarket = "kr" | "us" | "jp";

export interface PptSource {
  /** 조사기관·매체·증권사 이름 */
  org: string;
  title: string;
  /** YYYY-MM-DD (모르면 YYYY-MM) */
  publishedAt: string;
  url: string;
}

export interface PptShareRow {
  name: string;
  /** 0~1 */
  value: number;
}

export interface PptShare {
  /** 사업(점유율 칸 제목에 쓰는 시장 이름, 예 「글로벌 D램」) */
  business: string;
  /** 기준 시점(예 「2026년 2분기」) */
  asOf: string;
  rows: PptShareRow[];
  sources: PptSource[];
  /** 숫자가 출처 본문에서 확인됐는지(API 채우기 = 웹검색 인용문 대조, 커넥터 = 출처 주소 본문 대조) */
  verified: "confirmed" | "unconfirmed";
  warnings: string[];
}

export type PptPointKind = "founding" | "business" | "thesis";
export interface PptPoint {
  kind: PptPointKind;
  text: string;
  sources: PptSource[];
}

export type PptVia = "claude-api" | "claude-connector" | "person";

export interface PptStamp {
  at: string;
  by: string;
  via: PptVia;
}

export interface PptCompanyDoc {
  _id: string;
  market: PptMarket;
  symbol: string;
  share?: (PptShare & PptStamp) | null;
  /** 같은 사업의 다른 값 — 사업보고서 본문 자사 점유율과 다르거나 기존 값과 크게 달라 사람이 골라야 할 때(고르기 전에는 슬라이드에 안 씀) */
  shareCandidates?: (PptShare & PptStamp)[];
  points?: { lines: PptPoint[] } & PptStamp;
  updatedAt: string;
}

export interface PptCompanyLogDoc {
  key: string;
  field: "share" | "shareCandidates" | "points";
  before: unknown;
  after: unknown;
  at: Date;
  by: string;
  via: PptVia;
}

export interface PptAiUsageDoc {
  at: Date;
  key: string;
  model: string;
  servedBy: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
  costUsd: number;
  ok: boolean;
  note: string | null;
}

const LOG_TTL_S = 2 * 365 * 86400;
/** 시험 전용 컬렉션 이름 앞붙이(가짜 응답 시험이 2호기 검증 DB 에 test_ppt_* 로만 쓰고 지운다). 운영에서는 비어 있다. */
const P = process.env.PPT_COLLECTION_PREFIX ?? "";
const USAGE_TTL_S = 400 * 86400;

export const companyKey = (market: string, symbol: string) => `${market}:${symbol}`;

export async function pptCompanyCol(): Promise<Collection<PptCompanyDoc>> {
  return (await getDb()).collection<PptCompanyDoc>(`${P}ppt_company`);
}

async function logCol(): Promise<Collection<PptCompanyLogDoc>> {
  const col = (await getDb()).collection<PptCompanyLogDoc>(`${P}ppt_company_log`);
  await col.createIndex({ at: 1 }, { expireAfterSeconds: LOG_TTL_S });
  await col.createIndex({ key: 1, at: -1 });
  return col;
}

export async function pptUsageCol(): Promise<Collection<PptAiUsageDoc>> {
  const col = (await getDb()).collection<PptAiUsageDoc>(`${P}ppt_ai_usage`);
  await col.createIndex({ at: 1 }, { expireAfterSeconds: USAGE_TTL_S });
  return col;
}

export async function getCompany(market: string, symbol: string): Promise<PptCompanyDoc | null> {
  return (await pptCompanyCol()).findOne({ _id: companyKey(market, symbol) });
}

/** 한 필드를 바꾸고 변경 기록을 남긴다. */
export async function setCompanyField<F extends "share" | "shareCandidates" | "points">(
  market: PptMarket,
  symbol: string,
  field: F,
  value: PptCompanyDoc[F],
  stamp: Omit<PptStamp, "at">,
): Promise<void> {
  const col = await pptCompanyCol();
  const key = companyKey(market, symbol);
  const before = await col.findOne({ _id: key }, { projection: { [field]: 1 } });
  const now = new Date();
  await col.updateOne(
    { _id: key },
    { $set: { [field]: value, market, symbol, updatedAt: now.toISOString() } },
    { upsert: true },
  );
  await (await logCol()).insertOne({
    key,
    field,
    before: (before as Record<string, unknown> | null)?.[field] ?? null,
    after: value ?? null,
    at: now,
    by: stamp.by,
    via: stamp.via,
  });
}

/** 이번 달(UTC) Claude API 추정 비용 합 */
export async function monthSpendUsd(now = new Date()): Promise<number> {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const r = await (await pptUsageCol())
    .aggregate<{ sum: number }>([{ $match: { at: { $gte: from } } }, { $group: { _id: null, sum: { $sum: "$costUsd" } } }])
    .toArray();
  return r[0]?.sum ?? 0;
}
