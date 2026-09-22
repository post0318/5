import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";

/**
 * 국내 종목의 섹터 캐시 — 주간 리포트의 "섹터별 주도 종목"용(2026-09-22).
 *
 * KRX OPEN API 전종목 시세에는 업종 필드가 없고(`SECT_TP_NM` 이 빈 문자열,
 * 실측) 국내 섹터 ETF 는 Yahoo 가 보유종목을 0건으로 준다. 그래서 종목별
 * 섹터를 Yahoo `assetProfile` 로 한 번 조회해 여기에 쌓아두고 재사용한다 —
 * 섹터는 거의 바뀌지 않으므로 매주 다시 물을 이유가 없다(종목당 1회 호출을
 * 매주 수백 번 반복하는 것을 피하는 게 목적).
 */
export interface KrStockSectorDoc {
  /** 6자리 종목코드 */
  _id: string;
  name: string;
  /** Yahoo assetProfile 원문. 조회했으나 값이 없으면 null 로 남긴다 —
   * null 도 "확인함"이라 다음 주에 또 묻지 않는다. */
  sector: string | null;
  industry: string | null;
  checkedAt: string;
}

export async function krStockSectorsCol(): Promise<Collection<KrStockSectorDoc>> {
  const db = await getDb();
  return db.collection<KrStockSectorDoc>("kr_stock_sectors");
}

export async function getKrStockSectors(codes: string[]): Promise<Map<string, KrStockSectorDoc>> {
  if (codes.length === 0) return new Map();
  const col = await krStockSectorsCol();
  const docs = await col.find({ _id: { $in: codes } }).toArray();
  return new Map(docs.map((d) => [d._id, d]));
}

export async function upsertKrStockSectors(docs: KrStockSectorDoc[]): Promise<void> {
  if (docs.length === 0) return;
  const col = await krStockSectorsCol();
  await col.bulkWrite(
    docs.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })),
    { ordered: false },
  );
}
