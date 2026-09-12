import { jsonError, ok } from "@/lib/api";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId } from "@/lib/markets/types";
import { fetchStockNewsBySide } from "@/lib/markets/news";
import { getSavedNews } from "@/lib/db/news-saved";

export const maxDuration = 30;

/**
 * 종목뉴스 목록 — 국내(한국어 언론)·해외(영미권 등 외국 언론, 화이트리스트) 좌우 분리.
 * 종목의 상장 시장과 무관하게 둘 다 조회(예: 한국 종목의 로이터·블룸버그 보도도 표시).
 * 조회기간 1주일, 각 최대 30건(10개씩 3페이지 페이지네이션은 클라이언트에서 처리).
 * 저장(번역·요약)된 기사는 saved:true 로 표시. 30분 단위 갱신(Cache-Control s-maxage).
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
      // 이름 못 가져오면 심볼로 검색 — fetchStockNewsBySide 가 폴백
    }

    const [{ domestic, overseas }, savedDocs] = await Promise.all([
      fetchStockNewsBySide(market, sym, companyName),
      getSavedNews(market, sym).catch(() => []),
    ]);
    const savedUrls = new Set(savedDocs.map((d) => d.url));
    const withSaved = <T extends { url: string }>(items: T[]) =>
      items.map((it) => ({ ...it, saved: savedUrls.has(it.url) }));

    return ok(
      {
        domestic: withSaved(domestic),
        overseas: withSaved(overseas),
        saved: savedDocs,
      },
      { headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600" } },
    );
  } catch (err) {
    return jsonError(err);
  }
}
