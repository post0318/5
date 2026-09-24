import { jsonError, ok } from "@/lib/api";
import { isMarketId } from "@/lib/markets/types";
import { getAdapter } from "@/lib/markets/registry";
import { getEodQuote } from "@/lib/markets/quote";
import { fetchForwardConsensus, fetchYahooEstimates } from "@/lib/markets/quote/yahoo";
import { fetchUsCompanyFacts, fetchUsSic } from "@/lib/markets/us/edgar";
import { estimatesToUsd } from "@/lib/markets/us/edgar-foreign";
import { buildUsHighlights } from "@/lib/markets/us/edgar-highlights";
import { buildUsBankHighlights, isFinancialCompany } from "@/lib/markets/us/edgar-highlights-bank";
import { loadClassAFacts } from "@/lib/markets/us/class-facts-loader";
import { loadCaptiveDebt } from "@/lib/markets/us/edgar-captive";
import { reitOpUnits } from "@/lib/markets/us/edgar-ev";
import { resolveCorpCode } from "@/lib/markets/kr/corpcode";
import { getKrJurirNo } from "@/lib/markets/kr/opendart";
import { fetchKrFacts, fetchKrDps } from "@/lib/markets/kr/dart-facts";
import { buildKrHighlights } from "@/lib/markets/kr/dart-highlights";
import { fetchStooqEod } from "@/lib/markets/quote/stooq";
import { fetchKrxEod, fetchKrxCloseOn } from "@/lib/markets/quote/krx";
import { fetchKrNaverConsensus } from "@/lib/markets/kr/naver";
import { fetchKrAnnualDps } from "@/lib/markets/kr/rights-schedule";
import { getKrDaDoc } from "@/lib/db/kr-da";
import { usSharesHint } from "@/lib/markets/us/shares-hint";
import { loadKrCaps } from "@/lib/markets/kr/dart-ev";

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
      const [facts, dps, krx, bars, ttm, consensus, dpsTtm, daDoc, live] = await Promise.all([
        fetchKrFacts(corpCode, "annual"),
        fetchKrDps(corpCode),
        fetchKrxEod(sym).catch(() => null),
        fetchStooqEod("kr", sym, { from: `${new Date().getFullYear() - 6}-01-01` }).catch(() => []),
        adapter.getTtm?.(sym).catch(() => null) ?? Promise.resolve(null),
        fetchKrNaverConsensus(sym).catch(() => null),
        getKrJurirNo(sym)
          .then((crno) => fetchKrAnnualDps(crno))
          .catch(() => null),
        getKrDaDoc(sym).catch(() => null),
        // 현재가·시가총액은 개요(브라우저 멀티플)와 같은 시세 함수 — KRX 일별 전종목은 장
        // 마감 뒤에야 당일분이 나와 하루 늦을 수 있어 LTM 열이 개요와 갈렸다.
        getEodQuote("kr", sym).catch(() => null),
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
      // KRX 연말·현재 보통주·우선주 시가총액 (dart-ev.ts — EV·PBR·PSR 공통)
      const caps = await loadKrCaps(sym, facts.periods.map((p) => p.year)).catch(() => null);
      const highlights = buildKrHighlights({
        code: sym,
        caps,
        facts,
        bars,
        fyCloseByYear,
        sharesOutstanding: krx?.listedShares ?? live?.sharesOutstanding ?? null,
        currentMarketCap: live?.marketCap ?? krx?.marketCap ?? null,
        currentPrice: live?.last ?? krx?.bars.at(-1)?.close ?? bars.at(-1)?.close ?? null,
        ttm: ttm ?? null,
        dpsByYear: dps.dpsByYear,
        payoutByYear: dps.payoutByYear,
        dpsTtm: dpsTtm?.ttm?.dps ?? null,
        daDoc,
        consensus: consensus
          ? {
              estYear: consensus.estYear,
              estRevenue: consensus.estRevenue,
              estOpIncome: consensus.estOpIncome,
              estNetIncome: consensus.estNetIncome,
              estEps: consensus.estEps,
              estPer: consensus.estPer,
              estPbr: consensus.estPbr,
            }
          : null,
      });
      return ok(
        { highlights },
        { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
      );
    }

    const factsRes = await fetchUsCompanyFacts(sym);
    const [quote, estimatesRaw, consensus, classFacts, sic] = await Promise.all([
      getEodQuote(market, sym, { yahooOverride: yahoo }).catch(() => null),
      fetchYahooEstimates(market, sym, yahoo).catch(() => null),
      fetchForwardConsensus(market, sym, yahoo).catch(() => null),
      loadClassAFacts(factsRes.cik, factsRes.facts).catch(() => null),
      fetchUsSic(sym).catch(() => null),
    ]);
    // EV 브릿지 맥락 — 금융 자회사 부문 차입금(XBRL 인스턴스), UP-REIT 파트너 지분
    const captive = await loadCaptiveDebt(factsRes.cik, sic).catch(() => null);
    // 외화 공시 기업 예상치 → USD(edgar-foreign.ts). 환산 실패 시 예상치 숨김(원통화 숫자를 USD 로 섞지 않음)
    const estimates = estimatesRaw ? await estimatesToUsd(estimatesRaw, factsRes.facts).catch(() => null) : null;
    const opUnits = reitOpUnits(sic, consensus?.sharesOutstanding, consensus?.impliedSharesOutstanding);

    const sharesHint = usSharesHint(quote, consensus);

    const estCols = (estimates?.periods ?? []).map((p) => ({
      period: p.period,
      endDate: p.endDate,
      epsAvg: p.epsAvg,
      revenueAvg: p.revenueAvg,
    }));

    const highlights = isFinancialCompany(factsRes.facts, sic)
      ? buildUsBankHighlights(factsRes.facts, quote?.bars ?? [], estCols, sharesHint)
      : buildUsHighlights(factsRes.facts, quote?.bars ?? [], estCols, sharesHint, classFacts, {
          sic,
          captive,
          opUnits,
        });
    if (estimates && "fxNote" in estimates && estimates.fxNote) highlights.notes.push(estimates.fxNote);
    if (estimatesRaw && !estimates) highlights.notes.push("외화 예상치 환산 실패 — 예상치 숨김");

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
