// 외부 서비스 사용량 장부 설정(2026-10-06, 오너 지시 — 한도 사고 7회째: 검증 작업이 운영 DART 키 하루 한도를 넘겨 운영 한국 재무가 멈췄는데
// 세는 곳도 알리는 곳도 없었다). 서비스 구분(호스트·경로)과 운영 하루 상한을 이 파일 하나에 둔다.
// 앱(src/instrumentation.ts)·1호기 배치(scripts/lib/usage-preload.mjs)·보고 라우트(/api/cron/usage)가 같이 읽는다.
//
// dailyCap = 운영 하루(KST) 상한 — 네트워크 요청 수. 80% 에서 경고(healthcheck), 100% 에서 **배치·미리 수집만 멈춘다**(화면 요청은 계속 —
// 화면을 멈추면 사고와 같다). null = 한도 수치 미확인 → 집계만.
// 서버에서 배포 없이 바꾸려면 ${USAGE_DIR}/limits.json 에 {"dart": 12000} 꼴로 덮어쓴다(ledger.mjs).

/** @typedef {{ id: string, label: string, dailyCap: number | null, basis: string, match: (host: string, path: string) => boolean }} UsageService */

/** @type {UsageService[]} 위에서부터 처음 맞는 것 하나로 센다(네이버 트렌드가 검색보다 먼저) */
export const USAGE_SERVICES = [
  {
    id: "dart",
    label: "OpenDART",
    dailyCap: 15_000,
    basis: "키 단위 일 20,000건(DART 오류 020 안내문 '일반적으로 20,000건 이상') — IPO 운영·로컬이 같은 키를 쓰면(구멍 #1) 이 장부 밖 사용이 있어 75%로 둔다",
    match: (h) => h === "opendart.fss.or.kr",
  },
  {
    id: "krx",
    label: "KRX OPEN API",
    dailyCap: null,
    basis: "미확인 — 키 하나를 운영·작업·2호기 검증·로컬이 공유(구멍 #3). 한도 확인 뒤 기입",
    match: (h) => h === "data-dbg.krx.co.kr" || h === "openapi.krx.co.kr",
  },
  {
    id: "krx-mdc",
    label: "KRX 정보데이터시스템",
    dailyCap: null,
    basis: "공개 화면 내부 주소 — 한도 없음(차단 위험만)",
    match: (h) => h === "data.krx.co.kr",
  },
  {
    id: "datagokr",
    label: "공공데이터포털",
    dailyCap: null,
    basis: "API별 일 트래픽(개발계정 기본 1만건/API) — 계정 등급 미확인",
    match: (h) => h === "apis.data.go.kr",
  },
  {
    id: "sec",
    label: "SEC EDGAR",
    dailyCap: null,
    basis: "하루 한도 없음 — IP 단위 초당 10건(http.ts 줄 세우기가 지킨다)",
    match: (h) => h === "sec.gov" || h.endsWith(".sec.gov"),
  },
  {
    id: "naver-trend",
    label: "네이버 검색어 트렌드",
    dailyCap: 800,
    basis: "데이터랩 검색어 트렌드 일 1,000건(개발자센터 기준, API 허브 수치 미확인) — 80%",
    match: (h, p) => (h === "naverapihub.apigw.ntruss.com" && p.startsWith("/search-trend/")) || (h === "openapi.naver.com" && p.startsWith("/v1/datalab")),
  },
  {
    id: "naver-search",
    label: "네이버 검색(API 허브)",
    dailyCap: 20_000,
    basis: "검색 API 일 25,000건 — 80%",
    match: (h, p) => (h === "naverapihub.apigw.ntruss.com" && p.startsWith("/search/")) || (h === "openapi.naver.com" && p.startsWith("/v1/search")),
  },
  {
    id: "gemini",
    label: "Gemini",
    dailyCap: null,
    basis: "요청 수 한도 없음 — 월 예산(weekly_llm_usage, WEEKLY_MONTHLY_BUDGET_USD)으로 관리, 보고에 함께 표시",
    match: (h) => h === "generativelanguage.googleapis.com",
  },
  {
    id: "yahoo",
    label: "Yahoo Finance",
    dailyCap: null,
    basis: "비공식 — IP 단위 한도 미확인",
    match: (h) => h === "yahoo.com" || h.endsWith(".yahoo.com"),
  },
  {
    id: "ecos",
    label: "한국은행 ECOS",
    dailyCap: null,
    basis: "미확인",
    match: (h) => h === "ecos.bok.or.kr",
  },
  {
    id: "fred",
    label: "FRED",
    dailyCap: null,
    basis: "하루 한도 없음 — 분당 120건",
    match: (h) => h === "api.stlouisfed.org" || h === "fred.stlouisfed.org",
  },
  {
    id: "youtube",
    label: "YouTube Data API",
    dailyCap: null,
    basis: "일 10,000 단위(요청 수가 아니라 단위) — 집계만",
    match: (h, p) => h === "www.googleapis.com" && p.startsWith("/youtube/"),
  },
];

/** 경고 비율(80%) */
export const USAGE_WARN_RATIO = 0.8;
