import { after } from "next/server";
import { z } from "zod";
import { jsonError, ok } from "@/lib/api";
import { isMarketId } from "@/lib/markets/types";
import { bulkUpsert, parseBulk } from "@/lib/universe/repo";
import { refreshUniverseOverview } from "@/lib/universe/overview";
import { authErrorResponse, requireAppUser } from "@/lib/server/app-auth";

const schema = z.object({
  text: z.string().min(1).max(100_000),
  defaultMarket: z.enum(["kr", "us", "jp"]).optional(),
  dryRun: z.boolean().optional(),
});

export async function POST(request: Request) {
  try {
    const who = await requireAppUser();
    if (!who.ok) return authErrorResponse(who);

    const { text, defaultMarket, dryRun } = schema.parse(await request.json());
    const dm = defaultMarket && isMarketId(defaultMarket) ? defaultMarket : undefined;
    const parsed = parseBulk(text, { defaultMarket: dm });

    if (dryRun) {
      return ok({ preview: parsed.ok, errors: parsed.errors, inserted: 0 });
    }
    const inserted = await bulkUpsert(who.userId, parsed.ok);
    // 내 종목만 재계산 — 공유 캐시라 남의 종목까지 훑을 이유가 없다.
    after(() => refreshUniverseOverview({ ownerId: who.userId }).catch(() => {}));
    return ok({ preview: parsed.ok, errors: parsed.errors, inserted });
  } catch (err) {
    return jsonError(err);
  }
}
