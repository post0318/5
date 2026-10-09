import { jsonError, ok } from "@/lib/api";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId } from "@/lib/markets/types";
import { getKrJurirNo } from "@/lib/markets/kr/opendart";
import { fetchKrAnnualDps } from "@/lib/markets/kr/rights-schedule";
import { fetchKrDps } from "@/lib/markets/kr/dart-facts";
import { resolveCorpCode } from "@/lib/markets/kr/corpcode";
import { after } from "next/server";
import { readTtmSnapAny, touchTtmSeen, writeTtmSnap } from "@/lib/db/ttm-snap";

export const maxDuration = 180; // 재무(fin) 저장본이 없는 종목은 요청 시점 조립 40초 + SEC 원본 판독 — 45~60초 한도에 걸려 504(2026-10-01)

/**
 * TTM(최근 4분기) 플로우 + 국내 보조지표(주당배당금). 52주 베타는 ../beta 라우트(TTM 첫 조회가 느려 분리, 2026-10-01).
 * 미구현 시장은 { ttm: null, dividend: null }.
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
    let dividendError: string | null = null;
    const [ttm, krDividend, krDps] = await Promise.all([
      // 미국: TTM 스냅샷 저장본(같은 배포판·24시간 안)을 바로 쓰고, 없으면 계산해 저장(db/ttm-snap.ts — 첫 조회 6~40초 문제)
      market === "us"
        ? readTtmSnapAny(market, sym)
            .catch(() => null)
            .then(async (hit) => {
              if (hit) {
                await touchTtmSeen(market, sym).catch(() => {});
                // 배포판만 다른 저장본 — 바로 돌려주고 응답 뒤에 새 코드로 다시 계산·저장
                if (!hit.current && adapter.getTtm)
                  after(async () => {
                    const t = await adapter.getTtm!(sym).catch(() => null);
                    if (t) await writeTtmSnap(market, sym, t, { viewed: true }).catch(() => {});
                  });
                return hit.ttm;
              }
              const t = adapter.getTtm ? await adapter.getTtm(sym) : null;
              if (t) await writeTtmSnap(market, sym, t, { viewed: true }).catch(() => {});
              return t;
            })
        : adapter.getTtm
          ? adapter.getTtm(sym)
          : Promise.resolve(null),
      // no-silent-catch:begin — 한국 배당(감사 1차 ⑨)
      market === "kr"
        ? getKrJurirNo(sym)
            .then((crno) => (crno ? fetchKrAnnualDps(crno) : null))
            .catch((e) => { dividendError = `배당기준일(공공데이터) 조회 실패 — ${e instanceof Error ? e.message : String(e)}`; return null; })
        : Promise.resolve(null),
      // 사업연도 DPS = 하이라이트와 같은 DART 배당(alotMatter, 무배당 = 0) — 개요 DPS 가 공공데이터 달력연도 합이라 하이라이트와 갈렸다(감사 6차 ①)
      market === "kr"
        ? fetchKrDps(resolveCorpCode("", sym).corpCode).catch((e) => { dividendError = `DART 배당(사업연도 주당배당금) 조회 실패 — ${e instanceof Error ? e.message : String(e)}`; return null; })
        : Promise.resolve(null),
      // no-silent-catch:end
    ]);

    // 미국(EDGAR)은 주당배당금도 TTM 페이로드에 실려 온다 → 국내와 동일 형태로 변환.
    let dividend = krDividend as {
      annual: { dps: number; year: number } | null;
      ttm: { dps: number; from: string; to: string; basis?: "fy"; year?: number } | null;
    } | null;
    // 한국: 하이라이트와 같은 정의 — 사업연도 = DART 최근 사업연도 주당배당금(무배당 0), 최근 12개월 = 공공데이터 배당기준일 합, 창 안에 배당이
    // 없으면 최근 사업연도 값(하이라이트 LTM 과 같은 대체 — basis "fy")
    if (market === "kr") {
      const fy = krDps && krDps.dpsByYear.size ? Math.max(...krDps.dpsByYear.keys()) : null;
      const fyDps = fy != null ? (krDps!.dpsByYear.get(fy) ?? null) : null;
      const tt = krDividend?.ttm ?? null;
      dividend = krDividend || krDps
        ? {
            annual: fy != null && fyDps != null ? { dps: fyDps, year: fy } : null,
            ttm: tt ?? (krDividend && fy != null && fyDps != null ? { dps: fyDps, from: "", to: "", basis: "fy", year: fy } : null),
          }
        : null;
    }
    if (!dividend && ttm?.dpsAnnual) {
      dividend = {
        annual: {
          dps: ttm.dpsAnnual.dps,
          year: Number(ttm.dpsAnnual.label.match(/FY(\d{4})/)?.[1]) || 0,
        },
        ttm: ttm.dpsTtm ?? null,
      };
    }

    return ok(
      { ttm, dividend, ...(dividendError ? { dividendError } : {}) },
      {
        headers: {
          "Cache-Control": dividendError || ttm?.degraded?.length ? "no-store" : "public, s-maxage=1800, stale-while-revalidate=86400",
        },
      },
    );
  } catch (err) {
    return jsonError(err);
  }
}
