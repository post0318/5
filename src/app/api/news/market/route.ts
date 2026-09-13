import { jsonError, ok } from "@/lib/api";
import { fetchMacroNews } from "@/lib/markets/news";

// 종목뉴스 탭과 동일 소스(공신력 있는 언론사 화이트리스트) — 캐시 30분
export const revalidate = 1800;
export const maxDuration = 20;

export async function GET(request: Request) {
  try {
    const region = new URL(request.url).searchParams.get("market");
    if (region !== "kr" && region !== "us") {
      return Response.json({ error: "알 수 없는 시장" }, { status: 404 });
    }
    const items = await fetchMacroNews(region);
    return ok(
      { items },
      { headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600" } },
    );
  } catch (err) {
    return jsonError(err);
  }
}
