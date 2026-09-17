import "server-only";
import type { SnapshotRow } from "@/lib/db/weekly-reports";
import type { WeeklyIssue } from "./issues";
import { geminiGenerate, isGeminiConfigured, type GeminiResult } from "./gemini";

/**
 * 주간 리포트 해석 코멘트 — Gemini(수집→**해석**→검증의 가운데 단계).
 *
 * "수집"(스냅샷 수치·이슈별 증권사 리포트/뉴스 근거)은 전부 `snapshot.ts`·
 * `issues.ts`가 코드로 이미 끝낸다. 이 모듈은 그 결과만 JSON으로 넘겨받아
 * **짧은 해석 문장만** 만든다 — 리포트 구조·숫자·표는 절대 다시 만들지 않는다
 * (오너 지시 2026-09 "llm을 부활한다. 하지만 llm 퀄리티는 낮다고 느껴지기에
 * 더 잘해야한다" — 예전 `prompt.ts`는 LLM이 리포트 전체를 쓰게 시켜 수치
 * 왜곡 위험이 컸다. 이번엔 입력 범위를 코멘트로만 좁혀 위험을 줄였다).
 *
 * "검증" 단계는 `verifyComment()` — 응답에 %/bp/배/pt/건 단위가 붙은 수치가
 * 나오면 원본 수집 데이터에 실제로 있는 값인지 대조하고, 근거 없는 수치가
 * 하나라도 섞이면 그 코멘트 전체를 버린다(빈 문자열로 대체) — 절반만
 * 맞는 문장을 그대로 노출하지 않는다.
 */

export interface WeeklyComments {
  /** key = SnapshotRow.name */
  snapshot: Map<string, string>;
  /** key = WeeklyIssue.label */
  issues: Map<string, string>;
}

const SYSTEM_PROMPT = `# 역할
너는 국내 자산운용사 소속 시니어 매크로·주식 애널리스트다. 이미 집계된
주간 시장 데이터에 짧은 해석 코멘트를 붙이는 것이 임무다. 리포트의 구조·
표·숫자는 이미 코드로 완성돼 있으니 절대 다시 만들지 않는다.

# 입력 데이터
사용자 메시지는 JSON 객체 하나다.
- snapshot: 이번 주 자산별 종가·주간 변동(pct=주간 변동률%, diffBp=금리류
  변동폭 bp). value/pct/diffBp 가 null 이면 비교할 값이 없다는 뜻이다.
- issues: 이번 주 핵심 이슈 후보. reports(증권사 리포트 제목)·news(뉴스
  제목, 일부는 excerpt=기사 요약문도 있음)가 근거로 들어있다. excerpt가
  있으면 제목보다 구체적인 근거이니 우선 참고한다.

# 작성 원칙 (반드시 지킬 것)
1. **제공된 JSON에 있는 수치만 인용한다.** 새 수치·통계·퍼센트·bp를 추측해서
   만들지 않는다. 확신이 없으면 수치 언급 자체를 뺀다.
2. 인과관계는 근거(reports/news 제목)에 실제로 드러난 경우에만 "~영향",
   "~로 해석됨" 처럼 조심스럽게 쓴다. 근거가 없으면 사실 나열에 그친다.
3. 각 코멘트는 1문장, 간결한 애널리스트 어조(~음/~함 체). 미사여구·감탄사·
   전망 단정("반드시", "확실히") 금지.
4. snapshot 코멘트는 40자 내외, issues 코멘트는 80자 내외.
5. 근거가 부족한 항목은 빈 문자열("")로 남긴다. 억지로 채우지 않는다.

# 출력 형식
마크다운 코드펜스나 설명 없이, 아래 스키마의 JSON 객체만 출력한다:
{"snapshot": {"<snapshot 항목의 name과 동일한 문자열>": "코멘트"}, "issues": {"<issues 항목의 label과 동일한 문자열>": "코멘트"}}
snapshot·issues 에 없는 키를 새로 만들지 말 것.`;

interface CommentPayload {
  snapshot: {
    name: string;
    group: string;
    value: number | null;
    unit: string;
    pct: number | null;
    diffBp: number | null;
    asOf: string | null;
  }[];
  issues: {
    label: string;
    researchCount: number;
    newsCount: number;
    searchInterest: number | null;
    reports: { date: string; source: string; stockName: string; title: string }[];
    news: { title: string; excerpt?: string; source: string; publishedAt: string }[];
  }[];
}

function buildPayload(snapshot: SnapshotRow[], issues: WeeklyIssue[]): CommentPayload {
  return {
    snapshot: snapshot
      .filter((r) => r.value != null)
      .map((r) => ({
        name: r.name,
        group: r.group,
        value: r.value,
        unit: r.unit,
        pct: r.pct,
        diffBp: r.diff != null && r.unit.startsWith("%") ? Math.round(r.diff * 100) : null,
        asOf: r.asOf,
      })),
    issues: issues.map((i) => ({
      label: i.label,
      researchCount: i.researchCount,
      newsCount: i.newsCount,
      searchInterest: i.searchInterest,
      reports: i.reports.map((r) => ({ date: r.date, source: r.source, stockName: r.stockName, title: r.title })),
      news: i.news.map((n) => ({
        title: n.title,
        excerpt: n.excerpt,
        source: n.source,
        publishedAt: n.publishedAt,
      })),
    })),
  };
}

interface CommentResponse {
  snapshot?: Record<string, string>;
  issues?: Record<string, string>;
}

function parseJson(text: string): CommentResponse | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "");
  try {
    const v = JSON.parse(cleaned) as unknown;
    if (v && typeof v === "object") return v as CommentResponse;
    return null;
  } catch {
    return null;
  }
}

/** 검증 단계 입력 — 코멘트가 인용할 수 있는 "실제 수치" 전체 목록. */
function buildAllowedNumbers(payload: CommentPayload): number[] {
  const nums: number[] = [];
  for (const r of payload.snapshot) {
    if (r.pct != null) nums.push(r.pct);
    if (r.diffBp != null) nums.push(r.diffBp);
    if (r.value != null) nums.push(r.value);
  }
  for (const i of payload.issues) {
    nums.push(i.researchCount, i.newsCount);
    if (i.searchInterest != null) nums.push(i.searchInterest);
  }
  return nums;
}

// 통계적 주장으로 보이는 "숫자+단위" 조합만 검증 대상으로 삼는다(서수·
// "2주 연속" 같은 평범한 소수는 자연어에 흔해 오탐이 크다 — 실제 위험은
// 근거 없는 %/bp/배/건 수치를 지어내는 쪽이다).
const CLAIM_NUM_RE = /(-?\d+(?:\.\d+)?)\s*(%|bp|배|pt|건)/g;

function verifyComment(raw: string, allowed: number[]): string {
  const text = raw.trim();
  if (!text) return "";
  for (const m of text.matchAll(CLAIM_NUM_RE)) {
    const n = Number(m[1]);
    const unit = m[2];
    const tol = unit === "bp" ? 1 : unit === "건" ? 0.5 : 0.15;
    const ok = allowed.some((a) => Math.abs(a - n) <= tol);
    if (!ok) {
      console.warn(`[weekly] 코멘트 검증 실패 — 근거 없는 수치 "${m[0]}" 포함, 폐기: ${text}`);
      return "";
    }
  }
  return text;
}

/**
 * Gemini 로 스냅샷·이슈 코멘트를 생성한다. 설정이 없거나 이슈가 비면 null —
 * 호출부는 rule-based(빈 코멘트)로 조용히 폴백한다(이 프로젝트의 기존
 * "실패 시 해당 부분만 생략" 패턴과 동일).
 */
export async function generateWeeklyComments(
  snapshot: SnapshotRow[],
  issues: WeeklyIssue[],
): Promise<{ comments: WeeklyComments; result: GeminiResult } | null> {
  if (!isGeminiConfigured() || issues.length === 0) return null;

  const payload = buildPayload(snapshot, issues);
  const result = await geminiGenerate({
    system: SYSTEM_PROMPT,
    user: JSON.stringify(payload),
    grounding: false, // 코멘트는 수집된 자체 데이터만 근거로 삼는다 — 웹검색 그라운딩은 비용만 늘고 대조 불가능한 외부 주장이 섞일 위험이 있어 끔.
    temperature: 0.25,
    maxOutputTokens: 2_000,
  });

  const parsed = parseJson(result.text);
  const allowed = buildAllowedNumbers(payload);
  const comments: WeeklyComments = { snapshot: new Map(), issues: new Map() };

  for (const [name, text] of Object.entries(parsed?.snapshot ?? {})) {
    const v = verifyComment(String(text ?? ""), allowed);
    if (v) comments.snapshot.set(name, v);
  }
  for (const [label, text] of Object.entries(parsed?.issues ?? {})) {
    const v = verifyComment(String(text ?? ""), allowed);
    if (v) comments.issues.set(label, v);
  }

  return { comments, result };
}
