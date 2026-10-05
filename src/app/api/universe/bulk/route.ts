import { after } from "next/server";
import { z } from "zod";
import { jsonError, ok } from "@/lib/api";
import { bulkUpsertResolved, type BulkSaveItem } from "@/lib/universe/repo";
import { BULK_MAX_ROWS } from "@/lib/universe/bulk-input";
import { lookupOfficial, makeBulkLists } from "@/lib/universe/resolve";
import { refreshUniverseOverview } from "@/lib/universe/overview";
import { authErrorResponse, requireAppUser } from "@/lib/server/app-auth";

export const maxDuration = 60;

/**
 * 일괄 업로드 저장 — 미리보기(`/api/universe/bulk/resolve`)에서 확정한 종목만 받는다.
 * 이름은 클라이언트 값을 믿지 않고 시장·코드로 공식 목록에서 다시 찾아 저장한다
 * (목록에 없는 코드는 건너뛰고 사유를 돌려준다).
 */
const schema = z.object({
  items: z
    .array(
      z.object({
        market: z.enum(["kr", "us", "jp"]),
        symbol: z.string().min(1).max(20),
        groupName: z.string().max(60).optional().nullable(),
        tags: z.array(z.string().max(40)).max(20).optional(),
        note: z.string().max(500).optional().nullable(),
      }),
    )
    .min(1)
    .max(BULK_MAX_ROWS),
});

export async function POST(request: Request) {
  try {
    const who = await requireAppUser();
    if (!who.ok) return authErrorResponse(who);

    const { items } = schema.parse(await request.json());
    const lists = makeBulkLists();
    const save: BulkSaveItem[] = [];
    const skipped: { market: string; symbol: string; reason: string }[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      let official = null;
      try {
        official = await lookupOfficial(it.market, it.symbol.trim().toUpperCase(), lists);
      } catch {
        skipped.push({ market: it.market, symbol: it.symbol, reason: "종목 목록을 불러오지 못했습니다" });
        continue;
      }
      if (!official) {
        skipped.push({ market: it.market, symbol: it.symbol, reason: "상장 종목 목록에 없는 코드" });
        continue;
      }
      const key = `${official.market}:${official.symbol}`;
      if (seen.has(key)) continue; // 같은 종목을 두 번 보내면 앞의 것만
      seen.add(key);
      save.push({
        market: official.market,
        symbol: official.symbol,
        name: official.name,
        yahooSymbol: official.yahooSymbol ?? null,
        groupName: it.groupName,
        tags: it.tags,
        note: it.note,
      });
    }

    const res = save.length > 0 ? await bulkUpsertResolved(who.userId, save) : { inserted: 0, updated: 0 };
    // 내 종목만 재계산 — 공유 캐시라 남의 종목까지 훑을 이유가 없다.
    if (save.length > 0) {
      after(() => refreshUniverseOverview({ ownerId: who.userId }).catch(() => {}));
    }
    return ok({ ...res, skipped });
  } catch (err) {
    return jsonError(err);
  }
}
