import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";
import type { MarketId } from "../markets/types";

/**
 * 증권사 리서치(기업분석) 리포트 — 개인용 로컬 수집 (CLAUDE.md 예외 참고).
 * 여러 증권사를 붙일 걸 감안해 스키마에 `source`를 두고 `_id`도
 * `${source}:${게시글번호}`로 네임스페이스했다(증권사별 ID 체계가 달라 충돌
 * 방지). 원문 PDF·전체 본문은 저장하지 않고 목록에 이미 노출되는 요약
 * (summary)·메타만 저장한다(용량: 건당 1~2KB 수준). 180일 지난 리포트는
 * 수집 시점마다 정리한다(표시는 최근 3개월 우선, 없으면 더 오래된 것으로
 * 확대 — getShinhanResearchBySymbol).
 */
export interface ShinhanResearchDoc {
  _id: string; // `${source}:${증권사 게시글 번호}`
  /** 증권사명 — "신한투자증권" 등. 여러 증권사 연동 대비 필드. */
  source: string;
  /** 종목의 상장 시장(2026-09 추가, GlobalMonitor의 미국주식 리포트 수집으로
   * 한국 전용이 아니게 됨) — 컬렉션 이름(kr_research)은 유지하되 필드로 구분. */
  market: MarketId;
  date: string; // ISO (YYYY-MM-DD)
  title: string;
  stockName: string;
  /** 종목명 → 종목코드 매핑 실패 시 null (필터링 대상에서 제외됨). */
  symbol: string | null;
  analyst: string;
  opinion: string;
  summary: string;
  pdfUrl: string | null;
  views: number | null;
  collectedAt: string;
  /** 기업분석/산업분석 구분(2026-09 추가) — 현재 모든 수집기가 기업분석만
   * 수집하므로 기존 데이터·미지정 시 "기업"으로 취급(라우트에서 기본값 처리).
   * 산업분석 수집은 추후 과제. */
  category: "기업" | "산업";
}

// 저장 자체는 넉넉하게 보관(건당 1~2KB라 용량 문제 없음) — 짧게 지우면 커버리지가
// 뜸한 종목은 "최근 것"이 아예 없어져 버린다. 화면의 "최근 3개월" 우선 표시는
// getShinhanResearchBySymbol 의 조회 단계에서 처리(없으면 그보다 오래된 것도 폴백).
const MAX_AGE_MS = 180 * 24 * 3600_000;
const RECENT_WINDOW_MS = 90 * 24 * 3600_000;

export async function shinhanResearchCol(): Promise<Collection<ShinhanResearchDoc>> {
  const db = await getDb();
  const col = db.collection<ShinhanResearchDoc>("kr_research");
  await col.createIndex({ market: 1, symbol: 1, date: -1 }).catch(() => {});
  return col;
}

export async function upsertShinhanResearch(
  docs: ShinhanResearchDoc[],
): Promise<{ upserted: number; pruned: number }> {
  const col = await shinhanResearchCol();
  let upserted = 0;
  if (docs.length > 0) {
    // 문서 수가 많을 때(예: 초기 백필) 건별 replaceOne 순차 호출은 Vercel
    // 서버리스 함수 60초 제한을 넘겨 FUNCTION_INVOCATION_TIMEOUT 이 났다
    // (실측: KB·신한·하나 각 68~391건 배치에서 재현). bulkWrite 로 한 번에
    // 보내 라운드트립을 줄인다.
    const result = await col.bulkWrite(
      docs.map((d) => ({
        replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true },
      })),
      { ordered: false },
    );
    upserted = result.upsertedCount + result.modifiedCount;
  }
  const cutoff = new Date(Date.now() - MAX_AGE_MS).toISOString().slice(0, 10);
  const del = await col.deleteMany({ date: { $lt: cutoff } });
  return { upserted, pruned: del.deletedCount ?? 0 };
}

/**
 * 최근 3개월 내 리포트를 우선 반환하고, 없으면(커버리지가 뜸한 종목) 기간
 * 제한 없이 가장 최근 것으로 확대해서 보여준다 — "없음"보다 "오래됐지만
 * 있는 것"이 낫다는 원칙.
 */
export async function getShinhanResearchBySymbol(
  market: MarketId,
  symbol: string,
  limit = 20,
): Promise<ShinhanResearchDoc[]> {
  const col = await shinhanResearchCol();
  // market 필드는 2026-09 미국주식 리서치(GlobalMonitor) 추가 시 도입됨 — 그
  // 이전 문서(전부 한국 브로커 수집분)는 이 필드 자체가 없다. market="kr" 조회
  // 시에만 필드 없는 레거시 문서도 함께 매칭(하위호환), 다른 시장은 필드가
  // 명시적으로 있는 문서만 — DB 마이그레이션 없이도 기존 데이터가 안 사라짐.
  const marketFilter =
    market === "kr" ? { $or: [{ market }, { market: { $exists: false } }] } : { market };
  const recentCutoff = new Date(Date.now() - RECENT_WINDOW_MS).toISOString().slice(0, 10);
  const recent = await col
    .find({ ...marketFilter, symbol, date: { $gte: recentCutoff } })
    .sort({ date: -1 })
    .limit(limit)
    .toArray();
  if (recent.length > 0) return recent;
  return col
    .find({ ...marketFilter, symbol })
    .sort({ date: -1 })
    .limit(Math.min(limit, 3))
    .toArray();
}
