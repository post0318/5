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
  /** "1. 한 줄 결론" — 가장 크게 움직인 자산과 이슈 근거를 인과관계로 엮은
   * 한 문장(오너 지시 2026-09-18 — "딸랑 상승·하락 2개만 적고 끝이냐,
   * 원인이든 결과든 인과가 있어야". 근거가 약하면 null → 렌더링 쪽이
   * 기존 `movers()`(사실 나열)로 폴백한다. */
  headline: string | null;
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
- topMovers: 이번 주 가장 많이 오른/내린 자산(코드가 계산한 값, 그대로
  인용 가능).
- snapshot: 이번 주 자산별 종가·주간 변동(pct=주간 변동률%, diffBp=금리류
  변동폭 bp). value/pct/diffBp 가 null 이면 비교할 값이 없다는 뜻이다.
- issues: 이번 주 핵심 이슈 후보. reports(증권사 리포트 제목)·news(뉴스
  제목, 일부는 excerpt=기사 요약문도 있음)가 근거로 들어있다. excerpt가
  있으면 제목보다 구체적인 근거이니 우선 참고한다. 일부 이슈엔 earnings
  (빅테크 최근 실적 EPS 서프라이즈)·metrics(FRED 공식 거시지표, 전기 대비
  변화)도 있다 — 있으면 우선 인용할 만한 확정 수치다.

# 작성 원칙 (반드시 지킬 것)
1. **제공된 JSON에 있는 수치만 인용한다.** 새 수치·통계·퍼센트·bp를 추측해서
   만들지 않는다. 확신이 없으면 수치 언급 자체를 뺀다.
2. 인과관계는 근거(reports/news 제목)에 실제로 드러난 경우에만 "~영향",
   "~로 해석됨" 처럼 조심스럽게 쓴다. 근거가 없으면 사실 나열에 그친다.
3. 각 코멘트는 1문장, 간결한 애널리스트 어조(~음/~함 체). 미사여구·감탄사·
   전망 단정("반드시", "확실히") 금지.
4. snapshot 코멘트는 40자 내외, issues 코멘트는 80자 내외.
5. **snapshot 의 pct/diffBp 를 말로 그대로 옮기기만 하는 코멘트는 절대
   금지한다** — 그 숫자는 이미 표의 "주간 변동" 열에 그대로 보이므로
   다시 적으면 정보량이 0이다.
   - 나쁜 예(금지): "주간 3.33% 상승하며 강세를 보임." / "주간 0.88%
     상승 마감함." — 숫자를 문장으로 바꿔 적기만 함.
   - 이슈 3개에 직접 엮이는 자산만 쓰라는 뜻이 아니다. 아래 중 하나라도
     실제로 해당되면 코멘트를 써라(전부 issues 에 묶일 필요 없음):
     a) issues 중 하나의 근거(뉴스·리포트·실적·지표)와 직접 연결된다 —
        그 원인을 인용(예: "국제유가 급등 여파로 에너지 비용 부담 반영").
     b) snapshot 안의 다른 자산과 뚜렷하게 알려진 상관관계가 보인다
        (예: 미국채 금리 상승과 함께 달러·환율이 움직임, 증시 조정과
        VIX 상승이 같이 나타남) — 숫자 두 개를 실제로 엮어 설명한다.
     c) 그 등락의 배경으로 통상 통용되는 시장 메커니즘이 명백하다(예:
        안전자산 선호 확대·위험선호 회복) — 이때도 "~로 보임"처럼 조심
        스럽게 쓰고 단정하지 않는다.
   - 위 a~c 어디에도 해당 안 되고 정말 근거가 없을 때만 빈 문자열("")로
     남긴다 — 숫자 재진술로 자리만 채우지 말라는 것이지, "이슈에 안
     묶이면 무조건 빈칸"이 아니다.
6. **headline(한 줄 결론)이 이 리포트에서 가장 중요한 문장이다.** topMovers
   (가장 크게 움직인 자산)를 issues 의 근거(뉴스·리포트·실적·FRED 지표)와
   엮어 "무엇이(원인) → 무엇에 영향을 줬다(결과)"는 인과관계로 써라.
   예: "WTI가 [원인 근거]로 급등하며 에너지 관련 자산에 부담을 줬다"처럼.
   근거가 진짜로 연결되지 않으면 억지로 엮지 말고 topMovers 사실만 간결히
   서술한다(과잉 추론 금지). 100자 내외, 위 1·3 규칙(수치 원칙·어조)도
   동일하게 적용.

# 출력 형식
마크다운 코드펜스나 설명 없이, 아래 스키마의 JSON 객체만 출력한다:
{"headline": "한 줄 결론", "snapshot": {"<snapshot 항목의 name과 동일한 문자열>": "코멘트"}, "issues": {"<issues 항목의 label과 동일한 문자열>": "코멘트"}}
snapshot·issues 에 없는 키를 새로 만들지 말 것.`;

interface CommentPayload {
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

function buildPayload(snapshot: SnapshotRow[], issues: WeeklyIssue[]): CommentPayload {
  return {
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
    for (const e of i.earnings ?? []) {
      if (e.surprisePct != null) nums.push(e.surprisePct);
      if (e.epsActual != null) nums.push(e.epsActual);
      if (e.epsEstimate != null) nums.push(e.epsEstimate);
    }
    for (const m of i.metrics ?? []) {
      nums.push(m.current, m.previous, m.change);
    }
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
    // gemini-3.1-pro-preview 는 "사고" 토큰도 이 상한을 같이 쓴다 — 2,000
    // 이었을 때 사고에 다 쓰고 JSON 이 중간에 잘려 파싱이 통째로 실패했을
    // 가능성이 있어(실측 — 비용은 $0.031 정상 청구됐는데 코멘트가 0건)
    // 여유를 더 뒀다.
    maxOutputTokens: 4_000,
  });

  const parsed = parseJson(result.text);
  const allowed = buildAllowedNumbers(payload);
  const snapshotNames = payload.snapshot.map((r) => r.name);
  const issueLabels = payload.issues.map((i) => i.label);
  const comments: WeeklyComments = { headline: null, snapshot: new Map(), issues: new Map() };
  comments.headline = parsed?.headline ? verifyComment(parsed.headline, allowed) || null : null;

  for (const [rawName, text] of Object.entries(parsed?.snapshot ?? {})) {
    const canonical = matchCanonical(rawName, snapshotNames);
    if (!canonical) {
      console.warn(`[weekly] 스냅샷 코멘트 키 불일치 — "${rawName}" 는 알려진 자산명이 아님`);
      continue;
    }
    const v = verifyComment(String(text ?? ""), allowed);
    if (v) comments.snapshot.set(canonical, v);
  }
  for (const [rawLabel, text] of Object.entries(parsed?.issues ?? {})) {
    const canonical = matchCanonical(rawLabel, issueLabels);
    if (!canonical) {
      console.warn(`[weekly] 이슈 코멘트 키 불일치 — "${rawLabel}" 는 알려진 이슈명이 아님`);
      continue;
    }
    const v = verifyComment(String(text ?? ""), allowed);
    if (v) comments.issues.set(canonical, v);
  }

  return { comments, result };
}
