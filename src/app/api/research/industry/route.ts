import { jsonError, ok } from "@/lib/api";
import { isMarketId } from "@/lib/markets/types";
import { isDbConfigured } from "@/lib/db";
import { getIndustryResearch, type ResearchTopic } from "@/lib/db/shinhan-research";

export const revalidate = 1800;

/**
 * 산업분석/투자전략 리포트 — 종목 무관, 시장 전체용(`/[market]/research`
 * 새 탭). DB만 읽는다(수집은 로컬 스크립트, CLAUDE.md 예외 참고). 종목별
 * 기업분석(`/api/markets/[market]/[symbol]/research`)과는 별개 라우트.
 * `topic` 쿼리로 전체/산업분석/투자전략을 나눠 조회(오너 지시, 2026-09).
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const market = url.searchParams.get("market");
    if (!market || !isMarketId(market)) {
      return Response.json({ error: "알 수 없는 시장" }, { status: 404 });
    }
    if (!isDbConfigured()) return ok({ items: [] });

    const topicParam = url.searchParams.get("topic");
    const topic: ResearchTopic | undefined =
      topicParam === "산업분석" || topicParam === "투자전략" ? topicParam : undefined;

    const items = await getIndustryResearch(market, 30, topic);
    return ok(
      { items },
      { headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600" } },
    );
  } catch (err) {
    return jsonError(err);
  }
}
