import { jsonError, ok } from "@/lib/api";
import { isMarketId } from "@/lib/markets/types";
import { getAdapter } from "@/lib/markets/registry";
import { getEodQuote } from "@/lib/markets/quote";
import { fetchForwardConsensus, fetchYahooEstimates } from "@/lib/markets/quote/yahoo";
import { fetchUsCompanyFacts } from "@/lib/markets/us/edgar";
import { buildUsHighlights } from "@/lib/markets/us/edgar-highlights";
import { loadClassAFacts } from "@/lib/markets/us/class-facts-loader";
import { resolveCorpCode } from "@/lib/markets/kr/corpcode";
import { fetchKrFacts, fetchKrDps } from "@/lib/markets/kr/dart-facts";
import { buildKrHighlights } from "@/lib/markets/kr/dart-highlights";
import { fetchStooqEod } from "@/lib/markets/quote/stooq";
import { fetchKrxEod, fetchKrxCloseOn } from "@/lib/markets/quote/krx";
import { fetchKrNaverConsensus } from "@/lib/markets/kr/naver";

export const revalidate = 3600;
export const maxDuration = 45;

/**
 * 재무 하이라이트 표 (EV 브릿지 + 5개년 손익·현금흐름 + 현재/LTM + 차기 추정).
 * 미국(SEC EDGAR) · 한국(OpenDART). 그 외 시장은 { highlights: null }.
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
    if (market !== "us" && market !== "kr") return ok({ highlights: null });

    const adapter = getAdapter(market);
    const sym = adapter.normalizeSymbol(decodeURIComponent(symbol));
    const yahoo = new URL(request.url).searchParams.get("yahoo");

    if (market === "kr") {
      const { corpCode } = resolveCorpCode("", sym);
      const [facts, dps, krx, bars, ttm, consensus] = await Promise.all([
        fetchKrFacts(corpCode, "annual"),
        fetchKrDps(corpCode),
        fetchKrxEod(sym).catch(() => null),
        fetchStooqEod("kr", sym, { from: `${new Date().getFullYear() - 6}-01-01` }).catch(() => []),
        adapter.getTtm?.(sym).catch(() => null) ?? Promise.resolve(null),
        fetchKrNaverConsensus(sym).catch(() => null),
      ]);
      if (!facts) return ok({ highlights: null });
      // 회계연도말 종가 — Stooq 커버리지가 부족하면 KRX 로 개별 조회
      const fyCloseByYear = new Map<number, number>();
      const needYears = facts.periods
        .map((p) => p.year)
        .filter((y) => !bars.some((b) => b.date <= `${y}-12-31` && b.date >= `${y}-11-01` && b.close != null));
      await Promise.all(
        needYears.map(async (y) => {
          const c = await fetchKrxCloseOn(sym, `${y}1231`).catch(() => null);
          if (c != null) fyCloseByYear.set(y, c);
        }),
      );
      const highlights = buildKrHighlights({
        facts,
        bars,
        fyCloseByYear,
        sharesOutstanding: krx?.listedShares ?? null,
        currentMarketCap: krx?.marketCap ?? null,
        currentPrice: krx?.bars.at(-1)?.close ?? bars.at(-1)?.close ?? null,
        ttm: ttm ?? null,
        dpsByYear: dps.dpsByYear,
        payoutByYear: dps.payoutByYear,
        consensus: consensus
          ? { estYear: consensus.estYear, estEps: consensus.estEps, estPer: consensus.estPer, estPbr: consensus.estPbr }
          : null,
      });
      return ok(
        { highlights },
        { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
      );
    }

    const factsRes = await fetchUsCompanyFacts(sym);
    const [quote, estimates, consensus, classFacts] = await Promise.all([
      getEodQuote(market, sym, { yahooOverride: yahoo }).catch(() => null),
      fetchYahooEstimates(market, sym, yahoo).catch(() => null),
      fetchForwardConsensus(market, sym, yahoo).catch(() => null),
      loadClassAFacts(factsRes.cik, factsRes.facts).catch(() => null),
    ]);

    const mcap = consensus?.marketCap ?? quote?.marketCap ?? null;
    const sharesHint =
      (mcap != null && quote?.last ? mcap / quote.last : null) ??
      consensus?.sharesOutstanding ??
      quote?.sharesOutstanding ??
      null;

    const highlights = buildUsHighlights(
      factsRes.facts,
      quote?.bars ?? [],
      (estimates?.periods ?? []).map((p) => ({
        period: p.period,
        endDate: p.endDate,
        epsAvg: p.epsAvg,
        revenueAvg: p.revenueAvg,
      })),
      sharesHint,
      classFacts,
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
