import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { universeItems, type UniverseItem } from "@/lib/db/schema";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId, type MarketId } from "@/lib/markets/types";

export const marketSchema = z.enum(["kr", "us", "jp"]);

export const universeInputSchema = z.object({
  market: marketSchema,
  symbol: z.string().min(1).max(20),
  name: z.string().max(120).optional().nullable(),
  yahooSymbol: z.string().max(20).optional().nullable(),
  groupName: z.string().max(60).optional().nullable(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  active: z.boolean().optional(),
  note: z.string().max(500).optional().nullable(),
});
export type UniverseInput = z.infer<typeof universeInputSchema>;

function normalize(input: UniverseInput): UniverseInput {
  const adapter = getAdapter(input.market);
  return { ...input, symbol: adapter.normalizeSymbol(input.symbol) };
}

export async function listUniverse(filter?: {
  market?: MarketId;
  activeOnly?: boolean;
}): Promise<UniverseItem[]> {
  const conds = [];
  if (filter?.market) conds.push(eq(universeItems.market, filter.market));
  if (filter?.activeOnly) conds.push(eq(universeItems.active, true));
  return db
    .select()
    .from(universeItems)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(universeItems.market), asc(universeItems.symbol));
}

export async function upsertUniverseItem(raw: UniverseInput): Promise<UniverseItem> {
  const input = normalize(universeInputSchema.parse(raw));
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const [row] = await db
    .insert(universeItems)
    .values({
      market: input.market,
      symbol: input.symbol,
      name: input.name ?? null,
      yahooSymbol: input.yahooSymbol ?? null,
      groupName: input.groupName ?? null,
      tags: input.tags ?? [],
      active: input.active ?? true,
      note: input.note ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [universeItems.market, universeItems.symbol],
      set: {
        name: input.name ?? null,
        yahooSymbol: input.yahooSymbol ?? null,
        groupName: input.groupName ?? null,
        tags: input.tags ?? [],
        active: input.active ?? true,
        note: input.note ?? null,
        updatedAt: now,
      },
    })
    .returning();
  return row;
}

export async function deleteUniverseItem(id: number): Promise<boolean> {
  const res = await db.delete(universeItems).where(eq(universeItems.id, id)).returning();
  return res.length > 0;
}

export async function setActive(id: number, active: boolean): Promise<UniverseItem | null> {
  const [row] = await db
    .update(universeItems)
    .set({ active })
    .where(eq(universeItems.id, id))
    .returning();
  return row ?? null;
}

/**
 * 일괄 업로드 파서 (prd.md §5.4)
 * CSV / 붙여넣기: 한 줄에 `market,symbol[,name[,group]]` 또는 `symbol` (단일 시장 지정 시)
 */
export interface BulkParseResult {
  ok: UniverseInput[];
  errors: { line: number; raw: string; reason: string }[];
}

export function parseBulk(
  text: string,
  opts: { defaultMarket?: MarketId } = {},
): BulkParseResult {
  const ok: UniverseInput[] = [];
  const errors: BulkParseResult["errors"] = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    // 헤더 행 스킵
    if (/^(market|시장)[,\t]/i.test(line)) return;

    const parts = line.split(/[,\t;]/).map((p) => p.trim()).filter(Boolean);
    let market: string | undefined;
    let symbol: string | undefined;
    let name: string | undefined;
    let groupName: string | undefined;

    if (parts.length === 1 && opts.defaultMarket) {
      market = opts.defaultMarket;
      symbol = parts[0];
    } else if (parts.length >= 2 && isMarketId(parts[0].toLowerCase())) {
      [market, symbol, name, groupName] = [
        parts[0].toLowerCase(),
        parts[1],
        parts[2],
        parts[3],
      ];
    } else if (parts.length >= 1 && opts.defaultMarket) {
      market = opts.defaultMarket;
      [symbol, name, groupName] = [parts[0], parts[1], parts[2]];
    }

    if (!market || !isMarketId(market)) {
      errors.push({ line: i + 1, raw: line, reason: "시장(kr/us/jp)을 판별할 수 없음" });
      return;
    }
    if (!symbol) {
      errors.push({ line: i + 1, raw: line, reason: "종목코드 없음" });
      return;
    }
    const parsed = universeInputSchema.safeParse({
      market,
      symbol,
      name: name || undefined,
      groupName: groupName || undefined,
    });
    if (!parsed.success) {
      errors.push({ line: i + 1, raw: line, reason: parsed.error.issues[0]?.message ?? "형식 오류" });
      return;
    }
    ok.push(normalize(parsed.data));
  });

  return { ok, errors };
}

export async function bulkUpsert(items: UniverseInput[]): Promise<number> {
  let count = 0;
  for (const item of items) {
    await upsertUniverseItem(item);
    count++;
  }
  return count;
}
