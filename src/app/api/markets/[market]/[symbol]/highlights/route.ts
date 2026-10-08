import { after } from "next/server";
import { jsonError, ok } from "@/lib/api";
import { readApiSnap, writeApiSnap } from "@/lib/db/api-snap";
import type { FinancialHighlights } from "@/lib/markets/us/edgar-highlights";
import { isMarketId } from "@/lib/markets/types";
import { yahooLtmLabel } from "@/lib/markets/us/edgar-yahoo-quarters";
import { getAdapter } from "@/lib/markets/registry";
import { getEodQuote } from "@/lib/markets/quote";
import { fetchForwardConsensus, fetchYahooEstimates } from "@/lib/markets/quote/yahoo";
import { fetchUsCompanyFacts, fetchUsSic } from "@/lib/markets/us/edgar";
import { estimatesToUsd } from "@/lib/markets/us/edgar-foreign";
import { buildUsHighlights } from "@/lib/markets/us/edgar-highlights";
import { buildUsBankHighlights, isFinancialCompany } from "@/lib/markets/us/edgar-highlights-bank";
import { blankLtmColumnIfFilingsUnavailable } from "@/lib/markets/us/sec-unavailable";
import { loadClassAFactsMarked } from "@/lib/markets/us/class-facts-loader";
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
import { secBasisBars } from "@/lib/markets/us/edgar-shares";
import { loadKrCaps } from "@/lib/markets/kr/dart-ev";
import { dartAdrHighlights, dartAdrOf } from "@/lib/markets/us/dart-adr";
import { getJpHighlights } from "@/lib/markets/jp/jp-views";

export const revalidate = 3600;
export const maxDuration = 180; // 재무(fin) 저장본이 없는 종목은 요청 시점 조립 40초 + SEC 원본 판독 — 45~60초 한도에 걸려 504(2026-10-01)

/**
 * 재무 하이라이트 표 (EV 브릿지 + 5개년 손익·현금흐름 + 현재/LTM + 차기 추정).
 * 미국(SEC EDGAR) · 한국(OpenDART) · 일본(EDINET XBRL — jp/jp-ev.ts 단일 기준).
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
    const adapter = getAdapter(market);
    const sym = adapter.normalizeSymbol(decodeURIComponent(symbol));
    const yahoo = new URL(request.url).searchParams.get("yahoo");

    // 일본 — EDINET 본표 조립 + Yahoo 시세(jp-ev.ts 단일 기준). 시세·서류 판독 경고가 있으면 캐시하지 않는다
    if (market === "jp") {
      const highlights = await getJpHighlights(sym, yahoo);
      const warned = highlights.notes.some((n) => n.startsWith("⚠"));
      return ok({ highlights }, { headers: { "Cache-Control": warned ? "no-store" : "public, s-maxage=3600, stale-while-revalidate=86400" } });
    }

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

    // SEC XBRL 이 없는 ADR(SKHY) — 본국 DART 재무를 USD·ADR 기준으로(dart-adr.ts)
    const dartAdr = dartAdrOf(sym);
    if (dartAdr) {
      return ok(
        { highlights: await dartAdrHighlights(dartAdr, yahoo) },
        { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
      );
    }

    // 저장본 먼저(배포 직후·CDN 캐시 비었을 때도 바로) — 묵었으면 응답 뒤 다시 계산(api-snap.ts)
    const snapKey = `hl:us:${sym}|${yahoo ?? ""}`;
    // 저장본은 계산 때 주가가 지금 주가와 같을 때만(시가총액·EV·PER 등이 개요·재무분석과 같은 주가로 — 화면 간 같은 값). 주가는 캐시된 조회라 빠르다
    const [snap0, q0] = await Promise.all([
      readApiSnap<{ highlights: FinancialHighlights; price: number | null }>(snapKey).catch(() => null),
      getEodQuote(market, sym, { yahooOverride: yahoo }).catch(() => null),
    ]);
    // 구조 확인 — 형식이 다른 저장본(옛 형식·다른 판)은 쓰지 않는다
    const okShape = (h: unknown): h is FinancialHighlights =>
      !!h && Array.isArray((h as FinancialHighlights).columns) && Array.isArray((h as FinancialHighlights).rows);
    const snap = snap0 && okShape(snap0.data?.highlights) && snap0.data.price === (q0?.last ?? null) ? { data: snap0.data.highlights, stale: snap0.stale } : null;
    if (snap) {
      if (snap.stale)
        after(async () => {
          const r = await computeUsHighlights(market, sym, yahoo).catch(() => null);
          if (r && !r.degraded) await writeApiSnap(snapKey, { highlights: r.highlights, price: r.price }).catch(() => {});
        });
      return ok({ highlights: snap.data }, { headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600" } });
    }
    const { highlights, degraded, price } = await computeUsHighlights(market, sym, yahoo);
    if (!degraded) await writeApiSnap(snapKey, { highlights, price }).catch(() => {});
    return ok(
      { highlights },
      {
        headers: {
          "Cache-Control": degraded ? "no-store" : "public, s-maxage=3600, stale-while-revalidate=86400",
        },
      },
    );
  } catch (err) {
    return jsonError(err);
  }
}

/** 미국 하이라이트 계산(SEC·Yahoo) — 저장본(api_snap) 갱신에도 쓴다 */
async function computeUsHighlights(market: "us", sym: string, yahoo: string | null) {
  const factsRes0 = await fetchUsCompanyFacts(sym);
  const [quote, estimatesRaw, consensus, cls, sic] = await Promise.all([
    getEodQuote(market, sym, { yahooOverride: yahoo }).catch(() => null),
    fetchYahooEstimates(market, sym, yahoo).catch(() => null),
    fetchForwardConsensus(market, sym, yahoo).catch(() => null),
    // 듀얼클래스 보정 — 원본 판독 실패는 facts 에 기록(클래스별 값이 필요한 칸 공란 + 사유)
    loadClassAFactsMarked(factsRes0.cik, factsRes0.facts),
    fetchUsSic(sym).catch(() => null),
  ]);
  const factsRes = { cik: factsRes0.cik, facts: cls.facts };
  const classFacts = cls.classFacts;
  // EV 브릿지 맥락 — 금융 자회사 부문 차입금(XBRL 인스턴스), UP-REIT 파트너 지분. 판별 조회 실패 = "unknown"(EV 미표시)
  const captive = await loadCaptiveDebt(factsRes.cik, sic).catch(() => "unknown" as const);
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

  // 과거 결산일 가격을 주식수와 같은 기준으로 — Yahoo 가 분할로 기록한 분사 되돌림(edgar-shares.ts)
  const usBars = secBasisBars(factsRes.facts, quote);
  const highlights = isFinancialCompany(factsRes.facts, sic)
    ? buildUsBankHighlights(factsRes.facts, usBars, estCols, sharesHint)
    : buildUsHighlights(factsRes.facts, usBars, estCols, sharesHint, classFacts, {
        sic,
        captive,
        opUnits,
      });
  if (estimates && "fxNote" in estimates && estimates.fxNote) highlights.notes.push(estimates.fxNote);
  if (estimatesRaw && !estimates) highlights.notes.push("외화 예상치 환산 실패 — 예상치 숨김");
  // 최신 공시 보완이 원본 조회 실패면 LTM 열은 공란(더 오래된 기간 값을 LTM 으로 내지 않음 — sec-unavailable.ts)
  blankLtmColumnIfFilingsUnavailable(factsRes.facts, highlights);
  // 원본 조회 일시 오류(SEC 429 등) — 일부 공시가 빠졌을 수 있다(fetch-health.ts, 2분 뒤 다시 계산)
  if (factsRes.facts.fetchWarnings?.length)
    highlights.notes.unshift(`⚠ 일부 공시 조회 실패(${factsRes.facts.fetchWarnings.slice(0, 3).join(", ")}) — 값이 빠지거나 오래됐을 수 있음, 잠시 뒤 다시 계산`);
  // 20-F 발행사 LTM 열 = Yahoo 분기(edgar-yahoo-quarters.ts) — 기준일·공란 항목 명시
  const lq = factsRes.facts.ltmQuarterSource;
  if (lq) highlights.notes.push(yahooLtmLabel(lq));
  // 외화 환산 — 연준 H.10 최신 고시일 뒤 기간은 비움(edgar-foreign.ts, 다른 환율로 대체하지 않음)
  if (factsRes.facts.fxPending) highlights.notes.push(`⚠ ${factsRes.facts.fxPending} — 해당 기간 환산 값 비움`);

  // 조회 실패로 불완전한 결과는 CDN 에 1시간 붙잡히지 않게 캐시하지 않는다(다음 요청이 다시 계산)
  const degraded = !!factsRes.facts.fetchWarnings?.length || !!factsRes.facts.sourceUnavailable;
  return { highlights, degraded, price: quote?.last ?? null };
}
