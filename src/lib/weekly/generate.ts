import "server-only";
import {
  getPreviousSnapshot,
  getWeeklyMonthUsage,
  getWeeklyReport,
  incWeeklyUsage,
  saveWeeklyReport,
  WEEKLY_MONTHLY_BUDGET_USD,
  type SnapshotRow,
  type WeeklyReportDoc,
} from "@/lib/db/weekly-reports";
import { generateWeeklyComments, type WeeklyComments } from "./comment";
import { enrichTopIssues } from "./evidence";
import { isGeminiConfigured } from "./gemini";
import { buildWeeklyIssues, type WeeklyIssue } from "./issues";
import { renderWeeklyReport } from "./render";
import { buildSnapshot, fillFromPrevious } from "./snapshot";
import { WEEKLY_TOPICS } from "./topics";
import { resolveReportWeek, type ReportWeek } from "./week";

/**
 * 주간 리포트 초안 생성.
 *
 *  1) 대상 주 계산
 *  2) 시세 스냅샷 (기존 코드 — LLM 과 무관)
 *  3) 핵심 이슈 3개 = 증권사 리포트 빈도 + 그 주 뉴스 건수
 *     (+ 네이버 검색어 트렌드, 활성화된 경우)
 *  3.5) 뽑힌 3개에 한해 실적 서프라이즈·FRED 공식 지표 근거 보강
 *     (`evidence.ts`, 오너 지시 2026-09-18 "핵심 이슈 근거로만 추가")
 *  4) 금리정책·다음 주 일정 = 미리 정한 검색어의 그 주 기사 목록
 *  5) **해석 코멘트** = Gemini(`comment.ts`, 수집→해석→검증 3단계, 오너 지시
 *     2026-09 "llm을 부활한다") — 설정 없음/월 예산(`WEEKLY_MONTHLY_BUDGET_USD`)
 *     초과/API 실패 시 조용히 생략(빈 코멘트로 폴백, model="rule-based")
 *  6) 코드로 본문 조립 → draft 저장
 *
 * 표·숫자·구조는 절대 지어내지 않는다 — 그 부분은 5)와 무관하게 항상 코드가
 * 만든다. 발행된 리포트는 force 없이는 덮어쓰지 않는다.
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

type LlmOutcome = {
  comments: WeeklyComments;
  model: string;
  usage: WeeklyReportDoc["usage"];
  groundingQueries: string[];
  groundingSources: { title: string; uri: string }[];
};

/**
 * Gemini 코멘트 생성 시도 — 실패는 전부 이 함수 안에서 삼키고 null 을 준다.
 * 호출부는 null 이면 그냥 rule-based(빈 코멘트)로 렌더링한다.
 */
async function tryGenerateComments(
  snapshot: SnapshotRow[],
  issues: WeeklyIssue[],
  week: ReportWeek,
  allIssues: WeeklyIssue[],
): Promise<LlmOutcome | null> {
  if (!isGeminiConfigured()) return null;
  const monthUsage = await getWeeklyMonthUsage();
  if (monthUsage.totalCostUsd >= WEEKLY_MONTHLY_BUDGET_USD) {
    console.warn(
      `[weekly] 월 예산 초과($${monthUsage.totalCostUsd.toFixed(2)} / $${WEEKLY_MONTHLY_BUDGET_USD}) — Gemini 코멘트 생략`,
    );
    return null;
  }
  try {
    const out = await generateWeeklyComments(snapshot, issues, week, allIssues);
    if (!out) return null;
    await incWeeklyUsage(out.result.usage.costUsd);
    return {
      comments: out.comments,
      model: out.result.model,
      // 오너 지시 2026-09-18 — Gemini 호출을 매크로/코멘트 2개로 쪼개
      // 병렬 실행(comment.ts 참고) — 매크로 쪽은 그라운딩 실패 시 1회
      // 재시도하므로 실제로는 2~3회일 수 있다. costUsd 등 usage 수치
      // 자체는(out.result.usage) 재시도분까지 이미 정확히 합산돼 있고,
      // calls 는 화면 참고용 근사치라 "2(+재시도)" 로만 표기.
      usage: { ...out.result.usage, calls: 2 },
      groundingQueries: out.result.groundingQueries,
      groundingSources: out.result.groundingSources,
    };
  } catch (err) {
    console.warn("[weekly] Gemini 코멘트 생성 실패 — rule-based로 폴백", err);
    return null;
  }
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
    top: await enrichTopIssues(all.slice(0, 3)),
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
  const top = await enrichTopIssues(all.slice(0, 3));
  const llm = await tryGenerateComments(doc.snapshot, top, week, all);
  const rendered = await renderWeeklyReport({
    week,
    snapshot: doc.snapshot,
    issues: top,
    comments: llm?.comments,
  });

  const untouched = doc.body === doc.draftBody;
  const next: WeeklyReportDoc = {
    ...doc,
    rawBody: rendered,
    draftBody: rendered,
    body: untouched ? rendered : doc.body,
    candidates: candidatesText(all, top),
    model: llm?.model ?? doc.model,
    usage: llm?.usage ?? doc.usage,
    sources: {
      ...doc.sources,
      groundingQueries: llm?.groundingQueries ?? doc.sources.groundingQueries,
      groundingSources: llm?.groundingSources ?? doc.sources.groundingSources,
    },
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
  const llm = await tryGenerateComments(snapshot, top, week, all);
  const body = await renderWeeklyReport({ week, snapshot, issues: top, comments: llm?.comments });

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
      groundingQueries: llm?.groundingQueries ?? [],
      groundingSources: llm?.groundingSources ?? [],
    },
    // Gemini 미설정/예산 초과/실패 시 rule-based 로 폴백(모델·비용 0, 스키마 호환 유지).
    model: llm?.model ?? "rule-based",
    usage: llm?.usage ?? { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, costUsd: 0, calls: 0 },
    generatedAt: now,
    publishedAt: null,
    updatedAt: now,
  };
  await saveWeeklyReport(doc);
  return doc;
}
