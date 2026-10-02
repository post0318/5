import { jsonError, ok } from "@/lib/api";
import { getStockOverview } from "@/lib/markets/service";
import { computeUniverseRow } from "@/lib/universe/overview";
import { fetchUsCompanyFacts } from "@/lib/markets/us/edgar";
import { isCfConcept, ltmBaseEnd, sourceIdsAt, yahooLtm } from "@/lib/markets/us/edgar-yahoo-quarters";
import { instantOn, ltmAnchor, ltmFlowOf } from "@/lib/markets/us/edgar-series";
import type { CompanyFacts } from "@/lib/markets/us/edgar";

/**
 * 20-F LTM 항목 전부(최종 재무 데이터의 YAHOO-Q 항목) — 출처(ltmSrc)와 함께. 잔액 = 그 날짜 값, 흐름 = 사업연도(ltmQ) + 당기 − 전기(LTM 조합과 같은 식).
 * 출처 없는 항목도 그대로 내보낸다(검증기가 실패 처리 — 값만 넣고 출처를 빠뜨린 경우)
 */
function ltmItems(facts: CompanyFacts) {
  type Entry = import("@/lib/markets/us/edgar").FactUnitEntry;
  const items: { concept: string; at: string; usd: number | null; flow: boolean; src: unknown; form: string; end: string }[] = [];
  const gaps: { concept: string; kind: "bs" | "cf"; at: string; ids: { id: string; sign: 1 | -1 }[]; reason: string | null }[] = [];
  const yl = yahooLtm(facts);
  const through = yl?.through, E = ltmBaseEnd(facts);
  if (!through || !E) return { items, gaps, sixKSource: null, through: null, E: null };
  const yearAgo = (() => { const x = new Date(`${through}T00:00:00Z`); return new Date(Date.UTC(x.getUTCFullYear() - 1, x.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); })();
  const anchor = ltmAnchor(facts);
  const dd = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;
  // 화면과 같은 선택 규칙(재감사 P1·P2·P4 — 다시 고르지 않는다): 잔액 = instantOn(±6일, 가장 가까운 항목), 흐름 = ltmFlowOf(화면 함수)
  const nearest = (arr: Entry[], d: string) => arr.filter((e) => !e.start && dd(e.end, d) <= 6).sort((a, b) => dd(a.end, d) - dd(b.end, d))[0];
  for (const [c, node] of Object.entries(facts.facts["us-gaap"] ?? {})) {
    const arr = (node as { units?: Record<string, Entry[]> }).units?.USD ?? [];
    if (arr.some((e) => !e.start)) {
      for (const d of [through, yearAgo]) {
        const e = nearest(arr, d);
        if (e) items.push({ concept: c, at: d, usd: e.val, flow: false, src: e.ltmSrc ?? null, form: e.form, end: e.end });
        // 완결성(재감사 P5) — 사업연도말 값이 있는데 기준일 값이 없는 개념은 공란 목록으로(검증기가 6-K 에 그 줄이 있으면 실패)
        else if (d === through && instantOn(arr, E) != null) gaps.push({ concept: c, kind: "bs", at: d, ids: sourceIdsAt(facts, c, "bs", E), reason: null });
      }
    }
    if (arr.some((e) => e.start)) {
      const r = ltmFlowOf(arr, anchor);
      if (!r.fy || dd(r.fy.end, E) > 7) continue;
      if (r.value != null) items.push({ concept: c, at: r.cur?.end ?? r.fy.end, usd: r.value, flow: true, src: r.cur?.ltmSrc ?? null, form: r.cur?.form ?? r.fy.form, end: r.cur?.end ?? r.fy.end });
      else if (isCfConcept(c)) gaps.push({ concept: c, kind: "cf", at: through, ids: sourceIdsAt(facts, c, "cf", E), reason: r.reason });
    }
  }
  return { items, gaps, sixKSource: yl?.sixKSource ?? null, through, E };
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
