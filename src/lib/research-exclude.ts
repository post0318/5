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
const WEEKLY_RE = /weekly|위클리|주간(?!사)|week\s*ahead|\d+\s*월\s*\d+\s*주(?!년)/i;
// 주간물 제외의 예외 — 비상장 리서치는 수집해 비상장으로 분류(오너 지시 2026-09-26).
const UNLISTED_RE = /비상장/;
const CALENDAR_RE = /캘린더|캘박|calendar|일정표/i;
const RECOMMEND_RE = /추천\s*종목/;
const ALT_INVEST_RE = /대체투자/;
const COMMODITY_RE = /원자재|commodit/i;
// "메리츠"(증권사명)의 "리츠"에 걸리지 않게 앞글자가 "메"인 경우는 제외.
const REIT_RE = /(?<!메)리츠|\bREITs?\b/i;
const ETF_RE = /\bETFs?\b|\bETPs?\b|상장지수(?:펀드|증권)?/i;
const ESG_RE = /\bESG/i;
// "거버넌스"는 ESG(지배구조)로 보고 제외(오너 지시 2026-09-27 — "거버넌스는 esg다", DS "거버넌스 - 베어허그 시리즈"). 종목 리포트 제목의
// "거버넌스 개선 기대"까지 지우지 않도록 산업·거시 글(category "기업" 아님)에만 적용한다.
const GOVERNANCE_RE = /거버넌스|\bgovernance\b/i;

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
const QUANT_RE = /퀀트|\bquant\b|factor\s*sentiment|팩터\s*로테이션/i;
const QUANT_EXCEPT_RE = null as RegExp | null; // 오너 요청 시 예외 패턴(RegExp) — 지정되면 QUANT_RE 에 걸려도 제외하지 않는다
const isQuant = (t: string) => QUANT_RE.test(t) && !(QUANT_EXCEPT_RE && QUANT_EXCEPT_RE.test(t));

export function isCommonExcludedResearch(text: string | null | undefined, category?: string): boolean {
  const t = String(text ?? "");
  if ((WEEKLY_RE.test(t) && !UNLISTED_RE.test(t)) || CALENDAR_RE.test(t) || RECOMMEND_RE.test(t) || REIT_RE.test(t)) return true;
  if (ETF_RE.test(t) || ESG_RE.test(t) || isQuant(t)) return true;
  if (category === "기업") return false;
  if (GOVERNANCE_RE.test(t)) return true;
  return ALT_INVEST_RE.test(t) && !COMMODITY_RE.test(t);
}
