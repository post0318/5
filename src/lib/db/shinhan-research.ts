import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";

/**
 * 신한투자증권 "기업분석" 리포트(개인용 로컬 수집 — CLAUDE.md 예외 참고).
 * 원문 PDF·전체 본문은 저장하지 않고 목록에 이미 노출되는 요약(summary)·메타만
 * 저장한다(용량: 건당 1~2KB 수준). 30일 지난 리포트는 수집 시점마다 정리한다.
 */
export interface ShinhanResearchDoc {
  _id: string; // Shinhan 게시글 번호(fn)
  date: string; // ISO (YYYY-MM-DD)
  title: string;
  stockName: string;
  /** 종목명 → 6자리 종목코드 매핑 실패 시 null (필터링 대상에서 제외됨). */
  symbol: string | null;
  analyst: string;
  opinion: string;
  summary: string;
  pdfUrl: string | null;
  views: number | null;
  collectedAt: string;
}

const MAX_AGE_MS = 30 * 24 * 3600_000;

export async function shinhanResearchCol(): Promise<Collection<ShinhanResearchDoc>> {
  const db = await getDb();
  const col = db.collection<ShinhanResearchDoc>("shinhan_research");
  await col.createIndex({ symbol: 1, date: -1 }).catch(() => {});
  return col;
}

export async function upsertShinhanResearch(
  docs: ShinhanResearchDoc[],
): Promise<{ upserted: number; pruned: number }> {
  const col = await shinhanResearchCol();
  let upserted = 0;
  for (const d of docs) {
    const r = await col.replaceOne({ _id: d._id }, d, { upsert: true });
    if (r.upsertedCount || r.modifiedCount) upserted++;
  }
  const cutoff = new Date(Date.now() - MAX_AGE_MS).toISOString().slice(0, 10);
  const del = await col.deleteMany({ date: { $lt: cutoff } });
  return { upserted, pruned: del.deletedCount ?? 0 };
}

export async function getShinhanResearchBySymbol(
  symbol: string,
  limit = 20,
): Promise<ShinhanResearchDoc[]> {
  const col = await shinhanResearchCol();
  return col.find({ symbol }).sort({ date: -1 }).limit(limit).toArray();
}
