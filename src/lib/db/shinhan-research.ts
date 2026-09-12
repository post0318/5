import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";

/**
 * 증권사 리서치(기업분석) 리포트 — 개인용 로컬 수집 (CLAUDE.md 예외 참고).
 * 지금은 신한투자증권 한 곳만 수집하지만, 여러 증권사를 붙일 걸 감안해 스키마에
 * `source`를 두고 `_id`도 `${source}:${게시글번호}`로 네임스페이스했다(증권사별
 * ID 체계가 달라 충돌 방지). 원문 PDF·전체 본문은 저장하지 않고 목록에 이미
 * 노출되는 요약(summary)·메타만 저장한다(용량: 건당 1~2KB 수준). 180일 지난
 * 리포트는 수집 시점마다 정리한다(표시는 최근 30일 우선, 없으면 더 오래된
 * 것으로 확대 — getShinhanResearchBySymbol).
 */
export interface ShinhanResearchDoc {
  _id: string; // `${source}:${증권사 게시글 번호}`
  /** 증권사명 — 지금은 "신한투자증권"만. 추가 증권사 연동 대비 필드. */
  source: string;
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

// 저장 자체는 넉넉하게 보관(건당 1~2KB라 용량 문제 없음) — 짧게 지우면 커버리지가
// 뜸한 종목은 "최근 것"이 아예 없어져 버린다. 화면의 "최근 30일" 우선 표시는
// getShinhanResearchBySymbol 의 조회 단계에서 처리(없으면 그보다 오래된 것도 폴백).
const MAX_AGE_MS = 180 * 24 * 3600_000;
const RECENT_WINDOW_MS = 30 * 24 * 3600_000;

export async function shinhanResearchCol(): Promise<Collection<ShinhanResearchDoc>> {
  const db = await getDb();
  const col = db.collection<ShinhanResearchDoc>("kr_research");
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

/**
 * 최근 30일 내 리포트를 우선 반환하고, 없으면(커버리지가 뜸한 종목) 기간
 * 제한 없이 가장 최근 것으로 확대해서 보여준다 — "없음"보다 "오래됐지만
 * 있는 것"이 낫다는 원칙.
 */
export async function getShinhanResearchBySymbol(
  symbol: string,
  limit = 20,
): Promise<ShinhanResearchDoc[]> {
  const col = await shinhanResearchCol();
  const recentCutoff = new Date(Date.now() - RECENT_WINDOW_MS).toISOString().slice(0, 10);
  const recent = await col
    .find({ symbol, date: { $gte: recentCutoff } })
    .sort({ date: -1 })
    .limit(limit)
    .toArray();
  if (recent.length > 0) return recent;
  return col.find({ symbol }).sort({ date: -1 }).limit(Math.min(limit, 3)).toArray();
}
