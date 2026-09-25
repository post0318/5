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
// 붙여 쓴 시리즈명("The ESGVerse" — 메리츠, 2026-09-25 실측)도 잡도록 뒤쪽 \b 는 뺐다.
const ESG_RE = /\bESG/i;

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
// 리츠(오너 지시 2026-09-25 — "공통으로 리츠는 수집에서 제외한다") — ETF/ETP와
// 같은 성격으로 보고 카테고리 구분 없이 전부 제외.
const REIT_RE = /리츠|\bREITs?\b/i;

/** 원자재(Commodity) 얘기면 true — 대체투자 중 이것만 수집한다. */
export function isCommodityContent(text) {
  return COMMODITY_RE.test(String(text ?? ""));
}

/**
 * 주간물·일정표·추천종목·리츠·ETF/ETP·ESG·원자재 외 대체투자면 true — 수집기가
 * 건너뛴다. ETF/ETP·ESG 는 원래 `isEtfOrEtpContent`/`isEsgContent` 로 따로
 * 불러써야만 걸러졌는데, 신한·하나·NH·KB·한국투자 등 먼저 만든 수집기들은 이걸
 * 안 써서 뚫려 있었다(오너 지적 2026-09-25 — "etf etp 등은 공통에서
 * 수집제외하고 있지?"/"esg도 공용모듈에서 처리안되고 있어?") — 서버 안전망
 * (`src/lib/research-exclude.ts`)에도 같이 올려 전 소스에 한 번에 적용한다.
 */
export function isCommonExcludedContent(text, category) {
  const t = String(text ?? "");
  if (COMMON_WEEKLY_RE.test(t) || CALENDAR_RE.test(t) || RECOMMEND_RE.test(t) || REIT_RE.test(t)) return true;
  if (ETF_RE.test(t) || ESG_RE.test(t)) return true;
  // 대체투자 규칙은 종목 리포트에 적용하지 않는다(서버 규칙과 동일).
  if (category === "기업") return false;
  return ALT_INVEST_RE.test(t) && !COMMODITY_RE.test(t);
}

/**
 * 거시경제 이슈분석/환율분석 공용 FX 판정(오너 지적 2026-09-25 — "거시경제 fx
 * 수집기준은 공통에서 반영하고 있지?"). 확인 결과 공통이 아니라 수집기마다
 * 따로 FX_RE 를 두고 있었고, 심지어 삼성·iM·메리츠·IBK 는 경제/채권 게시판을
 * 항상 "이슈분석"으로만 보내 환율분석 분기 자체가 없었다(실측 — iM 경제분석의
 * "거침없는 원화 강세, 1,300원이 보인다"·"가속 페달을 밟은 달러-엔"이 전부
 * 이슈분석으로 샘). 이 함수 하나로 모든 수집기가 통일해서 쓴다.
 */
const FX_RE =
  /\bFX\b|환율|엔화|달러화|위안화|유로화|파운드화|원화\s*(?:강세|약세|절상|절하)|달러[-\s]?엔|달러\s*인덱스|\bDXY\b/i;

/** 환율(FX) 얘기면 true — 거시경제 이슈분석/환율분석 중 어느 topic으로 보낼지 판정. */
export function isFxContent(text) {
  return FX_RE.test(String(text ?? ""));
}
