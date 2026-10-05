import { jsonError, ok } from "@/lib/api";
import { isMarketId } from "@/lib/markets/types";
import { isDbConfigured } from "@/lib/db";
import { getIndustryResearch } from "@/lib/db/shinhan-research";

export const revalidate = 1800;

/**
 * 산업분석 리포트 — 종목 무관, 시장 전체용(`/[market]/research`). DB만
 * 읽는다(수집은 로컬 스크립트, CLAUDE.md 예외 참고). 종목별 기업분석
 * (`/api/markets/[market]/[symbol]/research`)과는 별개 라우트.
 * 이 탭은 "산업분석"·"글로벌IB"·"투자전략"을 다룬다. 시황(Daily/Monthly)·이슈분석·환율분석·비상장은 각자의
 * 전용 화면(`/macro/market-condition`·`/macro/issues`·`/macro/fx`·`/kr/unlisted`)으로 갔다. 미국 비상장은 이 탭의 산업분석에
 * 합쳤다(오너 지시 2026-10-05).
 * 투자전략은 오너 지시(2026-09-27 — "각 국가별 산업분석으로 다시 변경한다")로 시장(국가)별 조회로 되돌아왔다.
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
    const VALID_TOPICS = ["산업분석", "글로벌IB", "투자전략"] as const;
    const topic = (VALID_TOPICS as readonly string[]).includes(topicParam ?? "")
      ? (topicParam as "산업분석" | "글로벌IB" | "투자전략")
      : undefined;
    // 글로벌IB 는 미국 탭 전용(오너 지시 2026-09-28) — 다른 시장 요청은 빈 목록
    if (topic === "글로벌IB" && market !== "us") return ok({ items: [] });

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
