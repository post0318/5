import { after } from "next/server";
import { jsonError, ok } from "@/lib/api";
import { isMarketId } from "@/lib/markets/types";
import { listUniverse, upsertUniverseItem } from "@/lib/universe/repo";
import { refreshOverviewItem } from "@/lib/universe/overview";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const marketParam = searchParams.get("market");
    const activeOnly = searchParams.get("active") === "1";
    const market = marketParam && isMarketId(marketParam) ? marketParam : undefined;
    const items = await listUniverse({ market, activeOnly });
    return ok({ items });
  } catch (err) {
    return jsonError(err);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const item = await upsertUniverseItem(body);
    after(() => refreshOverviewItem(item).catch(() => {}));
    return ok({ item }, { status: 201 });
  } catch (err) {
    return jsonError(err);
  }
}
