import { after } from "next/server";
import { jsonError, ok } from "@/lib/api";
import { isMarketId, type MarketId } from "@/lib/markets/types";
import { getUniverseOverview, refreshUniverseOverview } from "@/lib/universe/overview";

export const maxDuration = 60;

/**
 * 유니버스 통합 뷰 데이터 (prd.md §5.3)
 * 사전 계산된 DB 캐시만 읽어 즉시 응답. 외부 API 는 배치/수동 새로고침 시에만 호출.
 *  - 기본: DB 캐시 반환 (오래됐으면 백그라운드 갱신 예약)
 *  - ?refresh=1 : 즉시 재계산 후 반환 (새로고침 버튼)
 */
export async function GET(request: Request) {
  try {
    const sp = new URL(request.url).searchParams;
    const marketParam = sp.get("market");
    const market =
      marketParam && isMarketId(marketParam) ? (marketParam as MarketId) : undefined;

    if (sp.get("refresh") === "1") {
      const { rows } = await refreshUniverseOverview(market);
      return ok({ rows, refreshedAt: new Date().toISOString() });
    }

    const { rows, stale } = await getUniverseOverview(market);
    if (stale) {
      after(() => refreshUniverseOverview(market).catch(() => {}));
    }
    return ok({ rows, stale });
  } catch (err) {
    return jsonError(err);
  }
}
