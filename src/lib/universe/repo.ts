import "server-only";
import { ObjectId, type WithId } from "mongodb";
import { z } from "zod";
import { universeCol } from "@/lib/db";
import type { UniverseItem, UniverseItemDoc } from "@/lib/db/schema";
import { getAdapter } from "@/lib/markets/registry";
import type { MarketId } from "@/lib/markets/types";

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

/** 일괄 업로드 저장 단위 — 이름은 해석 단계가 찾은 공식 종목명 */
export interface BulkSaveItem {
  market: MarketId;
  symbol: string;
  name: string;
  yahooSymbol?: string | null;
  groupName?: string | null;
  tags?: string[];
  note?: string | null;
}

/**
 * 일괄 업로드 저장 (오너 지시 2026-10-05).
 * 개별 등록(upsertUniverseItem)과 달리 이미 있는 종목의 그룹·태그·메모·활성
 * 상태·Yahoo 심볼은 **입력에 값이 있을 때만** 바꾼다 — 비워 둔 칸으로 내가 정리해
 * 둔 값을 지우지 않게. 이름은 새 종목이면 공식 종목명, 이미 있으면 비어 있을 때만
 * 채운다(목록에서 직접 고친 이름은 그대로).
 */
export async function bulkUpsertResolved(
  ownerId: string,
  items: BulkSaveItem[],
): Promise<{ inserted: number; updated: number }> {
  const col = await universeCol();
  let inserted = 0;
  let updated = 0;
  for (const it of items) {
    const now = new Date().toISOString();
    const symbol = getAdapter(it.market).normalizeSymbol(it.symbol);
    const set: Record<string, unknown> = { updatedAt: now };
    const onInsert: Record<string, unknown> = {
      ownerId,
      name: it.name,
      active: true,
      createdAt: now,
    };
    const put = (field: string, value: unknown, empty: unknown) => {
      if (value != null && value !== "" && !(Array.isArray(value) && value.length === 0)) set[field] = value;
      else onInsert[field] = empty;
    };
    put("yahooSymbol", it.yahooSymbol?.trim() || null, null);
    put("groupName", it.groupName?.trim() || null, null);
    put("tags", it.tags ?? [], []);
    put("note", it.note?.trim() || null, null);

    const filter = { ownerId, market: it.market, symbol };
    const res = await col.updateOne(filter, { $set: set, $setOnInsert: onInsert }, { upsert: true });
    if (res.upsertedCount > 0) {
      inserted += 1;
    } else {
      updated += 1;
      await col.updateOne(
        { ...filter, $or: [{ name: null }, { name: "" }] },
        { $set: { name: it.name } },
      );
    }
  }
  return { inserted, updated };
}

/**
 * Clerk 도입 이전에 만들어진(소유자 없는) 유니버스를 한 계정으로 귀속시킨다.
 * 관리자가 「기존 유니버스 가져오기」를 누를 때 1회 실행. 이미 같은 종목을
 * 갖고 있으면 유니크 인덱스에 걸리므로 그 건만 건너뛴다.
 */
/**
 * 다른 계정의 유니버스를 내 계정으로 복제한다 (오너 지시 2026-09-17 —
 * 지메일 계정의 77종목을 회사 계정에도 똑같이).
 *
 * 복제지 공유가 아니다 — 복제한 뒤에는 각자 따로 편집된다. 계정별 분리라는
 * 이번 작업의 취지를 유지하면서 "처음 상태만 맞추기"를 지원한다.
 * 이미 갖고 있는 종목은 건드리지 않는다(그룹명·메모를 덮어쓰지 않기 위해).
 */
export async function copyUniverseFrom(
  fromOwnerId: string,
  toOwnerId: string,
): Promise<{ copied: number; skipped: number }> {
  if (fromOwnerId === toOwnerId) return { copied: 0, skipped: 0 };
  const col = await universeCol();
  const [source, mine] = await Promise.all([
    col.find({ ownerId: fromOwnerId }).toArray(),
    col.find({ ownerId: toOwnerId }).toArray(),
  ]);
  const have = new Set(mine.map((d) => `${d.market}:${d.symbol}`));
  const now = new Date().toISOString();

  let copied = 0;
  let skipped = 0;
  for (const d of source) {
    if (have.has(`${d.market}:${d.symbol}`)) {
      skipped += 1;
      continue;
    }
    // _id 는 새로 발급받아야 한다 — 원본 문서를 그대로 넣으면 키가 겹친다.
    const rest = { ...d } as Partial<typeof d>;
    delete rest._id;
    await col.insertOne({
      ...(rest as UniverseItemDoc),
      ownerId: toOwnerId,
      createdAt: now,
      updatedAt: now,
    });
    copied += 1;
  }
  return { copied, skipped };
}

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
