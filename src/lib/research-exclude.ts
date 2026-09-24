/**
 * 리서치 공통 제외 규칙(오너 지시 2026-09-25 — "공통으로 캘린더나 주간,
 * 추천종목은 수집 대상에서 제외, 대체투자에서 원자재는 수집으로 적용").
 *
 * 수집기가 40개가 넘어 각자 키워드를 두지 않고, 모든 수집기가 거치는 수신
 * 라우트(`/api/cron/shinhan-research`, `/api/cron/macro-issues`)와 조회 함수
 * (이미 쌓인 문서용 안전망)에서 이 함수 하나로 거른다. 수집기 쪽 같은 규칙은
 * `scripts/lib/exclude-filters.mjs` 의 `isCommonExcludedContent()` — 두 파일의
 * 정규식을 함께 고칠 것.
 *
 * - 주간물: Weekly/Biweekly/위클리/주간/Week Ahead/"9월 4주(차)". "주간사"는
 *   IPO 용어라 제외 대상 아님. Daily 는 대상 아님(일간 시황 게시판을 의도적으로
 *   수집 중).
 * - 일정표: 캘린더/캘박/일정표.
 * - 추천종목: "추천종목"/"추천 종목"(퀀트 모델 추천 종목·대형주 추천종목 등).
 * - 대체투자: 원자재(Commodity) 얘기만 남기고 나머지(리츠 PF·사모대출 등)는 제외.
 *   종목 리포트(category "기업")에는 적용하지 않는다 — "JPM … 대체투자 확장과
 *   궤를 같이하는 딜"처럼 회사 사업 얘기에 단어만 나오는 경우(실측).
 */
const WEEKLY_RE = /weekly|위클리|주간(?!사)|week\s*ahead|\d+\s*월\s*\d+\s*주(?!년)/i;
const CALENDAR_RE = /캘린더|캘박|calendar|일정표/i;
const RECOMMEND_RE = /추천\s*종목/;
const ALT_INVEST_RE = /대체투자/;
const COMMODITY_RE = /원자재|commodit/i;

export function isCommonExcludedResearch(text: string | null | undefined, category?: string): boolean {
  const t = String(text ?? "");
  if (WEEKLY_RE.test(t) || CALENDAR_RE.test(t) || RECOMMEND_RE.test(t)) return true;
  if (category === "기업") return false;
  return ALT_INVEST_RE.test(t) && !COMMODITY_RE.test(t);
}
