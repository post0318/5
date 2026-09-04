import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";

/**
 * 한국판 공포·탐욕 지수 저장소 (MongoDB M0 무료 범위).
 *  - kr_fg_daily     : 거래일별 원자료 스냅샷 1문서 (영구 보관, 문서당 ~250B)
 *  - kr_stock_roll   : 종목별 최근 252거래일 종가 롤링 창 (52주 신고/신저 판정용)
 */

export interface KrFgDailyDoc {
  _id: string; // 거래일 YYYY-MM-DD
  kospiClose: number | null;
  advancers: number | null;
  decliners: number | null;
  unchanged: number | null;
  upVolume: number | null; // 상승 종목 거래량 합
  downVolume: number | null; // 하락 종목 거래량 합
  newHigh52: number | null; // 52주 신고가 종목 수
  newLow52: number | null; // 52주 신저가 종목 수
  totalWithHistory: number | null; // 52주 판정 대상 종목 수 (분모)
  vkospi: number | null;
  gov3y: number | null;
  gov10y: number | null;
  corpAA: number | null;
  corpBBB: number | null;
  putCall: number | null;
  updatedAt: string;
}

export interface KrStockRollDoc {
  _id: string; // 종목코드
  // 최근 252 거래일 종가 (오래된 것 → 최신). 길이 유지.
  closes: number[];
  lastDate: string;
}

export async function krFgDailyCol(): Promise<Collection<KrFgDailyDoc>> {
  const col = (await getDb()).collection<KrFgDailyDoc>("kr_fg_daily");
  return col;
}

export async function krStockRollCol(): Promise<Collection<KrStockRollDoc>> {
  const col = (await getDb()).collection<KrStockRollDoc>("kr_stock_roll");
  return col;
}

export async function getKrFgHistory(limitDays = 260 * 6): Promise<KrFgDailyDoc[]> {
  const col = await krFgDailyCol();
  const docs = await col.find({}).sort({ _id: 1 }).toArray();
  return docs.slice(-limitDays);
}
