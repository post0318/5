import { jsonError, ok } from "@/lib/api";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId } from "@/lib/markets/types";
import { fetchStockNewsBySide } from "@/lib/markets/news";

export const maxDuration = 30;

/**
 * 종목뉴스 목록 — 국내(한국어 언론)·해외(영미권 등 외국 언론, 화이트리스트+LLM
 * 관련성 판정) 좌우 분리. 종목의 상장 시장과 무관하게 둘 다 조회(예: 한국
 * 종목의 로이터·블룸버그 보도도 표시). 조회기간 1주일, 각 최대 30건(5개씩
 * 페이지네이션은 클라이언트에서 처리). 본문 번역·요약 저장 기능은 여기서
 * 제거됨(오너 결정, 2026-09 — 비용 부담. 거시경제 뉴스 쪽으로 이관).
 * 갱신 주기(Cache-Control s-maxage)는 KST 기준 오전 9시~오후 5시는 30분,
 * 그 외 시간은 1시간(오너 지정) — 장중에는 뉴스 흐름이 빠르니 더 자주,
 * 장 마감 후에는 LLM 관련성 판정 호출 빈도도 함께 줄어드는 효과.
 */
function cacheSeconds(): number {
  const kstHour = (new Date().getUTCHours() + 9) % 24;
  const isBusinessHours = kstHour >= 9 && kstHour < 17;
  return isBusinessHours ? 1800 : 3600;
}
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ market: string; symbol: string }> },
) {
  try {
    const { market, symbol } = await params;
    if (!isMarketId(market)) {
      return Response.json({ error: "알 수 없는 시장" }, { status: 404 });
    }

    const adapter = getAdapter(market);
    const sym = adapter.normalizeSymbol(decodeURIComponent(symbol));

    let companyName: string | null = null;
    try {
      companyName = (await adapter.getCompanyProfile(sym))?.name ?? null;
    } catch {
      // 이름 못 가져오면 심볼로 검색 — fetchStockNewsBySide 가 폴백
    }

    const { domestic, overseas, debug } = await fetchStockNewsBySide(market, sym, companyName);

    const maxAge = cacheSeconds();
    return ok(
      {
        domestic,
        overseas,
        // Vercel 대시보드 로그 확인이 번거로워 관련성 판정 방식·원본 후보 수를
        // 응답에 실어 curl로 바로 진단(오너 확인, 2026-09) — UI는 무시함.
        _debug: debug,
      },
      { headers: { "Cache-Control": `public, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 2}` } },
    );
  } catch (err) {
    return jsonError(err);
  }
}
