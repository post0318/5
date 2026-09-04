import "server-only";
import type { MarketId } from "@/lib/markets/types";
import { getStockOverview } from "@/lib/markets/service";
import { listUniverse } from "@/lib/universe/repo";
import type { UniverseItem } from "@/lib/db/schema";
import {
  deleteOverview,
  patchOverviewMeta,
  pruneOverview,
  readOverview,
  writeOverview,
  type UniverseOverviewDoc,
} from "@/lib/db/universe-overview";

async function computeDoc(item: UniverseItem): Promise<UniverseOverviewDoc> {
  const base = {
    _id: `${item.market}:${item.symbol}`,
    itemId: item.id,
    market: item.market as "kr" | "us" | "jp",
    symbol: item.symbol,
    yahooSymbol: item.yahooSymbol ?? null,
    name: item.name ?? null,
    groupName: item.groupName,
    tags: item.tags,
    updatedAt: new Date().toISOString(),
  };
  try {
    const ov = await getStockOverview(item.market as MarketId, item.symbol, item.yahooSymbol, {
      skipQuarterly: true,
    });
    const inp = ov.multiples?.inputs;
    const rev = inp?.revenueAnnual ?? null;
    const margin = (n: number | null | undefined) => (n != null && rev ? n / rev : null);
    return {
      ...base,
      name: item.name ?? ov.profile?.name ?? null,
      last: ov.quote?.last ?? null,
      changePct: ov.quote?.changePct ?? null,
      currency: ov.quote?.currency ?? null,
      per: ov.multiples?.per ?? null,
      pbr: ov.multiples?.pbr ?? null,
      forwardPer: ov.consensus?.forwardPer ?? null,
      targetMeanPrice: ov.consensus?.targetMeanPrice ?? null,
      recommendationKey: ov.consensus?.recommendationKey ?? null,
      marketCap: ov.multiples?.marketCap ?? null,
      revenueAnnual: rev,
      opMargin: margin(inp?.opIncomeAnnual),
      netMargin: margin(inp?.netIncomeAnnual),
      warnings: ov.warnings,
      error: null,
    };
  } catch (err) {
    return {
      ...base,
      last: null,
      changePct: null,
      currency: null,
      per: null,
      pbr: null,
      forwardPer: null,
      targetMeanPrice: null,
      recommendationKey: null,
      marketCap: null,
      revenueAnnual: null,
      opMargin: null,
      netMargin: null,
      warnings: [],
      error: err instanceof Error ? err.message : "조회 실패",
    };
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 전체(또는 시장별) 유니버스 요약을 재계산해 DB 에 저장. 배치·수동 새로고침용. */
export async function refreshUniverseOverview(market?: MarketId): Promise<{
  count: number;
  rows: UniverseOverviewDoc[];
}> {
  const items = await listUniverse({ market, activeOnly: true });
  const rows = await mapWithConcurrency(items, 8, computeDoc);
  await writeOverview(rows);
  if (!market) {
    await pruneOverview(rows.map((r) => r._id));
  }
  return { count: rows.length, rows };
}

/** 종목 1개만 재계산 (편집 직후 즉시 반영). */
export async function refreshOverviewItem(item: UniverseItem): Promise<void> {
  const doc = await computeDoc(item);
  await writeOverview([doc]);
}

export async function removeOverviewItem(market: string, symbol: string): Promise<void> {
  await deleteOverview(market, symbol);
}

/** 편집 즉시 반영: 시세는 그대로 두고 이름·그룹·태그만 갱신. 이후 배치가 전체 재계산. */
export async function patchOverviewItemMeta(item: UniverseItem): Promise<void> {
  await patchOverviewMeta(item.market, item.symbol, {
    name: item.name ?? null,
    groupName: item.groupName,
    tags: item.tags,
  });
}

/** 조회: DB 만 읽음. 비어있으면 즉석 계산 후 저장. */
export async function getUniverseOverview(market?: MarketId): Promise<{
  rows: UniverseOverviewDoc[];
  stale: boolean;
}> {
  const rows = await readOverview(market);
  if (rows.length === 0) {
    const items = await listUniverse({ market, activeOnly: true });
    if (items.length === 0) return { rows: [], stale: false };
    const built = await refreshUniverseOverview(market);
    return { rows: built.rows, stale: false };
  }
  const oldest = rows.reduce((m, r) => (r.updatedAt < m ? r.updatedAt : m), rows[0].updatedAt);
  const ageMs = Date.now() - new Date(oldest).getTime();
  return { rows, stale: ageMs > 18 * 3600_000 };
}
