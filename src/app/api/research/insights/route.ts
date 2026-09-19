import { jsonError, ok } from "@/lib/api";
import { isMarketId } from "@/lib/markets/types";
import { isDbConfigured } from "@/lib/db";
import { getInsightResearch, INSIGHT_SOURCES } from "@/lib/db/shinhan-research";

export const revalidate = 1800;

/**
 * 해외 IB/자산운용사 인사이트 — 종목 무관, 시장 전체용(`/[market]/insights`
 * 새 탭, 오너 지시 2026-09-19). 골드만삭스·JP모간·모간스탠리·블랙록·PIMCO
 * 5곳만 반환(`getIndustryResearch`/`/[market]/research` 산업분석 탭과는
 * 서로 배타적 — CLAUDE.md 참고). `source` 쿼리로 전체/각사별을 나눠 조회.
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const market = url.searchParams.get("market");
    if (!market || !isMarketId(market)) {
      return Response.json({ error: "알 수 없는 시장" }, { status: 404 });
    }
    if (!isDbConfigured()) return ok({ items: [] });

    const sourceParam = url.searchParams.get("source");
    const source = (INSIGHT_SOURCES as readonly string[]).includes(sourceParam ?? "")
      ? (sourceParam as string)
      : undefined;

    // 90일 백필(오너 지시, 2026-09-19) 기준 소스가 5→10곳으로 늘며 합계가
    // 300을 넘어 "전체" 탭에서 새로 추가한 HSBC·Deutsche Bank가 밀려난 걸
    // 실측 확인 — 소스가 늘어날 걸 감안해 여유 있게 상향.
    const items = await getInsightResearch(market, 600, source);
    return ok(
      { items },
      { headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600" } },
    );
  } catch (err) {
    return jsonError(err);
  }
}
