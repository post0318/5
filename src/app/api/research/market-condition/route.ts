import { jsonError, ok } from "@/lib/api";
import { isDbConfigured } from "@/lib/db";
import { getMarketConditionResearch } from "@/lib/db/shinhan-research";

export const revalidate = 1800;

/**
 * 신규 "시황분석" 탭 조회(오너 지시 2026-09-26) — `/macro/market-condition`.
 * `segment` 쿼리로 Daily/Monthly 를 나눈다.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const segmentParam = url.searchParams.get("segment");
    // 투자전략은 각 국가 산업분석 탭으로 이동(오너 지시 2026-09-27) — 이 탭은 Daily·Monthly 만.
    const segment = segmentParam === "Monthly" ? "Monthly" : "Daily";

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
