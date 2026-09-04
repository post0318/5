import { unstable_cache } from "next/cache";
import { jsonError, ok } from "@/lib/api";
import { isMarketId, type MarketId } from "@/lib/markets/types";
import { getStockOverview } from "@/lib/markets/service";
import { listUniverse } from "@/lib/universe/repo";

export const maxDuration = 60;

/**
 * 유니버스 통합 뷰 데이터 (prd.md §5.3)
 * 등록 종목들의 시세·멀티플·컨센서스 요약. 시장별로 15분 캐시(unstable_cache).
 */
async function buildRows(market: MarketId | undefined) {
  const items = await listUniverse({ market, activeOnly: true });

  // 제한된 병렬로 (외부 API rate limit 배려)
  return mapWithConcurrency(items, 8, async (item) => {
    try {
      const ov = await getStockOverview(item.market as MarketId, item.symbol, item.yahooSymbol, {
        skipQuarterly: true, // 리스트 뷰는 분기 재무 불필요 (멀티플은 연간 기준)
      });
      const inp = ov.multiples?.inputs;
      const rev = inp?.revenueAnnual ?? null;
      const margin = (n: number | null | undefined) => (n != null && rev ? n / rev : null);
      return {
        id: item.id,
        market: item.market,
        symbol: item.symbol,
        name: item.name ?? ov.profile?.name ?? null,
        groupName: item.groupName,
        tags: item.tags,
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
      };
    } catch (err) {
      return {
        id: item.id,
        market: item.market,
        symbol: item.symbol,
        name: item.name ?? null,
        groupName: item.groupName,
        tags: item.tags,
        error: err instanceof Error ? err.message : "조회 실패",
      };
    }
  });
}

const cachedRows = (market: MarketId | undefined) =>
  unstable_cache(() => buildRows(market), ["universe-overview", market ?? "all"], {
    revalidate: 300,
    tags: ["universe-overview"],
  })();

export async function GET(request: Request) {
  try {
    const marketParam = new URL(request.url).searchParams.get("market");
    const market = marketParam && isMarketId(marketParam) ? (marketParam as MarketId) : undefined;
    const rows = await cachedRows(market);
    return ok({ rows });
  } catch (err) {
    return jsonError(err);
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
