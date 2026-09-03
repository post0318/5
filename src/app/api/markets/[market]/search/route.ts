import { jsonError, ok } from "@/lib/api";
import { isMarketId } from "@/lib/markets/types";
import { searchSymbols } from "@/lib/markets/search";

export const maxDuration = 60;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ market: string }> },
) {
  try {
    const { market } = await params;
    if (!isMarketId(market)) {
      return Response.json({ error: "알 수 없는 시장" }, { status: 404 });
    }
    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q") ?? "";
    const hits = await searchSymbols(market, q);
    return ok({ hits });
  } catch (err) {
    return jsonError(err);
  }
}
