import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";

/**
 * KOSPI·KOSDAQ 지수 일별 종가 (과거분 — 2015~2020).
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
}

export async function krIndexCol(): Promise<Collection<KrIndexDoc>> {
  return (await getDb()).collection<KrIndexDoc>("kr_index_daily");
}

/** market 의 [fromIso, toIso] 구간 일별 종가 (오름차순). */
export async function getKrIndexHistory(
  market: "KOSPI" | "KOSDAQ",
  fromIso: string,
  toIso: string,
): Promise<{ date: string; close: number }[]> {
  try {
    const col = await krIndexCol();
    const docs = await col
      .find({ market, date: { $gte: fromIso, $lte: toIso } })
      .project<{ date: string; close: number }>({ _id: 0, date: 1, close: 1 })
      .sort({ date: 1 })
      .toArray();
    return docs.filter((d) => Number.isFinite(d.close) && d.close > 0);
  } catch {
    return [];
  }
}
