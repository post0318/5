/**
 * 리서치 공통 제외 규칙(오너 지시 2026-09-25 — "공통으로 캘린더나 주간,
 * 추천종목은 수집 대상에서 제외, 대체투자에서 원자재는 수집으로 적용").
 *
 * 수집기가 40개가 넘어 각자 키워드를 두지 않고, 모든 수집기가 거치는 수신
 * 라우트(`/api/cron/total-research`, `/api/cron/macro-issues`)와 조회 함수
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
 * - 리츠(오너 지시 2026-09-25 — "공통으로 리츠는 수집에서 제외한다"): ETF/ETP와
 *   같은 성격(상품/펀드 얘기, 개별 종목·업종 분석이 아님)으로 보고 카테고리 구분
 *   없이 전부 제외 — 개별 리츠 종목의 기업분석 리포트도 대상이다(ETF 필터와 동일한
 *   트레이드오프).
 * - ETF/ETP·ESG(오너 지적 2026-09-25 — "etf etp 등은 공통에서 수집제외하고
 *   있지?"/"esg도 공통모듈에서 처리안되고 있어?"): 둘 다 원래 CLAUDE.md 방침상
 *   "전 수집기 공통 제외 대상"이었지만 실제로는 리츠와 달리 이 서버단 안전망에
 *   없었다 — 각 수집기가 `scripts/lib/exclude-filters.mjs`의 `isEtfOrEtpContent`/
 *   `isEsgContent`를 개별로 불러써야만 걸러졌고, 신한·하나·NH·KB·한국투자·DS·
 *   BNK·상상인 등 먼저 만든 수집기들은 이 필터를 아예 안 써서 뚫려 있었다
 *   (CLAUDE.md에 "미결"로 남아있던 항목). 리츠와 같은 방식으로 여기 올려 전
 *   수집기·전 소스에 한 번에 적용한다.
 */
// "다음주 시장은?"(대신증권 주간 시장 전망 시리즈, 오너 지적 2026-09-27 — "주간같은데")도 주간물이다.
// "9월 넷째 주: …"(KB증권 자산배분/매크로, 오너 지적 2026-09-27 — "주간 아니냐? 주간이 왜 수집되지?")처럼
// 숫자 대신 서수(첫째/둘째/셋째/넷째/다섯째)로 쓴 주차 표기도 주간물이다.
const WEEKLY_RE = /weekly|위클리|주간(?!사)|week\s*ahead|\d+\s*월\s*(?:\d+|첫째|둘째|셋째|넷째|다섯째)\s*주(?!년)|다음\s*주\s*시장/i;
// 주간물 제외의 예외 — 비상장 리서치는 수집해 비상장으로 분류(오너 지시 2026-09-26).
const UNLISTED_RE = /비상장/;
// 주간물이지만 수집하는 거시 시리즈(오너 지시 2026-09-27 — 삼성 "Macro Week Ahead"(채권)·"Weekly Economic Issue"(경제)).
// BlackRock 인사이트 "글로벌 위클리 시황"(수집기가 붙이는 고정 라벨)도 예외(2026-10-09 — 주간물 공통 제외는 국내 증권사 위클리 시황 범람
// 때문이었고, 이건 해외 IB 인사이트 탭의 주 1회 대표 콘텐츠라 범람이 없다. 이 라벨 때문에 09-25 이후 매주 저장 단계에서 버려졌다).
const WEEKLY_KEEP_RE = /Macro\s*Week\s*Ahead|Weekly\s*Economic\s*Issue|글로벌\s*위클리\s*시황/i;
const CALENDAR_RE = /캘린더|캘박|calendar|일정표/i;
const RECOMMEND_RE = /추천\s*종목/;
const ALT_INVEST_RE = /대체투자/;
const COMMODITY_RE = /원자재|commodit/i;
// "메리츠"(증권사명)의 "리츠"에 걸리지 않게 앞글자가 "메"인 경우는 제외.
const REIT_RE = /(?<!메)리츠|\bREITs?\b/i;
const ETF_RE = /\bETFs?\b|\bETPs?\b|상장지수(?:펀드|증권)?/i;
// ELS(주가연계증권) 제외(오너 지시 2026-10-01 — KB증권 "ELS 기초자산 밴드전망" 발견,
// "ELS 전체 공통 수집제외"): ETF/ETP 와 같은 성격 — 개별 종목·업종 얘기가 아니라
// 파생결합상품(기초자산 밴드·조기상환 조건 등) 얘기라 범위 밖. ETF/ETP 와 동일하게
// 카테고리 구분 없이 전부 제외.
const ELS_RE = /\bELS\b|주가연계증권/i;
const ESG_RE = /\bESG/i;
// "거버넌스"는 ESG(지배구조)로 보고 제외(오너 지시 2026-09-27 — "거버넌스는 esg다", DS "거버넌스 - 베어허그 시리즈"). 종목 리포트 제목의
// "거버넌스 개선 기대"까지 지우지 않도록 산업·거시 글(category "기업" 아님)에만 적용한다.
const GOVERNANCE_RE = /거버넌스|\bgovernance\b/i;
// 부동산은 리츠와 함께 수집 제외(오너 지적 2026-09-27 — 대신 "한국 상업용 부동산", "리츠, 부동산은 수집제외라고 했을텐데"). 리츠는 기업 리포트까지
// 제외하지만, 부동산은 종목 리포트 제목에 사업 얘기로 흔히 나와("…부동산 PF 부담") 산업·거시 글(category "기업" 아님)에만 적용한다.
const REAL_ESTATE_RE = /부동산|맨션/;
// 미래에셋 "글로벌 마켓 브리핑" 일일 시리즈 수집 제외(오너 지시 2026-09-27) — 기업 리포트에는 적용하지 않는다.
const CREDIT_RE = /크레딧|신용|회사채|\bCredit\b/i; // 크레딧 계열 수집 제외(오너 지시 2026-09-27 — "크레딧은 아예 제외다"). 기업 리포트에는 적용하지 않는다.
// "US Market Pulse"(KB증권 미국전략, 오너 지적 2026-09-27 — "Market Pulse는 수집제외대상아니었나?")도 마켓레이더와 같은 성격의 일일
// 시장 브리핑 시리즈라 영문 표기(Market Pulse/Radar/Insight)까지 포함한다. "Global Insights"(KB증권 미국전략, 같은 게시판)도
// 오너 결정(2026-09-27 — "KB데일리는 종합판이네 이거 있으면 KB 다른 데일리자료는 불필요다. Market Pulse 글로벌인사이트는
// 별도로 수집하지 않는다")으로 제외 — KB데일리(종합판)가 이미 다루는 내용이라 별도 시리즈로 안 모은다.
const DAILY_BRIEFING_RE = /글로벌\s*마켓\s*브리핑|(?:^|\s)마켓\s*(?:뷰|클로징)(?=\s|\(|$)|Earnings\s*Revision|자산가격\s*[메매]커니즘\s*변화|신한\s*FX\s*Check-?up|마켓\s*레이더|Global\s*Portfolio|Market\s?(?:Pulse|Radar|Insight)\b|\bGlobal\s*Insights\b/i; // 미래에셋 일일 시리즈(글로벌 마켓 브리핑·마켓 뷰·마켓 클로징)·Earnings Revision·신한 자산가격 메커니즘 변화·신한 FX Check-up·마켓레이더·Global Portfolio(추천 포트폴리오)·Market Pulse/Radar/Insight·Global Insights 시리즈 수집 제외(오너 지시 2026-09-27)
// "포트폴리오" 라벨은 기본 수집 제외(오너 지시 2026-09-27 — "기본은 포트폴리오는 수집제외다" + "예외만 수집한다").
// 지금까지 KB(EXCLUDE_LABEL_RE)·DAILY_BRIEFING_RE(Global Portfolio) 등 개별 수집기·시리즈명마다 따로
// 걸려있던 걸 공통 필터로 승격 — 한국투자증권 "매크로 & 포트폴리오 전략"(Running Hot)이 안 걸려 발견됨.
// 예외가 생기면 PORTFOLIO_KEEP_RE 에 추가(지금은 없음, QUANT_EXCEPT_RE 와 같은 관례).
const PORTFOLIO_RE = /포트폴리오|\bPortfolio\b/i;
const PORTFOLIO_KEEP_RE = null as RegExp | null;

/**
 * 디지털자산은 여기 없다(오너 결정 2026-09-26 — "이건 스크립트에서
 * 마무리되는거 아닌가? 서버단에서 다시 나올이유는 없어보인다"). ETF/ESG/
 * 리츠와 달리 디지털자산 배제는 market에 따라 결과가 달라지는데(국내만
 * 배제, 해외는 유지), 서버까지 오면 macro_issues처럼 market 필드 자체가
 * 없는 경로도 있어 여기서 재판정하면 오히려 잘못 걸러질 위험이 있다.
 * 수집기가 자기 market을 정확히 알고 이미 걸러내므로(scripts/lib/
 * exclude-filters.mjs 의 isDigitalAssetContent()) 서버는 재검사하지 않는다.
 */
// 퀀트 제외(오너 지시 2026-09-27 — "공통에 퀀트는 수집제외 추가한다", "BNK Factor Sentiment 지표 - 월간 팩터 로테이션 &
// 팩터별 투자유망 종목 수집제외"). 퀀트·팩터 모델 리포트는 개별 종목·업종 분석이 아니라 모델 산출물이라 ETF/ESG 와 같은 성격으로
// 카테고리 구분 없이 제외. 예외는 오너가 공통에 따로 요청한다("공통에 예외로 요청할 것이다") — 예외 패턴은 QUANT_EXCEPT_RE 에 추가
// (지금은 없음). BNK 제목은 "퀀트" 단어가 없어 Factor Sentiment·팩터 로테이션으로도 잡는다.
const QUANT_RE = /퀀트|퀀틴전시|\bquant\b|factor\s*sentiment|팩터\s*로테이션/i;
const QUANT_EXCEPT_RE = null as RegExp | null; // 오너 요청 시 예외 패턴(RegExp) — 지정되면 QUANT_RE 에 걸려도 제외하지 않는다
const isQuant = (t: string) => QUANT_RE.test(t) && !(QUANT_EXCEPT_RE && QUANT_EXCEPT_RE.test(t));

export function isCommonExcludedResearch(text: string | null | undefined, category?: string): boolean {
  const t = String(text ?? "");
  if ((WEEKLY_RE.test(t) && !UNLISTED_RE.test(t) && !WEEKLY_KEEP_RE.test(t)) || CALENDAR_RE.test(t) || RECOMMEND_RE.test(t) || REIT_RE.test(t)) return true;
  if (ETF_RE.test(t) || ESG_RE.test(t) || ELS_RE.test(t) || isQuant(t)) return true;
  if (DAILY_BRIEFING_RE.test(t)) return true; // 시리즈 제외는 기업 카테고리에도 적용
  if (PORTFOLIO_RE.test(t) && !(PORTFOLIO_KEEP_RE && PORTFOLIO_KEEP_RE.test(t))) return true; // 포트폴리오는 기본 제외(오너 지시 2026-09-27)
  if (category === "기업") return false;
  if (GOVERNANCE_RE.test(t) || REAL_ESTATE_RE.test(t) || CREDIT_RE.test(t)) return true;
  return ALT_INVEST_RE.test(t) && !COMMODITY_RE.test(t);
}
