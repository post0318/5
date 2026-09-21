import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";

/**
 * 주간 거시·시황 리포트(A4 1장) — 매주 월요일 Gemini API가 초안을 쓰고 오너가
 * 화면에서 검수·수정 후 발행한다(오너 지시, 2026-09 — "한 사람 인력을 대체").
 * 원문 코퍼스(리포트 발췌·뉴스 제목 등)는 저장하지 않고 생성된 리포트와
 * 수치 스냅샷·사용량 메타만 저장. 상세 설계는 src/lib/weekly/ 와 CLAUDE.md.
 */

export type WeeklyReportStatus = "draft" | "published";

export interface SnapshotRow {
  key: string;
  group: string; // 국내주식 / 해외주식 / 채권 / 원자재 / 환율·변동성
  name: string;
  /** 지난주 마지막 거래일 값 */
  value: number | null;
  /** 값의 기준일 */
  asOf: string | null;
  /** 전주 대비 값(변동률 %) — 금리류는 %p 를 `diff` 에 따로 둔다 */
  pct: number | null;
  /** 전주 대비 절대 변화(금리 %p 등). 변동률과 함께 보여줄 때만 */
  diff: number | null;
  /** 기준값 날짜(전주 마지막 거래일) */
  baseAsOf: string | null;
  unit: string; // "pt" | "%" | "$" | "원" ...
  source: string;
}

export interface WeeklyReportDoc {
  /** 리포트 대상 주(週)의 월요일 YYYY-MM-DD — 주당 1건 */
  _id: string;
  weekStart: string;
  weekEnd: string;
  status: WeeklyReportStatus;
  title: string;
  /** 검수·수정 대상 본문(마크다운) */
  body: string;
  /** 후처리(표 재생성·제목 고정)까지 끝난 최초 초안 — 오너 수정 이력 비교용 */
  draftBody: string;
  /** 모델 출력 원문(후보이슈 분리 후, 후처리 전) — 후처리 코드를 고친 뒤 비용 0으로
   * 다시 렌더링(reprocess)할 때의 입력. 렌더링 결과로 절대 덮어쓰지 않는다. */
  rawBody: string;
  /** 검수용 후보 이슈 전체(마크다운) — 발행본엔 안 나감 */
  candidates: string;
  snapshot: SnapshotRow[];
  sources: {
    researchCount: number;
    newsCount: number;
    telegramCount: number;
    youtubeCount: number;
    /** Gemini 웹검색 그라운딩이 실제 조회한 검색어 */
    groundingQueries: string[];
    /** 그라운딩이 인용한 출처(제목·URL) */
    groundingSources: { title: string; uri: string }[];
    /**
     * 코멘트가 빈 채로 남은 이유(오너 지시 2026-09-21). 키는 comment.ts 의
     * WeeklyComments.dropReasons 와 같다("headline" | "policySummary" |
     * "calendar" | `snapshot:${name}` | `issue:${label}` | `sector:${id}`).
     * Mongo 저장용으로 Map 대신 일반 객체를 쓴다.
     */
    dropReasons: Record<string, string>;
  };
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    thoughtTokens: number;
    /** 공식 단가 기반 추정치(USD) */
    costUsd: number;
    calls: number;
  };
  generatedAt: string;
  publishedAt: string | null;
  updatedAt: string;
}

export async function weeklyReportsCol(): Promise<Collection<WeeklyReportDoc>> {
  const db = await getDb();
  const col = db.collection<WeeklyReportDoc>("weekly_reports");
  await col.createIndex({ weekStart: -1 }).catch(() => {});
  return col;
}

export async function saveWeeklyReport(doc: WeeklyReportDoc): Promise<void> {
  const col = await weeklyReportsCol();
  await col.replaceOne({ _id: doc._id }, doc, { upsert: true });
}

export async function getWeeklyReport(id: string): Promise<WeeklyReportDoc | null> {
  const col = await weeklyReportsCol();
  return col.findOne({ _id: id });
}

/** 목록용 — 본문 제외한 메타만 */
export type WeeklyReportSummary = Pick<
  WeeklyReportDoc,
  "_id" | "weekStart" | "weekEnd" | "status" | "title" | "generatedAt" | "publishedAt" | "updatedAt"
> & { costUsd: number };

export async function listWeeklyReports(limit = 52): Promise<WeeklyReportSummary[]> {
  const col = await weeklyReportsCol();
  const docs = await col
    .find({}, { projection: { body: 0, draftBody: 0, candidates: 0, snapshot: 0, sources: 0 } })
    .sort({ weekStart: -1 })
    .limit(limit)
    .toArray();
  return docs.map((d) => ({
    _id: d._id,
    weekStart: d.weekStart,
    weekEnd: d.weekEnd,
    status: d.status,
    title: d.title,
    generatedAt: d.generatedAt,
    publishedAt: d.publishedAt,
    updatedAt: d.updatedAt,
    costUsd: d.usage?.costUsd ?? 0,
  }));
}

export async function updateWeeklyReport(
  id: string,
  patch: { body?: string; status?: WeeklyReportStatus },
): Promise<WeeklyReportDoc | null> {
  const col = await weeklyReportsCol();
  const now = new Date().toISOString();
  const $set: Partial<WeeklyReportDoc> = { updatedAt: now };
  if (typeof patch.body === "string") $set.body = patch.body;
  if (patch.status) {
    $set.status = patch.status;
    $set.publishedAt = patch.status === "published" ? now : null;
  }
  await col.updateOne({ _id: id }, { $set });
  return col.findOne({ _id: id });
}

/** 직전 리포트(현재 주 제외)의 스냅샷 — 주간 이력이 없는 지표(브라질 국채 등)의
 * 전주 대비 계산에 쓴다. */
export async function getPreviousSnapshot(beforeWeekStart: string): Promise<SnapshotRow[] | null> {
  const col = await weeklyReportsCol();
  const doc = await col
    .find({ weekStart: { $lt: beforeWeekStart } }, { projection: { snapshot: 1 } })
    .sort({ weekStart: -1 })
    .limit(1)
    .next();
  return doc?.snapshot ?? null;
}

// ---- 월별 사용량(예산 상한) — 종목뉴스 요약의 llm_usage 와는 별도 컬렉션 ----

export interface WeeklyLlmUsageDoc {
  _id: string; // "YYYY-MM"
  totalCostUsd: number;
  callCount: number;
}

/** Google AI Pro 구독에 포함된 월 $10 Cloud 크레딧 안에서만 돈다 — 그 아래로 상한. */
export const WEEKLY_MONTHLY_BUDGET_USD = Number(process.env.WEEKLY_MONTHLY_BUDGET_USD ?? 8);

function monthId(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function usageCol(): Promise<Collection<WeeklyLlmUsageDoc>> {
  const db = await getDb();
  return db.collection<WeeklyLlmUsageDoc>("weekly_llm_usage");
}

export async function getWeeklyMonthUsage(): Promise<WeeklyLlmUsageDoc> {
  const col = await usageCol();
  const _id = monthId();
  return (await col.findOne({ _id })) ?? { _id, totalCostUsd: 0, callCount: 0 };
}

export async function incWeeklyUsage(costUsd: number, calls = 1): Promise<void> {
  const col = await usageCol();
  await col.updateOne(
    { _id: monthId() },
    { $inc: { totalCostUsd: costUsd, callCount: calls } },
    { upsert: true },
  );
}
