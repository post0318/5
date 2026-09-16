import "server-only";
import {
  getPreviousSnapshot,
  getWeeklyReport,
  saveWeeklyReport,
  type SnapshotRow,
  type WeeklyReportDoc,
} from "@/lib/db/weekly-reports";
import { buildWeeklyIssues, type WeeklyIssue } from "./issues";
import { renderWeeklyReport } from "./render";
import { buildSnapshot, fillFromPrevious } from "./snapshot";
import { WEEKLY_TOPICS } from "./topics";
import { resolveReportWeek, type ReportWeek } from "./week";

/**
 * 주간 리포트 초안 생성 — **LLM 호출 없음**(오너 지시 2026-09 — "주간 리포트는
 * LLM 사용 없이 가자. LLM 을 통해 추론을 안 하는 것일 뿐 시장 요약 정리는
 * 유효하다").
 *
 *  1) 대상 주 계산
 *  2) 시세 스냅샷 (기존 코드 — 원래부터 LLM 과 무관)
 *  3) 핵심 이슈 3개 = 증권사 리포트 빈도 + 뉴스 건수 (+ 데이터랩 구독 시 검색량)
 *  4) 금리정책·다음 주 일정 = 미리 정한 검색어의 그 주 기사 목록
 *  5) 코드로 본문 조립 → draft 저장
 *
 * 문장을 지어내지 않는다. 숫자와 실제 제목·링크만 배치하고 해석은 오너가
 * 편집기에서 직접 쓴다. 발행된 리포트는 force 없이는 덮어쓰지 않는다.
 */

export class WeeklyGenerateError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WeeklyGenerateError";
  }
}

/** 표 행(| … |)을 제외한 본문 글자 수 — 화면 분량 표시용 */
export function bodyCharCount(md: string): number {
  return md
    .split("\n")
    .filter((l) => !/^\s*\|/.test(l))
    .join("")
    .replace(/\s+/g, "").length;
}

/**
 * 검수용 후보 목록 — 채택한 3개 말고도 어떤 주제가 몇 건 잡혔는지 그대로
 * 남긴다. 발행본엔 안 나가고 화면의 접힘 영역에만 보인다.
 */
function candidatesText(all: WeeklyIssue[], picked: WeeklyIssue[]): string {
  const pickedSet = new Set(picked.map((p) => p.label));
  const lines = all
    .filter((a) => a.researchCount > 0 || a.newsCount > 0)
    .map((a) => {
      const mark = pickedSet.has(a.label) ? "[채택] " : "";
      const search = a.searchInterest != null ? ` · 검색 ${a.searchInterest.toFixed(0)}` : "";
      return `- ${mark}${a.label} — 리포트 ${a.researchCount}건 · 뉴스 ${a.newsCount}건${search} (점수 ${a.score.toFixed(3)})`;
    });
  return lines.join("\n");
}

async function collect(week: ReportWeek): Promise<{
  snapshot: SnapshotRow[];
  all: WeeklyIssue[];
  top: WeeklyIssue[];
}> {
  const [rawSnapshot, prevSnapshot, all] = await Promise.all([
    buildSnapshot(week),
    getPreviousSnapshot(week.weekStart),
    // 후보 전체를 받아 두고(검수용) 상위 3개만 본문에 쓴다
    buildWeeklyIssues(week, { top: WEEKLY_TOPICS.length }),
  ]);
  return {
    snapshot: fillFromPrevious(rawSnapshot, prevSnapshot),
    all,
    top: all.slice(0, 3),
  };
}

/** 저장 없이 입력만 조립해 점검 — 비용 0 (원래도 0 이었지만 이제 전 과정이 0) */
export async function previewWeeklyInputs(): Promise<{
  week: ReportWeek;
  snapshot: SnapshotRow[];
  issues: WeeklyIssue[];
  candidates: string;
}> {
  const week = resolveReportWeek();
  const { snapshot, all, top } = await collect(week);
  return { week, snapshot, issues: top, candidates: candidatesText(all, top) };
}

/**
 * 저장된 리포트를 다시 렌더링한다. 조립 규칙(`render.ts`)을 고친 뒤 쓰는
 * 경로로, 오너가 수정한 body 는 건드리지 않고 body 가 초안과 같을 때(미수정)만
 * 함께 갱신한다. LLM 이 없어져 재생성과 비용이 같지만, 오너 수정본을 지키는
 * 점이 달라 그대로 둔다.
 */
export async function reprocessWeeklyReport(id: string): Promise<WeeklyReportDoc> {
  const doc = await getWeeklyReport(id);
  if (!doc) throw new WeeklyGenerateError(`${id} 리포트 없음`, 404);

  const week: ReportWeek = {
    weekStart: doc.weekStart,
    weekEnd: doc.weekEnd,
    baseFriday: "",
    today: new Date().toISOString().slice(0, 10),
  };
  const all = await buildWeeklyIssues(week, { top: WEEKLY_TOPICS.length });
  const top = all.slice(0, 3);
  const rendered = await renderWeeklyReport({ week, snapshot: doc.snapshot, issues: top });

  const untouched = doc.body === doc.draftBody;
  const next: WeeklyReportDoc = {
    ...doc,
    rawBody: rendered,
    draftBody: rendered,
    body: untouched ? rendered : doc.body,
    candidates: candidatesText(all, top),
    updatedAt: new Date().toISOString(),
  };
  await saveWeeklyReport(next);
  return next;
}

export async function generateWeeklyReport(
  opts: { force?: boolean } = {},
): Promise<WeeklyReportDoc> {
  const week = resolveReportWeek();
  const existing = await getWeeklyReport(week.weekStart);
  if (existing?.status === "published" && !opts.force) {
    throw new WeeklyGenerateError(
      `${week.weekStart} 주 리포트는 이미 발행됨 (force 필요)`,
      409,
    );
  }

  const { snapshot, all, top } = await collect(week);
  const body = await renderWeeklyReport({ week, snapshot, issues: top });

  const now = new Date().toISOString();
  const doc: WeeklyReportDoc = {
    _id: week.weekStart,
    weekStart: week.weekStart,
    weekEnd: week.weekEnd,
    status: "draft",
    title: `주간 거시·시황 요약 (${week.weekStart} ~ ${week.weekEnd})`,
    body,
    draftBody: body,
    rawBody: body,
    candidates: candidatesText(all, top),
    snapshot,
    sources: {
      // 이슈 집계에 실제로 쓰인 건수 — 코퍼스를 통째로 모으던 시절과 달리
      // 주제별 합계다.
      researchCount: all.reduce((s, a) => s + a.researchCount, 0),
      newsCount: all.reduce((s, a) => s + a.newsCount, 0),
      telegramCount: 0,
      youtubeCount: 0,
      groundingQueries: [],
      groundingSources: [],
    },
    // LLM 을 안 쓰므로 모델·토큰·비용은 0 으로 남긴다(기존 문서와 스키마 호환).
    model: "rule-based",
    usage: { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, costUsd: 0, calls: 0 },
    generatedAt: now,
    publishedAt: null,
    updatedAt: now,
  };
  await saveWeeklyReport(doc);
  return doc;
}
