import "server-only";
import {
  BANK_BOJ,
  BANK_BOK,
  BANK_FOMC,
  getCentralBankMeetings,
  type CbMeeting,
} from "./cb-calendar";
import type { SnapshotRow } from "@/lib/db/weekly-reports";
import type { WeeklyIssue } from "./issues";
import { geminiGenerate, isGeminiConfigured, type GeminiResult } from "./gemini";
import type { SectorHighlight, WeeklySectors } from "./sectors";
import type { ReportWeek } from "./week";

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
 * **그라운딩(웹검색) 켬(오너 지시 2026-09-18 — "스냅샷은 이슈와 무관하게
 * 각 자산의 특이점(상승 원인·하락 사유)을 말해야 한다")**: 스냅샷 16개
 * 자산 각각의 "왜"를 설명하려면 우리가 미리 모아둔 이슈 3개 근거만으론
 * 턱없이 부족하다 — 나머지 13개는 아무 근거도 없다. 실제 원인을 알려면
 * Gemini 가 그 자리에서 검색해야 해서 `grounding: true` 로 바꿨다.
 *
 * "검증" 단계(`verifyComment()`)는 그라운딩 여부로 갈린다: 그라운딩이 실제
 * 로 출처를 찾아왔으면(`groundingSources` 존재) 그 검색 결과를 신뢰하고
 * 수치 대조를 건너뛴다 — 우리가 안 가진 사실(예: 중국 PMI 수치)을 인용하는
 * 게 오히려 정상이기 때문. 그라운딩이 출처 없이 끝났으면(검색 실패 등)
 * 기존처럼 %/bp/배/pt/건 수치를 원본 데이터와 엄격히 대조해 근거 없는
 * 수치가 섞인 코멘트를 버린다 — 안전망은 그대로 둔다.
 *
 * **호출을 둘로 쪼개 병렬 실행(오너 지시 2026-09-18)**: 한 호출에 한 줄
 * 결론·정책요약·캘린더·스냅샷 16개·이슈 3개를 전부 몰아넣었더니 응답이
 * 중간에 잘리거나(사고 토큰이 예산을 다 먹음, 실측 — 410자에서 끊김)
 * 전체 처리시간이 70~90초까지 늘어나 모바일에서 "재생성이 안 되는 것
 * 처럼" 보였다. "매크로"(한 줄 결론·정책요약·캘린더)와 "코멘트"(스냅샷·
 * 이슈)로 나눠 `Promise.all`로 동시에 호출 — 각각 다룰 필드가 줄어 잘릴
 * 위험이 낮아지고, 전체 대기시간도 "더 느린 쪽 하나" 수준으로 줄어든다.
 * 두 호출 다 그라운딩을 쓰므로 비용은 두 배(+$0.035 한 번 더)지만 회당
 * 여전히 10~20센트 수준.
 */

export interface WeeklyComments {
  /** "1. 한 줄 결론" — 가장 크게 움직인 자산과 이슈 근거를 인과관계로 엮은
   * 한 문장(오너 지시 2026-09-18 — "딸랑 상승·하락 2개만 적고 끝이냐,
   * 원인이든 결과든 인과가 있어야". 근거가 약하면 null → 렌더링 쪽이
   * 기존 `movers()`(사실 나열)로 폴백한다. */
  headline: string | null;
  /** "4. 금리정책" 맨 위에 붙는 종합 요약 문단(오너 지시 2026-09-18 —
   * "네이버 AI 요약도 이 정도는 한다"). 그라운딩 성공 또는 이미 수집된
   * policyEvidence(실제 리포트·뉴스)가 있을 때 채워진다 — 둘 다 없으면
   * null → 화면이 안내 문구만 보여준다. */
  policySummary: string | null;
  /** "5. 다음 주 주시 일정" — 날짜별 확정 이벤트 캘린더(오너 지시
   * 2026-09-18 — "관련 기사 목록이 아니라 일자별 캘린더를 원한 거다").
   * 그라운딩 성공일 때만 채워진다 — 실패하면 null → 기존 기사 표로 폴백. */
  calendar: { date: string; event: string }[] | null;
  /** key = SnapshotRow.name */
  snapshot: Map<string, string>;
  /** key = WeeklyIssue.label */
  issues: Map<string, string>;
  /** "주요 섹터 이슈"(오너 지시 2026-09-19) — key = SectorHighlight.id
   * (예: "kr-up-1", "combined-down-2"). 등락률·순위는 코드(sectors.ts)가
   * 이미 계산해 확정하고, 여기엔 "왜 그렇게 움직였는지" 코멘트만 담는다. */
  sectors: Map<string, string>;
}

const INPUT_DATA_DESC = `# 입력 데이터
사용자 메시지는 JSON 객체 하나다.
- reportWeek: 이 리포트가 다루는 주(월~금).
- nextWeek: reportWeek 바로 다음 주(월~금) — calendar 는 이 기간 대상.
- topMovers: 이번 주 가장 많이 오른/내린 자산(코드가 계산한 값, 참고용).
- snapshot: 이번 주 자산별 종가·주간 변동(pct=주간 변동률%, diffBp=금리류
  변동폭 bp). value/pct/diffBp 가 null 이면 비교할 값이 없다는 뜻이다.
- issues: 이번 주 핵심 이슈 후보(증권사 리포트·뉴스 빈도로 뽑힘). reports·
  news·earnings(실적 서프라이즈)·metrics(FRED 거시지표)가 근거로 들어있다.
- policyEvidence: 미국 금리·연준/한국은행/일본은행 주제로 이미 수집된
  증권사 리포트·뉴스 근거(근거 있는 주제만 포함). policySummary 를 쓸 때
  최우선으로 활용한다.
- sectors: 이번 주 한국·미국·일본 증시의 상승/하락 상위 섹터(등락률은 코드가
  이미 계산해 확정). 왜 그 섹터가 그렇게 움직였는지는 안 채워져 있다 —
  네가 웹검색으로 원인을 찾아 채운다.
- centralBankMeetings: 미국 FOMC·일본은행(BOJ)·한국은행 금통위의 **남은
  공식 회의 일정 전부**(각 중앙은행·Kalshi 공식 캘린더에서 실시간 조회).

# 중앙은행 회의 일정 (절대 규칙)
회의 날짜·개최 월을 언급할 때는 **centralBankMeetings 에 있는 날짜만**
쓴다. 목록에 없는 달의 회의를 지어내지 마라 — FOMC 는 연 8회라 회의가
아예 없는 달이 있다(실측 오류 2026-09: 10월 다음이 12월인데 "11월 추가
인상 여부"라고 썼다). "다음 회의"를 말하려면 목록에서 그 주 이후 가장
가까운 날짜를 찾아 그 달을 써라. 목록에 근거가 없으면 달을 특정하지 말고
"다음 회의"처럼 뭉뚱그려 쓴다.`;

const MACRO_PROMPT = `# 역할
너는 국내 자산운용사 소속 시니어 매크로·주식 애널리스트다. 이번 주 전체
흐름을 종합해서 "한 줄 결론"·"금리정책 요약"·"다음 주 일정 캘린더"를
쓰는 게 임무다. 리포트의 표·숫자는 이미 코드로 완성돼 있으니 다시 만들지
않는다. 확실치 않으면 **웹검색으로 실제 사실을 확인**하고 인용해라 —
짐작으로 채우지 마라.

${INPUT_DATA_DESC}

# 작성 원칙 (반드시 지킬 것)
1. **headline(한 줄 결론)** — 스냅샷 표 전체를 훑고 "이번 주 시장이 무엇
   때문에 이렇게 흘렀는지"를 종합해 한 문장으로 쓴다. topMovers 하나만
   짚는 게 아니라, 여러 자산에 걸쳐 공통으로 작용한 배경(금리 결정, 유가
   급등, 인플레이션 지표 등)이 있으면 그걸 중심으로 삼아라. 예: "미 CPI
   서프라이즈발 금리 인상 우려와 유가 급등이 겹치며 위험자산은 눌리고
   원자재는 강세를 보인 한 주." 근거가 정말 없을 때만 topMovers 사실
   나열로 대체한다. 120자 내외.
2. **policySummary** — 미국 연준(FOMC)·한국은행·일본은행의 이번 주 통화
   정책 동향. **policyEvidence 의 근거를 최우선으로 활용**하고, 부족한
   부분만 웹검색으로 보강해라. 단순 기사 나열이 아니라 "그 중앙은행이
   이번 주 무엇을 했거나 시사했는지, 시장이 어떻게 반응했는지"를
   종합 서술한다(포털 AI 검색 요약 수준을 목표로 한다 — 얕은 사실 나열
   금지). **한 문단으로 뭉쳐 쓰지 말고, 은행별로 줄을 바꿔라**(오너 지시
   2026-09-19 — "시장별로 줄바꿈"): 마크다운 리스트로 "- 미국 연준(Fed):
   ...", "- 한국은행: ...", "- 일본은행(BOJ): ..." 세 줄(각 1~2문장)을
   개행 문자로 구분해 하나의 문자열에 담아라. 그 은행 소식이 그 주에
   전혀 없으면 그 줄은 통째로 뺀다(세 줄을 억지로 채우지 마라).
   policyEvidence 에도 없고 웹검색으로도 확인 안 되는 은행만 아는 범위
   까지 쓰고, 셋 다 없으면 null 로 남긴다.
3. **calendar** — nextWeek(다음 주) 기간의 날짜별 확정 경제 일정. "관련
   기사 목록"이 아니라 **실제 캘린더**다 — 웹검색으로 그 주에 실제
   예정된 이벤트를 날짜별로 확인해서 적는다. 대상: 중앙은행 회의·주요
   경제지표 발표일·옵션선물 동시만기일 같은 거시·시장 이벤트 **더하여
   M7(애플·마이크로소프트·엔비디아·아마존·구글·메타·테슬라) 등 시가총액
   최상위 빅테크의 실적 발표일**도 포함한다(오너 지시 2026-09-19 — 시황에
   미치는 영향이 커서 거시 이벤트급으로 취급). 그 외 개별 기업 실적·
   공모주 일정은 제외. **주요 중앙은행 회의가 없는 주라고 캘린더가
   빈 게 정상은 아니다** — CPI·PPI·고용지표(비농업)·PMI·소매판매 같은
   정기 경제지표 발표일, ECB·BOE 회의, 미 국채 입찰처럼 거의 매주
   무언가는 있다. "이번 주 [nextWeek 날짜] 경제지표 발표 일정"처럼
   구체적으로 검색해서 찾아라 — 검색 자체를 안 하고 비우지 마라.
   **절대 지어내지 마라** — 확인 안 되는 날짜/이벤트는 통째로 뺀다
   (그래도 목록이 비면 어쩔 수 없다. 주요 중앙은행 회의·고용지표·시장
   휴장일은 이미 코드가 따로 채우니 몰라도 괜찮다). 각 항목은
   {"date": "YYYY-MM-DD", "event": "그 날 있는 일정, 15자 내외"} 형식,
   nextWeek 범위를 벗어나는 날짜는 넣지 않는다. 날짜 오름차순 정렬.
4. 제공된 JSON의 수치는 그대로 인용해도 된다. 그 외의 새 수치를 쓸 때는
   **실제 웹검색으로 확인한 것만** 쓴다 — 확인 안 되면 수치 없이
   정성적으로만 서술한다.
5. 간결한 애널리스트 어조(~음/~함 체). 미사여구·감탄사·전망 단정
   ("반드시", "확실히") 금지.

# 출력 형식
마크다운 코드펜스나 설명 없이, 아래 스키마의 JSON 객체만 출력한다:
{"headline": "한 줄 결론", "policySummary": "정책 요약 또는 null", "calendar": [{"date": "YYYY-MM-DD", "event": "..."}]}`;

const COMMENT_PROMPT = `# 역할
너는 국내 자산운용사 소속 시니어 매크로·주식 애널리스트다. 이미 집계된
주간 시장 데이터의 **자산별·이슈별 짧은 해석 코멘트**를 쓰는 게 임무다.
리포트의 표·숫자는 이미 코드로 완성돼 있으니 다시 만들지 않는다. 이번 주
각 자산·이슈가 왜 그렇게 움직였는지 확실치 않으면 **웹검색으로 실제
원인을 확인**하고 인용해라 — 짐작으로 채우지 마라.

${INPUT_DATA_DESC}

# 작성 원칙 (반드시 지킬 것)
1. **snapshot: 각 자산 고유의 그 주 등락 원인·특이점을 쓴다.** 핵심 이슈
   3개(issues)에 묶이는 자산만 쓰라는 게 아니다 — 16개 전부 독립적으로
   "이 자산이 왜 오르내렸는가"를 다룬다. 확실한 원인을 모르면 웹검색으로
   찾아서 쓰고, 그래도 못 찾으면 빈 문자열로 남긴다.
   - 나쁜 예(절대 금지): "주간 3.33% 상승하며 강세를 보임." — 표에
     이미 있는 등락률을 문장으로 바꿔 적기만 함, 정보량 0.
   - 좋은 예: "미 CPI 상회로 금리 인상 우려 완화, 외국인 순매수 유입."
     (실제 그 주 있었던 사건을 원인으로 명시)
   - **pct/diffBp 절댓값이 큰(그 주 가장 많이 움직인) 자산부터 우선
     채워라.** 같은 그룹(예: 채권) 안에서 더 크게 움직인 자산을 건너뛰고
     덜 움직인 자산만 채우는 건 앞뒤가 안 맞다(예: 미국채 3년이 10년보다
     더 움직였는데 10년만 쓰는 것 — 금지).
2. **issues 코멘트가 이 리포트의 핵심이다(오너 지시).** reports/news/
   earnings/metrics 는 근거일 뿐이고, 코멘트가 실제 분석이다 — "A 때문에
   B했다" 한 문장으로 끝내지 마라. 다음 세 가지를 담은 3~5문장 분석으로
   쓴다:
   (a) 이번 주 실제로 무슨 일이 있었는지 — 근거(reports/news/earnings/
       metrics, 부족하면 웹검색)에 기반한 사실.
   (b) 그게 왜 중요한지 — 어떤 메커니즘으로 시장·다른 자산에 영향을
       주는지(예: 할인율 상승이 고밸류에이션 성장주에 미치는 압박,
       원자재 가격이 인플레이션 기대에 미치는 영향 등).
   (c) 다음에 무엇을 주시해야 하는지(있다면) — 확정된 사실이 아니면
       "~로 보임", "~가능성"처럼 조심스럽게. 근거 없는 전망을 확정
       처럼 쓰지 마라.
   짧게 요약하려 하지 말고 실제 분석 분량(200~400자)으로 써라.
3. **sectors: 이번 주 왜 그 섹터가 그렇게 오르내렸는지를 쓴다.** 등락률·
   순위는 이미 코드가 계산해 확정했으니 다시 쓰지 마라 — "이번 주 X.X%
   상승" 처럼 표에 이미 있는 숫자를 문장으로 바꿔 적기만 하는 건 금지
   (snapshot 규칙 1과 같은 이유). 그 섹터 안에서 실제로 무슨 일이 있었는지
   (실적·정책·수급·업황 뉴스 등)를 웹검색으로 확인해 1~2문장(60자 내외)
   으로 쓴다. 확인 안 되면 빈 문자열로 남긴다. sectors 항목의 id 값을
   그대로 키로 써서 응답한다(예: "kr-up-1").
4. 제공된 JSON의 수치는 그대로 인용해도 된다. 그 외의 새 수치(%, 가격,
   지표 등)를 쓸 때는 **실제 웹검색으로 확인한 것만** 쓴다 — 확인 안 되면
   수치 없이 정성적으로만("~영향", "~로 해석됨") 서술하고, 그마저 안 되면
   해당 칸을 비운다.
5. 간결한 애널리스트 어조(~음/~함 체). 미사여구·감탄사 금지(단, 전망은
   위 2-(c)처럼 조심스러운 표현 사용). **snapshot·sectors 코멘트는 40~60자
   내외로 짧게 유지**(항목이 많아 다 길면 표가 안 읽힌다) — 길이 기준은
   issues 에만 적용되지 않는다.

# 출력 형식
마크다운 코드펜스나 설명 없이, 아래 스키마의 JSON 객체만 출력한다:
{"snapshot": {"<snapshot 항목의 name과 동일한 문자열>": "코멘트"}, "issues": {"<issues 항목의 label과 동일한 문자열>": "코멘트"}, "sectors": {"<sectors 항목의 id와 동일한 문자열>": "코멘트"}}
snapshot·issues·sectors 에 없는 키를 새로 만들지 말 것.`;

interface CommentPayload {
  reportWeek: { start: string; end: string };
  nextWeek: { start: string; end: string };
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
  /** 미국 금리·연준/한국은행/일본은행 주제로 이미 수집된 근거 — 핵심
   * 이슈 3개(issues)에 안 뽑혀도 policySummary 는 이걸 우선 활용한다
   * (오너 지시 2026-09-18 — "4번은 사실밖에 없는 정책을 이야기하는건데
   * 없다는게 더 이상하다": 매번 실시간 검색에만 기대지 않고 이미 모아둔
   * 근거로 신뢰도를 높인다). 근거가 없는 주제는 빠진다. */
  policyEvidence: {
    label: string;
    reports: { date: string; source: string; stockName: string; title: string }[];
    news: { title: string; excerpt?: string; source: string; publishedAt: string }[];
  }[];
  sectors: {
    id: string;
    market: string;
    label: string;
    direction: "up" | "down";
    pct: number;
    startDate: string;
    endDate: string;
  }[];
  /** 남은 중앙은행 회의 일정 — `cb-calendar.ts` 가 공식 소스에서 가져온다.
   * 이걸 안 주면 모델이 회의가 없는 달을 지어낸다(실측 2026-09: FOMC 가
   * 10/28 다음 12/09 인데 "11월 추가 인상 여부"라고 썼다). */
  centralBankMeetings: CbMeeting[];
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function thirdFridayUTC(year: number, month1to12: number): string {
  const first = new Date(Date.UTC(year, month1to12 - 1, 1));
  const firstFridayDate = 1 + ((5 - first.getUTCDay() + 7) % 7); // 5 = 금요일
  const thirdFridayDate = firstFridayDate + 14;
  return new Date(Date.UTC(year, month1to12 - 1, thirdFridayDate)).toISOString().slice(0, 10);
}

/** 선물·옵션 동시 만기일("네 마녀의 날") — 3/6/9/12월 셋째 금요일은 공개된
 * 고정 일정이라 검색 없이 코드로 항상 정확히 계산할 수 있다(할루시네이션
 * 위험 0). 대상 기간(YYYY-MM-DD)에 걸리면 그 날짜를 돌려준다. */
function computeQuadWitching(startDate: string, endDate: string): { date: string; event: string } | null {
  const y1 = Number(startDate.slice(0, 4));
  const y2 = Number(endDate.slice(0, 4));
  const candidates: string[] = [];
  for (let y = y1; y <= y2; y++) {
    for (const m of [3, 6, 9, 12]) candidates.push(thirdFridayUTC(y, m));
  }
  const hit = candidates.find((d) => d >= startDate && d <= endDate);
  return hit ? { date: hit, event: "선물·옵션 동시 만기일(네 마녀의 날)" } : null;
}

function firstFridayUTC(year: number, month1to12: number): string {
  const first = new Date(Date.UTC(year, month1to12 - 1, 1));
  const firstFridayDate = 1 + ((5 - first.getUTCDay() + 7) % 7); // 5 = 금요일
  return new Date(Date.UTC(year, month1to12 - 1, firstFridayDate)).toISOString().slice(0, 10);
}

/** 미국 고용지표(비농업, Employment Situation) — 매월 첫째 금요일 발표가
 * 수십 년째 고정 관행이라(드물게 공휴일과 겹치면 하루 밀림) 검색 없이
 * 코드로 계산한다. FRED(아래 fetchFredReleaseEvents)가 실제 공식 날짜를
 * 주므로 그쪽이 우선이고, 이건 FRED 호출 실패 시 폴백이다. */
function computeJobsReport(startDate: string, endDate: string): { date: string; event: string } | null {
  const y1 = Number(startDate.slice(0, 4));
  const y2 = Number(endDate.slice(0, 4));
  const candidates: string[] = [];
  for (let y = y1; y <= y2; y++) {
    for (let m = 1; m <= 12; m++) candidates.push(firstFridayUTC(y, m));
  }
  const hit = candidates.find((d) => d >= startDate && d <= endDate);
  return hit ? { date: hit, event: "미국 고용지표(비농업, Employment Situation)" } : null;
}

/**
 * 미국 CPI·PPI·GDP·고용지표(비농업) 공식 발표일 — FRED `release/dates`
 * API(오너가 발급받은 무료 키, 2026-09-19). `fredgraph.csv`(값 조회, 키
 * 불필요)와 달리 "언제 발표되는지"는 이 엔드포인트가 필요하다. release_id
 * 는 `/fred/series/release?series_id=...` 로 실측 확인:
 *  - CPIAUCSL(CPI) → 10, PPIACO(PPI) → 46, GDP → 53, PAYEMS(고용) → 50.
 * 키 없거나 호출 실패 시 조용히 빈 배열(고용지표만 위 규칙 기반 계산으로
 * 대신 채워짐, CPI/PPI/GDP는 그냥 빠짐 — 지어내지 않음).
 */
const FRED_RELEASES: { id: number; label: string }[] = [
  { id: 10, label: "미국 CPI(소비자물가지수) 발표" },
  { id: 46, label: "미국 PPI(생산자물가지수) 발표" },
  { id: 53, label: "미국 GDP 발표" },
  { id: 50, label: "미국 고용지표(비농업, Employment Situation)" },
];

async function fetchFredReleaseEvents(
  startDate: string,
  endDate: string,
): Promise<{ date: string; event: string }[]> {
  const key = process.env.FRED_API_KEY;
  if (!key) return [];
  const results = await Promise.all(
    FRED_RELEASES.map(async (r) => {
      try {
        const res = await fetch(
          `https://api.stlouisfed.org/fred/release/dates?release_id=${r.id}&api_key=${key}&realtime_start=${startDate}&realtime_end=${endDate}&include_release_dates_with_no_data=true&file_type=json`,
          { signal: AbortSignal.timeout(8_000) },
        );
        if (!res.ok) return [];
        const j = (await res.json()) as { release_dates?: { date: string }[] };
        return (j.release_dates ?? [])
          .filter((d) => d.date >= startDate && d.date <= endDate)
          .map((d) => ({ date: d.date, event: r.label }));
      } catch {
        return [];
      }
    }),
  );
  return results.flat();
}

/**
 * 시장 휴장일 — Nager.Date 공개 API(무료, 인증 불필요, 실측 확인
 * 2026-09-19)로 미국·일본·중국·독일(유럽 섹터 거래소 기준)의 공휴일을 받아
 * 대상 기간에 걸리는 것만 돌려준다. 웹검색과 달리 구조화된 공식 데이터라
 * 확인 실패·할루시네이션 위험이 없다.
 *
 * **한국은 뺐다**(오너 지시 2026-09-20 — "주시일정에 한국연휴와 공휴일은
 * 빼라. 이미 안다") — 오너 본인 기준 시장이라 국내 공휴일은 안내가 불필요.
 */
const HOLIDAY_COUNTRIES: { code: string; label: string }[] = [
  { code: "US", label: "미국" },
  { code: "JP", label: "일본" },
  { code: "CN", label: "중국" },
  { code: "DE", label: "유럽(독일)" },
];

async function fetchHolidayEvents(
  startDate: string,
  endDate: string,
): Promise<{ date: string; event: string }[]> {
  const y1 = Number(startDate.slice(0, 4));
  const y2 = Number(endDate.slice(0, 4));
  const years = y1 === y2 ? [y1] : [y1, y2];
  const results = await Promise.all(
    HOLIDAY_COUNTRIES.flatMap((c) =>
      years.map(async (y) => {
        try {
          const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${y}/${c.code}`, {
            signal: AbortSignal.timeout(8_000),
          });
          if (!res.ok) return [];
          // localName 은 그 나라 언어 그대로라(일본어 한자·중국어 간체 등)
          // 한글 리포트에서 읽기 어렵다 — 영문 name 을 대신 쓴다(실측 확인,
          // 2026-09-19: "敬老の日" 대신 "Respect for the Aged Day").
          const rows = (await res.json()) as { date: string; name: string }[];
          return rows
            .filter((r) => r.date >= startDate && r.date <= endDate)
            .map((r) => ({ date: r.date, event: `${c.label} 휴장 — ${r.name}` }));
        } catch {
          return [];
        }
      }),
    ),
  );
  return results.flat();
}

interface FixedCalendarEvent {
  date: string;
  event: string;
  /** 같은 날짜에 Gemini 가 이미 같은 이벤트를 독립적으로 언급했는지
   * 판별하는 키워드 — 날짜만으로 중복 판정하면 같은 날 다른 이벤트가
   * 있을 때 잘못 걸러진다(실측 버그, 네 마녀의 날이 BOJ 회의에 가려짐). */
  dedupe: RegExp;
}

async function computeFixedCalendarEvents(
  startDate: string,
  endDate: string,
  meetings: CbMeeting[],
): Promise<FixedCalendarEvent[]> {
  const inRange = (d: string) => d >= startDate && d <= endDate;
  const out: FixedCalendarEvent[] = [];
  const quadWitching = computeQuadWitching(startDate, endDate);
  if (quadWitching) out.push({ ...quadWitching, dedupe: /네\s*마녀|만기일/ });
  // 손으로 박아둔 배열 대신 공식 소스에서 가져온 일정을 쓴다(cb-calendar.ts).
  const meetingEvent: Record<string, { event: string; dedupe: RegExp }> = {
    [BANK_FOMC]: { event: "미국 FOMC 금리 결정", dedupe: /FOMC|연준.*금리|Fed\b/i },
    [BANK_BOJ]: { event: "일본은행(BOJ) 금융정책결정회의", dedupe: /BOJ|일본은행/i },
    [BANK_BOK]: { event: "한국은행 금융통화위원회", dedupe: /한국은행|금통위|한은\b/ },
  };
  for (const m of meetings) {
    const spec = meetingEvent[m.bank];
    if (spec && inRange(m.date)) out.push({ date: m.date, ...spec });
  }

  // CPI·PPI·GDP·고용지표는 FRED(공식 발표일)가 우선. 고용지표만 FRED가
  // 실패했을 때 "매월 첫째 금요일" 규칙으로 대신 채운다(FRED 성공 시 규칙
  // 계산은 버림 — 같은 이벤트가 두 번 들어가는 걸 막는다).
  const fredEvents = await fetchFredReleaseEvents(startDate, endDate).catch(() => []);
  const jobsRe = /고용지표|비농업|Employment Situation|Nonfarm/i;
  for (const f of fredEvents) out.push({ ...f, dedupe: jobsRe.test(f.event) ? jobsRe : new RegExp(escapeRegExp(f.event)) });
  if (!fredEvents.some((f) => jobsRe.test(f.event))) {
    const jobsReport = computeJobsReport(startDate, endDate);
    if (jobsReport) out.push({ ...jobsReport, dedupe: jobsRe });
  }

  const holidays = await fetchHolidayEvents(startDate, endDate).catch(() => []);
  for (const h of holidays) {
    const name = h.event.split(" — ")[1] ?? h.event;
    out.push({ ...h, dedupe: new RegExp(escapeRegExp(name)) });
  }
  return out;
}

/** issues.ts WEEKLY_TOPICS 의 정확한 라벨과 일치해야 한다. */
const POLICY_TOPIC_LABELS = ["미국 금리·연준", "한국은행·국내 금리", "일본은행·엔화"];

const MARKET_LABEL: Record<string, string> = {
  "kr-kospi": "코스피",
  "kr-kosdaq": "코스닥",
  us: "미국",
  jp: "일본",
  eu: "유럽",
};

function flattenSectors(sectors: WeeklySectors): CommentPayload["sectors"] {
  const groups: SectorHighlight[] = [
    ...sectors.kospi.up,
    ...sectors.kospi.down,
    ...sectors.kosdaq.up,
    ...sectors.kosdaq.down,
    ...sectors.us.up,
    ...sectors.us.down,
    ...sectors.jp.up,
    ...sectors.jp.down,
    ...sectors.eu.up,
    ...sectors.eu.down,
  ];
  return groups.map((s) => ({
    id: s.id,
    market: MARKET_LABEL[s.market] ?? s.market,
    label: s.label,
    direction: s.direction,
    pct: Math.round(s.pct * 100) / 100,
    startDate: s.startDate,
    endDate: s.endDate,
  }));
}

function buildPayload(
  snapshot: SnapshotRow[],
  issues: WeeklyIssue[],
  week: ReportWeek,
  allIssues: WeeklyIssue[],
  sectors: WeeklySectors,
  meetings: CbMeeting[],
): CommentPayload {
  const weekEndMs = Date.parse(`${week.weekEnd}T00:00:00Z`);
  const nextStart = new Date(weekEndMs + 3 * 86_400_000).toISOString().slice(0, 10); // 금→월
  const nextEnd = new Date(weekEndMs + 7 * 86_400_000).toISOString().slice(0, 10); // 금→그다음 금
  const policyEvidence = POLICY_TOPIC_LABELS.map((label) => {
    const found = allIssues.find((i) => i.label === label);
    return {
      label,
      reports: (found?.reports ?? []).map((r) => ({ date: r.date, source: r.source, stockName: r.stockName, title: r.title })),
      news: (found?.news ?? []).map((n) => ({
        title: n.title,
        excerpt: n.excerpt,
        source: n.source,
        publishedAt: n.publishedAt,
      })),
    };
  }).filter((p) => p.reports.length > 0 || p.news.length > 0);
  return {
    reportWeek: { start: week.weekStart, end: week.weekEnd },
    nextWeek: { start: nextStart, end: nextEnd },
    topMovers: computeTopMovers(snapshot),
    policyEvidence,
    // 리포트 주 시작일 기준 — 그 주에 열린 회의도 "이번 주 무슨 일이
    // 있었는지" 서술에 필요하므로 nextWeek 이 아니라 weekStart 부터.
    centralBankMeetings: meetings,
    sectors: flattenSectors(sectors),
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

interface MacroResponse {
  headline?: string;
  policySummary?: string;
  calendar?: { date?: string; event?: string }[];
}

interface CommentsOnlyResponse {
  snapshot?: Record<string, string>;
  issues?: Record<string, string>;
  sectors?: Record<string, string>;
}

function tryParse<T>(s: string): T | null {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" ? (v as T) : null;
  } catch {
    return null;
  }
}

/** 출력 형식을 "JSON만" 이라고 강제해도 앞뒤에 설명을 붙이는 경우가 있어
 * 코드펜스 제거 → 실패하면 첫 '{' ~ 마지막 '}' 만 다시 시도한다. */
function parseJson<T>(text: string, label: string): T | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "");
  const direct = tryParse<T>(cleaned);
  if (direct) return direct;
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const loose = tryParse<T>(cleaned.slice(start, end + 1));
    if (loose) return loose;
  }
  console.warn(`[weekly] Gemini(${label}) 응답 JSON 파싱 실패 — 응답 앞 300자: ${text.slice(0, 300)}`);
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

// 통계적 주장으로 보이는 "숫자+단위" 조합만 뽑는다(서수·"2주 연속" 같은
// 평범한 소수는 자연어에 흔해 오탐이 크다). verifyComment() 도 같은
// 정규식으로 코멘트를 검사하므로 여기서 먼저 선언해 재사용한다.
const CLAIM_NUM_RE = /(-?\d+(?:\.\d+)?)\s*(%|bp|배|pt|건)/g;

function extractNumbers(text: string): number[] {
  return [...text.matchAll(CLAIM_NUM_RE)].map((m) => Number(m[1]));
}

/**
 * 검증 단계 입력 — 코멘트가 인용할 수 있는 "실제 수치" 전체 목록.
 *
 * 근거로 준 리포트·뉴스 제목/요약문 안의 숫자도 반드시 포함해야 한다 —
 * 안 그러면 Gemini가 근거를 그대로 인용해도("美 8월 CPI 3.4%↑" 제목의
 * "3.4%") "우리 데이터에 없는 수치"로 오판돼 코멘트 전체가 버려진다
 * (실측 — 근거가 가장 풍부했던 "물가·인플레이션" 이슈만 계속 코멘트가
 * 비던 진짜 원인. 근거를 주고 그 근거를 인용하면 검열하는 자기모순이었다).
 */
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
    for (const r of i.reports) {
      nums.push(...extractNumbers(r.title));
    }
    for (const n of i.news) {
      nums.push(...extractNumbers(n.title));
      if (n.excerpt) nums.push(...extractNumbers(n.excerpt));
    }
  }
  for (const p of payload.policyEvidence) {
    for (const r of p.reports) nums.push(...extractNumbers(r.title));
    for (const n of p.news) {
      nums.push(...extractNumbers(n.title));
      if (n.excerpt) nums.push(...extractNumbers(n.excerpt));
    }
  }
  for (const s of payload.sectors) nums.push(s.pct);
  return nums;
}

/**
 * @param trustGrounded 그라운딩이 실제로 출처를 찾아왔을 때 true — 우리가
 *   안 가진 사실(웹검색으로 확인한 수치)을 인용하는 게 정상이므로 수치
 *   대조를 건너뛴다. false 면(그라운딩 꺼짐/검색 실패) 기존처럼 엄격 검증.
 */
function verifyComment(raw: string, allowed: number[], trustGrounded: boolean): string {
  const text = raw.trim();
  if (!text) return "";
  if (trustGrounded) return text;
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
 * 매크로 호출(한 줄 결론·정책요약·캘린더)만 그라운딩 실패 시 1회 재시도
 * (오너 지시 2026-09-18 — "4,5번 개선해", 정책요약·캘린더가 그라운딩
 * 미스로 자주 빈 채 나오던 문제). 코멘트 호출은 이런 문제가 덜해 재시도
 * 안 함 — 실패해도 추가 비용만 든다. 재시도 발생분까지 usage 를 전부
 * 합산해서 돌려준다(실제로 청구된 비용이므로).
 */
async function callMacroWithRetry(userJson: string): Promise<{ result: GeminiResult; attempts: GeminiResult[] }> {
  const attempts: GeminiResult[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await geminiGenerate({
      system: MACRO_PROMPT,
      user: userJson,
      grounding: true,
      temperature: 0.25,
      maxOutputTokens: 16_000,
    });
    attempts.push(r);
    if (r.groundingSources.length > 0) break;
    if (attempt === 1) {
      console.warn("[weekly] 매크로 호출 그라운딩 실패(정책요약·캘린더 못 채움 위험) — 1회 재시도");
    }
  }
  return { result: attempts[attempts.length - 1], attempts };
}

/**
 * Gemini 로 스냅샷·이슈 코멘트를 생성한다. 설정이 없거나 이슈가 비면 null —
 * 호출부는 rule-based(빈 코멘트)로 조용히 폴백한다(이 프로젝트의 기존
 * "실패 시 해당 부분만 생략" 패턴과 동일).
 */
export async function generateWeeklyComments(
  snapshot: SnapshotRow[],
  issues: WeeklyIssue[],
  week: ReportWeek,
  allIssues: WeeklyIssue[],
  sectors: WeeklySectors,
): Promise<{ comments: WeeklyComments; result: GeminiResult } | null> {
  if (!isGeminiConfigured() || issues.length === 0) return null;

  // 중앙은행 회의 일정은 공식 소스에서 가져온다(cb-calendar.ts). 프롬프트
  // 입력과 "다음 주 일정" 캘린더가 같은 목록을 쓰도록 여기서 한 번만 조회.
  const meetings = await getCentralBankMeetings(week.weekStart);
  const payload = buildPayload(snapshot, issues, week, allIssues, sectors, meetings);
  const userJson = JSON.stringify(payload);
  const allowed = buildAllowedNumbers(payload);
  const snapshotNames = payload.snapshot.map((r) => r.name);
  const issueLabels = payload.issues.map((i) => i.label);
  const sectorIds = payload.sectors.map((s) => s.id);
  // 매크로 콜(한 줄 결론·정책요약·캘린더)은 sectors 를 전혀 안 쓴다 — 그런데도
  // 코멘트 콜과 같은 payload(userJson)를 그대로 넘기면 섹터 16개만큼 입력이
  // 불필요하게 커져서, 이미 그라운딩 미스가 잦다고 알려진 매크로 콜(재시도
  // 로직이 있는 이유)의 실패율을 더 키운다(실측 — sectors 추가 이후 "다음 주
  // 일정"이 옛 기사-표 폴백으로 자주 떨어짐). 매크로 콜에는 sectors 를 뺀
  // 별도 payload 를 준다.
  const macroJson = JSON.stringify({ ...payload, sectors: undefined });

  const [macroCall, commentResult] = await Promise.all([
    callMacroWithRetry(macroJson),
    geminiGenerate({
      system: COMMENT_PROMPT,
      user: userJson,
      grounding: true,
      temperature: 0.25,
      maxOutputTokens: 16_000,
    }),
  ]);
  const macroResult = macroCall.result;

  const comments: WeeklyComments = {
    headline: null,
    policySummary: null,
    calendar: null,
    snapshot: new Map(),
    issues: new Map(),
    sectors: new Map(),
  };

  // --- 매크로(한 줄 결론·정책요약·캘린더) ---
  const macroParsed = parseJson<MacroResponse>(macroResult.text, "매크로");
  const macroTrustGrounded = macroResult.groundingSources.length > 0;
  console.warn(
    `[weekly] Gemini(매크로) 응답 요약 — model=${macroResult.model}, 응답길이=${macroResult.text.length}자, ` +
      `groundingSources=${macroResult.groundingSources.length}건, trustGrounded=${macroTrustGrounded}, ` +
      `parseJson성공=${macroParsed != null}`,
  );
  comments.headline = macroParsed?.headline
    ? verifyComment(macroParsed.headline, allowed, macroTrustGrounded) || null
    : null;

  // policySummary — 날짜·기관명 등 검증 불가능한 구체적 사실을 담을 수
  // 있으므로, 그라운딩 성공 **또는** 우리가 이미 모아둔 policyEvidence
  // (실제 리포트·뉴스)가 있을 때만 신뢰한다(오너 지시 2026-09-18 — "4번은
  // 사실밖에 없는 정책 얘기인데 없다는게 이상하다": 매번 실시간 검색
  // 성공에만 기대지 않고, 이미 검증된 근거가 있으면 그걸로도 충분히
  // 신뢰할 수 있다). 숫자 검증은 그라운딩 여부에 따라 그대로 적용.
  const hasPolicyEvidence = payload.policyEvidence.length > 0;
  if ((macroTrustGrounded || hasPolicyEvidence) && macroParsed?.policySummary) {
    comments.policySummary = verifyComment(macroParsed.policySummary, allowed, macroTrustGrounded) || null;
  }
  if (!comments.policySummary) {
    console.warn(
      `[weekly] policySummary 미채움 — trustGrounded=${macroTrustGrounded}, hasPolicyEvidence=${hasPolicyEvidence}, parsed=${JSON.stringify(macroParsed?.policySummary ?? null)}`,
    );
  }
  if (macroTrustGrounded && Array.isArray(macroParsed?.calendar)) {
    const nextStart = payload.nextWeek.start;
    const nextEnd = payload.nextWeek.end;
    comments.calendar = macroParsed.calendar
      .filter(
        (c): c is { date: string; event: string } =>
          typeof c?.date === "string" &&
          typeof c?.event === "string" &&
          c.date >= nextStart &&
          c.date <= nextEnd,
      )
      .sort((a, b) => a.date.localeCompare(b.date));
  } else if (!macroTrustGrounded || macroParsed?.calendar) {
    console.warn(
      `[weekly] calendar 미채움 — trustGrounded=${macroTrustGrounded}, parsed=${JSON.stringify(macroParsed?.calendar ?? null)}`,
    );
  }
  // 네 마녀의 날·FOMC·BOJ·한국은행 금통위·미국 고용지표(첫째 금요일)·
  // 시장 휴장일(Nager.Date)은 전부 검색 없이 코드로 확정할 수 있다(오너
  // 지시 2026-09-18 "5번은 정해진 일정인데 없다는게 더 이상하다", 2026-09-19
  // "그라운딩이 계속 실패해 결국 안 채워진다" — 그라운딩 성공 여부에
  // 기대지 않는 항목을 최대한 늘림). 그라운딩 결과와 무관하게 항상 포함
  // — "같은 날짜"가 아니라 "이미 같은 이벤트가 그 날짜에 있는지"로 중복을
  // 판정한다(실측 버그 — 같은 날 BOJ 회의가 있어서 날짜만 보고 건너뛰는
  // 바람에 네 마녀의 날 자체가 통째로 빠짐. 한 날짜에 이벤트가 여러 개
  // 있는 건 정상이다).
  const fixedEvents = await computeFixedCalendarEvents(
    payload.nextWeek.start,
    payload.nextWeek.end,
    payload.centralBankMeetings,
  );
  if (fixedEvents.length > 0) {
    let list = comments.calendar ?? [];
    for (const fx of fixedEvents) {
      const alreadyListed = list.some((c) => c.date === fx.date && fx.dedupe.test(c.event));
      if (!alreadyListed) list = [...list, { date: fx.date, event: fx.event }];
    }
    comments.calendar = list.sort((a, b) => a.date.localeCompare(b.date));
  }

  // --- 코멘트(스냅샷·이슈) ---
  const commentParsed = parseJson<CommentsOnlyResponse>(commentResult.text, "코멘트");
  const commentTrustGrounded = commentResult.groundingSources.length > 0;
  console.warn(
    `[weekly] Gemini(코멘트) 응답 요약 — model=${commentResult.model}, 응답길이=${commentResult.text.length}자, ` +
      `groundingSources=${commentResult.groundingSources.length}건, trustGrounded=${commentTrustGrounded}, ` +
      `parseJson성공=${commentParsed != null}`,
  );

  for (const [rawName, text] of Object.entries(commentParsed?.snapshot ?? {})) {
    const canonical = matchCanonical(rawName, snapshotNames);
    if (!canonical) {
      console.warn(`[weekly] 스냅샷 코멘트 키 불일치 — "${rawName}" 는 알려진 자산명이 아님`);
      continue;
    }
    const v = verifyComment(String(text ?? ""), allowed, commentTrustGrounded);
    if (v) comments.snapshot.set(canonical, v);
  }
  for (const [rawLabel, text] of Object.entries(commentParsed?.issues ?? {})) {
    const canonical = matchCanonical(rawLabel, issueLabels);
    if (!canonical) {
      console.warn(`[weekly] 이슈 코멘트 키 불일치 — "${rawLabel}" 는 알려진 이슈명이 아님`);
      continue;
    }
    const v = verifyComment(String(text ?? ""), allowed, commentTrustGrounded);
    if (v) comments.issues.set(canonical, v);
  }
  for (const [rawId, text] of Object.entries(commentParsed?.sectors ?? {})) {
    // id 는 코드가 만든 단순 문자열(kr-up-1 등)이라 fuzzy 매칭 없이 정확히
    // 일치해야 한다 — 모델이 다른 값을 돌려주면 그냥 버린다(오염 방지).
    if (!sectorIds.includes(rawId)) {
      console.warn(`[weekly] 섹터 코멘트 키 불일치 — "${rawId}" 는 알려진 섹터 id 가 아님`);
      continue;
    }
    const v = verifyComment(String(text ?? ""), allowed, commentTrustGrounded);
    if (v) comments.sectors.set(rawId, v);
  }

  const missingIssues = issueLabels.filter((l) => !comments.issues.has(l));
  if (missingIssues.length > 0) {
    console.warn(
      `[weekly] 이슈 코멘트 누락: [${missingIssues.join(", ")}] — Gemini 응답 issues 원본 키: ${JSON.stringify(Object.keys(commentParsed?.issues ?? {}))}, trustGrounded=${commentTrustGrounded}`,
    );
  }

  // 매크로 재시도분까지 포함해 실제 청구된 비용을 전부 합산한다(재시도로
  // 버린 첫 응답도 돈은 이미 냈으므로 usage 에서 누락하면 안 됨).
  const macroUsage = macroCall.attempts.reduce(
    (acc, r) => ({
      inputTokens: acc.inputTokens + r.usage.inputTokens,
      outputTokens: acc.outputTokens + r.usage.outputTokens,
      thoughtTokens: acc.thoughtTokens + r.usage.thoughtTokens,
      costUsd: acc.costUsd + r.usage.costUsd,
    }),
    { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, costUsd: 0 },
  );
  const macroGroundingQueries = macroCall.attempts.flatMap((r) => r.groundingQueries);
  const macroGroundingSources = macroCall.attempts.flatMap((r) => r.groundingSources);

  // 두 호출 결과를 하나로 합쳐서 돌려준다 — 호출부(generate.ts)는 여전히
  // "호출 하나" 인터페이스로 usage/그라운딩 출처를 저장한다.
  const mergedResult: GeminiResult = {
    text: `${macroResult.text}\n${commentResult.text}`,
    model: macroResult.model,
    usage: {
      inputTokens: macroUsage.inputTokens + commentResult.usage.inputTokens,
      outputTokens: macroUsage.outputTokens + commentResult.usage.outputTokens,
      thoughtTokens: macroUsage.thoughtTokens + commentResult.usage.thoughtTokens,
      costUsd: macroUsage.costUsd + commentResult.usage.costUsd,
    },
    groundingQueries: [...macroGroundingQueries, ...commentResult.groundingQueries],
    groundingSources: [...macroGroundingSources, ...commentResult.groundingSources],
  };

  return { comments, result: mergedResult };
}
