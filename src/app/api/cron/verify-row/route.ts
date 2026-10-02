import { jsonError, ok } from "@/lib/api";
import { getStockOverview } from "@/lib/markets/service";
import { computeUniverseRow } from "@/lib/universe/overview";
import { fetchUsCompanyFacts } from "@/lib/markets/us/edgar";
import { YAHOO_Q_FORM, yahooLtm } from "@/lib/markets/us/edgar-yahoo-quarters";
import type { CompanyFacts } from "@/lib/markets/us/edgar";

/**
 * 20-F LTM 항목 전부(최종 재무 데이터의 YAHOO-Q 항목) — 출처(ltmSrc)와 함께. 잔액 = 그 날짜 값, 흐름 = 사업연도(ltmQ) + 당기 − 전기(LTM 조합과 같은 식).
 * 출처 없는 항목도 그대로 내보낸다(검증기가 실패 처리 — 값만 넣고 출처를 빠뜨린 경우)
 */
function ltmItems(facts: CompanyFacts) {
  const out: { concept: string; at: string; usd: number | null; flow: boolean; src: unknown }[] = [];
  for (const [c, node] of Object.entries(facts.facts["us-gaap"] ?? {})) {
    const arr = (node as { units?: Record<string, import("@/lib/markets/us/edgar").FactUnitEntry[]> }).units?.USD ?? [];
    for (const e of arr) {
      if (e.form !== YAHOO_Q_FORM) continue;
      if (!e.start) { out.push({ concept: c, at: e.end, usd: e.val, flow: false, src: e.ltmSrc ?? null }); continue; }
      // 흐름 — 당기 항목(끝 = 기준일)만. 사업연도 항목(같은 시작·1년)·전기 항목(같은 시작·끝 < 당기)으로 LTM
      const fy = arr.find((x) => x.start && x.form !== YAHOO_Q_FORM && x.ltmQ != null && x.end < e.end && Date.parse(x.end) >= Date.parse(e.start!) - 864e5 * 2);
      const prior = arr.find((x) => x.form === YAHOO_Q_FORM && x !== e && x.start === fy?.start && x.end < e.end);
      if (!fy || !prior) { if (e.ltmSrc) out.push({ concept: c, at: e.end, usd: null, flow: true, src: e.ltmSrc }); continue; }
      out.push({ concept: c, at: e.end, usd: fy.ltmQ! + (e.ltmQ ?? e.val) - (prior.ltmQ ?? prior.val), flow: true, src: e.ltmSrc ?? null });
    }
  }
  return out;
}

/**
 * 재무 검증 스크립트(scripts/verify-financials.mjs) 전용 — 화면이 실제로 쓰는 계산 함수의
 * 결과를 그대로 돌려준다. 검증기가 식을 따로 짜서 비교하면 화면과 다른 경로를 검증하게
 * 된다(검증 도구 감사 2026-09-24).
 *   - universe: 유니버스 통합 뷰 한 행(computeUniverseRow — 한국은 computeKrOverviewMetrics)
 *   - overview: 종목분석 개요 멀티플(getStockOverview + computeTrailingMultiples, 재무 포함)
 *   - ltm: 20-F LTM 항목 전부와 출처(edgar-yahoo-quarters LtmSrc — 검증기가 야후·SEC 20-F·6-K 를 따로 읽어 다시 계산, 2026-10-02 재감사)
 * 인증은 다른 cron 경로와 같다(CRON_SECRET, 로컬은 APP_PASSWORD). DB 불필요.
 */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const appPw = process.env.APP_PASSWORD;
  if (appPw && req.headers.get("x-app-token") === appPw) return true;
  if (secret) return req.headers.get("authorization") === `Bearer ${secret}`;
  return false;
}

export const maxDuration = 120;

export async function GET(req: Request) {
  try {
    if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const sp = new URL(req.url).searchParams;
    const market = sp.get("market");
    const symbol = sp.get("symbol");
    if ((market !== "us" && market !== "kr") || !symbol)
      return Response.json({ error: "market=us|kr, symbol 필요" }, { status: 400 });
    // 순서대로 — 동시에 돌리면 같은 시세를 두 번 받다가 제한시간(12초)에 걸려 결과가 비었다
    const universe = await computeUniverseRow(market, symbol);
    const overview = await getStockOverview(market, symbol, null, { skipQuarterly: true });
    // 20-F 만 값이 있다(10-K·10-Q 회사는 null)
    const usFacts = market === "us" ? ((await fetchUsCompanyFacts(symbol).catch(() => null))?.facts ?? null) : null;
    const ltm = usFacts && yahooLtm(usFacts) ? ltmItems(usFacts) : null;
    return ok({ universe, overview: { multiples: overview.multiples, warnings: overview.warnings }, ltm });
  } catch (e) {
    return jsonError(e);
  }
}
