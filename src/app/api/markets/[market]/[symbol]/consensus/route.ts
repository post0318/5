import { jsonError, ok } from "@/lib/api";
import { isMarketId } from "@/lib/markets/types";
import { getConsensusData } from "@/lib/markets/consensus";
import { koreanizeNotesDeep } from "@/lib/markets/jp/ko";

export const maxDuration = 180; // 재무(fin) 저장본이 없는 종목은 요청 시점 조립 40초 + SEC 원본 판독 — 45~60초 한도에 걸려 504(2026-10-01)

export async function GET(
  request: Request,
  { params }: { params: Promise<{ market: string; symbol: string }> },
) {
  try {
    const { market, symbol } = await params;
    if (!isMarketId(market)) {
      return Response.json({ error: "알 수 없는 시장" }, { status: 404 });
    }
    const yahoo = new URL(request.url).searchParams.get("yahoo");
    const raw = await getConsensusData(market, decodeURIComponent(symbol), yahoo);
    const data = market === "jp" ? await koreanizeNotesDeep(raw) : raw; // 일본 칸 주석 원문 용어 → 한국어(原文)
    return ok(data, {
      headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
    });
  } catch (err) {
    return jsonError(err);
  }
}
