import { unstable_cache } from "next/cache";
import { ok } from "@/lib/api";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId } from "@/lib/markets/types";
import { fetchKrDA } from "@/lib/markets/kr/xbrl";

export const maxDuration = 60;

/**
 * 감가상각비 + 무형자산상각비 (연결, DART XBRL). EV/EBITDA 정확 산출용.
 * XBRL zip 다운·파싱이 느려(공공 API 지연) 별도 라우트 + 7일 캐시. 실패 시 { da: null }.
 */
const cached = (sym: string) =>
  unstable_cache(
    async () => {
      const fy = new Date().getFullYear() - 1;
      try {
        return (await fetchKrDA(sym, fy)) ?? (await fetchKrDA(sym, fy - 1));
      } catch {
        return null;
      }
    },
    ["kr-da", sym],
    { revalidate: 60 * 60 * 24 * 7, tags: ["kr-da"] },
  )();

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ market: string; symbol: string }> },
) {
  const { market, symbol } = await params;
  if (!isMarketId(market)) return Response.json({ error: "알 수 없는 시장" }, { status: 404 });
  if (market !== "kr") return ok({ da: null });
  const sym = getAdapter("kr").normalizeSymbol(decodeURIComponent(symbol));
  const da = await cached(sym).catch(() => null);
  return ok(
    { da },
    { headers: { "Cache-Control": "public, s-maxage=604800, stale-while-revalidate=86400" } },
  );
}
