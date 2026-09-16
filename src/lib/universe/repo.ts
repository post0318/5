import "server-only";
import { ObjectId, type WithId } from "mongodb";
import { z } from "zod";
import { universeCol } from "@/lib/db";
import type { UniverseItem, UniverseItemDoc } from "@/lib/db/schema";
import { getAdapter } from "@/lib/markets/registry";
import { isMarketId, type MarketId } from "@/lib/markets/types";

function toItem(doc: WithId<UniverseItemDoc>): UniverseItem {
  const { _id, ownerId, ...rest } = doc;
  return { id: _id.toHexString(), ownerId: ownerId ?? null, ...rest };
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

/**
 * 유니버스 조회.
 *  - `ownerId` 를 주면 그 계정의 유니버스만 (화면·사용자 API 는 항상 이쪽)
 *  - 안 주면 전 계정 합집합 (수집 배치 전용 — 어떤 종목이든 하루 1회만
 *    외부에서 받아오면 되므로 소유자를 가리지 않는다)
 */
export async function listUniverse(filter?: {
  ownerId?: string;
  market?: MarketId;
  activeOnly?: boolean;
}): Promise<UniverseItem[]> {
  const col = await universeCol();
  const q: Record<string, unknown> = {};
  if (filter?.ownerId) q.ownerId = filter.ownerId;
  if (filter?.market) q.market = filter.market;
  if (filter?.activeOnly) q.active = true;
  const docs = await col.find(q).sort({ market: 1, symbol: 1 }).toArray();
  return docs.map(toItem);
}

/**
 * 전 계정 합집합에서 (market, symbol) 중복을 걷어낸 목록. 배치가 같은 종목을
 * 사람 수만큼 반복 조회하지 않게 한다.
 */
export async function listUniverseDistinct(filter?: {
  market?: MarketId;
  activeOnly?: boolean;
}): Promise<UniverseItem[]> {
  const items = await listUniverse(filter);
  const seen = new Set<string>();
  const out: UniverseItem[] = [];
  for (const it of items) {
    const key = `${it.market}:${it.symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

export async function upsertUniverseItem(
  ownerId: string,
  raw: UniverseInput,
): Promise<UniverseItem> {
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
    { ownerId, market: input.market, symbol: input.symbol },
    { $set: set, $setOnInsert: { ownerId, createdAt: now } },
    { upsert: true, returnDocument: "after" },
  );
  if (!doc) throw new Error("유니버스 저장 실패");
  return toItem(doc);
}

/** 삭제 — 남의 항목을 지우지 못하도록 ownerId 를 반드시 조건에 건다. */
export async function deleteUniverseItem(
  ownerId: string,
  id: string,
): Promise<UniverseItem | null> {
  if (!ObjectId.isValid(id)) return null;
  const col = await universeCol();
  const doc = await col.findOneAndDelete({ _id: new ObjectId(id), ownerId });
  return doc ? toItem(doc) : null;
}

export const universePatchSchema = z.object({
  name: z.string().max(120).optional().nullable(),
  groupName: z.string().max(60).optional().nullable(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  note: z.string().max(500).optional().nullable(),
  active: z.boolean().optional(),
});
export type UniversePatch = z.infer<typeof universePatchSchema>;

/** 수정 — 삭제와 같은 이유로 ownerId 를 조건에 건다. */
export async function updateUniverseItem(
  ownerId: string,
  id: string,
  patch: UniversePatch,
): Promise<UniverseItem | null> {
  if (!ObjectId.isValid(id)) return null;
  const col = await universeCol();
  const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if ("name" in patch) set.name = patch.name?.trim() || null;
  if ("groupName" in patch) set.groupName = patch.groupName?.trim() || null;
  if ("tags" in patch && patch.tags) set.tags = patch.tags;
  if ("note" in patch) set.note = patch.note?.trim() || null;
  if (patch.active !== undefined) set.active = patch.active;
  const doc = await col.findOneAndUpdate(
    { _id: new ObjectId(id), ownerId },
    { $set: set },
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

export async function bulkUpsert(ownerId: string, items: UniverseInput[]): Promise<number> {
  let count = 0;
  for (const item of items) {
    await upsertUniverseItem(ownerId, item);
    count++;
  }
  return count;
}

/**
 * Clerk 도입 이전에 만들어진(소유자 없는) 유니버스를 한 계정으로 귀속시킨다.
 * 관리자가 「기존 유니버스 가져오기」를 누를 때 1회 실행. 이미 같은 종목을
 * 갖고 있으면 유니크 인덱스에 걸리므로 그 건만 건너뛴다.
 */
export async function claimLegacyUniverse(ownerId: string): Promise<{
  claimed: number;
  skipped: number;
}> {
  const col = await universeCol();
  const legacy = await col.find({ ownerId: { $exists: false } }).toArray();
  let claimed = 0;
  let skipped = 0;
  for (const doc of legacy) {
    try {
      await col.updateOne({ _id: doc._id }, { $set: { ownerId } });
      claimed++;
    } catch {
      // 이미 같은 (ownerId, market, symbol) 을 갖고 있는 경우 — 옛 문서는 버린다
      await col.deleteOne({ _id: doc._id }).catch(() => {});
      skipped++;
    }
  }
  return { claimed, skipped };
}

/** 계정별 보유 종목 수 — 승인 관리 화면에서 누가 얼마나 담았는지 보여준다. */
export async function countUniverseByOwner(): Promise<Map<string, number>> {
  const col = await universeCol();
  const rows = await col
    .aggregate<{ _id: string | null; n: number }>([
      { $group: { _id: "$ownerId", n: { $sum: 1 } } },
    ])
    .toArray();
  const out = new Map<string, number>();
  for (const r of rows) if (r._id) out.set(r._id, r.n);
  return out;
}

/** 귀속 대기 중인 옛 문서 수 (관리 화면 배너 표시 판단용) */
export async function countLegacyUniverse(): Promise<number> {
  const col = await universeCol();
  return col.countDocuments({ ownerId: { $exists: false } });
}
