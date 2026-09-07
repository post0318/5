import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";

/**
 * 한국 종목 감가상각비·무형자산상각비 (연결, DART XBRL 파싱 결과).
 * OpenDART XBRL 엔드포인트가 클라우드 IP를 차단해 Vercel 실시간 조회 불가 →
 * 외부(로컬)에서 파싱해 MongoDB 에 적재, 조회는 DB 우선.
 */
export interface KrDaDoc {
  _id: string; // 종목코드
  year: number;
  depreciation: number | null;
  amortisation: number | null;
  updatedAt: string;
}

export async function krDaCol(): Promise<Collection<KrDaDoc>> {
  return (await getDb()).collection<KrDaDoc>("kr_da");
}

export async function getKrDaDoc(symbol: string): Promise<KrDaDoc | null> {
  try {
    const col = await krDaCol();
    return await col.findOne({ _id: symbol });
  } catch {
    return null;
  }
}

export async function putKrDaDoc(doc: KrDaDoc): Promise<void> {
  const col = await krDaCol();
  await col.replaceOne({ _id: doc._id }, doc, { upsert: true });
}
