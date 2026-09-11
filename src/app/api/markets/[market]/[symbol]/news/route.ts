import { jsonError, ok } from "@/lib/api";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId } from "@/lib/markets/types";
import { fetchStockNews } from "@/lib/markets/news";
import { getSavedNews } from "@/lib/db/news-saved";

export const maxDuration = 30;

/**
 * 종목뉴스 목록 — 한국·미국·일본(화이트리스트 언론사 + 3개월 이내).
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

    const adapter = getAdapter(market);
    const sym = adapter.normalizeSymbol(decodeURIComponent(symbol));

    let companyName: string | null = null;
    try {
      companyName = (await adapter.getCompanyProfile(sym))?.name ?? null;
    } catch {
      // 이름 못 가져오면 심볼로 검색 — fetchStockNews 가 폴백
    }

    const [items, savedDocs] = await Promise.all([
      fetchStockNews(market, sym, companyName),
      getSavedNews(market, sym).catch(() => []),
    ]);
    const savedUrls = new Set(savedDocs.map((d) => d.url));

    return ok(
      {
        items: items.map((it) => ({ ...it, saved: savedUrls.has(it.url) })),
        saved: savedDocs,
      },
      { headers: { "Cache-Control": "public, s-maxage=900, stale-while-revalidate=3600" } },
    );
  } catch (err) {
    return jsonError(err);
  }
}
