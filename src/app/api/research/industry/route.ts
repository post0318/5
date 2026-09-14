import { jsonError, ok } from "@/lib/api";
import { isMarketId } from "@/lib/markets/types";
import { isDbConfigured } from "@/lib/db";
import { getIndustryResearch, type ResearchTopic } from "@/lib/db/shinhan-research";

export const revalidate = 1800;

/**
 * 산업분석/투자전략 리포트 — 종목 무관, 시장 전체용(`/[market]/research`
 * 새 탭). DB만 읽는다(수집은 로컬 스크립트, CLAUDE.md 예외 참고). 종목별
 * 기업분석(`/api/markets/[market]/[symbol]/research`)과는 별개 라우트.
 * `topic` 쿼리로 전체/산업분석/투자전략/시황을 나눠 조회(오너 지시, 2026-09).
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
    const VALID_TOPICS: ResearchTopic[] = ["산업분석", "투자전략(주식)", "투자전략(채권)", "시황"];
    const topic = (VALID_TOPICS as string[]).includes(topicParam ?? "")
      ? (topicParam as ResearchTopic)
      : undefined;

    // 90일 백필인데도 화면엔 최근 1주일치만 보인다는 지적(오너, 2026-09) —
    // 수집기가 20곳 넘게 늘면서 하루 유입량 자체가 커져 30건 한도로는 며칠
    // 만에 소진됐음(실측). 150으로 상향.
    const items = await getIndustryResearch(market, 150, topic);
    return ok(
      { items },
      { headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600" } },
    );
  } catch (err) {
    return jsonError(err);
  }
}
