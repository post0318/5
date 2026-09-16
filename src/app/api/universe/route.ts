import { after } from "next/server";
import { jsonError, ok } from "@/lib/api";
import { isMarketId } from "@/lib/markets/types";
import { listUniverse, upsertUniverseItem } from "@/lib/universe/repo";
import { refreshOverviewItem } from "@/lib/universe/overview";
import { authErrorResponse, requireAppUser } from "@/lib/server/app-auth";

/**
 * 유니버스는 계정별로 분리된다 — 조회·등록 모두 로그인 필수이고, 항상 호출한
 * 계정(ownerId)으로만 좁혀 읽고 쓴다.
 */
export async function GET(request: Request) {
  try {
    const who = await requireAppUser();
    if (!who.ok) return authErrorResponse(who);

    const { searchParams } = new URL(request.url);
    const marketParam = searchParams.get("market");
    const activeOnly = searchParams.get("active") === "1";
    const market = marketParam && isMarketId(marketParam) ? marketParam : undefined;
    const items = await listUniverse({ ownerId: who.userId, market, activeOnly });
    return ok({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return jsonError(err);
  }
}

export async function POST(request: Request) {
  try {
    const who = await requireAppUser();
    if (!who.ok) return authErrorResponse(who);

    const body = await request.json();
    const item = await upsertUniverseItem(who.userId, body);
    after(() => refreshOverviewItem(item).catch(() => {}));
    return ok({ item }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
