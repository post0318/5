import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";

/**
 * 유니버스 통합 뷰 사전 계산 캐시 (prd.md §4 — "조회는 DB 우선").
 *  - 매일 배치가 종목별 요약을 계산해 upsert
 *  - 편집/삭제 시 해당 종목만 즉시 갱신
 *  - 조회 API 는 이 컬렉션만 읽어 즉시 응답 (외부 API 미호출)
 */

export interface UniverseOverviewDoc {
  _id: string; // `${market}:${symbol}`
  itemId: string;
  market: "kr" | "us" | "jp";
  symbol: string;
  yahooSymbol: string | null;
  name: string | null;
  groupName: string | null;
  tags: string[];
  last: number | null;
  changePct: number | null;
  currency: "KRW" | "USD" | "JPY" | null;
  per: number | null;
  pbr: number | null;
  forwardPer: number | null;
  targetMeanPrice: number | null;
  recommendationKey: string | null;
  marketCap: number | null;
  revenueAnnual: number | null;
  opMargin: number | null;
  netMargin: number | null;
  warnings: string[];
  error: string | null;
  updatedAt: string;
}

export async function universeOverviewCol(): Promise<Collection<UniverseOverviewDoc>> {
  const col = (await getDb()).collection<UniverseOverviewDoc>("universe_overview");
  await col.createIndex({ market: 1 }).catch(() => {});
  return col;
}

export async function readOverview(
  market?: "kr" | "us" | "jp",
): Promise<UniverseOverviewDoc[]> {
  const col = await universeOverviewCol();
  const q = market ? { market } : {};
  return col.find(q).sort({ market: 1, symbol: 1 }).toArray();
}

export async function writeOverview(docs: UniverseOverviewDoc[]): Promise<number> {
  if (docs.length === 0) return 0;
  const col = await universeOverviewCol();
  const res = await col.bulkWrite(
    docs.map((d) => ({
      replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true },
    })),
  );
  return res.upsertedCount + res.modifiedCount;
}

export async function deleteOverview(market: string, symbol: string): Promise<void> {
  const col = await universeOverviewCol();
  await col.deleteOne({ _id: `${market}:${symbol}` });
}

/** 시세 재계산 없이 분류 메타(이름·그룹·태그)만 즉시 반영 */
export async function patchOverviewMeta(
  market: string,
  symbol: string,
  meta: Partial<Pick<UniverseOverviewDoc, "name" | "groupName" | "tags">>,
): Promise<void> {
  const col = await universeOverviewCol();
  await col.updateOne({ _id: `${market}:${symbol}` }, { $set: meta });
}

/** 유니버스에서 빠진 종목의 잔여 캐시 정리 */
export async function pruneOverview(keepIds: string[]): Promise<number> {
  const col = await universeOverviewCol();
  const res = await col.deleteMany({ _id: { $nin: keepIds } });
  return res.deletedCount;
}
