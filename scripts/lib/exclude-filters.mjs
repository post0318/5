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
// "거버넌스"는 ESG(지배구조)로 보고 제외(오너 지시 2026-09-27) — 종목 리포트(category "기업")에는 적용하지 않는다(서버 규칙과 동일).
const GOVERNANCE_RE = /거버넌스|\bgovernance\b/i;
// 부동산은 리츠와 함께 수집 제외(오너 지적 2026-09-27) — 서버 규칙과 동일하게 산업·거시 글(category "기업" 아님)에만 적용.
const REAL_ESTATE_RE = /부동산|맨션/;
// 미래에셋 "글로벌 마켓 브리핑" 일일 시리즈 수집 제외(오너 지시 2026-09-27) — 기업 리포트에는 적용하지 않는다.
const CREDIT_RE = /크레딧|신용|회사채|\bCredit\b/i; // 크레딧 계열 수집 제외(오너 지시 2026-09-27 — "크레딧은 아예 제외다"). 기업 리포트에는 적용하지 않는다.
const DAILY_BRIEFING_RE = /글로벌\s*마켓\s*브리핑|(?:^|\s)마켓\s*(?:뷰|클로징)(?=\s|\(|$)|Earnings\s*Revision|자산가격\s*[메매]커니즘\s*변화|신한\s*FX\s*Check-?up|마켓\s*레이더|Global\s*Portfolio/i; // 미래에셋 일일 시리즈(글로벌 마켓 브리핑·마켓 뷰·마켓 클로징)·Earnings Revision·신한 자산가격 메커니즘 변화·신한 FX Check-up·마켓레이더·Global Portfolio(추천 포트폴리오) 시리즈 수집 제외(오너 지시 2026-09-27)

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
// "다음주 시장은?"(대신증권 주간 시장 전망 시리즈, 오너 지적 2026-09-27 — "주간같은데")도 주간물이다.
const COMMON_WEEKLY_RE = /weekly|위클리|주간(?!사)|week\s*ahead|\d+\s*월\s*\d+\s*주(?!년)|다음\s*주\s*시장/i;
const UNLISTED_RE = /비상장/;
// 주간물이지만 수집하는 거시 시리즈(오너 지시 2026-09-27 — 삼성 "Macro Week Ahead"(채권)·"Weekly Economic Issue"(경제)).
const WEEKLY_KEEP_RE = /Macro\s*Week\s*Ahead|Weekly\s*Economic\s*Issue/i;
const CALENDAR_RE = /캘린더|캘박|calendar|일정표/i;
const RECOMMEND_RE = /추천\s*종목/;
const ALT_INVEST_RE = /대체투자/;
const COMMODITY_RE = /원자재|commodit/i;
// 리츠(오너 지시 2026-09-25 — "공통으로 리츠는 수집에서 제외한다") — ETF/ETP와
// 같은 성격으로 보고 카테고리 구분 없이 전부 제외.
// "메리츠"(증권사명)의 "리츠"에 걸리지 않게 앞글자가 "메"인 경우는 제외.
const REIT_RE = /(?<!메)리츠|\bREITs?\b/i;

/** 원자재(Commodity) 얘기면 true — 대체투자 중 이것만 수집한다. */
export function isCommodityContent(text) {
  return COMMODITY_RE.test(String(text ?? ""));
}

/**
 * 디지털자산(가상자산/암호화폐/스테이블코인) 제외(오너 지시 2026-09-26 —
 * "디지털자산은 공통으로 수집제외이나 개별종목은 포함이다. 개별함수는
 * 해외일 경우는 예외다"). 삼성(KR_DIGITAL_ASSET_RE)·한화(DIGITAL_ASSET_RE)·
 * 유안타(DIGITAL_ASSET_RE)가 각자 다른 정규식으로 흩어져 있던 걸(FX_RE와
 * 같은 패턴의 구멍) 하나로 통일 — 유안타의 가장 넓은 버전을 기준으로 한다.
 */
const DIGITAL_ASSET_RE =
  /디지털\s*자산|가상\s*자산|가상자산|암호화폐|스테이블\s*코인|\bstablecoin\b|\bstable\s*coin\b|\bBTC\b|\bcrypto\b|조각\s*투자|\bSTO\b/i;

/** 제목에 디지털자산 신호가 있으면 true. */
export function isDigitalAssetContent(text) {
  return DIGITAL_ASSET_RE.test(String(text ?? ""));
}

/**
 * 주간물·일정표·추천종목·리츠·ETF/ETP·ESG·원자재 외 대체투자·디지털자산이면
 * true — 수집기가 건너뛴다. ETF/ETP·ESG 는 원래 `isEtfOrEtpContent`/
 * `isEsgContent` 로 따로 불러써야만 걸러졌는데, 신한·하나·NH·KB·한국투자 등
 * 먼저 만든 수집기들은 이걸 안 써서 뚫려 있었다(오너 지적 2026-09-25 —
 * "etf etp 등은 공통에서 수집제외하고 있지?"/"esg도 공용모듈에서
 * 처리안되고 있어?") — 서버 안전망(`src/lib/research-exclude.ts`)에도
 * 같이 올려 전 소스에 한 번에 적용한다.
 *
 * `market` 인자(선택, 오너 지시 2026-09-26): 디지털자산 배제만 시장을 본다 —
 * 개별종목(category:"기업")은 원래도 이 규칙 대상이 아니고, **해외(kr이 아닌
 * market)는 명시적 예외**다(삼성이 "미국 스테이블코인은 유지"하던 것과 동일
 * 원칙). market을 안 넘기면(레거시 호출) 국내로 간주해 기존처럼 배제한다.
 */
// 퀀트 제외(오너 지시 2026-09-27 — "공통에 퀀트는 수집제외 추가한다", "BNK Factor Sentiment 지표 - 월간 팩터 로테이션 &
// 팩터별 투자유망 종목 수집제외"). 퀀트·팩터 모델 리포트는 개별 종목·업종 분석이 아니라 모델 산출물이라 ETF/ESG 와 같은 성격으로
// 카테고리 구분 없이 제외. 예외는 오너가 공통에 따로 요청한다("공통에 예외로 요청할 것이다") — 예외 패턴은 QUANT_EXCEPT_RE 에 추가
// (지금은 없음). BNK 제목은 "퀀트" 단어가 없어 Factor Sentiment·팩터 로테이션으로도 잡는다.
const QUANT_RE = /퀀트|퀀틴전시|\bquant\b|factor\s*sentiment|팩터\s*로테이션/i;
const QUANT_EXCEPT_RE = null; // 오너 요청 시 예외 패턴(RegExp) — 지정되면 QUANT_RE 에 걸려도 제외하지 않는다
const isQuant = (t) => QUANT_RE.test(t) && !(QUANT_EXCEPT_RE && QUANT_EXCEPT_RE.test(t));

/** 퀀트·팩터 모델 리포트면 true(예외 패턴 제외) — 수집기가 건너뛴다. */
export function isQuantContent(text) {
  return isQuant(String(text ?? ""));
}

export function isCommonExcludedContent(text, category, market) {
  const t = String(text ?? "");
  // 주간물 제외의 예외: 비상장 리서치("주간 비상장 투자 동향" 등)는 수집해 비상장으로 분류한다(오너 지시 2026-09-26).
  if ((COMMON_WEEKLY_RE.test(t) && !UNLISTED_RE.test(t) && !WEEKLY_KEEP_RE.test(t)) || CALENDAR_RE.test(t) || RECOMMEND_RE.test(t) || REIT_RE.test(t)) return true;
  if (ETF_RE.test(t) || ESG_RE.test(t) || isQuant(t)) return true;
  // 대체투자 규칙은 종목 리포트에 적용하지 않는다(서버 규칙과 동일).
  if (DAILY_BRIEFING_RE.test(t)) return true; // 시리즈 제외는 기업 카테고리에도 적용
  if (category === "기업") return false;
  if (GOVERNANCE_RE.test(t) || REAL_ESTATE_RE.test(t) || CREDIT_RE.test(t)) return true;
  if (ALT_INVEST_RE.test(t) && !COMMODITY_RE.test(t)) return true;
  if ((market === undefined || market === "kr") && DIGITAL_ASSET_RE.test(t)) return true;
  return false;
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
  const t = String(text ?? "");
  // 증권사가 제목에 "[경제분석]" 분류 태그를 명시한 글은 환율이 소재로 나와도 경제 이슈분석이다
  // (오너 지적 2026-09-26 — 한화 "[경제분석] 같은 환율, 다른 충격": "환율을 분석한 게 아니라 경제분석").
  // "[FX]" 태그는 그대로 환율분석.
  if (/^\s*\[경제분석\]/.test(t)) return false;
  return FX_RE.test(t);
}
