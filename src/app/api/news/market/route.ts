import { jsonError, ok } from "@/lib/api";
import { isMarketId } from "@/lib/markets/types";
import { fetchMacroNews } from "@/lib/news";

// Google 뉴스 RSS(공개 피드) — 캐시 30분
export const revalidate = 1800;
export const maxDuration = 20;

export async function GET(request: Request) {
  try {
    const market = new URL(request.url).searchParams.get("market");
    if (!market || !isMarketId(market)) {
      return Response.json({ error: "알 수 없는 시장" }, { status: 404 });
    }
    const items = await fetchMacroNews(market, 20);
    return ok(
      { items },
      { headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600" } },
    );
  } catch (err) {
    return jsonError(err);
  }
}
