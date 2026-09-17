import "server-only";
import type { SnapshotRow } from "@/lib/db/weekly-reports";
import type { WeeklyIssue } from "./issues";
import { geminiGenerate, isGeminiConfigured, type GeminiResult } from "./gemini";
import type { ReportWeek } from "./week";

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
 * **그라운딩(웹검색) 켬(오너 지시 2026-09-18 — "스냅샷은 이슈와 무관하게
 * 각 자산의 특이점(상승 원인·하락 사유)을 말해야 한다")**: 스냅샷 16개
 * 자산 각각의 "왜"를 설명하려면 우리가 미리 모아둔 이슈 3개 근거만으론
 * 턱없이 부족하다 — 나머지 13개는 아무 근거도 없다. 실제 원인을 알려면
 * Gemini 가 그 자리에서 검색해야 해서 `grounding: true` 로 바꿨다.
 *
 * "검증" 단계(`verifyComment()`)는 그라운딩 여부로 갈린다: 그라운딩이 실제
 * 로 출처를 찾아왔으면(`groundingSources` 존재) 그 검색 결과를 신뢰하고
 * 수치 대조를 건너뛴다 — 우리가 안 가진 사실(예: 중국 PMI 수치)을 인용하는
 * 게 오히려 정상이기 때문. 그라운딩이 출처 없이 끝났으면(검색 실패 등)
 * 기존처럼 %/bp/배/pt/건 수치를 원본 데이터와 엄격히 대조해 근거 없는
 * 수치가 섞인 코멘트를 버린다 — 안전망은 그대로 둔다.
 */

export interface WeeklyComments {
  /** "1. 한 줄 결론" — 가장 크게 움직인 자산과 이슈 근거를 인과관계로 엮은
   * 한 문장(오너 지시 2026-09-18 — "딸랑 상승·하락 2개만 적고 끝이냐,
   * 원인이든 결과든 인과가 있어야". 근거가 약하면 null → 렌더링 쪽이
   * 기존 `movers()`(사실 나열)로 폴백한다. */
  headline: string | null;
  /** "4. 금리정책" 맨 위에 붙는 종합 요약 문단(오너 지시 2026-09-18 —
   * "네이버 AI 요약도 이 정도는 한다"). 그라운딩 성공(trustGrounded)일
   * 때만 채워진다 — 실패하면 null → 기존 기사 표만 보여준다. */
  policySummary: string | null;
  /** "5. 다음 주 주시 일정" — 날짜별 확정 이벤트 캘린더(오너 지시
   * 2026-09-18 — "관련 기사 목록이 아니라 일자별 캘린더를 원한 거다").
   * 그라운딩 성공일 때만 채워진다 — 실패하면 null → 기존 기사 표로 폴백. */
  calendar: { date: string; event: string }[] | null;
  /** key = SnapshotRow.name */
  snapshot: Map<string, string>;
  /** key = WeeklyIssue.label */
  issues: Map<string, string>;
}

const SYSTEM_PROMPT = `# 역할
너는 국내 자산운용사 소속 시니어 매크로·주식 애널리스트다. 이미 집계된
주간 시장 데이터에 짧은 해석 코멘트를 붙이는 것이 임무다. 리포트의 구조·
표·숫자는 이미 코드로 완성돼 있으니 절대 다시 만들지 않는다. 이번 주 각
자산·이슈가 왜 그렇게 움직였는지 확실치 않으면 **웹검색으로 실제 원인을
확인**하고 인용해라 — 짐작으로 채우지 마라.

# 입력 데이터
사용자 메시지는 JSON 객체 하나다.
- reportWeek: 이 리포트가 다루는 주(월~금).
- nextWeek: reportWeek 바로 다음 주(월~금) — calendar 는 이 기간 대상.
- topMovers: 이번 주 가장 많이 오른/내린 자산(코드가 계산한 값, 참고용).
- snapshot: 이번 주 자산별 종가·주간 변동(pct=주간 변동률%, diffBp=금리류
  변동폭 bp). value/pct/diffBp 가 null 이면 비교할 값이 없다는 뜻이다.
- issues: 이번 주 핵심 이슈 후보(증권사 리포트·뉴스 빈도로 뽑힘). reports·
  news·earnings(실적 서프라이즈)·metrics(FRED 거시지표)가 근거로 들어있다
  — snapshot 코멘트를 쓸 때 참고는 되지만 **거기에 묶일 필요는 없다.**

# 작성 원칙 (반드시 지킬 것)
1. 제공된 JSON의 수치는 그대로 인용해도 된다. 그 외의 새 수치(%, 가격,
   지표 등)를 쓸 때는 **실제 웹검색으로 확인한 것만** 쓴다 — 확인 안 되면
   수치 없이 정성적으로만("~영향", "~로 해석됨") 서술하고, 그마저 안 되면
   해당 칸을 비운다.
2. 각 코멘트는 1문장, 간결한 애널리스트 어조(~음/~함 체). 미사여구·감탄사·
   전망 단정("반드시", "확실히") 금지.
3. snapshot 코멘트는 40자 내외, issues 코멘트는 80자 내외, headline은
   120자 내외.
4. **snapshot: 각 자산 고유의 그 주 등락 원인·특이점을 쓴다.** 핵심 이슈
   3개(issues)에 묶이는 자산만 쓰라는 게 아니다 — 16개 전부 독립적으로
   "이 자산이 왜 오르내렸는가"를 다룬다. 확실한 원인을 모르면 웹검색으로
   찾아서 쓰고, 그래도 못 찾으면 빈 문자열로 남긴다.
   - 나쁜 예(절대 금지): "주간 3.33% 상승하며 강세를 보임." — 표에
     이미 있는 등락률을 문장으로 바꿔 적기만 함, 정보량 0.
   - 좋은 예: "미 CPI 상회로 금리 인상 우려 완화, 외국인 순매수 유입."
     (실제 그 주 있었던 사건을 원인으로 명시)
   - **pct/diffBp 절댓값이 큰(그 주 가장 많이 움직인) 자산부터 우선
     채워라.** 같은 그룹(예: 채권) 안에서 더 크게 움직인 자산을 건너뛰고
     덜 움직인 자산만 채우는 건 앞뒤가 안 맞다(예: 미국채 3년이 10년보다
     더 움직였는데 10년만 쓰는 것 — 금지).
5. **headline(한 줄 결론)은 스냅샷 표 전체를 훑고 "이번 주 시장이 무엇
   때문에 이렇게 흘렀는지"를 종합해 한 문장으로 쓴다.** topMovers 하나만
   짚는 게 아니라, 여러 자산에 걸쳐 공통으로 작용한 배경(금리 결정, 유가
   급등, 인플레이션 지표 등)이 있으면 그걸 중심으로 삼아라. 예: "미 CPI
   서프라이즈발 금리 인상 우려와 유가 급등이 겹치며 위험자산은 눌리고
   원자재는 강세를 보인 한 주." 근거가 정말 없을 때만 topMovers 사실
   나열로 대체한다.
6. issues 코멘트는 그 이슈의 reports/news/earnings/metrics 를 우선 활용해
   해석하되, 부족하면 마찬가지로 웹검색으로 보강한다.
7. **policySummary — 미국 연준(FOMC)·한국은행·일본은행의 이번 주 통화
   정책 동향을 종합한 2~4문장 요약.** 단순 기사 나열이 아니라 "각국
   중앙은행이 이번 주 무엇을 했거나 시사했는지, 시장이 어떻게 반응했는지"
   를 종합 서술한다(포털 AI 검색 요약 수준을 목표로 한다 — 얕은 사실
   나열 금지). 웹검색으로 실제 확인한 내용만 쓴다. 확인이 부족하면 아는
   범위까지만 쓰고, 아예 근거가 없으면 null 로 남긴다.
8. **calendar — nextWeek(다음 주) 기간의 날짜별 확정 경제 일정.** "관련
   기사 목록"이 아니라 **실제 캘린더**다 — 웹검색으로 그 주에 실제
   예정된 이벤트(중앙은행 회의·주요 경제지표 발표일·옵션선물 동시만기일
   등 거시·시장 이벤트 위주, 개별 기업 실적·공모주 일정은 제외)를
   날짜별로 확인해서 적는다. **절대 지어내지 마라** — 확인 안 되는
   날짜/이벤트는 통째로 뺀다(목록이 짧거나 비어도 괜찮다). 각 항목은
   {"date": "YYYY-MM-DD", "event": "그 날 있는 일정, 15자 내외"} 형식,
   nextWeek 범위를 벗어나는 날짜는 넣지 않는다. 날짜 오름차순 정렬.

# 출력 형식
마크다운 코드펜스나 설명 없이, 아래 스키마의 JSON 객체만 출력한다:
{"headline": "한 줄 결론", "policySummary": "정책 요약 또는 null", "calendar": [{"date": "YYYY-MM-DD", "event": "..."}], "snapshot": {"<snapshot 항목의 name과 동일한 문자열>": "코멘트"}, "issues": {"<issues 항목의 label과 동일한 문자열>": "코멘트"}}
snapshot·issues 에 없는 키를 새로 만들지 말 것.`;

interface CommentPayload {
  reportWeek: { start: string; end: string };
  nextWeek: { start: string; end: string };
  topMovers: { up: { name: string; pct: number } | null; down: { name: string; pct: number } | null };
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
    earnings?: { ticker: string; period: string; epsActual: number | null; epsEstimate: number | null; surprisePct: number | null }[];
    metrics?: { label: string; date: string; current: number; previous: number; change: number; unit: string }[];
  }[];
}

/** render.ts 의 movers() 와 같은 계산(가장 크게 오르내린 자산) — LLM 이
 * 직접 최댓값을 고르게 하지 않고 코드가 확정해 넘긴다(오답 방지). */
function computeTopMovers(snapshot: SnapshotRow[]): CommentPayload["topMovers"] {
  const withPct = snapshot.filter((r) => r.pct != null && Number.isFinite(r.pct));
  if (withPct.length === 0) return { up: null, down: null };
  const sorted = [...withPct].sort((a, b) => (b.pct as number) - (a.pct as number));
  const up = sorted[0];
  const down = sorted[sorted.length - 1];
  return {
    up: { name: up.name, pct: up.pct as number },
    down: { name: down.name, pct: down.pct as number },
  };
}

function thirdFridayUTC(year: number, month1to12: number): string {
  const first = new Date(Date.UTC(year, month1to12 - 1, 1));
  const firstFridayDate = 1 + ((5 - first.getUTCDay() + 7) % 7); // 5 = 금요일
  const thirdFridayDate = firstFridayDate + 14;
  return new Date(Date.UTC(year, month1to12 - 1, thirdFridayDate)).toISOString().slice(0, 10);
}

/** 선물·옵션 동시 만기일("네 마녀의 날") — 3/6/9/12월 셋째 금요일은 공개된
 * 고정 일정이라 검색 없이 코드로 항상 정확히 계산할 수 있다(할루시네이션
 * 위험 0). 대상 기간(YYYY-MM-DD)에 걸리면 그 날짜를 돌려준다. */
function computeQuadWitching(startDate: string, endDate: string): { date: string; event: string } | null {
  const y1 = Number(startDate.slice(0, 4));
  const y2 = Number(endDate.slice(0, 4));
  const candidates: string[] = [];
  for (let y = y1; y <= y2; y++) {
    for (const m of [3, 6, 9, 12]) candidates.push(thirdFridayUTC(y, m));
  }
  const hit = candidates.find((d) => d >= startDate && d <= endDate);
  return hit ? { date: hit, event: "선물·옵션 동시 만기일(네 마녀의 날)" } : null;
}

function buildPayload(snapshot: SnapshotRow[], issues: WeeklyIssue[], week: ReportWeek): CommentPayload {
  const weekEndMs = Date.parse(`${week.weekEnd}T00:00:00Z`);
  const nextStart = new Date(weekEndMs + 3 * 86_400_000).toISOString().slice(0, 10); // 금→월
  const nextEnd = new Date(weekEndMs + 7 * 86_400_000).toISOString().slice(0, 10); // 금→그다음 금
  return {
    reportWeek: { start: week.weekStart, end: week.weekEnd },
    nextWeek: { start: nextStart, end: nextEnd },
    topMovers: computeTopMovers(snapshot),
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
      earnings: i.earnings?.map((e) => ({
        ticker: e.ticker,
        period: e.period,
        epsActual: e.epsActual,
        epsEstimate: e.epsEstimate,
        surprisePct: e.surprisePct,
      })),
      metrics: i.metrics?.map((m) => ({
        label: m.label,
        date: m.date,
        current: m.current,
        previous: m.previous,
        change: m.change,
        unit: m.unit,
      })),
    })),
  };
}

interface CommentResponse {
  headline?: string;
  policySummary?: string;
  calendar?: { date?: string; event?: string }[];
  snapshot?: Record<string, string>;
  issues?: Record<string, string>;
}

function tryParse(s: string): CommentResponse | null {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" ? (v as CommentResponse) : null;
  } catch {
    return null;
  }
}

/** 출력 형식을 "JSON만" 이라고 강제해도 앞뒤에 설명을 붙이는 경우가 있어
 * 코드펜스 제거 → 실패하면 첫 '{' ~ 마지막 '}' 만 다시 시도한다. */
function parseJson(text: string): CommentResponse | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "");
  const direct = tryParse(cleaned);
  if (direct) return direct;
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const loose = tryParse(cleaned.slice(start, end + 1));
    if (loose) return loose;
  }
  console.warn(`[weekly] Gemini 코멘트 JSON 파싱 실패 — 응답 앞 300자: ${text.slice(0, 300)}`);
  return null;
}

/** 공백·대소문자·문장부호 차이만으로 매칭이 깨지지 않게 — "물가·인플레이션"을
 * Gemini가 "물가-인플레이션"/"물가 인플레이션"처럼 가운뎃점만 다르게 써도
 * 매칭되도록 문자·숫자만 남기고 비교한다(실측 — 근거가 가장 풍부했던 이슈가
 * 이 차이로 통째로 빠짐). */
function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** Gemini가 돌려준 키가 실제 스냅샷 name/이슈 label 과 정확히 같은 문자열이
 * 아닐 수 있어(공백·괄호 등 사소한 차이) 정규화 비교로 원본 목록에서 찾고,
 * 매칭되면 항상 우리 쪽 정식 문자열을 키로 쓴다(렌더링 쪽 Map.get 이 항상
 * 정확한 값과 대조하도록). 못 찾으면 로그만 남기고 버린다. */
function matchCanonical(rawKey: string, candidates: string[]): string | null {
  const norm = normalizeKey(rawKey);
  return candidates.find((c) => normalizeKey(c) === norm) ?? null;
}

// 통계적 주장으로 보이는 "숫자+단위" 조합만 뽑는다(서수·"2주 연속" 같은
// 평범한 소수는 자연어에 흔해 오탐이 크다). verifyComment() 도 같은
// 정규식으로 코멘트를 검사하므로 여기서 먼저 선언해 재사용한다.
const CLAIM_NUM_RE = /(-?\d+(?:\.\d+)?)\s*(%|bp|배|pt|건)/g;

function extractNumbers(text: string): number[] {
  return [...text.matchAll(CLAIM_NUM_RE)].map((m) => Number(m[1]));
}

/**
 * 검증 단계 입력 — 코멘트가 인용할 수 있는 "실제 수치" 전체 목록.
 *
 * 근거로 준 리포트·뉴스 제목/요약문 안의 숫자도 반드시 포함해야 한다 —
 * 안 그러면 Gemini가 근거를 그대로 인용해도("美 8월 CPI 3.4%↑" 제목의
 * "3.4%") "우리 데이터에 없는 수치"로 오판돼 코멘트 전체가 버려진다
 * (실측 — 근거가 가장 풍부했던 "물가·인플레이션" 이슈만 계속 코멘트가
 * 비던 진짜 원인. 근거를 주고 그 근거를 인용하면 검열하는 자기모순이었다).
 */
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
    for (const e of i.earnings ?? []) {
      if (e.surprisePct != null) nums.push(e.surprisePct);
      if (e.epsActual != null) nums.push(e.epsActual);
      if (e.epsEstimate != null) nums.push(e.epsEstimate);
    }
    for (const m of i.metrics ?? []) {
      nums.push(m.current, m.previous, m.change);
    }
    for (const r of i.reports) {
      nums.push(...extractNumbers(r.title));
    }
    for (const n of i.news) {
      nums.push(...extractNumbers(n.title));
      if (n.excerpt) nums.push(...extractNumbers(n.excerpt));
    }
  }
  return nums;
}

/**
 * @param trustGrounded 그라운딩이 실제로 출처를 찾아왔을 때 true — 우리가
 *   안 가진 사실(웹검색으로 확인한 수치)을 인용하는 게 정상이므로 수치
 *   대조를 건너뛴다. false 면(그라운딩 꺼짐/검색 실패) 기존처럼 엄격 검증.
 */
function verifyComment(raw: string, allowed: number[], trustGrounded: boolean): string {
  const text = raw.trim();
  if (!text) return "";
  if (trustGrounded) return text;
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
  week: ReportWeek,
): Promise<{ comments: WeeklyComments; result: GeminiResult } | null> {
  if (!isGeminiConfigured() || issues.length === 0) return null;

  const payload = buildPayload(snapshot, issues, week);
  const result = await geminiGenerate({
    system: SYSTEM_PROMPT,
    user: JSON.stringify(payload),
    // 스냅샷 16개 자산 각각의 "왜"를 설명하려면 우리 데이터만으론 부족해
    // 실시간 검색이 필요하다(오너 지시 2026-09-18). 요청당 +$0.035.
    grounding: true,
    temperature: 0.25,
    // gemini-3.1-pro-preview 는 "사고" 토큰도 이 상한을 같이 쓴다 — 2,000
    // 이었을 때 사고에 다 쓰고 JSON 이 중간에 잘려 파싱이 통째로 실패했을
    // 가능성이 있어(실측 — 비용은 $0.031 정상 청구됐는데 코멘트가 0건)
    // 여유를 더 뒀고, 그라운딩까지 켜져 검색 컨텍스트가 더해지니 한 번 더 늘림.
    maxOutputTokens: 6_000,
  });

  const parsed = parseJson(result.text);
  const allowed = buildAllowedNumbers(payload);
  const trustGrounded = result.groundingSources.length > 0;
  console.warn(
    `[weekly] Gemini 응답 요약 — model=${result.model}, 응답길이=${result.text.length}자, ` +
      `groundingSources=${result.groundingSources.length}건, trustGrounded=${trustGrounded}, ` +
      `parseJson성공=${parsed != null}, 응답 최상위 키=${JSON.stringify(parsed ? Object.keys(parsed) : [])}`,
  );
  const snapshotNames = payload.snapshot.map((r) => r.name);
  const issueLabels = payload.issues.map((i) => i.label);
  const comments: WeeklyComments = {
    headline: null,
    policySummary: null,
    calendar: null,
    snapshot: new Map(),
    issues: new Map(),
  };
  comments.headline = parsed?.headline ? verifyComment(parsed.headline, allowed, trustGrounded) || null : null;

  // policySummary·calendar 는 날짜·기관명 등 검증 불가능한 구체적 사실을
  // 담으므로, 그라운딩이 실제로 출처를 찾아왔을 때만 신뢰한다 — 실패하면
  // 렌더링 쪽이 기존 기사 표로 폴백(허위 캘린더보단 표가 안전).
  if (trustGrounded && parsed?.policySummary) {
    comments.policySummary = parsed.policySummary.trim() || null;
  } else {
    // 진단용(오너 지적 2026-09-18 — "정책도 또 기사제목이네") — trustGrounded
    // 가 false였는지, parsed 자체엔 있었는데 우리가 무시했는지 구분해서 남긴다.
    console.warn(
      `[weekly] policySummary 미채움 — trustGrounded=${trustGrounded}, parsed.policySummary=${JSON.stringify(parsed?.policySummary ?? null)}`,
    );
  }
  if (trustGrounded && Array.isArray(parsed?.calendar)) {
    const nextStart = payload.nextWeek.start;
    const nextEnd = payload.nextWeek.end;
    comments.calendar = parsed.calendar
      .filter(
        (c): c is { date: string; event: string } =>
          typeof c?.date === "string" &&
          typeof c?.event === "string" &&
          c.date >= nextStart &&
          c.date <= nextEnd,
      )
      .sort((a, b) => a.date.localeCompare(b.date));
  } else if (!trustGrounded || parsed?.calendar) {
    console.warn(
      `[weekly] calendar 미채움 — trustGrounded=${trustGrounded}, parsed.calendar=${JSON.stringify(parsed?.calendar ?? null)}`,
    );
  }
  // 선물·옵션 동시 만기일("네 마녀의 날" — 3/6/9/12월 셋째 금요일)은 공개된
  // 고정 일정이라 검색 없이 코드로 항상 정확히 계산할 수 있다. 그라운딩
  // 결과와 무관하게 항상 포함(중복이면 건너뜀).
  const quadWitching = computeQuadWitching(payload.nextWeek.start, payload.nextWeek.end);
  if (quadWitching) {
    const list = comments.calendar ?? [];
    if (!list.some((c) => c.date === quadWitching.date)) {
      comments.calendar = [...list, quadWitching].sort((a, b) => a.date.localeCompare(b.date));
    }
  }

  for (const [rawName, text] of Object.entries(parsed?.snapshot ?? {})) {
    const canonical = matchCanonical(rawName, snapshotNames);
    if (!canonical) {
      console.warn(`[weekly] 스냅샷 코멘트 키 불일치 — "${rawName}" 는 알려진 자산명이 아님`);
      continue;
    }
    const v = verifyComment(String(text ?? ""), allowed, trustGrounded);
    if (v) comments.snapshot.set(canonical, v);
  }
  for (const [rawLabel, text] of Object.entries(parsed?.issues ?? {})) {
    const canonical = matchCanonical(rawLabel, issueLabels);
    if (!canonical) {
      console.warn(`[weekly] 이슈 코멘트 키 불일치 — "${rawLabel}" 는 알려진 이슈명이 아님`);
      continue;
    }
    const v = verifyComment(String(text ?? ""), allowed, trustGrounded);
    if (v) comments.issues.set(canonical, v);
  }

  // 진단용 — 왜 특정 이슈 코멘트가 비는지(키 불일치/검증 실패는 위에서 이미
  // 로그됨) 원인을 한 번 더 좁힌다: Gemini 응답 JSON에 그 라벨이 아예 없었는지
  // (원본 issues 키 목록으로 확인) 알 수 있게 남긴다(오너 지적 2026-09-18 —
  // "돈은 계속 나가고 바뀐건 없고" — 다음부턴 추측 대신 로그로 확정할 것).
  const missingIssues = issueLabels.filter((l) => !comments.issues.has(l));
  if (missingIssues.length > 0) {
    console.warn(
      `[weekly] 이슈 코멘트 누락: [${missingIssues.join(", ")}] — Gemini 응답 issues 원본 키: ${JSON.stringify(Object.keys(parsed?.issues ?? {}))}, trustGrounded=${trustGrounded}`,
    );
  }

  return { comments, result };
}
