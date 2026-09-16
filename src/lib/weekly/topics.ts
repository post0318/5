import "server-only";

/**
 * 주간 리포트 핵심 이슈 후보 주제 사전 (오너 지시 2026-09 — "LLM 을 통해 추론을
 * 안 하는 것일 뿐 시장 요약 정리는 유효하다").
 *
 * 왜 사전인가: 한국어 형태소 분석기 없이 제목에서 주제어를 자동으로 뽑으면
 * 조사·복합명사 때문에 결과가 들쭉날쭉하다. 이 프로젝트가 이미 쓰는 방식
 * (`classifyResearchTopic()` 의 키워드 규칙)과 같이, 다룰 범위가 정해져 있으니
 * (한국·미국 시장, 브라질 국채, 금·원유, FOMC·BOJ·BOK, AI) 주제를 미리 적어
 * 두고 빈도만 센다. 결과가 매주 재현 가능하고 근거를 그대로 붙일 수 있다.
 *
 * `match` 는 리포트 제목·업종명·발췌와 뉴스 제목에 함께 쓴다.
 * `naverQuery` 는 네이버 뉴스에서 그 주 기사 수를 셀 때 쓰는 검색어.
 * `datalabKeywords` 는 네이버 데이터랩 검색어 트렌드 그룹(키가 있을 때만).
 */
export interface WeeklyTopic {
  /** 화면에 나가는 이슈 이름 */
  label: string;
  /** 같은 주제를 여러 이름으로 부르는 경우까지 잡는 정규식 */
  match: RegExp;
  naverQuery: string;
  datalabKeywords: string[];
}

export const WEEKLY_TOPICS: WeeklyTopic[] = [
  {
    label: "미국 금리·연준",
    match: /FOMC|연준|파월|미국\s*금리|기준금리\s*인하|점도표|Fed\b|Federal Reserve|금리\s*인하|금리\s*인상/i,
    naverQuery: "FOMC 연준 금리",
    datalabKeywords: ["FOMC", "연준", "미국 금리"],
  },
  {
    label: "한국은행·국내 금리",
    match: /한국은행|한은\b|금통위|국고채|원화\s*금리|BOK\b/i,
    naverQuery: "한국은행 기준금리 금통위",
    datalabKeywords: ["한국은행", "기준금리", "금통위"],
  },
  {
    label: "일본은행·엔화",
    match: /일본은행|BOJ\b|엔화|엔\/달러|엔캐리|일본\s*금리/i,
    naverQuery: "일본은행 BOJ 엔화",
    datalabKeywords: ["일본은행", "엔화"],
  },
  {
    label: "원달러 환율",
    match: /원\/?달러|원달러|환율|외환시장|달러\s*인덱스|DXY/i,
    naverQuery: "원달러 환율",
    datalabKeywords: ["환율", "원달러 환율"],
  },
  {
    label: "AI·반도체 수요",
    match: /\bAI\b|인공지능|반도체|메모리|HBM|엔비디아|NVIDIA|TSMC|파운드리|데이터센터|하이퍼스케일러|capex/i,
    naverQuery: "AI 반도체 수요",
    datalabKeywords: ["AI 반도체", "엔비디아", "HBM"],
  },
  {
    label: "관세·통상",
    match: /관세|통상|무역분쟁|수출규제|보호무역|tariff/i,
    naverQuery: "관세 통상 무역",
    datalabKeywords: ["관세", "무역분쟁"],
  },
  {
    label: "국제유가·에너지",
    // "유가증권시장"(코스피 정식 명칭)이 "유가"에 걸려 유가 이슈로 잡히던 것을 제외
    match: /유가(?!증권)|원유|WTI|브렌트|OPEC|정유|에너지\s*가격|천연가스/i,
    naverQuery: "국제유가 원유",
    datalabKeywords: ["국제유가", "유가"],
  },
  {
    label: "금·귀금속",
    // "골드만삭스"가 "골드"에 걸리지 않게
    match: /금값|금\s*가격|금시세|귀금속|은값|골드(?!만)|gold price/i,
    naverQuery: "금값 금 시세",
    datalabKeywords: ["금값", "금 시세"],
  },
  {
    label: "브라질 국채",
    match: /브라질|헤알|Selic|셀릭|NTN-?F|COPOM/i,
    naverQuery: "브라질 국채 헤알",
    datalabKeywords: ["브라질 국채", "헤알"],
  },
  {
    label: "코스피 수급·외국인",
    match: /코스피|코스닥|외국인\s*수급|외국인\s*순매수|기관\s*수급|공매도/i,
    naverQuery: "코스피 외국인 순매수",
    datalabKeywords: ["코스피", "코스피 외국인"],
  },
  {
    label: "미국 증시·밸류에이션",
    // "다우"는 다우케미칼·다우기술 같은 회사명과 겹쳐 지수 표기만 본다
    match: /S&P\s*500|나스닥|다우\s*지수|미국\s*증시|빅테크|밸류에이션\s*부담|매그니피센트/i,
    naverQuery: "미국 증시 나스닥",
    datalabKeywords: ["나스닥", "미국 증시"],
  },
  {
    label: "물가·인플레이션",
    match: /물가|인플레이션|CPI\b|PCE\b|근원물가|디스인플레/i,
    naverQuery: "물가 인플레이션 CPI",
    datalabKeywords: ["물가", "인플레이션"],
  },
  {
    label: "고용·경기",
    match: /고용지표|비농업|실업률|경기침체|리세션|ISM\b|PMI\b|소비지표/i,
    naverQuery: "고용지표 실업률 경기",
    datalabKeywords: ["고용지표", "실업률"],
  },
  {
    label: "2차전지·전기차",
    // EV 는 멀티플 표기(EV/EBITDA)와 겹쳐 빼고 전기차 표현만 본다
    match: /2차전지|이차전지|배터리|전기차|리튬|양극재/i,
    naverQuery: "2차전지 배터리 전기차",
    datalabKeywords: ["2차전지", "전기차"],
  },
  {
    label: "조선·방산",
    match: /조선업|조선\s*수주|방산|방위산업|MRO\b|잠수함|함정/i,
    naverQuery: "조선 방산 수주",
    datalabKeywords: ["조선주", "방산주"],
  },
  {
    label: "중국 경기·부양책",
    match: /중국\s*경기|중국\s*부양|위안화|인민은행|중국\s*수출|리오프닝/i,
    naverQuery: "중국 경기 부양책",
    datalabKeywords: ["중국 경기", "위안화"],
  },
];

/**
 * 금리정책·다음 주 일정 섹션에 붙일 고정 검색어 (오너 지시 — "정책, 일정은
 * 정해진 기사를 보여주는 것"). 추론 없이 그 주 기사를 그대로 건다.
 */
export const POLICY_QUERIES: { label: string; query: string }[] = [
  { label: "미국 FOMC", query: "FOMC 결정 금리" },
  { label: "한국은행", query: "한국은행 금통위 기준금리" },
  { label: "일본은행", query: "일본은행 BOJ 금융정책결정회의" },
];

export const CALENDAR_QUERIES: { label: string; query: string }[] = [
  { label: "주요 경제지표", query: "다음주 경제지표 발표 일정" },
  { label: "증시 일정", query: "이번주 증시 주요 일정" },
];
