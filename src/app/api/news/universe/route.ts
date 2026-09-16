import { jsonError, ok } from "@/lib/api";
import { isMarketId } from "@/lib/markets/types";
import { fetchUniverseNews } from "@/lib/news";
import { authErrorResponse, requireAppUser } from "@/lib/server/app-auth";

export const maxDuration = 30;

/**
 * 유니버스통합 뉴스 — 유니버스가 계정별로 분리되므로 응답도 사람마다 다르다.
 * 로그인 필수이고, 예전의 `revalidate`·공개 s-maxage 캐시는 다른 사람 목록이
 * 섞여 나갈 수 있어 걷어냈다.
 */
export async function GET(request: Request) {
  try {
    const who = await requireAppUser();
    if (!who.ok) return authErrorResponse(who);

    const market = new URL(request.url).searchParams.get("market");
    if (!market || !isMarketId(market)) {
      return Response.json({ error: "알 수 없는 시장" }, { status: 404 });
    }
    const items = await fetchUniverseNews(who.userId, market);
    return ok({ items }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return jsonError(err);
  }
}
