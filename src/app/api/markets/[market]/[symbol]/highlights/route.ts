import { jsonError, ok } from "@/lib/api";
import { isMarketId } from "@/lib/markets/types";
import { getAdapter } from "@/lib/markets/registry";
import { getEodQuote } from "@/lib/markets/quote";
import { fetchForwardConsensus, fetchYahooEstimates } from "@/lib/markets/quote/yahoo";
import { fetchUsCompanyFacts } from "@/lib/markets/us/edgar";
import { buildUsHighlights } from "@/lib/markets/us/edgar-highlights";

export const revalidate = 3600;
export const maxDuration = 30;

/**
 * 재무 하이라이트 표 (EV 브릿지 + 5개년 손익·현금흐름 + 현재/LTM + 차기 추정).
 * 현재는 미국(SEC EDGAR)만 지원. 그 외 시장은 { highlights: null }.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ market: string; symbol: string }> },
) {
  try {
    const { market, symbol } = await params;
    if (!isMarketId(market)) {
      return Response.json({ error: "알 수 없는 시장" }, { status: 404 });
    }
    if (market !== "us") return ok({ highlights: null });

    const adapter = getAdapter(market);
    const sym = adapter.normalizeSymbol(decodeURIComponent(symbol));
    const yahoo = new URL(request.url).searchParams.get("yahoo");

    const [factsRes, quote, estimates, consensus] = await Promise.all([
      fetchUsCompanyFacts(sym),
      getEodQuote(market, sym, { yahooOverride: yahoo }).catch(() => null),
      fetchYahooEstimates(market, sym, yahoo).catch(() => null),
      fetchForwardConsensus(market, sym, yahoo).catch(() => null),
    ]);

    const highlights = buildUsHighlights(
      factsRes.facts,
      quote?.bars ?? [],
      (estimates?.periods ?? []).map((p) => ({
        period: p.period,
        endDate: p.endDate,
        epsAvg: p.epsAvg,
        revenueAvg: p.revenueAvg,
      })),
      consensus?.sharesOutstanding ?? null,
    );

    return ok(
      { highlights },
      {
        headers: {
          "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
        },
      },
    );
  } catch (err) {
    return jsonError(err);
  }
}
