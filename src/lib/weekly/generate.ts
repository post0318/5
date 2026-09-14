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
import { buildCorpus } from "./corpus";
import { GeminiApiError, geminiGenerate, isGeminiConfigured } from "./gemini";
import {
  BODY_CHAR_LIMIT,
  buildCompressPrompt,
  buildSystemPrompt,
  CANDIDATES_DELIMITER,
} from "./prompt";
import { buildSnapshot, fillFromPrevious, snapshotToMarkdownTable, snapshotToText } from "./snapshot";
import { resolveReportWeek } from "./week";

/**
 * 주간 리포트 초안 생성 오케스트레이터.
 *  1) 대상 주 계산 → 2) 스냅샷·코퍼스 병렬 조립 → 3) Gemini(웹검색 그라운딩)
 *  → 4) 본문/후보이슈 분리 → 5) 분량 초과 시 압축 호출 → 6) 저장(draft).
 * 발행된(published) 리포트는 force 없이는 덮어쓰지 않는다.
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

/** 표 행(| … |)을 제외한 본문 글자 수 */
export function bodyCharCount(md: string): number {
  return md
    .split("\n")
    .filter((l) => !/^\s*\|/.test(l))
    .join("")
    .replace(/\s+/g, "").length;
}

/**
 * "## 2. 시장 스냅샷" 섹션을 코드가 만든 표로 교체 — 모델은 "- 지표명: 코멘트"
 * 줄만 쓰고, 값·변동은 스냅샷 데이터에서 넣는다. 모델이 표를 그대로 그려버린
 * 경우(지시 무시)에도 섹션 전체를 교체하므로 잘못 옮겨 적은 숫자가 남지 않는다.
 */
function replaceSnapshotSection(body: string, snapshot: SnapshotRow[]): string {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => /^##\s*2\./.test(l));
  if (start < 0) return body;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const comments = new Map<string, string>();
  const names = snapshot.map((r) => r.name).sort((a, b) => b.length - a.length);
  for (const raw of lines.slice(start + 1, end)) {
    const l = raw.trim();
    // "- 지표명: 코멘트" 또는 표 행 "| 지표명 | … | 코멘트 |"
    let name: string | null = null;
    let comment = "";
    const bullet = l.match(/^[-*]\s*\**([^:：*]+)\**\s*[:：]\s*(.+)$/);
    if (bullet) {
      name = bullet[1].trim();
      comment = bullet[2].trim();
    } else if (l.startsWith("|")) {
      const cells = l.split("|").map((c) => c.trim()).filter(Boolean);
      if (cells.length >= 4 && !/^-+$/.test(cells[0]) && cells[0] !== "자산") {
        name = cells[0];
        comment = cells[cells.length - 1];
      }
    }
    if (!name) continue;
    // 모델이 "원자재 | 금"처럼 그룹을 앞에 붙이거나 "(만기 2037)"을 생략/추가하는
    // 변형이 실측됨 → 마지막 "|" 뒤만 취하고 괄호 꼬리를 뗀 뒤 비교.
    // 정확 일치 → 스냅샷 이름이 모델 표기로 시작 → 모델 표기가 스냅샷 이름을
    // 포함(2자 이상만 — "금"이 "기준금리"에 걸리는 사고 방지)
    const key = name
      .split("|")
      .pop()!
      .replace(/\s*\(.*?\)\s*$/, "")
      .trim();
    if (!key) continue;
    const matched =
      names.find((n) => n === key) ??
      names.find((n) => n.startsWith(key)) ??
      names.find((n) => n.length >= 2 && key.includes(n));
    if (matched && !comments.has(matched)) comments.set(matched, comment);
  }
  const table = snapshotToMarkdownTable(snapshot, comments);
  return [...lines.slice(0, start), lines[start], table, "", ...lines.slice(end)].join("\n");
}

function forceTitle(body: string, weekStart: string, weekEnd: string): string {
  const title = `# 주간 거시·시황 요약 (${weekStart} ~ ${weekEnd})`;
  const lines = body.split("\n");
  const i = lines.findIndex((l) => /^#\s/.test(l));
  if (i < 0) return `${title}\n\n${body}`;
  lines[i] = title;
  return lines.join("\n");
}

function splitCandidates(text: string): { body: string; candidates: string } {
  const idx = text.indexOf(CANDIDATES_DELIMITER);
  if (idx < 0) return { body: text.trim(), candidates: "" };
  return {
    body: text.slice(0, idx).trim(),
    candidates: text.slice(idx + CANDIDATES_DELIMITER.length).trim(),
  };
}

/** Gemini API 오류를 라우트가 그대로 노출할 수 있는 502 로 변환 */
async function callGemini(opts: Parameters<typeof geminiGenerate>[0]) {
  try {
    return await geminiGenerate(opts);
  } catch (e) {
    if (e instanceof GeminiApiError) throw new WeeklyGenerateError(e.message, 502);
    throw e;
  }
}

/** LLM 호출 없이 입력(스냅샷·코퍼스)만 조립해 점검 — 비용 0 */
export async function previewWeeklyInputs(): Promise<{
  week: ReturnType<typeof resolveReportWeek>;
  snapshot: SnapshotRow[];
  corpus: { researchCount: number; newsCount: number; telegramCount: number; youtubeCount: number; chars: number };
  promptChars: number;
}> {
  const week = resolveReportWeek();
  const [rawSnapshot, corpus, prevSnapshot] = await Promise.all([
    buildSnapshot(week),
    buildCorpus(week),
    getPreviousSnapshot(week.weekStart),
  ]);
  const snapshot = fillFromPrevious(rawSnapshot, prevSnapshot);
  const promptChars = snapshotToText(snapshot, week).length + corpus.text.length + buildSystemPrompt().length;
  return {
    week,
    snapshot,
    corpus: {
      researchCount: corpus.researchCount,
      newsCount: corpus.newsCount,
      telegramCount: corpus.telegramCount,
      youtubeCount: corpus.youtubeCount,
      chars: corpus.text.length,
    },
    promptChars,
  };
}

/** LLM 재호출 없이 저장된 초안 원문(draftBody)에 후처리(표 재생성·제목)만 다시 적용 —
 * 후처리 코드를 고친 뒤 비용 0으로 재렌더링할 때. 오너가 수정한 body 는 건드리지
 * 않고, body 가 draftBody 와 같을 때(미수정)만 함께 갱신한다. */
export async function reprocessWeeklyReport(id: string): Promise<WeeklyReportDoc> {
  const doc = await getWeeklyReport(id);
  if (!doc) throw new WeeklyGenerateError(`${id} 리포트 없음`, 404);
  // 구버전 문서(rawBody 없음)는 draftBody 로 대체 — 그 경우 표 코멘트가 이미 렌더링
  // 결과라 완전한 재처리는 아님(재생성 권장)
  const source = doc.rawBody || doc.draftBody;
  const rendered = forceTitle(replaceSnapshotSection(source, doc.snapshot), doc.weekStart, doc.weekEnd);
  const untouched = doc.body === doc.draftBody;
  const next: WeeklyReportDoc = {
    ...doc,
    rawBody: source,
    draftBody: rendered,
    body: untouched ? rendered : doc.body,
    updatedAt: new Date().toISOString(),
  };
  await saveWeeklyReport(next);
  return next;
}

export async function generateWeeklyReport(opts: { force?: boolean } = {}): Promise<WeeklyReportDoc> {
  if (!isGeminiConfigured()) throw new WeeklyGenerateError("GEMINI_API_KEY 미설정", 503);

  const week = resolveReportWeek();
  const existing = await getWeeklyReport(week.weekStart);
  if (existing?.status === "published" && !opts.force) {
    throw new WeeklyGenerateError(`${week.weekStart} 주 리포트는 이미 발행됨 (force 필요)`, 409);
  }

  const usage = await getWeeklyMonthUsage();
  if (usage.totalCostUsd >= WEEKLY_MONTHLY_BUDGET_USD) {
    throw new WeeklyGenerateError(
      `이번 달 주간 리포트 예산(${WEEKLY_MONTHLY_BUDGET_USD}달러) 초과 — 누적 ${usage.totalCostUsd.toFixed(2)}달러`,
      429,
    );
  }

  const [rawSnapshot, corpus, prevSnapshot] = await Promise.all([
    buildSnapshot(week),
    buildCorpus(week),
    getPreviousSnapshot(week.weekStart),
  ]);
  const snapshot = fillFromPrevious(rawSnapshot, prevSnapshot);

  const user = [
    `오늘은 ${week.today}(KST)입니다. 대상 주간: ${week.weekStart} ~ ${week.weekEnd}.`,
    "",
    "## 주간 시세 스냅샷",
    snapshotToText(snapshot, week),
    "",
    corpus.text,
    "",
    "위 자료를 1차 근거로, 필요한 사실 확인·보강만 웹검색으로 하여 주간 리포트를 작성하세요.",
  ].join("\n");

  const first = await callGemini({
    system: buildSystemPrompt(),
    user,
    grounding: process.env.WEEKLY_GROUNDING !== "0",
  });
  let calls = 1;
  let costUsd = first.usage.costUsd;
  let inputTokens = first.usage.inputTokens;
  let outputTokens = first.usage.outputTokens;
  let thoughtTokens = first.usage.thoughtTokens;

  const split = splitCandidates(first.text);
  let rawBody = split.body;
  let body = forceTitle(replaceSnapshotSection(rawBody, snapshot), week.weekStart, week.weekEnd);
  const candidates = split.candidates;

  if (bodyCharCount(body) > BODY_CHAR_LIMIT) {
    const second = await callGemini({
      system: buildCompressPrompt(),
      user: body,
      grounding: false,
      temperature: 0.1,
    });
    calls += 1;
    costUsd += second.usage.costUsd;
    inputTokens += second.usage.inputTokens;
    outputTokens += second.usage.outputTokens;
    thoughtTokens += second.usage.thoughtTokens;
    rawBody = splitCandidates(second.text).body;
    body = forceTitle(replaceSnapshotSection(rawBody, snapshot), week.weekStart, week.weekEnd);
  }

  await incWeeklyUsage(costUsd, calls);

  const now = new Date().toISOString();
  const doc: WeeklyReportDoc = {
    _id: week.weekStart,
    weekStart: week.weekStart,
    weekEnd: week.weekEnd,
    status: "draft",
    title: `주간 거시·시황 요약 (${week.weekStart} ~ ${week.weekEnd})`,
    body,
    draftBody: body,
    rawBody,
    candidates,
    snapshot,
    sources: {
      researchCount: corpus.researchCount,
      newsCount: corpus.newsCount,
      telegramCount: corpus.telegramCount,
      youtubeCount: corpus.youtubeCount,
      groundingQueries: first.groundingQueries,
      groundingSources: first.groundingSources.slice(0, 40),
    },
    model: first.model,
    usage: { inputTokens, outputTokens, thoughtTokens, costUsd, calls },
    generatedAt: now,
    publishedAt: null,
    updatedAt: now,
  };
  await saveWeeklyReport(doc);
  return doc;
}
