import { jsonError, ok } from "@/lib/api";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId } from "@/lib/markets/types";
import { fetchUsCompanyFacts, fetchUsSic } from "@/lib/markets/us/edgar";
import { loadClassAFacts } from "@/lib/markets/us/class-facts-loader";
import { buildUsCashFlow } from "@/lib/markets/us/edgar-cashflow";
import { buildUsIncome } from "@/lib/markets/us/edgar-income";
import { buildUsBalance } from "@/lib/markets/us/edgar-balance";
import { buildUsAnalysis } from "@/lib/markets/us/edgar-analysis";
import { buildUsSummary } from "@/lib/markets/us/edgar-summary";
import { getEodQuote } from "@/lib/markets/quote";
import { fetchForwardConsensus } from "@/lib/markets/quote/yahoo";
import { resolveCorpCode } from "@/lib/markets/kr/corpcode";
import { fetchKrFacts } from "@/lib/markets/kr/dart-facts";
import { buildKrIncome } from "@/lib/markets/kr/dart-income";
import { buildKrBalance } from "@/lib/markets/kr/dart-balance";
import { buildKrCashFlow } from "@/lib/markets/kr/dart-cashflow";
import { buildKrSummary } from "@/lib/markets/kr/dart-summary";
import { buildKrAnalysis } from "@/lib/markets/kr/dart-analysis";
import { fetchStooqEod } from "@/lib/markets/quote/stooq";
import { fetchKrxEod, fetchKrxCloseOn } from "@/lib/markets/quote/krx";
import { getKrDaDoc } from "@/lib/db/kr-da";

export const maxDuration = 60;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ market: string; symbol: string }> },
) {
  try {
    const { market, symbol } = await params;
    if (!isMarketId(market)) {
      return Response.json({ error: "알 수 없는 시장" }, { status: 404 });
    }
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") === "quarter" ? "quarter" : "annual";
    const adapter = getAdapter(market);
    const sym = adapter.normalizeSymbol(decodeURIComponent(symbol));

    // 상세 재분류 뷰 (미국·한국)
    const detailView = searchParams.get("view");
    const isDetail =
      detailView === "cf" ||
      detailView === "is" ||
      detailView === "bs" ||
      detailView === "analysis" ||
      detailView === "summary";

    if (market === "kr" && isDetail) {
      const { corpCode } = resolveCorpCode("", sym);

      if (detailView === "analysis") {
        const [facts, krx, bars, ttm, daDoc] = await Promise.all([
          fetchKrFacts(corpCode, "annual"),
          fetchKrxEod(sym).catch(() => null),
          fetchStooqEod("kr", sym, { from: `${new Date().getFullYear() - 6}-01-01` }).catch(() => []),
          adapter.getTtm?.(sym).catch(() => null) ?? Promise.resolve(null),
          getKrDaDoc(sym).catch(() => null),
        ]);
        if (!facts) return Response.json({ error: "재무제표를 찾을 수 없습니다" }, { status: 404 });
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
        const stmt = buildKrAnalysis({
          facts,
          bars,
          fyCloseByYear,
          sharesOutstanding: krx?.listedShares ?? null,
          currentPrice: krx?.bars.at(-1)?.close ?? bars.at(-1)?.close ?? null,
          currentMarketCap: krx?.marketCap ?? null,
          ttm: ttm ?? null,
          daDoc: daDoc ?? null,
        });
        stmt.symbol = sym;
        return ok(stmt, {
          headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=86400" },
        });
      }

      const [facts, daDoc] = await Promise.all([
        fetchKrFacts(corpCode, period),
        detailView === "is" || detailView === "summary"
          ? getKrDaDoc(sym).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (!facts) {
        return Response.json({ error: "재무제표를 찾을 수 없습니다" }, { status: 404 });
      }
      const stmt =
        detailView === "cf"
          ? buildKrCashFlow(facts)
          : detailView === "is"
            ? buildKrIncome(facts, daDoc)
            : detailView === "bs"
              ? buildKrBalance(facts)
              : buildKrSummary(facts, daDoc);
      stmt.symbol = sym;
      return ok(stmt, {
        headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=86400" },
      });
    }

    if (market === "us" && isDetail) {
      const yahoo = searchParams.get("yahoo");
      const needsShares =
        detailView === "analysis" || detailView === "is" || detailView === "summary";
      const { cik, facts } = await fetchUsCompanyFacts(sym);
      const [quote, consensus, classFacts, sic] = await Promise.all([
        needsShares
          ? getEodQuote("us", sym, { yahooOverride: yahoo }).catch(() => null)
          : Promise.resolve(null),
        needsShares
          ? fetchForwardConsensus("us", sym, yahoo).catch(() => null)
          : Promise.resolve(null),
        needsShares
          ? loadClassAFacts(cik, facts).catch(() => null)
          : Promise.resolve(null),
        fetchUsSic(sym).catch(() => null),
      ]);
      // 현재 발행주식수 근사(클래스별로만 공시하는 Visa 등의 EPS·PBR 계산용):
      // 시가총액÷주가(전 클래스 경제적 주식수) 우선, 없으면 yahoo sharesOutstanding.
      const mcap = consensus?.marketCap ?? quote?.marketCap ?? null;
      const sharesHint =
        (mcap != null && quote?.last ? mcap / quote.last : null) ??
        consensus?.sharesOutstanding ??
        quote?.sharesOutstanding ??
        null;
      const stmt =
        detailView === "cf"
          ? buildUsCashFlow(facts, period)
          : detailView === "is"
            ? buildUsIncome(facts, period, { sharesHint, classFacts, sic })
            : detailView === "bs"
              ? buildUsBalance(facts, period)
              : detailView === "summary"
                ? buildUsSummary(facts, period, { sharesHint, classFacts, sic })
                : buildUsAnalysis(facts, quote?.bars ?? [], { sharesHint, classFacts, sic });
      stmt.symbol = sym;
      return ok(stmt, {
        headers: { "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=86400" },
      });
    }

    const statement = await adapter.getFinancials(sym, period);
    return ok(statement, {
      headers: {
        "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=86400",
      },
    });
  } catch (err) {
    return jsonError(err);
  }
}
