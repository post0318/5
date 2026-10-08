import { jsonError, ok } from "@/lib/api";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId } from "@/lib/markets/types";
import { fetchUsCompanyFacts, fetchUsSic } from "@/lib/markets/us/edgar";
import { blankLtmIfFilingsUnavailable } from "@/lib/markets/us/sec-unavailable";
import { loadClassAFactsMarked } from "@/lib/markets/us/class-facts-loader";
import { secBasisBars } from "@/lib/markets/us/edgar-shares";
import { yahooLtmLabel } from "@/lib/markets/us/edgar-yahoo-quarters";
import { loadCaptiveDebt } from "@/lib/markets/us/edgar-captive";
import { reitOpUnits } from "@/lib/markets/us/edgar-ev";
import { buildUsCashFlow } from "@/lib/markets/us/edgar-cashflow";
import { buildUsIncome } from "@/lib/markets/us/edgar-income";
import { finIssueNote } from "@/lib/markets/us/fin-revenue";
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
import { getKrDaDocChecked } from "@/lib/db/kr-da";
import { usSharesHint } from "@/lib/markets/us/shares-hint";
import { loadKrCapsChecked } from "@/lib/markets/kr/dart-ev";
import { dartAdrAnalysis, dartAdrDetail, dartAdrOf } from "@/lib/markets/us/dart-adr";
import { getJpFinModel, jpStatementView } from "@/lib/markets/jp/statements";

export const maxDuration = 180; // 재무(fin) 저장본이 없는 종목은 요청 시점 조립 40초 + SEC 원본 판독 — 45~60초 한도에 걸려 504(2026-10-01)

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

    // 일본 — EDINET XBRL 본표(jp/statements.ts: 회사 표시 구조·계정명 그대로, 연간 5기 + 현재/LTM, 분기 탭 = 반기 열).
    // 분기 탭 기본 표도 같은 조립 결과(총괄) — 옛 경영지표 요약(adapter.getFinancials 연간)은 멀티플·컨센서스 계산이 아직 쓴다
    if (market === "jp" && (isDetail || period === "quarter")) {
      if (detailView === "analysis") {
        return Response.json({ error: "일본 재무분석은 아직 준비 중입니다(3대 재무제표만 제공)" }, { status: 501 });
      }
      const model = await getJpFinModel(sym);
      const v = detailView === "is" || detailView === "bs" || detailView === "cf" ? detailView : "summary";
      return ok(jpStatementView(model, sym, v, period), { headers: NO_CACHE });
    }

    // no-silent-catch:begin — 한국 경로(감사 1차 ⑥⑨: 조회 실패는 경고로 남기고 캐시하지 않는다)
    if (market === "kr" && isDetail) {
      const { corpCode } = resolveCorpCode("", sym);

      if (detailView === "analysis") {
        const krxWarn: string[] = [];
        const warnOf = (what: string) => (e: unknown) => { krxWarn.push(`${what} 조회 실패 — ${e instanceof Error ? e.message : String(e)}`); return null; };
        const [facts, krx, bars, ttm, daR, live, quarterFacts] = await Promise.all([
          fetchKrFacts(corpCode, "annual"),
          // KRX 일별 시세 조회 실패 — 경고로 남긴다(현재가·시가총액은 공통 시세 함수 우선, KRX 는 상장주식수 등 보조)
          fetchKrxEod(sym).catch(warnOf("KRX 일별 시세")),
          // silent-ok: Stooq 는 보조(연말 종가는 KRX 시가총액 응답 종가 → 없으면 KRX 연말 종가를 따로 조회) — 실패해도 값이 바뀌지 않는다
          fetchStooqEod("kr", sym, { from: `${new Date().getFullYear() - 6}-01-01` }).catch(() => []),
          adapter.getTtm?.(sym).catch(warnOf("손익 TTM(분기 보고서)")) ?? Promise.resolve(null),
          getKrDaDocChecked(sym),
          // 현재가·시가총액은 개요·하이라이트와 같은 시세 함수
          getEodQuote("kr", sym).catch(warnOf("현재가(시세) — LTM 시가총액·주가는 KRX 일별 값")),
          // LTM 열 — 흐름은 최근 4개 분기 합, 재무상태표는 마지막 분기말(손익 TTM 과 같은 기준, 분기 화면과 같은 캐시)
          fetchKrFacts(corpCode, "quarter").catch(warnOf("분기 재무제표")),
        ]);
        const daDoc = daR.doc;
        if (daR.warning) krxWarn.push(daR.warning);
        for (const w of ttm?.degraded ?? []) krxWarn.push(w);
        for (const w of live?.warnings ?? []) krxWarn.push(`현재가: ${w}`);
        if (!facts) return Response.json({ error: "재무제표를 찾을 수 없습니다" }, { status: 404 });
        const fyCloseByYear = new Map<number, number>();
        const needYears = facts.periods
          .map((p) => p.year)
          .filter((y) => !bars.some((b) => b.date <= `${y}-12-31` && b.date >= `${y}-11-01` && b.close != null));
        await Promise.all(
          needYears.map(async (y) => {
            const c = await fetchKrxCloseOn(sym, `${y}1231`).catch((e) => { krxWarn.push(`${y} 연말 종가(KRX) 조회 실패 — ${e instanceof Error ? e.message : String(e)}`); return null; });
            if (c != null) fyCloseByYear.set(y, c);
          }),
        );
        const capsR = await loadKrCapsChecked(sym, facts.periods.map((p) => p.year));
        const stmt = buildKrAnalysis({
          code: sym,
          caps: capsR.caps,
          capsError: capsR.error,
          warnings: krxWarn,
          facts,
          bars,
          fyCloseByYear,
          sharesOutstanding: krx?.listedShares ?? live?.sharesOutstanding ?? null,
          currentPrice: live?.last ?? krx?.bars.at(-1)?.close ?? bars.at(-1)?.close ?? null,
          currentMarketCap: live?.marketCap ?? krx?.marketCap ?? null,
          ttm: ttm ?? null,
          daDoc: daDoc ?? null,
          quarterFacts: quarterFacts ?? null,
        });
        stmt.symbol = sym;
        return ok(stmt, { headers: NO_CACHE });
      }

      const [facts, daR] = await Promise.all([
        fetchKrFacts(corpCode, period),
        detailView === "is" || detailView === "summary" || detailView === "bs"
          ? getKrDaDocChecked(sym)
          : Promise.resolve({ doc: null, warning: null }),
      ]);
      const daDoc = daR.doc;
      if (!facts) {
        return Response.json({ error: "재무제표를 찾을 수 없습니다" }, { status: 404 });
      }
      const stmt =
        detailView === "cf"
          ? buildKrCashFlow(facts)
          : detailView === "is"
            ? buildKrIncome(facts, daDoc)
            : detailView === "bs"
              ? buildKrBalance(facts, daDoc)
              : buildKrSummary(facts, daDoc);
      stmt.symbol = sym;
      // 감가상각 적재본 조회 실패 — 감가상각비·EBITDA 가 공시 줄 폴백·빈칸으로 바뀌었다는 경고(조용한 대체 금지)
      if (daR.warning) stmt.warnings = [`⚠ ${daR.warning} — 감가상각비·EBITDA 는 DART 공시 현금흐름 줄 또는 빈칸`];
      return ok(stmt, { headers: NO_CACHE });
    }
    // no-silent-catch:end

    // SEC XBRL 이 없는 ADR(SKHY) — 본국 DART 재무를 USD·ADR 기준으로(dart-adr.ts)
    const dartAdr = market === "us" && isDetail ? dartAdrOf(sym) : null;
    if (dartAdr) {
      const stmt =
        detailView === "analysis"
          ? await dartAdrAnalysis(dartAdr, searchParams.get("yahoo"))
          : await dartAdrDetail(dartAdr, detailView as "is" | "bs" | "cf" | "summary", period);
      return ok(stmt, { headers: NO_CACHE });
    }

    if (market === "us" && isDetail) {
      const yahoo = searchParams.get("yahoo");
      const needsShares =
        detailView === "analysis" || detailView === "is" || detailView === "summary";
      const { cik, facts: facts0 } = await fetchUsCompanyFacts(sym);
      const [quote, consensus, cls, sic] = await Promise.all([
        needsShares
          ? getEodQuote("us", sym, { yahooOverride: yahoo }).catch(() => null)
          : Promise.resolve(null),
        needsShares
          ? fetchForwardConsensus("us", sym, yahoo).catch(() => null)
          : Promise.resolve(null),
        // 듀얼클래스 보정 — 원본 판독 실패는 facts 에 기록(클래스별 값이 필요한 칸 공란 + 사유)
        needsShares
          ? loadClassAFactsMarked(cik, facts0)
          : Promise.resolve({ classFacts: null, facts: facts0 }),
        fetchUsSic(sym).catch(() => null),
      ]);
      const facts = cls.facts;
      const classFacts = cls.classFacts;
      // Yahoo 현재 주식수 힌트 — ADR 비율 판정에만(주식수 값으로 대신 쓰지 않음, edgar-shares.ts)
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
                : buildUsAnalysis(facts, secBasisBars(facts, quote), {
                    sharesHint,
                    classFacts,
                    sic,
                    evCtx: {
                      sic,
                      // 판별 조회 실패 = "unknown"(금융 자회사 없음으로 단정하지 않음 — EV 미표시)
                      captive: await loadCaptiveDebt(cik, sic).catch(() => "unknown" as const),
                      opUnits: reitOpUnits(
                        sic,
                        consensus?.sharesOutstanding,
                        consensus?.impliedSharesOutstanding,
                      ),
                    },
                  });
      stmt.symbol = sym;
      // 최신 공시 보완이 원본 조회 실패면 LTM 열은 공란(더 오래된 기간 값을 LTM 으로 내지 않음 — sec-unavailable.ts)
      blankLtmIfFilingsUnavailable(facts, stmt);
      // 원본 조회 일시 오류(SEC 429 등) — 일부 공시가 빠졌을 수 있다(fetch-health.ts)
      if (facts.fetchWarnings?.length) stmt.source += ` · ⚠ 일부 공시 조회 실패(${facts.fetchWarnings.slice(0, 3).join(", ")}) — 잠시 뒤 다시 계산`;
      // 20-F 발행사 LTM 열 = Yahoo 분기(edgar-yahoo-quarters.ts) — 기준일·공란 항목 명시
      if (facts.ltmQuarterSource) stmt.source += ` · ${yahooLtmLabel(facts.ltmQuarterSource)}`;
      // 외화 환산 — 연준 H.10 최신 고시일 뒤 기간은 비움(edgar-foreign.ts, 다른 환율로 대체하지 않음)
      if (facts.fxPending) stmt.source += ` · ⚠ ${facts.fxPending} — 해당 기간 환산 값 비움`;
      // 재무 5층 구조 조립 점검 결과(gaps·조립 항등식) — 검증기·관리자용 구조화 필드로만 싣고 화면 출처 문구에는 넣지 않는다(오너 지적
      // 2026-10-01 — MU "fin 조립 미완전 열 …" 내부 진단이 화면에 그대로 떠 숫자가 틀린 것처럼 보였다. 숫자는 SEC 와 일치). 매출이 실제로
      // 비는 열은 그 칸의 사유 주석으로 따로 보인다
      if (finIssueNote(facts.revenue)) stmt.finIssues = facts.revenue!.issues;
      return ok(stmt, { headers: NO_CACHE });
    }

    const statement = await adapter.getFinancials(sym, period);
    return ok(statement, { headers: NO_CACHE });
  } catch (err) {
    return jsonError(err);
  }
}
