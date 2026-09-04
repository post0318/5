import "server-only";
import type { AnyBulkWriteOperation } from "mongodb";
import YahooFinancePkg from "yahoo-finance2";
import { krFgDailyCol, krStockRollCol, type KrFgDailyDoc, type KrStockRollDoc } from "@/lib/db/kr-fg";
import { fetchAllStocks, fetchKospiIndex, fetchPutCall, fetchVkospi } from "./krx";
import { fetchLatestRates } from "./ecos";

const WINDOW = 252; // 52주(거래일)
const MIN_HISTORY = 200; // 신고/신저 판정 최소 히스토리

export interface BatchResult {
  date: string;
  advancers: number;
  decliners: number;
  newHigh52: number;
  newLow52: number;
  rollTracked: number;
  ok: boolean;
  error?: string;
}

/** 특정 거래일(YYYYMMDD) 1일치 수집·집계·저장 */
export async function runKrFgBatch(ymd: string): Promise<BatchResult> {
  const date = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  try {
    const [stocks, vkospi, kospiClose, putCall, rates] = await Promise.all([
      fetchAllStocks(ymd),
      fetchVkospi(ymd).catch(() => null),
      fetchKospiIndex(ymd).catch(() => null),
      fetchPutCall(ymd).catch(() => null),
      fetchLatestRates(ymd).catch(() => ({ gov3y: null, gov10y: null, corpAA: null, corpBBB: null })),
    ]);

    if (stocks.length < 100) {
      return { ...empty(date), ok: false, error: `거래 데이터 없음 (${stocks.length}건) — 휴장일?` };
    }

    // 등락 종목수 + 등락 거래량
    let advancers = 0;
    let decliners = 0;
    let unchanged = 0;
    let upVolume = 0;
    let downVolume = 0;
    for (const s of stocks) {
      const c = s.changePrc ?? 0;
      const v = s.volume ?? 0;
      if (c > 0) {
        advancers++;
        upVolume += v;
      } else if (c < 0) {
        decliners++;
        downVolume += v;
      } else unchanged++;
    }

    // 52주 신고/신저 — 롤링 창을 메모리에 올려 판정 후 일괄 업데이트
    const rollCol = await krStockRollCol();
    const rolls = await rollCol.find({}).toArray();
    const rollMap = new Map(rolls.map((r) => [r._id, r]));

    let newHigh52 = 0;
    let newLow52 = 0;
    let totalWithHistory = 0;
    const ops: AnyBulkWriteOperation<KrStockRollDoc>[] = [];

    for (const s of stocks) {
      if (s.close == null || !s.code) continue;
      const prev = rollMap.get(s.code);
      if (prev && prev.closes.length >= MIN_HISTORY) {
        totalWithHistory++;
        const hi = Math.max(...prev.closes);
        const lo = Math.min(...prev.closes);
        if (s.close >= hi) newHigh52++;
        else if (s.close <= lo) newLow52++;
      }
      ops.push({
        updateOne: {
          filter: { _id: s.code },
          update: {
            $set: { lastDate: date },
            $push: { closes: { $each: [s.close], $slice: -WINDOW } },
          },
          upsert: true,
        },
      });
    }
    if (ops.length) await rollCol.bulkWrite(ops, { ordered: false });

    const doc: KrFgDailyDoc = {
      _id: date,
      kospiClose,
      advancers,
      decliners,
      unchanged,
      upVolume,
      downVolume,
      newHigh52,
      newLow52,
      totalWithHistory: totalWithHistory || null,
      vkospi,
      gov3y: rates.gov3y,
      gov10y: rates.gov10y,
      corpAA: rates.corpAA,
      corpBBB: rates.corpBBB,
      putCall,
      updatedAt: new Date().toISOString(),
    };
    const col = await krFgDailyCol();
    await col.replaceOne({ _id: date }, doc, { upsert: true });

    return {
      date,
      advancers,
      decliners,
      newHigh52,
      newLow52,
      rollTracked: ops.length,
      ok: true,
    };
  } catch (err) {
    return { ...empty(date), ok: false, error: err instanceof Error ? err.message : "batch 실패" };
  }
}

function empty(date: string): BatchResult {
  return { date, advancers: 0, decliners: 0, newHigh52: 0, newLow52: 0, rollTracked: 0, ok: false };
}

/**
 * 모멘텀(125일선)용 KOSPI 종가 히스토리를 yahoo(^KS11)에서 부트스트랩.
 * kr_fg_daily 의 kospiClose 만 채운다 (없는 날짜는 thin 문서 생성).
 */
export async function bootstrapKospiHistory(): Promise<{ upserted: number }> {
  const YF = (YahooFinancePkg as { default?: unknown }).default ?? YahooFinancePkg;
  const C = YF as new (o: Record<string, unknown>) => {
    chart: (s: string, o: Record<string, unknown>) => Promise<{ quotes: { date: Date | string; close?: number | null }[] }>;
  };
  const yf = new C({ suppressNotices: ["yahooSurvey"], validation: { logErrors: false } });
  const from = new Date();
  from.setDate(from.getDate() - 420);
  const res = await yf.chart("^KS11", { period1: from.toISOString().slice(0, 10), interval: "1d" });
  const rows = (res.quotes ?? [])
    .map((q) => ({
      date: (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10),
      close: q.close ?? null,
    }))
    .filter((r) => r.close != null);

  const col = await krFgDailyCol();
  const ops: AnyBulkWriteOperation<KrFgDailyDoc>[] = rows.map((r) => ({
    updateOne: {
      filter: { _id: r.date },
      update: {
        $set: { kospiClose: r.close, updatedAt: new Date().toISOString() },
        $setOnInsert: thinDoc(),
      },
      upsert: true,
    },
  }));
  if (ops.length) await col.bulkWrite(ops, { ordered: false });
  return { upserted: ops.length };
}

function thinDoc(): Partial<KrFgDailyDoc> {
  return {
    advancers: null, decliners: null, unchanged: null, upVolume: null, downVolume: null,
    newHigh52: null, newLow52: null, totalWithHistory: null, vkospi: null,
    gov3y: null, gov10y: null, corpAA: null, corpBBB: null, putCall: null,
  };
}

/** 롤링창 초기화 (200일 백필 전 순서 꼬임 방지) */
export async function resetKrStockRoll(): Promise<{ deleted: number }> {
  const col = await krStockRollCol();
  const r = await col.deleteMany({});
  return { deleted: r.deletedCount };
}

/**
 * 날짜 범위(YYYY-MM-DD, 포함)를 **오름차순**으로 처리. skipExisting=true 면
 * 이미 있는 날짜는 건너뜀(일상 백필), false 면 덮어씀(전체 재구축).
 */
export async function backfillRange(
  fromIso: string,
  toIso: string,
  skipExisting = true,
): Promise<{ done: number; skipped: number; failed: number; lastDate: string | null }> {
  const col = await krFgDailyCol();
  const existing = skipExisting
    ? new Set(
        (
          await col
            .find({ _id: { $gte: fromIso, $lte: toIso } }, { projection: { _id: 1 } })
            .toArray()
        ).map((d) => d._id),
      )
    : new Set<string>();

  const dates: string[] = [];
  const d = new Date(`${fromIso}T00:00:00Z`);
  const end = new Date(`${toIso}T00:00:00Z`);
  let guard = 0;
  while (d <= end && guard++ < 1000) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }

  let done = 0;
  let skipped = 0;
  let failed = 0;
  let lastDate: string | null = null;
  for (const iso of dates) {
    if (existing.has(iso)) {
      skipped++;
      continue;
    }
    const r = await runKrFgBatch(iso.replace(/-/g, ""));
    lastDate = iso;
    if (r.ok) done++;
    else failed++;
  }
  return { done, skipped, failed, lastDate };
}
