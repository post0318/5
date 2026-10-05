import "server-only";
import type { Collection } from "mongodb";
import { getDb, universeCol } from "./index";

/**
 * 새 유니버스 종목 미리 계산 대기열(오너 승인 2026-10-06). 유니버스에 **전 계정 합집합 기준으로 처음 들어온** (market, symbol) 만 넣는다 —
 * 요청 처리 안에서는 이 작은 문서만 남기고(무거운 계산 금지), 1호기 타이머 `fin-precompute`(5분, ops/oracle/run-precompute.sh →
 * scripts/run/precompute.mts)가 꺼내 미국은 재무 조립(fin_sym)·TTM 스냅샷(ttm_snap), 한국은 감가상각 적재(kr_da, fin-kr-da 가 있을 때만)를 그 종목만 돌린다.
 *
 * 상태: pending → running → done | failed(시도 MAX_ATTEMPTS 회 실패). DART 하루 상한에 걸린 건 시도 횟수를 늘리지 않고 notBefore 뒤로 미룬다.
 * 보존: addedAt TTL 7일(다시 담기면 addedAt 이 새로 찍힌다). 예상 용량: 문서 ~0.2KB × 일괄 업로드 1,000건 = 0.2MB 상한.
 */
export type PrecomputeMarket = "us" | "kr";
export type PrecomputeState = "pending" | "running" | "done" | "failed";

export interface PrecomputeQueueDoc {
  _id: string; // `${market}:${symbol}`
  market: PrecomputeMarket;
  symbol: string;
  addedAt: Date; // TTL 기준
  state: PrecomputeState;
  attempts: number;
  notBefore?: Date | null;
  claimedAt?: Date | null;
  updatedAt: Date;
  lastError?: string | null;
}

const TTL_SECONDS = 7 * 24 * 3600;
export const PRECOMPUTE_MAX_ATTEMPTS = 3; // 첫 시도 + 재시도 2회
const STALE_RUNNING_MS = 2 * 3600_000; // 처리기가 죽어 running 에 남은 문서는 2시간 뒤 다시 pending

export async function precomputeQueueCol(): Promise<Collection<PrecomputeQueueDoc>> {
  const col = (await getDb()).collection<PrecomputeQueueDoc>("precompute_queue");
  await col.createIndex({ addedAt: 1 }, { expireAfterSeconds: TTL_SECONDS }).catch(() => {});
  await col.createIndex({ state: 1, market: 1, addedAt: 1 }).catch(() => {});
  return col;
}

const QUEUE_MARKETS = new Set(["us", "kr"]);

/**
 * 방금 새로 담긴 종목 중 전 계정 합집합에서 처음인 것만 대기열에 넣는다(유니버스 문서가 1건뿐인 종목).
 * 실패해도 유니버스 저장은 성공으로 둔다 — 다음 날 정기 배치가 어차피 채운다. 넣은 개수를 돌려준다.
 */
export async function enqueueIfFirstInUniverse(keys: { market: string; symbol: string }[]): Promise<number> {
  const want = keys.filter((k) => QUEUE_MARKETS.has(k.market));
  if (!want.length) return 0;
  try {
    const uni = await universeCol();
    const counts = await uni
      .aggregate<{ _id: { market: string; symbol: string }; n: number }>([
        { $match: { $or: want.map((k) => ({ market: k.market, symbol: k.symbol })) } },
        { $group: { _id: { market: "$market", symbol: "$symbol" }, n: { $sum: 1 } } },
      ])
      .toArray();
    const first = counts.filter((c) => c.n === 1).map((c) => c._id);
    if (!first.length) return 0;
    const col = await precomputeQueueCol();
    const now = new Date();
    const r = await col.bulkWrite(
      first.map((k) => ({
        updateOne: {
          // 처리 중(running)인 문서는 건드리지 않는다 — 그 경우 upsert 가 같은 _id 로 충돌하므로 ordered:false 로 그 건만 버린다
          filter: { _id: `${k.market}:${k.symbol}`, state: { $ne: "running" as const } },
          update: {
            $set: { market: k.market as PrecomputeMarket, symbol: k.symbol, addedAt: now, state: "pending" as const, attempts: 0, notBefore: null, updatedAt: now, lastError: null },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    ).catch((e: { result?: { upsertedCount?: number; modifiedCount?: number } }) => e.result ?? null);
    return r ? (r.upsertedCount ?? 0) + (r.modifiedCount ?? 0) : 0;
  } catch (e) {
    console.error("[precompute-queue] 대기열 기록 실패(유니버스 저장은 정상):", e);
    return 0;
  }
}

/** 처리할 문서를 limit 개까지 running 으로 바꿔 가져온다(먼저 담긴 순). 오래 걸려 남은 running 은 먼저 되살린다. */
export async function claimPrecompute(market: PrecomputeMarket, limit: number): Promise<PrecomputeQueueDoc[]> {
  if (limit <= 0) return [];
  const col = await precomputeQueueCol();
  const now = new Date();
  await col.updateMany(
    { state: "running", claimedAt: { $lt: new Date(now.valueOf() - STALE_RUNNING_MS) } },
    { $set: { state: "pending", updatedAt: now }, $inc: { attempts: 1 } },
  );
  const out: PrecomputeQueueDoc[] = [];
  while (out.length < limit) {
    const d = await col.findOneAndUpdate(
      { market, state: "pending", $or: [{ notBefore: null }, { notBefore: { $exists: false } }, { notBefore: { $lte: now } }] },
      { $set: { state: "running", claimedAt: now, updatedAt: now } },
      { sort: { addedAt: 1 }, returnDocument: "after" },
    );
    if (!d) break;
    out.push(d);
  }
  return out;
}

/** 지난 24시간 안에 처리하려고 꺼낸 종목 수(한국 DART 하루 몫 계산용) */
export async function countClaimedSince(market: PrecomputeMarket, since: Date): Promise<number> {
  const col = await precomputeQueueCol();
  return col.countDocuments({ market, claimedAt: { $gte: since } });
}

export async function countPending(market: PrecomputeMarket): Promise<number> {
  const col = await precomputeQueueCol();
  return col.countDocuments({ market, state: "pending" });
}

export async function markPrecomputeDone(id: string): Promise<void> {
  const col = await precomputeQueueCol();
  await col.updateOne({ _id: id }, { $set: { state: "done", updatedAt: new Date(), lastError: null } });
}

/** 실패 — 시도 횟수를 올리고 상한 미만이면 다시 pending(다음 회차에 재시도), 상한이면 failed. 최종 상태를 돌려준다. */
export async function markPrecomputeFailed(id: string, error: string): Promise<PrecomputeState> {
  const col = await precomputeQueueCol();
  const d = await col.findOneAndUpdate(
    { _id: id },
    { $inc: { attempts: 1 }, $set: { updatedAt: new Date(), lastError: error.slice(0, 300) } },
    { returnDocument: "after" },
  );
  const state: PrecomputeState = d && d.attempts >= PRECOMPUTE_MAX_ATTEMPTS ? "failed" : "pending";
  await col.updateOne({ _id: id }, { $set: { state } });
  return state;
}

/** 외부 상한(DART 하루 상한) 때문에 못 한 것 — 시도 횟수를 늘리지 않고 delayMs 뒤로 미룬다. */
export async function deferPrecompute(id: string, delayMs: number, why: string): Promise<void> {
  const col = await precomputeQueueCol();
  const now = new Date();
  await col.updateOne({ _id: id }, { $set: { state: "pending", notBefore: new Date(now.valueOf() + delayMs), updatedAt: now, lastError: why.slice(0, 300) } });
}

/** 지난 since 이후 최종 실패한 종목(감시용 — 있으면 처리기가 종료코드 1 로 끝나 healthcheck job-fin-precompute 알림이 유지된다) */
export async function listRecentFailed(since: Date): Promise<PrecomputeQueueDoc[]> {
  const col = await precomputeQueueCol();
  return col.find({ state: "failed", updatedAt: { $gte: since } }).toArray();
}
