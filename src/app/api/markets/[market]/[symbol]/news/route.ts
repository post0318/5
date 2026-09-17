import { after } from "next/server";
import { jsonError, ok } from "@/lib/api";
import { isMarketId } from "@/lib/markets/types";
import {
  freshMs,
  readStockNews,
  refreshStockNews,
} from "@/lib/markets/stock-news-cache";

export const maxDuration = 30;

/**
 * 종목뉴스 목록 — 국내(한국어 언론)·해외(영미권 등 외국 언론, 화이트리스트+LLM
 * 관련성 판정) 좌우 분리. 종목의 상장 시장과 무관하게 둘 다 조회(예: 한국
 * 종목의 로이터·블룸버그 보도도 표시). 조회기간 1주일, 각 최대 30건(5개씩
 * 페이지네이션은 클라이언트에서 처리). 본문 번역·요약 저장 기능은 여기서
 * 제거됨(오너 결정, 2026-09 — 비용 부담. 거시경제 뉴스 쪽으로 이관).
 *
 * 2026-09-17 — 수집을 MongoDB(`stock_news`)로 옮겼다. 실시간으로 긁으면 처음
 * 보는 종목이 4.5~9.3초 걸린다(실측, 로컬 프로덕션 빌드). 크론이 유니버스
 * 종목을 미리 채우고 여기서는 그 문서를 읽는다. 묵었으면 곧바로 주고 갱신은
 * 응답 뒤(`after`)로 미뤄 사용자를 기다리게 하지 않는다. 유니버스 밖 종목만
 * 실시간 조회하고 결과를 같은 컬렉션에 남긴다.
 *
 * 갱신 주기는 KST 기준 오전 9시~오후 5시 30분, 그 외 1시간(오너 지정) —
 * DB 신선도 판정과 HTTP 캐시(s-maxage)가 같은 기준을 쓴다. CDN 에서 걸리면
 * 서버까지 오지도 않으므로 HTTP 캐시는 그대로 둔다.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ market: string; symbol: string }> },
) {
  try {
    const { market, symbol } = await params;
    if (!isMarketId(market)) {
      return Response.json({ error: "알 수 없는 시장" }, { status: 404 });
    }
    const sym = decodeURIComponent(symbol);

    const { payload, source, refreshInBackground } = await readStockNews(market, sym);
    if (refreshInBackground) {
      // 응답을 먼저 보내고 갱신한다. 실패해도 이번 응답에는 영향이 없다.
      after(async () => {
        try {
          await refreshStockNews(market, sym);
        } catch (err) {
          console.error("[news] 배경 갱신 실패", market, sym, err);
        }
      });
    }

    const maxAge = Math.round(freshMs() / 1000);
    return ok(
      {
        domestic: payload.domestic,
        overseas: payload.overseas,
        // Vercel 대시보드 로그 확인이 번거로워 관련성 판정 방식·원본 후보 수를
        // 응답에 실어 curl로 바로 진단(오너 확인, 2026-09) — UI는 무시함.
        _debug: {
          rawDomestic: payload.rawDomestic,
          rawOverseas: payload.rawOverseas,
          relevance: payload.relevance,
          source,
          fetchedAt: payload.fetchedAt,
          refreshing: refreshInBackground,
        },
      },
      {
        headers: {
          "Cache-Control": `public, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 2}`,
        },
      },
    );
  } catch (err) {
    return jsonError(err);
  }
}
