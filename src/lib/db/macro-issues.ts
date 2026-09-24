import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";

/**
 * 거시경제 "이슈분석"/"환율분석" 탭 전용 컬렉션(`macro_issues`, 오너 지시
 * 2026-09-24) — 종목·시장(kr/us/jp)에 매이지 않는 매크로 코멘트라
 * `kr_research`(종목분석/산업분석용, market·symbol 필드가 핵심)와는 별개로
 * 뒀다. "전체/증권사명" 탭 구성이 목적이라 스키마도 그에 맞춰 최소화 —
 * 종목코드·투자의견·목표주가 개념이 없다.
 *
 * 시작은 키움증권만(오너 지시 — "새 전용 수집(권장)... 다른 증권사는 추후
 * 동일한 방식으로 하나씩 추가"):
 *  - topic:"이슈분석" ← 키움 게시판 코드 IA("경제/전략" 하위의 진짜
 *    이슈분석 — FOMC/금통위 리뷰·프리뷰, 물가, 예산안 등). "기업/산업분석"
 *    하위에도 이름이 같은 "이슈분석"(코드 CS)이 있는데 그쪽은 실측 결과
 *    "키움리서치 관심종목(N월 N주)" 반복 시리즈라 대상이 아니다(오너 지시
 *    — "키움증권은 경제전략의 이슈분석만 대상이 된다").
 *  - topic:"환율분석" ← 키움 게시판 코드 FE(rMenuGbNm "일간환율전망").
 */
export interface MacroIssueDoc {
  _id: string; // `${source}:${topic}:${원본 게시글 번호}`
  source: string;
  topic: "이슈분석" | "환율분석";
  date: string; // ISO (YYYY-MM-DD)
  title: string;
  analyst: string;
  summary: string;
  pdfUrl: string | null;
  collectedAt: string;
}

// 다른 리서치 컬렉션(kr_research)과 같은 90일 보존 원칙.
const MAX_AGE_MS = 90 * 24 * 3600_000;

export async function macroIssuesCol(): Promise<Collection<MacroIssueDoc>> {
  const db = await getDb();
  const col = db.collection<MacroIssueDoc>("macro_issues");
  await col.createIndex({ topic: 1, date: -1 }).catch(() => {});
  return col;
}

export async function upsertMacroIssues(docs: MacroIssueDoc[]): Promise<{ upserted: number; pruned: number }> {
  const col = await macroIssuesCol();
  let upserted = 0;
  if (docs.length > 0) {
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

export async function getMacroIssues(
  topic: "이슈분석" | "환율분석",
  source?: string,
  limit = 150,
): Promise<MacroIssueDoc[]> {
  const col = await macroIssuesCol();
  const filter: Record<string, unknown> = { topic };
  if (source) filter.source = source;
  return col.find(filter).sort({ date: -1 }).limit(limit).toArray();
}

/** 탭 UI용 — 해당 topic에 실제로 존재하는 증권사명 목록(문서 수 많은 순). */
export async function getMacroIssueSources(topic: "이슈분석" | "환율분석"): Promise<string[]> {
  const col = await macroIssuesCol();
  const rows = await col
    .aggregate<{ _id: string; count: number }>([
      { $match: { topic } },
      { $group: { _id: "$source", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])
    .toArray();
  return rows.map((r) => r._id);
}
