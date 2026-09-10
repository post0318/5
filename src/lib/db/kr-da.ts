import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";

/**
 * 한국 종목 감가상각비·무형자산상각비 (연결, DART XBRL 주석 파싱 결과).
 * OpenDART XBRL 엔드포인트가 클라우드 IP를 차단해 Vercel 실시간 조회 불가 →
 * 외부(로컬)에서 파싱해 MongoDB 에 적재, 조회는 DB 우선.
 * `scripts/populate-kr-da.mjs` (분기·반기 보고서 시즌마다 재실행).
 */
export interface KrDaDoc {
  _id: string; // 종목코드
  /** 연도 → {감가상각비, 무형자산상각비} (원) */
  byYear: Record<string, { depreciation: number | null; amortisation: number | null }>;
  updatedAt: string;

  // ── 레거시(단일연도) — 마이그레이션 전 문서 호환 ──
  year?: number;
  depreciation?: number | null;
  amortisation?: number | null;
  basis?: "ttm" | "annual";
  label?: string;
  ttmDepreciation?: number | null;
  ttmAmortisation?: number | null;
  ttmLabel?: string | null;
}

export async function krDaCol(): Promise<Collection<KrDaDoc>> {
  return (await getDb()).collection<KrDaDoc>("kr_da");
}

export async function getKrDaDoc(symbol: string): Promise<KrDaDoc | null> {
  try {
    const col = await krDaCol();
    const doc = await col.findOne({ _id: symbol });
    if (!doc) return null;
    // 레거시 문서(byYear 없음) → 단일연도를 byYear 로 승격
    if (!doc.byYear && doc.year != null) {
      doc.byYear = { [doc.year]: { depreciation: doc.depreciation ?? null, amortisation: doc.amortisation ?? null } };
    }
    return doc;
  } catch {
    return null;
  }
}

export async function putKrDaDoc(doc: KrDaDoc): Promise<void> {
  const col = await krDaCol();
  await col.replaceOne({ _id: doc._id }, doc, { upsert: true });
}
