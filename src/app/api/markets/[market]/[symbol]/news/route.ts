import { jsonError, ok } from "@/lib/api";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId } from "@/lib/markets/types";
import { fetchStockNews } from "@/lib/markets/news";
import { getSavedUrlSet } from "@/lib/db/news-saved";

export const maxDuration = 30;

/**
 * 종목뉴스 목록 — 미국·일본만(화이트리스트 언론사 + 3개월 이내). 한국은
 * 빈 배열(화면은 기존 "관련 뉴스" 딥링크를 그대로 씀 — src/lib/markets/news.ts 참조).
 * 저장(번역·요약)된 기사는 saved:true 로 표시.
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
    if (market === "kr") return ok({ items: [] });

    const adapter = getAdapter(market);
    const sym = adapter.normalizeSymbol(decodeURIComponent(symbol));

    let companyName: string | null = null;
    try {
      companyName = (await adapter.getCompanyProfile(sym))?.name ?? null;
    } catch {
      // 이름 못 가져오면 심볼로 검색 — fetchStockNews 가 폴백
    }

    const [items, saved] = await Promise.all([
      fetchStockNews(market, sym, companyName),
      getSavedUrlSet(market, sym).catch(() => new Set<string>()),
    ]);

    return ok(
      { items: items.map((it) => ({ ...it, saved: saved.has(it.url) })) },
      { headers: { "Cache-Control": "public, s-maxage=900, stale-while-revalidate=3600" } },
    );
  } catch (err) {
    return jsonError(err);
  }
}
