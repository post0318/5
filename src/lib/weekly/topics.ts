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
 * `newsQuery` 는 그 주 기사 수를 셀 때 쓰는 검색어.
 * `trendKeywords` 는 네이버 검색어 트렌드(API 허브) 그룹 — 활성화됐을 때만 쓴다.
 * `domestic` 은 뉴스 소스 선택에 쓴다(오너 지시 2026-09 — "해외는 구글과
 * 네이버를 같이쓰고 국내는 대체"): 국내 주제는 네이버 뉴스 검색(요약문 포함,
 * `naverNews.ts`)만 쓰고, 해외 주제는 네이버+구글 뉴스 RSS 를 합쳐 쓴다
 * (`issues.ts` `countFromNews()`). 자동 판정 대신 사전에 직접 적는 이유는
 * 위 "왜 사전인가"와 같다 — 재현 가능하고 오탐이 없다. 미국/일본/중국/
 * 브라질처럼 나라 이름이 들어간 주제는 명백해 고민 없이 정했고, 물가·
 * 고용처럼 국내외 데이터가 섞이는 주제는 근거를 더 넓게 모으는 쪽(해외
 * 취급 — 구글+네이버 병행)으로 정했다.
 */
export interface WeeklyTopic {
  /** 화면에 나가는 이슈 이름 */
  label: string;
  /** 같은 주제를 여러 이름으로 부르는 경우까지 잡는 정규식 */
  match: RegExp;
  newsQuery: string;
  trendKeywords: string[];
  /** true = 네이버 뉴스만, false = 네이버+구글 뉴스 RSS */
  domestic: boolean;
}

export const WEEKLY_TOPICS: WeeklyTopic[] = [
  {
    label: "미국 금리·연준",
    match: /FOMC|연준|파월|미국\s*금리|기준금리\s*인하|점도표|Fed\b|Federal Reserve|금리\s*인하|금리\s*인상/i,
    newsQuery: "FOMC 연준 금리",
    trendKeywords: ["FOMC", "연준", "미국 금리"],
    domestic: false,
  },
  {
    label: "한국은행·국내 금리",
    match: /한국은행|한은\b|금통위|국고채|원화\s*금리|BOK\b/i,
    newsQuery: "한국은행 기준금리 금통위",
    trendKeywords: ["한국은행", "기준금리", "금통위"],
    domestic: true,
  },
  {
    label: "일본은행·엔화",
    match: /일본은행|BOJ\b|엔화|엔\/달러|엔캐리|일본\s*금리/i,
    newsQuery: "일본은행 BOJ 엔화",
    trendKeywords: ["일본은행", "엔화"],
    domestic: false,
  },
  {
    label: "원달러 환율",
    match: /원\/?달러|원달러|환율|외환시장|달러\s*인덱스|DXY/i,
    newsQuery: "원달러 환율",
    trendKeywords: ["환율", "원달러 환율"],
    domestic: true,
  },
  {
    // 해외 기업 한정(오너 지시 2026-09-21) — 국내 반도체는 아래 "국내
    // 반도체" 주제가 맡는다. 종전엔 `반도체|메모리|HBM` 같은 일반 명사가
    // 들어 있어 삼성전자·SK하이닉스 기사가 대거 섞였다. "무엇이 아닌가"
    // (제외 규칙)로 정의하면 예외가 계속 생기므로 해외 고유명사 중심으로
    // "무엇인가"를 적는다.
    label: "AI·반도체 수요(해외)",
    match: /엔비디아|NVIDIA|TSMC|\bAMD\b|브로드컴|Broadcom|마이크론|Micron|ASML|인텔|Intel|하이퍼스케일러|데이터센터\s*투자|AI\s*(반도체|가속기|서버|인프라)|인공지능\s*반도체/i,
    newsQuery: "엔비디아 TSMC AI 반도체",
    trendKeywords: ["엔비디아", "AI 반도체"],
    domestic: false,
  },
  {
    label: "관세·통상",
    match: /관세|통상|무역분쟁|수출규제|보호무역|tariff/i,
    newsQuery: "관세 통상 무역",
    trendKeywords: ["관세", "무역분쟁"],
    domestic: false,
  },
  {
    label: "국제유가·에너지",
    // "유가증권시장"(코스피 정식 명칭)이 "유가"에 걸려 유가 이슈로 잡히던 것을 제외
    match: /유가(?!증권)|원유|WTI|브렌트|OPEC|정유|에너지\s*가격|천연가스/i,
    newsQuery: "국제유가 원유",
    trendKeywords: ["국제유가", "유가"],
    domestic: false,
  },
  {
    // 오너 지시 2026-09-21 — AI·반도체를 해외로 한정하면서 국내 반도체가
    // 어느 주제에도 안 잡히게 되어 신설. 계열은 「국내시장」.
    label: "국내 반도체",
    match: /삼성전자|SK\s*하이닉스|하이닉스|메모리\s*(반도체|가격)|\bHBM\b|디램|\bDRAM\b|낸드|\bNAND\b|파운드리|국내\s*반도체|반도체\s*수출/i,
    newsQuery: "삼성전자 SK하이닉스 반도체",
    trendKeywords: ["삼성전자", "SK하이닉스"],
    domestic: true,
  },
  {
    // 오너 지시 2026-09-21 — 원자재 계열에 구리 등 금속 포함. 금(안전자산)과
    // 달리 산업금속은 경기·물가에 연동돼 계열이 다르다.
    label: "구리·산업금속",
    match: /구리|동값|전기동|니켈|알루미늄|아연|비철금속|산업금속|copper\b/i,
    newsQuery: "구리 가격 비철금속",
    trendKeywords: ["구리 가격", "비철금속"],
    domestic: false,
  },
  {
    label: "금·귀금속",
    // "골드만삭스"가 "골드"에 걸리지 않게
    match: /금값|금\s*가격|금시세|귀금속|은값|골드(?!만)|gold price/i,
    newsQuery: "금값 금 시세",
    trendKeywords: ["금값", "금 시세"],
    domestic: false,
  },
  {
    label: "브라질 국채",
    match: /브라질|헤알|Selic|셀릭|NTN-?F|COPOM/i,
    newsQuery: "브라질 국채 헤알",
    trendKeywords: ["브라질 국채", "헤알"],
    domestic: false,
  },
  {
    label: "코스피 수급·외국인",
    match: /코스피|코스닥|외국인\s*수급|외국인\s*순매수|기관\s*수급|공매도/i,
    newsQuery: "코스피 외국인 순매수",
    trendKeywords: ["코스피", "코스피 외국인"],
    domestic: true,
  },
  {
    label: "미국 증시·밸류에이션",
    // "다우"는 다우케미칼·다우기술 같은 회사명과 겹쳐 지수 표기만 본다
    match: /S&P\s*500|나스닥|다우\s*지수|미국\s*증시|빅테크|밸류에이션\s*부담|매그니피센트/i,
    newsQuery: "미국 증시 나스닥",
    trendKeywords: ["나스닥", "미국 증시"],
    domestic: false,
  },
  {
    label: "물가·인플레이션",
    match: /물가|인플레이션|CPI\b|PCE\b|근원물가|디스인플레/i,
    newsQuery: "물가 인플레이션 CPI",
    trendKeywords: ["물가", "인플레이션"],
    domestic: false,
  },
  {
    label: "고용·경기",
    match: /고용지표|비농업|실업률|경기침체|리세션|ISM\b|PMI\b|소비지표/i,
    newsQuery: "고용지표 실업률 경기",
    trendKeywords: ["고용지표", "실업률"],
    domestic: false,
  },
  {
    label: "2차전지·전기차",
    // EV 는 멀티플 표기(EV/EBITDA)와 겹쳐 빼고 전기차 표현만 본다
    match: /2차전지|이차전지|배터리|전기차|리튬|양극재/i,
    newsQuery: "2차전지 배터리 전기차",
    trendKeywords: ["2차전지", "전기차"],
    domestic: true,
  },
  {
    label: "조선·방산",
    match: /조선업|조선\s*수주|방산|방위산업|MRO\b|잠수함|함정/i,
    newsQuery: "조선 방산 수주",
    trendKeywords: ["조선주", "방산주"],
    domestic: true,
  },
  {
    label: "중국 경기·부양책",
    match: /중국\s*경기|중국\s*부양|위안화|인민은행|중국\s*수출|리오프닝/i,
    newsQuery: "중국 경기 부양책",
    trendKeywords: ["중국 경기", "위안화"],
    domestic: false,
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
