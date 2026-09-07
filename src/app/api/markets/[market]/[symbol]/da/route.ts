import { ok } from "@/lib/api";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId } from "@/lib/markets/types";
import { getKrDaDoc } from "@/lib/db/kr-da";
import { fetchKrDA } from "@/lib/markets/kr/xbrl";

export const maxDuration = 60;

/**
 * 감가상각비 + 무형자산상각비 (연결) — EV/EBITDA 정확 산출용.
 * MongoDB(kr_da, 외부 파싱본) 우선. 없으면 라이브 XBRL 시도(OpenDART가 클라우드 IP를
 * 차단해 대개 실패). 최종 실패 시 { da: null } → 화면은 EV/EBIT 근사.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ market: string; symbol: string }> },
) {
  const { market, symbol } = await params;
  if (!isMarketId(market)) return Response.json({ error: "알 수 없는 시장" }, { status: 404 });
  if (market !== "kr") return ok({ da: null });
  const sym = getAdapter("kr").normalizeSymbol(decodeURIComponent(symbol));

  const doc = await getKrDaDoc(sym);
  if (doc) {
    return ok(
      { da: { year: doc.year, depreciation: doc.depreciation, amortisation: doc.amortisation } },
      { headers: { "Cache-Control": "public, s-maxage=604800, stale-while-revalidate=86400" } },
    );
  }

  const fy = new Date().getFullYear() - 1;
  const da = await fetchKrDA(sym, fy)
    .then((r) => r ?? fetchKrDA(sym, fy - 1))
    .catch(() => null);
  return ok(
    { da },
    { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=86400" } },
  );
}
