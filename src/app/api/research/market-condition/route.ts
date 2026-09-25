import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { getMarketConditionResearch } from "@/lib/db/shinhan-research";

export const revalidate = 1800;

/**
 * 신규 "시황분석" 탭 조회(오너 지시 2026-09-26) — `/macro/market-condition`.
 * `segment` 쿼리로 Daily/Monthly/투자전략을 나눈다. 구 "시황"·"투자전략(주식)"이
 * 여기로 이동했다(산업분석 탭에서 완전히 제거).
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const segmentParam = url.searchParams.get("segment");
    const segment =
      segmentParam === "Monthly" ? "Monthly" : segmentParam === "투자전략" ? "투자전략" : "Daily";

    if (!isDbConfigured()) return ok({ items: [] });

    const items = await getMarketConditionResearch(segment, 150);
    return ok(
      { items },
      { headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600" } },
    );
  } catch (err) {
    return jsonError(err);
  }
}
