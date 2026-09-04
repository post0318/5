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
      fetchPutCall(ymd).catch(() => ({ byVolume: null, byValue: null })),
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
      if (s.market === "KOSPI" && prev && prev.closes.length >= MIN_HISTORY) {
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
      putCall: putCall.byVolume,
      putCallVal: putCall.byValue,
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
    gov3y: null, gov10y: null, corpAA: null, corpBBB: null, putCall: null, putCallVal: null,
  };
}

/** VKOSPI 과거 시계열 주입 (KRX OPEN API가 옵션지수를 불안정하게 제공 → 외부 CSV/XLSX 사용) */
export async function importVkospi(
  rows: { date: string; vkospi: number }[],
): Promise<{ upserted: number }> {
  const col = await krFgDailyCol();
  const ops: AnyBulkWriteOperation<KrFgDailyDoc>[] = rows
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.vkospi))
    .map((r) => ({
      updateOne: {
        filter: { _id: r.date },
        update: {
          $set: { vkospi: r.vkospi, updatedAt: new Date().toISOString() },
          $setOnInsert: thinDocNoVkospi(),
        },
        upsert: true,
      },
    }));
  if (ops.length) await col.bulkWrite(ops, { ordered: false });
  return { upserted: ops.length };
}

function thinDocNoVkospi(): Partial<KrFgDailyDoc> {
  return {
    kospiClose: null,
    advancers: null, decliners: null, unchanged: null, upVolume: null, downVolume: null,
    newHigh52: null, newLow52: null, totalWithHistory: null,
    gov3y: null, gov10y: null, corpAA: null, corpBBB: null, putCall: null, putCallVal: null,
  };
}

/** 롤링창 초기화 (대량 백필 전 순서 꼬임 방지) */
export async function resetKrStockRoll(): Promise<{ deleted: number }> {
  const col = await krStockRollCol();
  const r = await col.deleteMany({});
  return { deleted: r.deletedCount };
}

/**
 * 대량 과거 백필 — 롤링창을 메모리에 유지하며 범위를 한 번에 처리.
 * runKrFgBatch(일별) 는 매 호출마다 roll 컬렉션 전체를 읽어 느림 → 이 함수는
 * 시작 시 1회 읽고, 끝에 1회 저장. ECOS 금리는 범위 전체를 항목당 1콜로 미리 확보.
 */
export async function deepBackfill(
  fromIso: string,
  toIso: string,
): Promise<{ done: number; failed: number; firstReadyDate: string | null; carriedRoll: number }> {
  const rollCol = await krStockRollCol();
  const dailyCol = await krFgDailyCol();

  // 시작 롤 상태 → 메모리
  const roll = new Map<string, number[]>();
  for (const r of await rollCol.find({}).toArray()) roll.set(r._id, r.closes);

  // ECOS 금리: 범위 전체 시계열 미리
  const from = fromIso.replace(/-/g, "");
  const to = toIso.replace(/-/g, "");
  const { fetchRateSeries } = await import("./ecos");
  const [g3, g10, aa, bbb] = await Promise.all([
    fetchRateSeries("gov3y", from, to).catch(() => []),
    fetchRateSeries("gov10y", from, to).catch(() => []),
    fetchRateSeries("corpAA", from, to).catch(() => []),
    fetchRateSeries("corpBBB", from, to).catch(() => []),
  ]);
  const rateAt = (s: { date: string; value: number }[], iso: string): number | null => {
    let v: number | null = null;
    for (const p of s) {
      if (p.date <= iso) v = p.value;
      else break;
    }
    return v;
  };

  const dates: string[] = [];
  const d = new Date(`${fromIso}T00:00:00Z`);
  const end = new Date(`${toIso}T00:00:00Z`);
  let guard = 0;
  while (d <= end && guard++ < 2000) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }

  let done = 0;
  let failed = 0;
  let firstReadyDate: string | null = null;

  for (const iso of dates) {
    const ymd = iso.replace(/-/g, "");
    let stocks: Awaited<ReturnType<typeof fetchAllStocks>>;
    try {
      stocks = await fetchAllStocks(ymd);
    } catch {
      failed++;
      continue;
    }
    if (stocks.length < 100) {
      failed++;
      continue;
    }
    const [vkospi, kospiClose, putCall] = await Promise.all([
      fetchVkospi(ymd).catch(() => null),
      fetchKospiIndex(ymd).catch(() => null),
      fetchPutCall(ymd).catch(() => ({ byVolume: null, byValue: null })),
    ]);

    let advancers = 0;
    let decliners = 0;
    let unchanged = 0;
    let upVolume = 0;
    let downVolume = 0;
    let newHigh52 = 0;
    let newLow52 = 0;
    let totalWithHistory = 0;

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

      if (s.close == null || !s.code) continue;
      const w = roll.get(s.code) ?? [];
      if (s.market === "KOSPI" && w.length >= MIN_HISTORY) {
        totalWithHistory++;
        if (s.close >= Math.max(...w)) newHigh52++;
        else if (s.close <= Math.min(...w)) newLow52++;
      }
      w.push(s.close);
      if (w.length > WINDOW) w.splice(0, w.length - WINDOW);
      roll.set(s.code, w);
    }

    if (totalWithHistory > 0 && !firstReadyDate) firstReadyDate = iso;

    const dailyDoc: KrFgDailyDoc = {
        _id: iso,
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
        gov3y: rateAt(g3, iso),
        gov10y: rateAt(g10, iso),
        corpAA: rateAt(aa, iso),
        corpBBB: rateAt(bbb, iso),
        putCall: putCall.byVolume,
        putCallVal: putCall.byValue,
        updatedAt: new Date().toISOString(),
    };
    await dailyCol.replaceOne({ _id: iso }, dailyDoc, { upsert: true });
    done++;
  }

  // 최종 롤 상태 저장 (1회 bulkWrite)
  const lastDate = dates.at(-1) ?? new Date().toISOString().slice(0, 10);
  const ops: AnyBulkWriteOperation<KrStockRollDoc>[] = [...roll.entries()].map(([code, closes]) => ({
    updateOne: {
      filter: { _id: code },
      update: { $set: { closes, lastDate } },
      upsert: true,
    },
  }));
  if (ops.length) await rollCol.bulkWrite(ops, { ordered: false });

  return { done, failed, firstReadyDate, carriedRoll: roll.size };
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
