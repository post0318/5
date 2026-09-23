import { jsonError, ok } from "@/lib/api";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId } from "@/lib/markets/types";
import { fetchUsCompanyFacts, fetchUsSic } from "@/lib/markets/us/edgar";
import { loadClassAFacts } from "@/lib/markets/us/class-facts-loader";
import { loadCaptiveDebt } from "@/lib/markets/us/edgar-captive";
import { reitOpUnits } from "@/lib/markets/us/edgar-ev";
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
import { usSharesHint } from "@/lib/markets/us/shares-hint";
import { loadKrCaps } from "@/lib/markets/kr/dart-ev";

export const maxDuration = 60;

/**
 * 이 라우트 응답은 캐시하지 않는다(오너 지적 2026-09-21 — "재무제표 분기
 * 총괄조회시 캐쉬가 모일때까지 과거 변경전 레이아웃이 노출된다. 레이아웃은
 * 캐쉬랑 조회시간 여부 무관하게 변경된 버전이 나와야한다").
 *
 * 원인: 응답에 `Cache-Control: s-maxage=1800, stale-while-revalidate=86400`
 * 이 붙어 있어 Vercel CDN 이 이 URL(symbol·period·view 조합)의 응답 **본문**을
 * 최대 30분은 그대로, 그 뒤 24시간은 "일단 예전 걸 내주고 뒤에서 갱신"
 * 방식으로 캐시했다. 이 캐시는 **배포와 무관하게 URL 기준으로 유지**된다 —
 * buildKrSummary/buildUsSummary 같은 레이아웃 생성 코드를 고쳐 배포해도,
 * 배포 전에 이미 캐시된 URL 은 그 예전 코드가 만든 JSON 을 그대로 계속
 * 내려준다. "캐쉬가 모일 때까지"는 그 캐시가 자연 만료(최대 24.5시간)될
 * 때까지를 뜻했다.
 *
 * 이 응답을 만드는 build*(...) 변환 자체는 가벼운 동기 연산이고, 실제
 * 무거운 외부 호출(SEC EDGAR·OpenDART 원본 조회)은 각 모듈이 자체적으로
 * Next.js fetch revalidate 로 이미 캐시한다(예: edgar.ts, dart-facts.ts) —
 * 그쪽은 원본 데이터가 바뀔 때만 갱신하면 되므로 그대로 둔다. 이 라우트가
 * 캐시를 끄는 건 "완성된 응답 모양(레이아웃)"이 배포 시점과 어긋나는 걸
 * 막기 위해서다.
 */
const NO_CACHE = { "Cache-Control": "no-store" };

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
        const [facts, krx, bars, ttm, daDoc, live] = await Promise.all([
          fetchKrFacts(corpCode, "annual"),
          fetchKrxEod(sym).catch(() => null),
          fetchStooqEod("kr", sym, { from: `${new Date().getFullYear() - 6}-01-01` }).catch(() => []),
          adapter.getTtm?.(sym).catch(() => null) ?? Promise.resolve(null),
          getKrDaDoc(sym).catch(() => null),
          // 현재가·시가총액은 개요·하이라이트와 같은 시세 함수
          getEodQuote("kr", sym).catch(() => null),
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
        const caps = await loadKrCaps(sym, facts.periods.map((p) => p.year)).catch(() => null);
        const stmt = buildKrAnalysis({
          code: sym,
          caps,
          facts,
          bars,
          fyCloseByYear,
          sharesOutstanding: krx?.listedShares ?? live?.sharesOutstanding ?? null,
          currentPrice: live?.last ?? krx?.bars.at(-1)?.close ?? bars.at(-1)?.close ?? null,
          currentMarketCap: live?.marketCap ?? krx?.marketCap ?? null,
          ttm: ttm ?? null,
          daDoc: daDoc ?? null,
        });
        stmt.symbol = sym;
        return ok(stmt, { headers: NO_CACHE });
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
      return ok(stmt, { headers: NO_CACHE });
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
      const sharesHint = usSharesHint(quote, consensus);
      const stmt =
        detailView === "cf"
          ? buildUsCashFlow(facts, period, sic)
          : detailView === "is"
            ? buildUsIncome(facts, period, { sharesHint, classFacts, sic })
            : detailView === "bs"
              ? buildUsBalance(facts, period, sic)
              : detailView === "summary"
                ? buildUsSummary(facts, period, { sharesHint, classFacts, sic })
                : buildUsAnalysis(facts, quote?.bars ?? [], {
                    sharesHint,
                    classFacts,
                    sic,
                    evCtx: {
                      sic,
                      captive: await loadCaptiveDebt(cik, sic).catch(() => null),
                      opUnits: reitOpUnits(
                        sic,
                        consensus?.sharesOutstanding,
                        consensus?.impliedSharesOutstanding,
                      ),
                    },
                  });
      stmt.symbol = sym;
      return ok(stmt, { headers: NO_CACHE });
    }

    const statement = await adapter.getFinancials(sym, period);
    return ok(statement, { headers: NO_CACHE });
  } catch (err) {
    return jsonError(err);
  }
}
