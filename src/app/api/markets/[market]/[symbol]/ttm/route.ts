import { koreanizeNotesDeep } from "@/lib/markets/jp/ko";
import { jsonError, ok } from "@/lib/api";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId } from "@/lib/markets/types";
import { getKrJurirNo } from "@/lib/markets/kr/opendart";
import { fetchKrAnnualDps } from "@/lib/markets/kr/rights-schedule";
import { isStorableTtm, readTtmSnapAny, touchTtmSeen, writeTtmSnap } from "@/lib/db/ttm-snap";

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
    const [ttm, krDividend] = await Promise.all([
      // 미국: TTM 스냅샷 저장본(같은 배포판·24시간 안)을 바로 쓰고, 없으면 계산해 저장(db/ttm-snap.ts — 첫 조회 6~40초 문제)
      market === "us"
        ? readTtmSnapAny(market, sym)
            .catch(() => null)
            .then(async (hit) => {
              if (hit) {
                await touchTtmSeen(market, sym).catch(() => {});
                // 판번호만 다른 저장본 — 새 저장본이 생길 때까지 그대로 돌려준다(오너 승인 2026-10-09). 다시 계산은 배치(ttm-build)만 — 예전엔
                // 응답 뒤에 요청마다 다시 계산했는데, 재무 저장본도 옛 판이면 그 계산은 저장되지 않아(isStorableTtm staleInputs) 서버 CPU 만 썼다
                return hit.current ? hit.ttm : { ...hit.ttm, snapStale: true };
              }
              const t = adapter.getTtm ? await adapter.getTtm(sym) : null;
              if (t && isStorableTtm(t)) {
                await writeTtmSnap(market, sym, t, { viewed: true }).catch(() => {});
                return t;
              }
              // 저장할 수 없는 계산(재무 저장본 옛 판 staleInputs 등) — 조회 기록은 남기고(배치 대상), 옛 판 fin 인 동안은 24시간 넘은 저장본도
              // 새 값이 나올 때까지 그대로(오너 결정 2026-10-09)
              await touchTtmSeen(market, sym, { upsert: true }).catch(() => {});
              if (t?.staleInputs?.length) {
                const old = await readTtmSnapAny(market, sym, { anyAge: true }).catch(() => null);
                if (old) return { ...old.ttm, snapStale: true };
              }
              return t;
            })
        : adapter.getTtm
          ? adapter.getTtm(sym)
          : Promise.resolve(null),
      market === "kr"
        ? getKrJurirNo(sym)
            .then((crno) => fetchKrAnnualDps(crno))
            .catch(() => null)
        : Promise.resolve(null),
    ]);

    // 미국(EDGAR)은 주당배당금도 TTM 페이로드에 실려 온다 → 국내와 동일 형태로 변환.
    let dividend = krDividend as {
      annual: { dps: number; year: number } | null;
      ttm: { dps: number; from: string; to: string } | null;
    } | null;
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
      { ttm: market === "jp" && ttm ? await koreanizeNotesDeep(ttm) : ttm, dividend },
      {
        headers: {
          // 옛 판 입력·옛 판 저장본 응답(staleInputs·snapStale)은 배치가 새로 채우면 바로 바뀌도록 짧게
          "Cache-Control": ttm?.staleInputs?.length || ttm?.snapStale ? "public, s-maxage=60" : "public, s-maxage=1800, stale-while-revalidate=86400",
        },
      },
    );
  } catch (err) {
    return jsonError(err);
  }
}
