import { after } from "next/server";
import { jsonError, ok } from "@/lib/api";
import { isMarketId, type MarketId } from "@/lib/markets/types";
import { getUniverseOverview, refreshUniverseOverview } from "@/lib/universe/overview";
import { authErrorResponse, requireAppUser } from "@/lib/server/app-auth";

export const maxDuration = 60;

/**
 * 유니버스 통합 뷰 데이터 (prd.md §5.3)
 * 사전 계산된 DB 캐시만 읽어 즉시 응답. 외부 API 는 배치/수동 새로고침 시에만 호출.
 *  - 기본: DB 캐시 반환 (오래됐으면 백그라운드 갱신 예약)
 *  - ?refresh=1 : 즉시 재계산 후 반환 (새로고침 버튼)
 *
 * 유니버스가 계정별로 분리돼 응답이 사람마다 다르다 — 로그인 필수이고
 * 절대 공유 캐시(CDN)에 태우지 않는다.
 */
export async function GET(request: Request) {
  try {
    const who = await requireAppUser();
    if (!who.ok) return authErrorResponse(who);

    const sp = new URL(request.url).searchParams;
    const marketParam = sp.get("market");
    const market =
      marketParam && isMarketId(marketParam) ? (marketParam as MarketId) : undefined;
    const noStore = { "Cache-Control": "no-store" };

    if (sp.get("refresh") === "1") {
      await refreshUniverseOverview({ ownerId: who.userId, market });
      const { rows } = await getUniverseOverview(who.userId, market);
      return ok({ rows, refreshedAt: new Date().toISOString() }, { headers: noStore });
    }

    const { rows, stale } = await getUniverseOverview(who.userId, market);
    if (stale) {
      after(() =>
        refreshUniverseOverview({ ownerId: who.userId, market }).catch(() => {}),
      );
    }
    return ok({ rows, stale }, { headers: noStore });
  } catch (err) {
    return jsonError(err);
  }
}
