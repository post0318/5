import { jsonError, ok } from "@/lib/api";
import { isMarketId, type MarketId } from "@/lib/markets/types";
import { getStockOverview } from "@/lib/markets/service";
import { listUniverse } from "@/lib/universe/repo";

export const maxDuration = 60;

/**
 * 유니버스 통합 뷰 데이터 (prd.md §5.3)
 * 등록 종목들의 시세·멀티플·컨센서스 요약을 한 번에.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const marketParam = searchParams.get("market");
    const market = marketParam && isMarketId(marketParam) ? (marketParam as MarketId) : undefined;

    const items = await listUniverse({ market, activeOnly: true });

    // 순차가 아닌 제한된 병렬로 (외부 API rate limit 배려)
    const rows = await mapWithConcurrency(items, 4, async (item) => {
      try {
        const ov = await getStockOverview(item.market as MarketId, item.symbol, item.yahooSymbol);
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
