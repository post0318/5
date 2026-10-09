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
import {
  assembleConnectorComments,
  buildCodeCalendar,
  buildConnectorPayload,
  CONNECTOR_GUIDE,
  generateWeeklyComments,
  nextWeekRange,
  type CommentExtras,
  type ConnectorComments,
  type WebFact,
  type IssueComment,
  type WeeklyComments,
} from "./comment";
import { saveWeeklyTopicCounts } from "@/lib/db/weekly-topic-counts";
import { enrichTopIssues, fetchOfficialMetrics } from "./evidence";
import { isGeminiConfigured } from "./gemini";
import { buildWeeklyIssues, selectTopIssues, type WeeklyIssue } from "./issues";
import { renderWeeklyReport } from "./render";
import { isKrxHoliday } from "@/lib/macro/kr/market-calendar";
import { buildSectorNews, type SectorNews } from "./sector-news";
import { buildWeeklySectors, type WeeklySectors } from "./sectors";
import { fetchShinhanSchedule } from "./shinhan-schedule";
import { buildSnapshot, fillFromPrevious } from "./snapshot";
import { WEEKLY_TOPICS } from "./topics";
import { reportWeekFromStart, resolveReportWeek, type ReportWeek } from "./week";
import { getWeeklyInputs, saveWeeklyInputs, type WeeklyInputsDoc } from "@/lib/db/weekly-inputs";

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
  dropReasons: Record<string, string>;
  webFacts: WebFact[];
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
  sectors: WeeklySectors,
  extras: CommentExtras,
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
    const out = await generateWeeklyComments(snapshot, issues, week, allIssues, sectors, extras);
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
      dropReasons: Object.fromEntries(out.comments.dropReasons),
      webFacts: out.comments.webFacts,
    };
  } catch (err) {
    console.warn("[weekly] Gemini 코멘트 생성 실패 — rule-based로 폴백", err);
    return null;
  }
}

interface Collected {
  snapshot: SnapshotRow[];
  all: WeeklyIssue[];
  top: WeeklyIssue[];
  sectors: WeeklySectors;
  /** 코드 확정 자료(공식 지표·섹터 근거 기사·다음 주 일정) — LLM 과 무관하게 렌더링에 쓰인다 */
  extras: CommentExtras;
  /** 코드 단계에서 못 채운 이유(예: FRED 키 없음) — 검수 화면 dropReasons 로 */
  notes: Record<string, string>;
}

/** 이슈·섹터가 정해진 뒤 붙이는 코드 확정 자료 — collect·reprocess 공통 */
async function collectExtras(
  week: ReportWeek,
  all: WeeklyIssue[],
  sectors: WeeklySectors,
): Promise<{ top: WeeklyIssue[]; extras: CommentExtras; notes: Record<string, string> }> {
  const next = nextWeekRange(week);
  const [official, sectorNews, schedule] = await Promise.all([
    fetchOfficialMetrics(week),
    buildSectorNews(sectors, week).catch(() => new Map()),
    fetchShinhanSchedule(next.start, next.end),
  ]);
  const codeCalendar = await buildCodeCalendar(week, schedule);
  // 계열 규칙(통화정책 제외 + 계열당 1개 + 물가·미국증시 병합)을 적용해
  // 고른다. all 은 그대로 둔다 — 검수용 후보 목록과 금리정책 근거가
  // 개별 주제를 참조한다.
  const top = await enrichTopIssues(selectTopIssues(all, 3), week, official.metrics);
  const notes: Record<string, string> = {};
  if (official.note) notes.officialMetrics = official.note;
  if (sectors.notes?.kospi) notes["sector:kospi"] = sectors.notes.kospi;
  if (sectors.notes?.kosdaq) notes["sector:kosdaq"] = sectors.notes.kosdaq;
  if (schedule.length === 0) notes.schedule = "신한 「이슈 및 섹터 스케줄」 다음 주 일정을 받지 못함";
  return { top, extras: { official: official.metrics, sectorNews, schedule, codeCalendar }, notes };
}

async function collect(week: ReportWeek): Promise<Collected> {
  const [rawSnapshot, prevSnapshot, all, sectors] = await Promise.all([
    buildSnapshot(week),
    getPreviousSnapshot(week.weekStart),
    // 후보 전체를 받아 두고(검수용) 상위 3개만 본문에 쓴다
    buildWeeklyIssues(week, { top: WEEKLY_TOPICS.length }),
    buildWeeklySectors(week),
  ]);
  const { top, extras, notes } = await collectExtras(week, all, sectors);
  const snapshot = fillFromPrevious(rawSnapshot, prevSnapshot);
  for (const r of snapshot) if (r.value == null && r.note) notes[`snapshot:${r.name}`] = r.note;
  return { snapshot, all, top, sectors, extras, notes };
}

/** 저장 없이 입력만 조립해 점검 — 비용 0 (원래도 0 이었지만 이제 전 과정이 0) */
export async function previewWeeklyInputs(): Promise<{
  week: ReportWeek;
  snapshot: SnapshotRow[];
  issues: WeeklyIssue[];
  candidates: string;
  sectors: WeeklySectors;
  extras: Omit<CommentExtras, "sectorNews"> & { sectorNews: Record<string, SectorNews> };
  notes: Record<string, string>;
}> {
  const week = resolveReportWeek();
  const { snapshot, all, top, sectors, extras, notes } = await collect(week);
  // Map 은 JSON 으로 안 나가 점검 응답에서 객체로 바꾼다
  const shown = { ...extras, sectorNews: Object.fromEntries(extras.sectorNews) };
  return { week, snapshot, issues: top, candidates: candidatesText(all, top), sectors, extras: shown, notes };
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
    // 전전주 금요일 = weekEnd - 7일(스냅샷과 같은 구간, week.ts 의
    // resolveReportWeek() 과 동일 계산) — sectors.ts 의 등락률 기준점으로
    // 쓰인다. 전에는 여기서 안 써서 빈 문자열이었지만 이제 필요해짐.
    baseFriday: new Date(Date.parse(`${doc.weekEnd}T00:00:00Z`) - 7 * 86_400_000)
      .toISOString()
      .slice(0, 10),
    today: new Date().toISOString().slice(0, 10),
  };
  const [all, sectors] = await Promise.all([
    buildWeeklyIssues(week, { top: WEEKLY_TOPICS.length }),
    buildWeeklySectors(week),
  ]);
  const { top, extras, notes } = await collectExtras(week, all, sectors);
  const llm = await tryGenerateComments(doc.snapshot, top, week, all, sectors, extras);
  const rendered = await renderWeeklyReport({
    week,
    snapshot: doc.snapshot,
    issues: top,
    sectors,
    comments: llm?.comments,
    official: extras.official,
    codeCalendar: extras.codeCalendar,
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
      webFacts: llm?.webFacts ?? doc.sources.webFacts ?? [],
      dropReasons: { ...notes, ...(llm?.dropReasons ?? doc.sources.dropReasons ?? {}) },
    },
    updatedAt: new Date().toISOString(),
  };
  await saveWeeklyReport(next);
  return next;
}

/**
 * 자동 생성 실행 여부(오너 지시 2026-10-05 — "월요일이 휴일이면 화요일에 작업하는
 * 거로 반영하라"). 오라클 타이머는 월~금 같은 시각에 깨우고, 여기서 **그 주 첫
 * 한국 거래일**에만 통과시킨다(월요일 휴장이면 화요일, 화요일도 휴장이면 그다음).
 * 대상 주는 여전히 지난주(월~금, `resolveReportWeek`).
 *
 * - 휴장 판정은 앱 휴장일 달력(`isKrxHoliday`). 달력을 못 받은 날(null)은 "거래일이었다"고
 *   단정하지 않는다 — 대신 아래 "초안 이미 있음" 검사가 중복 생성을 막는다.
 * - 그 주 초안이 이미 있으면(앞선 회차·화면에서 수동 생성) 건너뛴다. 자동 실행은
 *   기존 초안을 덮어쓰지 않는다.
 */
export async function weeklyAutoRunGate(now = new Date()): Promise<{ run: boolean; reason: string }> {
  const kstMs = now.getTime() + 9 * 3600_000;
  const today = new Date(kstMs).toISOString().slice(0, 10);
  const dow = new Date(kstMs).getUTCDay();
  if (dow === 0 || dow === 6) return { run: false, reason: `${today} 주말` };
  if ((await isKrxHoliday(today)) === true) return { run: false, reason: `${today} 한국 증시 휴장` };
  for (let back = dow - 1; back >= 1; back--) {
    const d = new Date(kstMs - back * 86_400_000).toISOString().slice(0, 10);
    if ((await isKrxHoliday(d)) === false) {
      return { run: false, reason: `이번 주 첫 거래일은 ${d} — 오늘(${today})은 건너뜀` };
    }
  }
  const week = resolveReportWeek(now);
  const existing = await getWeeklyReport(week.weekStart);
  if (existing) return { run: false, reason: `${week.weekStart} 주 초안이 이미 있음(${existing.status})` };
  return { run: true, reason: `${today} = 이번 주 첫 한국 거래일` };
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
  if (existing?.origin === "claude-connector" && !opts.force) {
    throw new WeeklyGenerateError(
      `${week.weekStart} 주는 Claude 커넥터 초안이 있음 — 덮어쓰려면 "재생성"(force)`,
      409,
    );
  }

  const collected = await collect(week);
  const { snapshot, all, top, sectors, extras, notes } = collected;
  // claude.ai 커넥터가 같은 입력을 쓰도록 보관(실패해도 생성은 계속)
  await saveWeeklyInputs(toInputsDoc(week, collected)).catch((err) =>
    console.warn("[weekly] 입력 보관 실패(리포트는 계속)", err),
  );
  // 주제별 집계를 남긴다 — 몇 주 쌓이면 "평소 대비 배수" 정규화의 기준선이
  // 된다(과거를 역으로 조회할 수 없어 앞으로 쌓는 방식, 오너 지시 2026-09-21).
  // 실패해도 리포트 생성을 막지 않는다.
  await saveWeeklyTopicCounts(week.weekStart, all).catch((err) =>
    console.warn("[weekly] 주제 집계 저장 실패(리포트는 계속)", err),
  );
  const llm = await tryGenerateComments(snapshot, top, week, all, sectors, extras);
  const body = await renderWeeklyReport({
    week,
    snapshot,
    issues: top,
    sectors,
    comments: llm?.comments,
    official: extras.official,
    codeCalendar: extras.codeCalendar,
  });

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
      webFacts: llm?.webFacts ?? [],
      dropReasons: { ...notes, ...(llm?.dropReasons ?? {}) },
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

/**
 * 모델 비교(오너 지시 2026-09-21 — "비교해줘"). 같은 주 입력으로 모델
 * 여러 개를 각각 돌려 결과를 나란히 돌려준다. **DB 에 저장하지 않는다** —
 * 진행 중인 초안을 건드리지 않기 위해서다.
 *
 * 수집(스냅샷·이슈·섹터)은 한 번만 하고 모델별로 코멘트 생성만 다시 한다 —
 * 입력이 완전히 같아야 비교가 성립한다. 호출은 순차적으로 한다(동시에
 * 때리면 레이트리밋·그라운딩 쿼터가 꼬인다).
 *
 * 실제 과금되므로 usage 는 그대로 기록하고 월 예산도 검사한다.
 */
export async function compareWeeklyModels(models: string[]): Promise<{
  weekStart: string;
  weekEnd: string;
  results: {
    model: string;
    ok: boolean;
    error?: string;
    elapsedMs: number;
    body?: string;
    bodyChars?: number;
    headline?: string | null;
    policySummary?: string | null;
    issueComments?: { label: string; comment: IssueComment }[];
    calendar?: { date: string; event: string }[] | null;
    groundingSources?: number;
    usage?: WeeklyReportDoc["usage"];
  }[];
}> {
  if (!isGeminiConfigured()) throw new WeeklyGenerateError("GEMINI_API_KEY 미설정", 503);
  const monthUsage = await getWeeklyMonthUsage();
  if (monthUsage.totalCostUsd >= WEEKLY_MONTHLY_BUDGET_USD) {
    throw new WeeklyGenerateError(
      `월 예산 초과($${monthUsage.totalCostUsd.toFixed(2)} / $${WEEKLY_MONTHLY_BUDGET_USD})`,
      429,
    );
  }

  const week = resolveReportWeek();
  const { snapshot, all, top, sectors, extras } = await collect(week);

  const results = [];
  for (const model of models) {
    const startedAt = Date.now();
    try {
      const out = await generateWeeklyComments(snapshot, top, week, all, sectors, extras, model);
      if (!out) {
        results.push({ model, ok: false, error: "코멘트 생성 결과 없음", elapsedMs: Date.now() - startedAt });
        continue;
      }
      await incWeeklyUsage(out.result.usage.costUsd);
      const body = await renderWeeklyReport({
        week,
        snapshot,
        issues: top,
        sectors,
        comments: out.comments,
        official: extras.official,
        codeCalendar: extras.codeCalendar,
      });
      results.push({
        model: out.result.model,
        ok: true,
        elapsedMs: Date.now() - startedAt,
        body,
        bodyChars: bodyCharCount(body),
        headline: out.comments.headline,
        policySummary: out.comments.policySummary,
        issueComments: [...out.comments.issues.entries()].map(([label, comment]) => ({ label, comment })),
        calendar: out.comments.calendar,
        groundingSources: out.result.groundingSources.length,
        usage: { ...out.result.usage, calls: 2 },
      });
    } catch (err) {
      results.push({
        model,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        elapsedMs: Date.now() - startedAt,
      });
    }
  }
  return { weekStart: week.weekStart, weekEnd: week.weekEnd, results };
}

// ---- claude.ai 커넥터(`/api/mcp`) ---------------------------------------------
// 오너 지시 2026-10-10 — Anthropic API(별도 과금) 대신 오너 구독의 claude.ai 가 해석을 쓴다.
// 조회(getConnectorData)와 저장(saveConnectorDraft)만 있고 발행·삭제는 없다.

function toInputsDoc(week: ReportWeek, c: Collected): WeeklyInputsDoc {
  return {
    _id: week.weekStart,
    week,
    collectedAt: new Date(),
    snapshot: c.snapshot,
    all: c.all,
    top: c.top,
    sectors: c.sectors,
    official: c.extras.official,
    sectorNews: Object.fromEntries(c.extras.sectorNews),
    schedule: c.extras.schedule,
    codeCalendar: c.extras.codeCalendar,
    notes: c.notes,
  };
}

function extrasOf(d: WeeklyInputsDoc): CommentExtras {
  return {
    official: d.official,
    sectorNews: new Map(Object.entries(d.sectorNews ?? {})),
    schedule: d.schedule,
    codeCalendar: d.codeCalendar,
  };
}

function connectorWeek(weekStart?: string): ReportWeek {
  if (!weekStart) return resolveReportWeek();
  const w = reportWeekFromStart(weekStart);
  if (!w) {
    throw new WeeklyGenerateError(
      `weekStart(${weekStart})는 지난 8주 안의 월요일이어야 하고 그 주 금요일이 지나 있어야 함`,
      400,
    );
  }
  return w;
}

/** 보관본이 있으면 그것, 없거나 refresh 면 새로 수집해 보관 */
async function loadInputs(week: ReportWeek, refresh: boolean): Promise<WeeklyInputsDoc> {
  if (!refresh) {
    const cached = await getWeeklyInputs(week.weekStart);
    if (cached) return cached;
  }
  const doc = toInputsDoc(week, await collect(week));
  await saveWeeklyInputs(doc);
  return doc;
}

export async function getConnectorData(opts: { weekStart?: string; refresh?: boolean }) {
  const week = connectorWeek(opts.weekStart);
  const inputs = await loadInputs(week, Boolean(opts.refresh));
  const existing = await getWeeklyReport(week.weekStart);
  const data = await buildConnectorPayload(inputs.snapshot, inputs.top, inputs.week, inputs.all, inputs.sectors, extrasOf(inputs));
  return {
    week: { start: week.weekStart, end: week.weekEnd },
    collectedAt: inputs.collectedAt,
    existingDraft: existing
      ? {
          status: existing.status,
          by: existing.origin === "claude-connector" ? "claude-connector" : existing.model,
          editedByOwner: existing.body !== existing.draftBody,
          canSave: existing.status !== "published" && existing.body === existing.draftBody,
        }
      : null,
    guide: CONNECTOR_GUIDE,
    /** 코드 단계에서 못 채운 자료와 이유(예: FRED 키 없음) */
    notes: inputs.notes,
    data,
  };
}

export interface ConnectorSaveResult {
  saved: boolean;
  weekStart: string;
  /** 비어 남은 칸과 이유 — 고쳐서 다시 저장하면 된다 */
  dropped: Record<string, string>;
  /** 버리지는 않았지만 고칠 것(핵심 수치 없음 등) */
  warnings: string[];
  /** 날짜 검사로 버린 출처 */
  rejectedSources: { url: string; reason: string }[];
  body: string;
}

export async function saveConnectorDraft(opts: {
  weekStart?: string;
  comments: ConnectorComments;
  sources: { title: string; url: string; date?: string }[];
  preview?: boolean;
}): Promise<ConnectorSaveResult> {
  const week = connectorWeek(opts.weekStart);
  const existing = await getWeeklyReport(week.weekStart);
  if (!opts.preview) {
    if (existing?.status === "published") {
      throw new WeeklyGenerateError(`${week.weekStart} 주 리포트는 이미 발행됨 — 커넥터는 발행본을 바꿀 수 없음`, 409);
    }
    if (existing && existing.body !== existing.draftBody) {
      throw new WeeklyGenerateError(`${week.weekStart} 주 초안을 오너가 고쳐 둠 — 커넥터는 덮어쓰지 않음(/weekly 화면에서 처리)`, 409);
    }
  }
  const inputs = await getWeeklyInputs(week.weekStart);
  if (!inputs) throw new WeeklyGenerateError("이 주 입력 보관본이 없음 — get_weekly_data 를 먼저 호출", 409);
  const extras = extrasOf(inputs);
  // 출처 날짜 검사(오너 지시 2026-10-10 — "일년전에 발표하고 우연히 지금 맞을수도 있기에"): 리포트 주 앞 주말(토)부터
  // 다음 주 월요일까지 발행된 글만 근거로 인정한다. 날짜 없는 출처도 버린다.
  const lo = new Date(Date.parse(`${week.weekStart}T00:00:00Z`) - 2 * 86_400_000).toISOString().slice(0, 10);
  const hi = new Date(Date.parse(`${week.weekEnd}T00:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10);
  const rejectedSources: { url: string; reason: string }[] = [];
  const sources = opts.sources
    .filter((x) => {
      if (!/^https?:\/\//.test(x.url)) return false;
      const d = /^\d{4}-\d{2}-\d{2}$/.test(x.date ?? "") ? (x.date as string) : null;
      if (!d) rejectedSources.push({ url: x.url, reason: "발행일(date) 없음" });
      else if (d < lo || d > hi) rejectedSources.push({ url: x.url, reason: `발행일 ${d} 이 리포트 주(${lo}~${hi}) 밖` });
      return d != null && d >= lo && d <= hi;
    })
    .slice(0, 100);
  const { comments, warnings } = await assembleConnectorComments(
    inputs.snapshot,
    inputs.top,
    inputs.week,
    inputs.all,
    inputs.sectors,
    extras,
    opts.comments,
    sources.map((x) => x.title),
  );
  const body = await renderWeeklyReport({
    week: inputs.week,
    snapshot: inputs.snapshot,
    issues: inputs.top,
    sectors: inputs.sectors,
    comments,
    official: extras.official,
    codeCalendar: extras.codeCalendar,
  });
  const dropped = Object.fromEntries(comments.dropReasons);
  if (opts.preview) return { saved: false, weekStart: week.weekStart, dropped, warnings, rejectedSources, body };

  const now = new Date().toISOString();
  const all = inputs.all;
  await saveWeeklyReport({
    _id: week.weekStart,
    weekStart: week.weekStart,
    weekEnd: week.weekEnd,
    status: "draft",
    title: `주간 거시·시황 요약 (${week.weekStart} ~ ${week.weekEnd})`,
    body,
    draftBody: body,
    rawBody: body,
    candidates: candidatesText(all, inputs.top),
    snapshot: inputs.snapshot,
    sources: {
      researchCount: all.reduce((s, a) => s + a.researchCount, 0),
      newsCount: all.reduce((s, a) => s + a.newsCount, 0),
      telegramCount: 0,
      youtubeCount: 0,
      groundingQueries: [],
      groundingSources: sources.map((x) => ({ title: `${x.title.slice(0, 200)} (${x.date})`, uri: x.url })),
      webFacts: [],
      dropReasons: { ...inputs.notes, ...dropped },
    },
    model: "Claude (claude.ai 커넥터)",
    origin: "claude-connector",
    usage: { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, costUsd: 0, calls: 0 },
    generatedAt: now,
    publishedAt: null,
    updatedAt: now,
  });
  return { saved: true, weekStart: week.weekStart, dropped, warnings, rejectedSources, body };
}
