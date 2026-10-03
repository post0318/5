import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";

/**
 * KOSPI·KOSDAQ 지수 일별 종가 — 과거분(2015~2020, KRX 다운로드) + 2026-10-03 부터 일일 배치가 매일 전 영업일분을 쌓는다
 * (코스피·코스닥 둘 다, 오너 결정 — 거시경제 한국 지수 스냅샷이 KRX 를 매번 부르지 않고 이 DB 를 읽는다).
 * 금융위 지수시세 API 커버리지(2020~)를 벗어나는 구간을 KRX 다운로드 자료로 보관.
 * 조회 시 이 컬렉션(과거) + 금융위 API(최근) + Yahoo(폴백) 순으로 병합.
 */
export interface KrIndexDoc {
  _id: string; // "KOSPI:20150102"
  market: "KOSPI" | "KOSDAQ";
  date: string; // "2015-01-02"
  close: number;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  change?: number | null; // 전일 대비(KRX CMPPREVDD_IDX) — 2026-10-03 이후 저장분만
  pct?: number | null; // 등락률 %(KRX FLUC_RT) — 2026-10-03 이후 저장분만
}

export async function krIndexCol(): Promise<Collection<KrIndexDoc>> {
  return (await getDb()).collection<KrIndexDoc>("kr_index_daily");
}

/** market 의 [fromIso, toIso] 구간 일봉 (오름차순). 시·고·저는 캔들차트용(없으면 null). */
export async function getKrIndexHistory(
  market: "KOSPI" | "KOSDAQ",
  fromIso: string,
  toIso: string,
): Promise<{ date: string; close: number; open: number | null; high: number | null; low: number | null }[]> {
  try {
    const col = await krIndexCol();
    const docs = await col
      .find({ market, date: { $gte: fromIso, $lte: toIso } })
      .project<Pick<KrIndexDoc, "date" | "close" | "open" | "high" | "low">>({
        _id: 0,
        date: 1,
        close: 1,
        open: 1,
        high: 1,
        low: 1,
      })
      .sort({ date: 1 })
      .toArray();
    return docs
      .filter((d) => Number.isFinite(d.close) && d.close > 0)
      .map((d) => ({
        date: d.date,
        close: d.close,
        open: d.open ?? null,
        high: d.high ?? null,
        low: d.low ?? null,
      }));
  } catch {
    return [];
  }
}

/** 일일 배치가 받은 그날 일봉 저장(멱등 — 같은 날을 다시 받으면 덮어쓴다). */
export async function saveKrIndexDays(
  days: { market: "KOSPI" | "KOSDAQ"; date: string; close: number; open: number | null; high: number | null; low: number | null; change: number | null; pct: number | null }[],
): Promise<number> {
  if (!days.length) return 0;
  const col = await krIndexCol();
  const r = await col.bulkWrite(
    days.map((d) => ({
      updateOne: {
        filter: { _id: `${d.market}:${d.date.replace(/-/g, "")}` },
        update: { $set: { market: d.market, date: d.date, close: d.close, open: d.open, high: d.high, low: d.low, change: d.change, pct: d.pct } },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  return r.upsertedCount + r.modifiedCount;
}

/**
 * 가장 최근 일봉(스냅샷용). 전일 대비·등락률이 저장돼 있지 않으면 직전 일봉으로 계산한다. 없으면 null.
 */
export async function getLatestKrIndex(
  market: "KOSPI" | "KOSDAQ",
): Promise<{ date: string; close: number; change: number; pct: number } | null> {
  try {
    const col = await krIndexCol();
    const [last, prev] = await col.find({ market, close: { $gt: 0 } }).sort({ date: -1 }).limit(2).toArray();
    if (!last) return null;
    const change = last.change ?? (prev ? last.close - prev.close : null);
    const pct = last.pct ?? (prev && prev.close ? ((last.close - prev.close) / prev.close) * 100 : null);
    if (change == null || pct == null) return null;
    return { date: last.date, close: last.close, change, pct };
  } catch {
    return null;
  }
}
