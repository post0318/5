import { jsonError, ok } from "@/lib/api";
import { isMarketId } from "@/lib/markets/types";
import { getAdapter } from "@/lib/markets/registry";
import { isDbConfigured } from "@/lib/db";
import { getShinhanResearchBySymbol } from "@/lib/db/shinhan-research";

export const revalidate = 1800;

/**
 * 증권사 리서치 리포트 — 한국(다수 증권사)·미국(GlobalMonitor 경유 다수
 * 증권사, 2026-09 추가) 종목. DB만 읽는다(크롤링은 로컬 스크립트가 별도로
 * 수행 — src/lib/db/shinhan-research.ts 참고).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ market: string; symbol: string }> },
) {
  try {
    const { market, symbol } = await params;
    if (!isMarketId(market)) {
      return Response.json({ error: "알 수 없는 시장" }, { status: 404 });
    }
    if (!isDbConfigured()) return ok({ items: [] });

    const sym = getAdapter(market).normalizeSymbol(decodeURIComponent(symbol));
    const raw = await getShinhanResearchBySymbol(market, sym);
    // category 필드 추가(2026-09) 이전에 적재된 기존 문서엔 없을 수 있음 — 기본값 처리.
    const items = raw.map((it) => ({ ...it, category: it.category ?? "기업" }));
    return ok(
      { items },
      { headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600" } },
    );
  } catch (err) {
    return jsonError(err);
  }
}
