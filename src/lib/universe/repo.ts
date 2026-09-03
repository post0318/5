import "server-only";
import { ObjectId, type WithId } from "mongodb";
import { z } from "zod";
import { universeCol } from "@/lib/db";
import type { UniverseItem, UniverseItemDoc } from "@/lib/db/schema";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId, type MarketId } from "@/lib/markets/types";

function toItem(doc: WithId<UniverseItemDoc>): UniverseItem {
  const { _id, ...rest } = doc;
  return { id: _id.toHexString(), ...rest };
}

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
  const col = await universeCol();
  const q: Record<string, unknown> = {};
  if (filter?.market) q.market = filter.market;
  if (filter?.activeOnly) q.active = true;
  const docs = await col.find(q).sort({ market: 1, symbol: 1 }).toArray();
  return docs.map(toItem);
}

export async function upsertUniverseItem(raw: UniverseInput): Promise<UniverseItem> {
  const input = normalize(universeInputSchema.parse(raw));
  const col = await universeCol();
  const now = new Date().toISOString();
  const set = {
    name: input.name ?? null,
    yahooSymbol: input.yahooSymbol ?? null,
    groupName: input.groupName ?? null,
    tags: input.tags ?? [],
    active: input.active ?? true,
    note: input.note ?? null,
    updatedAt: now,
  };
  const doc = await col.findOneAndUpdate(
    { market: input.market, symbol: input.symbol },
    { $set: set, $setOnInsert: { createdAt: now } },
    { upsert: true, returnDocument: "after" },
  );
  if (!doc) throw new Error("유니버스 저장 실패");
  return toItem(doc);
}

export async function deleteUniverseItem(id: string): Promise<boolean> {
  if (!ObjectId.isValid(id)) return false;
  const col = await universeCol();
  const res = await col.deleteOne({ _id: new ObjectId(id) });
  return res.deletedCount > 0;
}

export async function setActive(id: string, active: boolean): Promise<UniverseItem | null> {
  if (!ObjectId.isValid(id)) return null;
  const col = await universeCol();
  const doc = await col.findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: { active, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" },
  );
  return doc ? toItem(doc) : null;
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
