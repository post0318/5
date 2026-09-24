/**
 * 여러 리서치 수집기가 공유하는 제외 필터.
 *
 * ETF/ETP 리포트 제외(오너 지시 2026-09-24 — "ETF, ETP 등은 수집대상에서
 * 제외한다. 여기뿐만 아니라 모두 동일하다"): 이 프로젝트의 산업분석/투자
 * 전략 수집은 개별 종목·업종 얘기를 다루는 게 목적인데, ETF/ETP 리포트는
 * 종목이 아니라 상품(펀드 자금 흐름·구성 등) 얘기라 범위 밖이다. 모든
 * 수집기(국내·해외 불문)가 이 필터를 거친다 — 소스마다 각자 키워드를
 * 두지 않고 한 곳에서 관리해야 나중에 예외가 하나 발견됐을 때 전체에
 * 한 번에 반영된다.
 */
const ETF_RE = /\bETFs?\b|\bETPs?\b|상장지수(?:펀드|증권)?/i;

/** 제목(또는 라벨+제목)에 ETF/ETP 신호가 있으면 true — 수집기가 이 항목을 건너뛴다. */
export function isEtfOrEtpContent(text) {
  return ETF_RE.test(String(text ?? ""));
}

/**
 * 정기 Weekly 시리즈 제외(오너 지시 2026-09-24 — "큠틴 아메리카처럼 weekly
 * 자료는 수집 제외다"). 키움 CC 게시판의 "09/21 큠틴 아메리카 (미국주식
 * Weekly)"류가 발견 계기 — 매주 반복되는 요약물이라 한 종목·업종을 깊게
 * 다루는 게 아니라 이 프로젝트의 산업분석/투자전략 범위와 안 맞는다.
 * ETF 필터와 동일하게 소스 불문 공용으로 둔다. "Daily"는 대상이 아니다
 * (일간증시전망·일간환율전망처럼 의도적으로 수집 중인 일간 게시판이 있어
 * 범위를 넓히면 그것들까지 제외돼버림 — 오너가 콕 집은 것도 weekly뿐).
 */
const WEEKLY_RE = /\bWeekly\b|위클리/i;

/** 제목에 "Weekly"/"위클리" 신호가 있으면 true — 수집기가 이 항목을 건너뛴다. */
export function isWeeklyRecurringContent(text) {
  return WEEKLY_RE.test(String(text ?? ""));
}

/**
 * ESG 콘텐츠 제외(오너 지시 2026-09-24 — "esg는 공통으로 제외처리", KB
 * 게시판 정리 중 "Global ESG Brief" 발견 → NH "NH ESG Research" 발견을
 * 계기로 ETF/Weekly와 동일하게 소스 불문 공용 필터로 승격). 이 프로젝트의
 * 산업분석/투자전략 수집은 개별 종목·업종 얘기가 목적인데 ESG 리포트는
 * 지배구조·지속가능성 등 그 범위 밖 주제다. `getIndustryResearch()`
 * 조회 시점에도 별도로 한 번 더 걸러진다(`shinhan-research.ts`의
 * `ESG_EXCLUDE_RE`) — 여기서는 애초에 DB에 쌓이지 않도록 수집 단계에서
 * 막는다.
 */
const ESG_RE = /\bESG\b/i;

/** 제목(또는 라벨+제목)에 ESG 신호가 있으면 true — 수집기가 이 항목을 건너뛴다. */
export function isEsgContent(text) {
  return ESG_RE.test(String(text ?? ""));
}

/**
 * 공통 제외(오너 지시 2026-09-25 — "공통으로 캘린더나 주간, 추천종목은 수집
 * 대상에서 제외, 대체투자에서 원자재는 수집으로 적용"). 서버 수신 라우트가
 * 같은 규칙(`src/lib/research-exclude.ts`)으로 한 번 더 거르므로 이 함수를 안
 * 쓰는 수집기도 결과는 같다 — 수집기에서 쓰면 PDF 보강 등 헛일을 줄인다.
 * 정규식은 두 파일에서 같이 고칠 것.
 */
const COMMON_WEEKLY_RE = /weekly|위클리|주간(?!사)|week\s*ahead|\d+\s*월\s*\d+\s*주(?!년)/i;
const CALENDAR_RE = /캘린더|캘박|calendar|일정표/i;
const RECOMMEND_RE = /추천\s*종목/;
const ALT_INVEST_RE = /대체투자/;
const COMMODITY_RE = /원자재|commodit/i;

/** 원자재(Commodity) 얘기면 true — 대체투자 중 이것만 수집한다. */
export function isCommodityContent(text) {
  return COMMODITY_RE.test(String(text ?? ""));
}

/** 주간물·일정표·추천종목·원자재 외 대체투자면 true — 수집기가 건너뛴다. */
export function isCommonExcludedContent(text, category) {
  const t = String(text ?? "");
  if (COMMON_WEEKLY_RE.test(t) || CALENDAR_RE.test(t) || RECOMMEND_RE.test(t)) return true;
  // 대체투자 규칙은 종목 리포트에 적용하지 않는다(서버 규칙과 동일).
  if (category === "기업") return false;
  return ALT_INVEST_RE.test(t) && !COMMODITY_RE.test(t);
}
