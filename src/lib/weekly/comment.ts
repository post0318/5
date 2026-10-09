import "server-only";
import { formatScheduleTitle, isMajorScheduleItem, type ScheduleItem } from "./shinhan-schedule";
import type { OfficialMetric } from "./evidence";
import type { SectorNews } from "./sector-news";
import {
  BANK_BOJ,
  BANK_BOK,
  BANK_FOMC,
  BANK_MENTION_RE,
  getCentralBankMeetings,
  type CbMeeting,
} from "./cb-calendar";
import type { SnapshotRow } from "@/lib/db/weekly-reports";
import { snapshotChangeText, snapshotValueText } from "./snapshot";
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

/**
 * 이슈 코멘트 — headline·reading 만 담는다(오너 지시 2026-10-01 — "핵심
 * 이슈를 뽑아서 작성할 때 깊이가 이 정도는 필요하다. LLM 아니어도
 * 가능하지 않냐?" → "해봐"). **facts 는 더 이상 LLM 이 쓰지 않는다** —
 * `WeeklyIssue.facts`(evidence.ts `buildFactsFromEvidence`)가 그 이슈의
 * 증권사 리포트·뉴스 제목에서 코드로 직접 뽑아 포맷한다(이미 실제
 * 데이터라 LLM 이 웹검색으로 재확인할 필요도, 수치를 지어낼 위험도 없다).
 * LLM 은 그 facts 를 **입력**으로 받아 headline·reading 만 쓴다.
 */
export interface IssueComment {
  /** 그 주 실제 화두를 짧게 담은 제목(오너 지시 2026-10-01 — "미국 증시
   * 밸류에이션이라고 했지만 AI 속도조절론이 화두였다... 단편적으로 정해진
   * 제목을 쓰는건 금지한다"). `WeeklyIssue.label`(토픽 사전의 고정 분류명,
   * 빈도 집계용 내부 키)을 화면 제목으로 그대로 쓰지 않고, 입력으로 받은
   * facts 를 보고 모델이 매주 새로 뽑는다 — 없으면 label 로 폴백
   * (render.ts). */
  headline: string | null;
  /** facts(입력)가 왜 중요한지, 무엇을 주시해야 하는지. */
  reading: string;
}

export interface WeeklyComments {
  /** "1. 한 줄 결론" — 가장 크게 움직인 자산과 이슈 근거를 인과관계로 엮은
   * 한 문장(오너 지시 2026-09-18 — "딸랑 상승·하락 2개만 적고 끝이냐,
   * 원인이든 결과든 인과가 있어야". 근거가 약하면 null → 렌더링 쪽이
   * 기존 `movers()`(사실 나열)로 폴백한다. */
  headline: string | null;
  /**
   * "5. 경제" 요약 문단(오너 지시 2026-09-21 — "경기와 관련된 내용을
   * 요약하도록 하자. 위치는 금리정책보다 앞에"). 관세·중국 경기·고용·
   * 금·구리 등 "경기" 계열 주제는 서로 포함 관계가 없어(금과 구리는
   * 방향조차 반대) 「3. 핵심 이슈」의 계열당-1개 규칙에서 거의 항상 밀린다
   * (실측: 최고점 계열이 0.25 안팎으로 다른 계열의 0.5~0.7 대에 못 미침 —
   * "경기는 안나오네"). 그래서 경쟁시키지 않고 전용 섹션을 둔다.
   * economyEvidence 를 우선 활용, 그라운딩 성공 또는 그 근거가 있을 때만
   * 채워진다 — policySummary 와 같은 신뢰 조건.
   */
  economySummary: string | null;
  /** "6. 금리정책" 맨 위에 붙는 종합 요약 문단(오너 지시 2026-09-18 —
   * "네이버 AI 요약도 이 정도는 한다"). 그라운딩 성공 또는 이미 수집된
   * policyEvidence(실제 리포트·뉴스)가 있을 때 채워진다 — 둘 다 없으면
   * null → 화면이 안내 문구만 보여준다. */
  policySummary: string | null;
  /** "7. 다음 주 주시 일정" — 날짜별 확정 이벤트 캘린더(오너 지시
   * 2026-09-18 — "관련 기사 목록이 아니라 일자별 캘린더를 원한 거다").
   * 그라운딩 성공일 때만 채워진다 — 실패하면 null → 기존 기사 표로 폴백. */
  calendar: { date: string; event: string }[] | null;
  /** key = SnapshotRow.name */
  snapshot: Map<string, string>;
  /** key = WeeklyIssue.label. facts(이젠 `WeeklyIssue.facts` — 코드가
   * reports/news 에서 직접 뽑음)를 보고 LLM 이 headline·reading 만 쓴다
   * (오너 지시 2026-10-01, 위 IssueComment 주석 참고). */
  issues: Map<string, IssueComment>;
  /** "주요 섹터 이슈"(오너 지시 2026-09-19) — key = SectorHighlight.id
   * (예: "kr-up-1", "combined-down-2"). 등락률·순위는 코드(sectors.ts)가
   * 이미 계산해 확정하고, 여기엔 "왜 그렇게 움직였는지" 코멘트만 담는다. */
  sectors: Map<string, string>;
  /**
   * 코멘트가 빈 채로 남은 이유(오너 지시 2026-09-21 — "폐기사유 넣으라는거").
   * 원인 없이 "비어 있음"만 보면 검증이 걸러낸 건지, 모델이 아예 안 쓴 건지,
   * 그라운딩이 실패한 건지 구분이 안 됐다(실측: 3개 이슈 중 1개만 코멘트가
   * 비어 원인을 못 밝힘). 키는 "headline" | "policySummary" | "calendar" |
   * `snapshot:${name}` | `issue:${label}` | `sector:${id}`. 값이 채워진
   * 항목에는 키가 없다.
   */
  dropReasons: Map<string, string>;
  /** 웹검색 소형 호출이 모은 사실 — 검수용으로 문서에 남긴다(무엇을 근거로 썼는지 확인) */
  webFacts: WebFact[];
}

const INPUT_DATA_DESC = `# 입력 데이터
사용자 메시지는 JSON 객체 하나다.
- webFacts: 별도 웹검색 호출이 **검색 출처를 확인하고** 모아 온 이번 주 사실(정책
  발언·지표 결과·자산별 등락 원인, topic·fact·source). 검증된 검색 결과이므로
  그대로 근거로 쓰고 숫자도 그대로 인용해도 된다. 네가 직접 검색할 필요가 줄어든다.
- reportWeek: 이 리포트가 다루는 주(월~금).
- nextWeek: reportWeek 바로 다음 주(월~금) — calendar 는 이 기간 대상.
- topMovers: 이번 주 가장 많이 오른/내린 자산(코드가 계산한 값, 참고용).
- snapshot: 이번 주 자산별 종가·주간 변동(pct=주간 변동률%, diffBp=금리류
  변동폭 bp). value/pct/diffBp 가 null 이면 비교할 값이 없다는 뜻이다.
  **valueText·changeText 는 리포트 표에 그대로 찍히는 문자열**이다 — 본문에서
  자산의 종가·변동을 인용할 땐 반드시 이 문자열을 그대로 쓴다(예: 표가
  "5.28%"면 "5.277%"·"5.27%대"처럼 다른 자릿수로 쓰지 마라. 표와 본문 숫자가
  다르면 리포트 신뢰가 깨진다).
- economyMetrics: 이번 주(reportWeek)에 **새로 발표된** 미국 공식 지표(FRED, 코드가
  계산). text 가 확정 표기다 — 인용할 땐 text 의 숫자·단위를 그대로 쓴다.
  비어 있으면 그 주에 새로 나온 공식 지표가 없다는 뜻이다(지난 발표분을 이번 주
  소식처럼 쓰지 마라).
- issues: 이번 주 핵심 이슈 후보(증권사 리포트·뉴스 빈도로 뽑힘). reports·
  news·earnings(실적 서프라이즈)·metrics(FRED 거시지표)가 근거로 들어있고,
  **facts 는 그 reports/news 에서 코드가 이미 뽑아 둔 사실 줄**이다(실제
  리포트·뉴스 제목/요약이라 이미 진짜 데이터 — 다시 찾거나 검증할 필요
  없음). headline·reading 을 쓸 때 이 facts 를 그대로 근거로 삼아라.
- policyEvidence: 미국 금리·연준/한국은행/일본은행 주제로 이미 수집된
  증권사 리포트·뉴스 근거(근거 있는 주제만 포함). policySummary 를 쓸 때
  최우선으로 활용한다.
- economyEvidence: 관세·통상/중국 경기/고용/브라질 국채/금/원달러 환율/
  구리 등 산업금속/BDI·해운운임 주제로 이미 수집된 증권사 리포트·뉴스
  근거(근거 있는 주제만 포함). economySummary 를 쓸 때 최우선으로 활용한다.
- nextWeekSchedule: 신한투자증권 「이슈 및 섹터 스케줄」에서 가져온 nextWeek 기간의
  거시·시장 일정(해외/국내 지표·이슈, 없을 수 있음). calendar 를 쓸 때 **반드시
  참조**하는 1차 후보 목록이다 — 다만 그대로 옮기지 말고 웹검색으로 날짜가 확인되는
  항목만 채택한다(검증). 요일·시차(현지시간)가 애매하면 뺀다.
- sectors: 이번 주 한국·미국·일본·유럽 증시의 상승/하락 상위 섹터(등락률은 코드가
  이미 계산해 확정). leaders 는 그 섹터를 실제로 끌고 간 종목(등락률 포함),
  headlines 는 그 종목들의 그 주 기사 제목이다. 섹터 사유는 **leaders 와
  headlines 로만** 설명한다 — 섹터 이름만 보고 업종 일반론(예: 소재 → 2차전지,
  산업재 → 방산)을 붙이지 마라.
- centralBankMeetings: 미국 FOMC·일본은행(BOJ)·한국은행 금통위의 **남은
  공식 회의 일정 전부**(각 중앙은행·Kalshi 공식 캘린더에서 실시간 조회).

# 중앙은행 회의 일정 (절대 규칙)
- **앞으로 열릴 회의의 월·날짜를 직접 쓰지 마라.** "다음 회의", "차기
  금통위"처럼만 쓰면 실제 날짜는 **코드가 괄호로 붙인다**(예: 네가 "다음
  회의에서 결정될 전망" 이라고 쓰면 화면엔 "다음 회의(10/28)에서 결정될
  전망" 으로 나간다). 월을 직접 쓰면 그 코멘트는 통째로 폐기된다.
  실측 오류(2026-09): 2026년 FOMC 는 10/28 다음이 12/09 라 11월 회의가
  없는데 "11월 추가 인상 여부가 결정될 것"이라고 썼다. FOMC 는 연 8회라
  회의가 아예 없는 달이 있다.
- 이미 열린 회의(리포트 주 이전)는 centralBankMeetings 의 날짜를 그대로
  인용해도 된다 — "9월 FOMC에서 인상" 처럼.`;

const MACRO_PROMPT = `# 역할
너는 국내 자산운용사 소속 시니어 매크로·주식 애널리스트다. 이번 주 전체
흐름을 종합해서 "한 줄 결론"·"경제 요약"·"금리정책 요약"·"다음 주 일정
캘린더"를 쓰는 게 임무다. 리포트의 표·숫자는 이미 코드로 완성돼 있으니
다시 만들지 않는다. 확실치 않으면 **웹검색으로 실제 사실을 확인**하고
인용해라 — 짐작으로 채우지 마라.

${INPUT_DATA_DESC}

# 작성 원칙 (반드시 지킬 것)
1. **headline(한 줄 결론)** — 스냅샷 표 전체를 훑고 "이번 주 시장이 무엇
   때문에 이렇게 흘렀는지"를 종합해 한 문장으로 쓴다. topMovers 하나만
   짚는 게 아니라, 여러 자산에 걸쳐 공통으로 작용한 배경(금리 결정, 유가
   급등, 인플레이션 지표 등)이 있으면 그걸 중심으로 삼아라. 예: "미 CPI
   서프라이즈발 금리 인상 우려와 유가 급등이 겹치며 위험자산은 눌리고
   원자재는 강세를 보인 한 주." 근거가 정말 없을 때만 topMovers 사실
   나열로 대체한다. 120자 내외.
2. **economySummary** — 통화정책(중앙은행)을 뺀 그 외 거시경제 동향
   종합. 대상: 관세·통상, 중국 경기·부양책, 고용지표, 브라질 국채,
   금 가격, 원달러 환율, 구리 등 산업금속, BDI·해운운임. **economyMetrics(그
   주에 새로 발표된 공식 지표)와 economyEvidence 의 근거를 최우선으로 활용**하고,
   부족한 부분만 웹검색으로 보강해라. economyMetrics 가 비어 있지 않으면 그 지표
   (예: 비농업 고용·실업률·PCE 물가)를 다루는 줄은 반드시 넣는다 — 그 주 가장 큰
   거시 소식인데 경제 섹션에서 빠지면 안 된다. 공식 지표 수치는 text 그대로.
   이 항목들은 서로 인과관계가 뚜렷하지 않은 개별 신호(금은 안전자산
   수요, 구리·BDI는 경기 선행지표, 원달러는 환율 그 자체)라 **주제별로
   줄을 바꿔라** — policySummary 와 같은 원칙. 마크다운 리스트로
   "- 관세·통상: ...", "- 원달러 환율: ...", "- 금값: ..." 처럼 그 주에
   실제 움직임·소식이 있던 주제만 한 줄씩(각 1~2문장) 쓴다. 아무 주제도
   특별한 움직임이 없으면 null 로 남긴다(억지로 채우지 마라).
3. **policySummary** — 미국 연준(FOMC)·한국은행·일본은행의 이번 주 통화
   정책 동향. **policyEvidence 의 근거를 최우선으로 활용**하고, 부족한
   부분만 웹검색으로 보강해라. 단순 기사 나열이 아니라 "그 중앙은행이
   이번 주 무엇을 했거나 시사했는지, 시장이 어떻게 반응했는지"를
   종합 서술한다(포털 AI 검색 요약 수준을 목표로 한다 — 얕은 사실 나열
   금지). **한 문단으로 뭉쳐 쓰지 말고, 은행별로 줄을 바꿔라**(오너 지시
   2026-09-19 — "시장별로 줄바꿈"): 마크다운 리스트로 "- 미국 연준(Fed):
   ...", "- 한국은행: ...", "- 일본은행(BOJ): ..." 세 줄을 개행 문자로
   구분해 하나의 문자열에 담아라. 그 은행 소식이 그 주에 전혀 없으면
   그 줄은 통째로 뺀다(세 줄을 억지로 채우지 마라). policyEvidence 에도
   없고 웹검색으로도 확인 안 되는 은행만 아는 범위까지 쓰고, 셋 다 없으면
   null 로 남긴다. **각 줄 1~3문장, 구체적인 수준으로**(오너 지시
   2026-10-01 — 타사가 만든 "글로벌 국채 매도세" 요약을 보여주며 "금리
   정책을 너두 잘 정리했다": 그 글은 "BOJ가 물가 억제에 초점을 두며
   초완화 정책 기대가 약해졌고 이에 일본 국채 금리가 상승"처럼 정책
   스탠스 변화와 시장 반응(금리 수준·방향)을 구체적으로 짝지어 썼다).
   "금리를 동결했다" 같은 한 줄 사실 나열에 그치지 말고, 가능하면
   (a) 이번 주 실제로 밝힌 입장/발언, (b) 그로 인해 시장(국채금리·
   환율 등)이 어떻게 움직였는지, (c) 다음 회의까지 시장이 주시하는
   지점을 이어서 짚어라 — 단, 숫자는 이번에도 제공된 값이거나 웹검색
   으로 확인한 것만(4번 규칙 그대로).
4. **calendar** — nextWeek(다음 주) 기간의 날짜별 확정 경제 일정. 입력의
   nextWeekSchedule(신한투자증권 스케줄)을 반드시 먼저 참조하고, 웹검색으로 확인되는 것만 담는다. "관련
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
5. 제공된 JSON의 수치는 그대로 인용해도 된다. 그 외의 새 수치를 쓸 때는
   **실제 웹검색으로 확인한 것만** 쓴다 — 확인 안 되면 수치 없이
   정성적으로만 서술한다.
6. 간결한 애널리스트 어조(~음/~함 체). 미사여구·감탄사·전망 단정
   ("반드시", "확실히") 금지.

# 출력 형식
마크다운 코드펜스나 설명 없이, 아래 스키마의 JSON 객체만 출력한다:
{"headline": "한 줄 결론", "economySummary": "경제 요약 또는 null", "policySummary": "정책 요약 또는 null", "calendar": [{"date": "YYYY-MM-DD", "event": "..."}]}`;

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
2. **issues 는 headline(제목)·reading(해석)만 쓴다 — facts 는 이미 입력에
   채워져 있다(코드가 reports/news 에서 직접 뽑음, 오너 지시 2026-10-01 —
   "핵심이슈를 뽑아서 작성할때 깊이가 이정도가 필요하다. LLM아니어도
   가능하지않냐?" → "해봐").** facts 를 다시 쓰거나 고치려 하지 마라 —
   출력 스키마에 facts 자리 자체가 없다. headline·reading 을 쓸 때 그
   이슈의 facts 배열(여러 줄, 동인별로 이미 나뉘어 있음)을 전부 읽고
   근거로 삼아라.
   - **headline: 그 주 실제 화두를 담은 자연스러운 제목, 10~30자.** issues
     항목의 label 은 빈도를 집계하려고 미리 정해 둔 넓은 분류명일 뿐이지
     제목이 아니다 — **label 을 그대로 베끼거나 label 의 동의어로만
     채우는 건 금지**(오너 지시 2026-10-01 — "미국 증시 밸류에이션이라고
     했지만 AI 속도조절론이 화두였다", "단편적으로 정해진 제목을 쓰는건
     금지한다", "주제의 선정이 자연스러워야 한다" — 증권사 데일리 시황
     ("AI 추론 수요 확산과 유가 급락으로 반도체 주도 강세"처럼 그 주의
     여러 동인을 원인→결과로 자연스럽게 엮은 한 문구)과 같은 수준을
     목표로 한다). facts 에 실제로 나오는 구체적 사건·동인의 이름을
     붙이고, facts 에 서로 관련된 동인이 여럿이면 "A에 B까지 겹치며 C"
     식으로 자연스럽게 엮어 써도 된다(label 하나당 사건 하나로 쪼개 쓸
     필요 없음).
     - 나쁜 예(금지): label 이 "미국 증시·밸류에이션"일 때 headline 을
       "미국 증시 밸류에이션"·"미국 증시 동향"처럼 label 과 같은 말로 채움.
     - 좋은 예: facts 가 빅테크 AI 투자 속도 논쟁이면 "AI 속도조절론
       부상", facts 가 장기 국채 금리·텀프리미엄 급등이면 "글로벌 장기금리
       급등"(label 이 "글로벌 금리시장"이어도 "미국채 10년물 급등"처럼 그
       주 실제 진원지를 구체적으로 좁혀도 된다), facts 에 AI 수요·유가·
       반도체가 함께 나오면 "AI 수요 확산과 유가 급락에 반도체 주도 강세"
       처럼 엮어 쓴다.
     - facts 만으로 구체적인 제목을 못 뽑겠으면 빈 문자열로 남겨라(그러면
       화면이 label 로 대체한다) — label 을 억지로 바꿔 쓰지 말 것.
   - **reading: 해석.** facts 에 적힌 사실이 왜 중요한지(어떤 메커니즘으로
     시장·다른 자산에 영향을 주는지)와 다음에 무엇을 주시해야 하는지를
     200~400자로 쓴다. facts 가 여러 동인을 다뤘으면(타사가 만든 "글로벌
     국채 매도세" 요약처럼 "가장 큰 촉매" 하나 + 그걸 키운 여러 요인이
     나열돼 있을 수 있다) 그 동인들을 단순 재나열하지 말고 "A가 촉발했고
     B·C가 가세해" 식으로 **인과관계로 엮어서** 설명한다. facts 를
     문장으로 바꿔 적기만 하는 건 금지 — facts 에 이미 있다. 확정된
     사실이 아니면 "~로 보임", "~가능성"처럼 조심스럽게 쓴다.
3. **sectors: 이번 주 왜 그 섹터가 그렇게 오르내렸는지를 쓴다.** 등락률·
   순위는 이미 코드가 계산해 확정했으니 다시 쓰지 마라 — "이번 주 X.X%
   상승" 처럼 표에 이미 있는 숫자를 문장으로 바꿔 적기만 하는 건 금지
   (snapshot 규칙 1과 같은 이유). **그 섹터의 headlines(주도 종목 기사)에
   나온 사건만 근거로** 1~2문장(60자 내외)으로 쓰고, 어떤 주도 종목(leaders)의
   무슨 소식인지 종목명을 짚는다(예: "롯데에너지머티리얼즈 ○○ 소식에 급등").
   headlines 가 비었거나 등락 이유를 설명하지 못하면 **빈 문자열**로 남긴다 —
   섹터 이름만 보고 업종 일반론을 지어내는 건 금지(실측 오류: 솔브레인·
   동진쎄미켐(반도체 소재)이 끈 섹터를 "2차전지 소재 매수"로 씀). sectors
   항목의 id 값을 그대로 키로 써서 응답한다(예: "kr-up-1").
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
{"snapshot": {"<snapshot 항목의 name과 동일한 문자열>": "코멘트"}, "issues": {"<issues 항목의 label과 동일한 문자열>": {"headline": "그 주 화두 제목(구체적으로, label 복사 금지)", "reading": "해석"}}, "sectors": {"<sectors 항목의 id와 동일한 문자열>": "코멘트"}}
snapshot·issues·sectors 에 없는 키를 새로 만들지 말 것.`;

interface PayloadMetric {
  label: string;
  text: string;
  value: number;
  previous: number | null;
  unit: string;
}

function toPayloadMetric(m: { label: string; text: string; value: number; previous: number | null; unit: string }): PayloadMetric {
  return { label: m.label, text: m.text, value: m.value, previous: m.previous, unit: m.unit };
}

export interface CommentPayload {
  /** 웹검색 전용 호출(researchWebFacts)이 그 주에 확인한 사실 — 출처 도메인 포함 */
  webFacts: WebFact[];
  reportWeek: { start: string; end: string };
  nextWeek: { start: string; end: string };
  topMovers: { up: { name: string; pct: number } | null; down: { name: string; pct: number } | null };
  snapshot: {
    name: string;
    group: string;
    /** 표에 찍히는 값과 같은 자릿수로 반올림한 값 — 원값(5.277)을 주면 모델이
     * 본문에 "5.277%"·"5.27%대"처럼 표(5.28%)와 다른 숫자를 쓴다(2026-10-05 실측). */
    value: number | null;
    /** 표의 "종가" 칸과 같은 문자열 — 본문에서 수치를 인용할 땐 이것만 쓴다 */
    valueText: string | null;
    /** 표의 "주간 변동" 칸과 같은 문자열 */
    changeText: string;
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
    /** 코드가 reports/news 에서 이미 뽑아 포맷한 사실 줄(evidence.ts
     * `buildFactsFromEvidence`) — headline·reading 작성의 1차 근거. */
    facts: string[];
    reports: { date: string; source: string; stockName: string; title: string; summary?: string; pdfUrl?: string }[];
    news: { title: string; excerpt?: string; source: string; publishedAt: string; url?: string }[];
    earnings?: { ticker: string; period: string; epsActual: number | null; epsEstimate: number | null; surprisePct: number | null }[];
    /** 그 주에 새로 발표된 공식 지표만(evidence.ts fetchOfficialMetrics) — text 가 확정 표기 */
    metrics?: PayloadMetric[];
  }[];
  /** 리포트 주에 새로 발표된 미국 공식 지표 전부(FRED, 코드가 계산·표기 확정) —
   * economySummary 의 1차 근거. 화면 "5. 경제"에도 코드가 그대로 싣는다. */
  economyMetrics: PayloadMetric[];
  /** 미국 금리·연준/한국은행/일본은행 주제로 이미 수집된 근거 — 핵심
   * 이슈 3개(issues)에 안 뽑혀도 policySummary 는 이걸 우선 활용한다
   * (오너 지시 2026-09-18 — "4번은 사실밖에 없는 정책을 이야기하는건데
   * 없다는게 더 이상하다": 매번 실시간 검색에만 기대지 않고 이미 모아둔
   * 근거로 신뢰도를 높인다). 근거가 없는 주제는 빠진다. */
  policyEvidence: {
    label: string;
    reports: { date: string; source: string; stockName: string; title: string; summary?: string; pdfUrl?: string }[];
    news: { title: string; excerpt?: string; source: string; publishedAt: string; url?: string }[];
  }[];
  /** "경기" 계열(관세·중국 경기·고용·브라질 국채·금·원달러·구리·BDI) 근거 —
   * policyEvidence 와 같은 구조·같은 이유(오너 지시 2026-09-21, "5. 경제"
   * 섹션 신설). 근거가 없는 주제는 빠진다. */
  economyEvidence: {
    label: string;
    reports: { date: string; source: string; stockName: string; title: string; summary?: string; pdfUrl?: string }[];
    news: { title: string; excerpt?: string; source: string; publishedAt: string; url?: string }[];
  }[];
  sectors: {
    id: string;
    market: string;
    label: string;
    direction: "up" | "down";
    pct: number;
    startDate: string;
    endDate: string;
    /** 섹터를 끌고 간 종목(코드 집계) */
    leaders: { name: string; pct: number }[];
    /** 그 종목들의 그 주 기사 제목(sector-news.ts) — 사유는 이것만 근거로 쓴다 */
    headlines: string[];
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

/** 같은 날 같은 일정인지 가르는 핵심어 — 신한 스케줄·FRED·회의 일정·Gemini
 * 항목이 서로 다른 표기로 같은 이벤트를 적는다("美) 9월 ISM 비제조업지수(현지시간)"
 * vs "미국 9월 ISM 서비스업 PMI"). 핵심어가 하나라도 겹치면 같은 일정으로 본다. */
const EVENT_KEYS: [string, RegExp][] = [
  ["fomc-minutes", /FOMC.*의사록|의사록.*FOMC/],
  ["fomc", /FOMC|연준.*금리\s*결정/],
  ["ecb", /ECB|유럽중앙은행/],
  ["boj", /BOJ|일본은행/],
  ["bok", /금통위|금융통화위원회|한국은행.*(기준)?금리/],
  ["cpi", /CPI|소비자물가/],
  ["ppi", /PPI|생산자물가/],
  ["pce", /PCE|개인소비지출/],
  ["jobs", /비농업|고용지표|고용보고서|Employment Situation|Nonfarm/i],
  ["ism-mfg", /ISM.*제조업/],
  ["ism-svc", /ISM.*(비제조업|서비스업)/],
  ["retail", /소매판매/],
  ["gdp", /GDP|국내총생산/],
  ["umich", /미시[건간]대/],
  ["jolts", /JOLT|구인/],
  ["quad", /네\s*마녀|동시\s*만기|옵션\s*만기/],
];

function eventKeys(event: string): string[] {
  const keys = EVENT_KEYS.filter(([, re]) => re.test(event)).map(([k]) => k);
  // FOMC 의사록은 FOMC 회의와 다른 일정이다
  return keys.includes("fomc-minutes") ? keys.filter((k) => k !== "fomc") : keys;
}

/** 나라 접두어가 다르면(미국 CPI vs 유로존 CPI) 다른 일정이다. */
function eventCountry(event: string): string | null {
  const m = event.match(/^(미국|중국|일본|영국|독일|유로존|한국|국내)/);
  return m ? m[1] : null;
}

function isSameEvent(a: { date: string; event: string }, b: { date: string; event: string }): boolean {
  if (a.date !== b.date) return false;
  const ca = eventCountry(a.event);
  const cb = eventCountry(b.event);
  if (ca && cb && ca !== cb) return false;
  const ka = eventKeys(a.event);
  const kb = eventKeys(b.event);
  if (ka.length > 0 && kb.length > 0) return ka.some((k) => kb.includes(k));
  return a.event.replace(/\s+/g, "") === b.event.replace(/\s+/g, "");
}

/** 다음 주(리포트 주 금요일 +3일 월 ~ +7일 금) */
export function nextWeekRange(week: ReportWeek): { start: string; end: string } {
  const weekEndMs = Date.parse(`${week.weekEnd}T00:00:00Z`);
  return {
    start: new Date(weekEndMs + 3 * 86_400_000).toISOString().slice(0, 10),
    end: new Date(weekEndMs + 7 * 86_400_000).toISOString().slice(0, 10),
  };
}

/**
 * "다음 주 주시 일정" 중 **코드로 확정되는 부분** — 그라운딩(웹검색) 성공 여부와
 * 무관하게 항상 표에 실린다. 예전엔 이 계산이 Gemini 호출 안에만 있어 Gemini 가
 * 실패·미설정이면 표가 통째로 비었고, 신한 스케줄은 모델 입력으로만 쓰였다
 * (2026-10-04 21:00 UTC 실행 — 검색 0건 + 그 주 고정 일정 없음 → "확인하지
 * 못했습니다"). 이제 generate.ts 가 한 번 계산해 Gemini 병합과 렌더링 폴백에
 * 같이 쓴다.
 */
export async function buildCodeCalendar(
  week: ReportWeek,
  schedule: ScheduleItem[],
): Promise<{ date: string; event: string }[]> {
  const { start, end } = nextWeekRange(week);
  const meetings = (await getCentralBankMeetings().catch(() => [] as CbMeeting[])).filter((m) => m.date >= week.weekStart);
  const fixed = await computeFixedCalendarEvents(start, end, meetings);
  let list: { date: string; event: string }[] = [];
  const add = (e: { date: string; event: string }) => {
    if (!list.some((c) => isSameEvent(c, e))) list = [...list, e];
  };
  for (const f of fixed) add({ date: f.date, event: f.event });
  for (const s of schedule) {
    if (s.date < start || s.date > end || !isMajorScheduleItem(s)) continue;
    const title = formatScheduleTitle(s.title);
    // 국내 일정은 나라 접두어가 없다("옵션만기일", "8월 국제수지(잠정)") — 해외와 섞여 헷갈리지 않게
    add({ date: s.date, event: s.category.startsWith("국내") && !/^한국/.test(title) ? `한국 ${title}` : title });
  }
  return list.sort((a, b) => a.date.localeCompare(b.date));
}

/** Gemini 캘린더(검색으로 확인한 것)에 코드 일정을 합친다 — 같은 일정은 하나만. */
export function mergeCalendar(
  model: { date: string; event: string }[] | null,
  code: { date: string; event: string }[],
): { date: string; event: string }[] {
  let list = [...(model ?? [])];
  for (const c of code) if (!list.some((m) => isSameEvent(m, c))) list = [...list, c];
  return list.sort((a, b) => a.date.localeCompare(b.date));
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

/** issues.ts 의 TOPIC_FAMILY 에서 "경기" 계열로 묶인 라벨과 정확히
 * 일치해야 한다(오너 지시 2026-09-21, "5. 경제" 섹션 신설). */
const ECONOMY_TOPIC_LABELS = [
  "관세·통상",
  "중국 경기·부양책",
  "고용·경기",
  "브라질 국채",
  "금·귀금속",
  "원달러 환율",
  "구리·산업금속",
  "BDI·해운운임",
];

const MARKET_LABEL: Record<string, string> = {
  "kr-kospi": "코스피",
  "kr-kosdaq": "코스닥",
  us: "미국",
  jp: "일본",
  eu: "유럽",
};

function flattenSectors(sectors: WeeklySectors, news: Map<string, SectorNews>): CommentPayload["sectors"] {
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
    leaders: (s.leaders ?? []).map((l) => ({ name: l.name, pct: Math.round(l.pct * 100) / 100 })),
    headlines: news.get(s.id)?.headlines ?? [],
  }));
}

function buildPayload(
  snapshot: SnapshotRow[],
  issues: WeeklyIssue[],
  week: ReportWeek,
  allIssues: WeeklyIssue[],
  sectors: WeeklySectors,
  meetings: CbMeeting[],
  extras: CommentExtras,
  /** claude.ai 커넥터용 — 리포트 요약 발췌·PDF·기사 링크까지 싣는다(Gemini 입력은 그대로) */
  rich = false,
): CommentPayload {
  const rep = (r: WeeklyIssue["reports"][number], max: number) => ({
    date: r.date,
    source: r.source,
    stockName: r.stockName,
    title: r.title,
    ...(rich && r.summary ? { summary: r.summary.slice(0, max) } : {}),
    ...(rich && r.pdfUrl ? { pdfUrl: r.pdfUrl } : {}),
  });
  const nws = (n: WeeklyIssue["news"][number]) => ({
    title: n.title,
    excerpt: n.excerpt,
    source: n.source,
    publishedAt: n.publishedAt,
    ...(rich && n.url ? { url: n.url } : {}),
  });
  const weekEndMs = Date.parse(`${week.weekEnd}T00:00:00Z`);
  const nextStart = new Date(weekEndMs + 3 * 86_400_000).toISOString().slice(0, 10); // 금→월
  const nextEnd = new Date(weekEndMs + 7 * 86_400_000).toISOString().slice(0, 10); // 금→그다음 금
  const policyEvidence = POLICY_TOPIC_LABELS.map((label) => {
    const found = allIssues.find((i) => i.label === label);
    return {
      label,
      reports: (found?.reports ?? []).slice(0, rich ? 6 : undefined).map((r) => rep(r, 250)),
      news: (found?.news ?? []).slice(0, rich ? 15 : 5).map(nws),
    };
  }).filter((p) => p.reports.length > 0 || p.news.length > 0);
  const economyEvidence = ECONOMY_TOPIC_LABELS.map((label) => {
    const found = allIssues.find((i) => i.label === label);
    return {
      label,
      reports: (found?.reports ?? []).slice(0, rich ? 6 : undefined).map((r) => rep(r, 250)),
      news: (found?.news ?? []).slice(0, rich ? 15 : 5).map(nws),
    };
  }).filter((p) => p.reports.length > 0 || p.news.length > 0);
  return {
    webFacts: [],
    reportWeek: { start: week.weekStart, end: week.weekEnd },
    nextWeek: { start: nextStart, end: nextEnd },
    topMovers: computeTopMovers(snapshot),
    policyEvidence,
    economyEvidence,
    // 리포트 주 시작일 기준 — 그 주에 열린 회의도 "이번 주 무슨 일이
    // 있었는지" 서술에 필요하므로 nextWeek 이 아니라 weekStart 부터.
    centralBankMeetings: meetings,
    sectors: flattenSectors(sectors, extras.sectorNews),
    economyMetrics: extras.official.map(toPayloadMetric),
    snapshot: snapshot
      .filter((r) => r.value != null)
      .map((r) => ({
        name: r.name,
        group: r.group,
        value: r.value != null ? Math.round(r.value * 100) / 100 : null,
        valueText: snapshotValueText(r),
        changeText: snapshotChangeText(r),
        unit: r.unit,
        pct: r.pct != null ? Math.round(r.pct * 100) / 100 : null,
        diffBp: r.diff != null && r.unit.startsWith("%") ? Math.round(r.diff * 100) : null,
        asOf: r.asOf,
      })),
    issues: issues.map((i) => ({
      label: i.label,
      researchCount: i.researchCount,
      newsCount: i.newsCount,
      searchInterest: i.searchInterest,
      facts: i.facts,
      reports: i.reports.map((r) => rep(r, 500)),
      news: i.news.slice(0, rich ? 15 : 5).map(nws),
      earnings: i.earnings?.map((e) => ({
        ticker: e.ticker,
        period: e.period,
        epsActual: e.epsActual,
        epsEstimate: e.epsEstimate,
        surprisePct: e.surprisePct,
      })),
      metrics: i.metrics?.map(toPayloadMetric),
    })),
  };
}

interface MacroResponse {
  headline?: string;
  economySummary?: string;
  policySummary?: string;
  calendar?: { date?: string; event?: string }[];
}

interface CommentsOnlyResponse {
  snapshot?: Record<string, string>;
  issues?: Record<string, string | { headline?: unknown; reading?: unknown }>;
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
      nums.push(m.value, Math.abs(m.value));
      if (m.previous != null) nums.push(m.previous, Math.abs(m.previous));
    }
    for (const r of i.reports) {
      nums.push(...extractNumbers(r.title));
      if (r.summary) nums.push(...extractNumbers(r.summary));
    }
    for (const n of i.news) {
      nums.push(...extractNumbers(n.title));
      if (n.excerpt) nums.push(...extractNumbers(n.excerpt));
    }
  }
  // economyEvidence 도 넣는다 — 빠져 있어서 그라운딩이 안 돈 실행에선 경제 요약이
  // 근거 기사의 수치("실업률 4.2%")를 인용하기만 해도 "근거 없는 수치"로 통째로
  // 버려졌다(2026-10-05 발견, policyEvidence 와 같은 자기모순).
  for (const p of [...payload.policyEvidence, ...payload.economyEvidence]) {
    for (const r of p.reports) {
      nums.push(...extractNumbers(r.title));
      if (r.summary) nums.push(...extractNumbers(r.summary));
    }
    for (const n of p.news) {
      nums.push(...extractNumbers(n.title));
      if (n.excerpt) nums.push(...extractNumbers(n.excerpt));
    }
  }
  for (const m of payload.economyMetrics) {
    nums.push(m.value, Math.abs(m.value));
    if (m.previous != null) nums.push(m.previous, Math.abs(m.previous));
  }
  for (const s of payload.sectors) {
    nums.push(s.pct, Math.abs(s.pct));
    for (const l of s.leaders) nums.push(l.pct, Math.abs(l.pct));
    for (const h of s.headlines) nums.push(...extractNumbers(h));
  }
  for (const r of payload.snapshot) if (r.pct != null) nums.push(Math.abs(r.pct));
  // 웹검색 호출이 출처와 함께 확인해 온 사실(researchWebFacts) — 검색 출처가 0건이면 비어 있다
  for (const w of payload.webFacts) nums.push(...extractNumbers(w.fact));
  return nums;
}

/**
 * 본문 수치를 표와 같은 자릿수로 맞춘다(2026-10-05 오너 지적 — 표 "미국채 10년
 * 5.28%" vs 본문 "5.27%대", 국고채 3년 3.94 vs 3.93). 모델이 원값(5.277)을
 * 버림·반올림해 다르게 쓴 것이다. payload 에 이미 표 값만 주지만, 모델이 검색
 * 결과의 값을 섞어 쓸 수 있어 출력도 고친다.
 *
 * 대상은 소수 둘째 자리 이상으로 쓴 "% 수치" 중 **허용 목록에 그대로는 없고**
 * 스냅샷 값(금리 수준·주간 변동률)과 0.01 미만 차이인 것뿐 — 그 표 값으로
 * 바꾼다. 허용 목록에 정확히 있는 다른 수치(섹터 등락률 등)는 건드리지 않는다.
 */
function alignSnapshotNumbers(text: string, snapshot: CommentPayload["snapshot"], allowed: number[]): string {
  const targets: number[] = [];
  for (const r of snapshot) {
    if (r.unit.startsWith("%") && r.value != null) targets.push(r.value);
    if (r.pct != null) targets.push(Math.abs(r.pct));
  }
  return text.replace(/(\d+\.\d{2,})(\s*%)/g, (all, num: string, pct: string) => {
    const n = Number(num);
    if (allowed.some((a) => a === n)) return all;
    const near = targets
      .filter((t) => Math.abs(t - n) < 0.01)
      .sort((a, b) => Math.abs(a - n) - Math.abs(b - n))[0];
    return near == null ? all : `${near.toFixed(2)}${pct}`;
  });
}

/** generate.ts 가 수집해 넘기는 코드 확정 자료 */
export interface CommentExtras {
  /** 리포트 주에 새로 발표된 미국 공식 지표(evidence.ts) */
  official: OfficialMetric[];
  /** 섹터 주도 종목의 그 주 기사(sector-news.ts), key = SectorHighlight.id */
  sectorNews: Map<string, SectorNews>;
  /** 신한 「이슈 및 섹터 스케줄」 다음 주 전체(모델 참고용) */
  schedule: ScheduleItem[];
  /** 코드로 확정된 다음 주 일정(buildCodeCalendar) — 모델 캘린더와 합친다 */
  codeCalendar: { date: string; event: string }[];
}

/**
 * @param trustGrounded 그라운딩이 실제로 출처를 찾아왔을 때 true — 우리가
 *   안 가진 사실(웹검색으로 확인한 수치)을 인용하는 게 정상이므로 수치
 *   대조를 건너뛴다. false 면(그라운딩 꺼짐/검색 실패) 기존처럼 엄격 검증.
 */
/**
 * 중앙은행 회의 **월** 검증 — 수치 검증(`verifyComment`)과 같은 원리로,
 * 우리가 확정 데이터를 갖고 있는데 모델이 다르게 쓰면 통째로 버린다.
 *
 * 실측 오류(2026-09-20, 오너 지적): 이슈 코멘트가 "11월 추가 인상 여부가
 * 결정될 것"이라고 썼는데 2026년 FOMC 는 10/28 다음이 12/09 라 11월 회의가
 * 없다. 프롬프트에 일정을 실어주는 것만으로는 모델이 무시하면 그만이라
 * 출력을 실제로 대조해야 한다.
 *
 * **그라운딩 성공이어도 건너뛰지 않는다** — 회의 일정은 우리 쪽이 공식
 * 소스에서 확정해 갖고 있는 사실이라 웹검색 결과에 양보할 이유가 없다
 * (수치 검증은 우리가 모르는 외부 수치를 인용하는 게 정상이라 건너뛴다).
 *
 * 검증 범위는 리포트 주 기준 앞뒤로만 본다(과거 3개월 ~ 이후 15개월).
 * 전체 기간으로 보면 2023·2024년에는 11월 FOMC 가 실제로 있어서 위 오류를
 * 못 잡는다. 범위 밖 월이나 일정을 아예 못 가져온 은행은 검증을 건너뛴다 —
 * 틀렸다고 증명할 수 없는 건 버리지 않는다.
 */
interface VerifyResult {
  text: string;
  /** 폐기됐을 때만 채워진다 — 검수 화면에 그대로 노출된다. */
  reason: string | null;
}

function verifyMeetingMonths(raw: string, meetings: CbMeeting[], weekStart: string): VerifyResult {
  const text = raw.trim();
  if (!text || meetings.length === 0) return { text, reason: null };

  const base = Date.parse(`${weekStart}T00:00:00Z`);
  if (!Number.isFinite(base)) return { text, reason: null };
  const lo = new Date(base - 90 * 86_400_000).toISOString().slice(0, 7);
  const hi = new Date(base + 455 * 86_400_000).toISOString().slice(0, 7);

  // 은행별로 "이 창 안에 회의가 있는 YYYY-MM" 집합을 만든다.
  const monthsByBank = new Map<string, Set<string>>();
  for (const m of meetings) {
    const ym = m.date.slice(0, 7);
    if (ym < lo || ym > hi) continue;
    const set = monthsByBank.get(m.bank) ?? new Set<string>();
    set.add(ym);
    monthsByBank.set(m.bank, set);
  }

  // 본문에 등장하는 중앙은행 키워드의 위치를 전부 모아둔다. "연준은 ...
  // (100자) ... 11월 추가 인상"처럼 주어가 문장 앞에 한 번만 나오는 경우가
  // 실제 오류 문장의 형태라, 월 주변 좁은 창만 보면 못 잡는다(실측).
  const mentions: { bank: string; at: number }[] = [];
  for (const [bank, re] of Object.entries(BANK_MENTION_RE)) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags.replace("g", "") + "g"))) {
      mentions.push({ bank, at: m.index ?? 0 });
    }
  }
  if (mentions.length === 0) return { text, reason: null };

  // "N월" 뒤에 통화정책 행위를 가리키는 말이 붙을 때만 회의 언급으로 본다 —
  // "11월 소비자물가 발표"처럼 회의와 무관한 월까지 잡으면 오탐이 된다.
  const POLICY_ACT_RE = /^[^.]{0,12}(회의|FOMC|금통위|금융통화|정책결정|인상|인하|동결|결정|금리)/;

  for (const hit of text.matchAll(/(\d{1,2})\s*월/g)) {
    const month = Number(hit[1]);
    if (month < 1 || month > 12) continue;
    const at = hit.index ?? 0;
    if (!POLICY_ACT_RE.test(text.slice(at + hit[0].length))) continue;
    // 그 월에서 가장 가까운 은행 언급을 주어로 본다(앞·뒤 모두 고려).
    const nearest = mentions.reduce((best, m) =>
      Math.abs(m.at - at) < Math.abs(best.at - at) ? m : best,
    );
    const known = monthsByBank.get(nearest.bank);
    if (!known || known.size === 0) continue; // 그 은행 일정을 못 가져옴
    if ([...known].some((ym) => Number(ym.slice(5, 7)) === month)) continue; // 실제로 있는 달
    if (!monthsExistInWindow(lo, hi, month)) continue; // 검증 범위 밖 — 판단 보류
    const reason = `${nearest.bank}는 ${month}월에 회의가 없는데 코멘트가 그 달을 언급함`;
    console.warn(`[weekly] 코멘트 검증 실패 — ${reason}, 폐기: ${text}`);
    return { text: "", reason };
  }
  return { text, reason: null };
}

/**
 * "다음 회의" 뒤에 **실제 날짜를 코드가 붙인다**(오너 지시 2026-09-21 —
 * "코드가 붙이게 하고"). 다음 FOMC 가 10/28 이라는 건 이미 공식 소스에서
 * 확정해 갖고 있는 값이라 모델이 다시 추측하게 둘 이유가 없다. 스냅샷
 * 수치를 모델에 안 맡기고 코드가 계산해 넣는 기존 원칙과 같은 방향 —
 * 검증으로 잡는 것보다 틀릴 자리를 없애는 쪽이 확실하다.
 *
 * 어느 중앙은행인지는 `verifyMeetingMonths` 와 같은 방식(본문에서 가장
 * 가까운 은행 언급)으로 정한다. 못 정하거나 일정이 없으면 그냥 둔다.
 */
function annotateNextMeeting(raw: string, meetings: CbMeeting[], afterDate: string): string {
  const text = raw.trim();
  if (!text || meetings.length === 0) return text;

  const mentions: { bank: string; at: number }[] = [];
  for (const [bank, re] of Object.entries(BANK_MENTION_RE)) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags.replace("g", "") + "g"))) {
      mentions.push({ bank, at: m.index ?? 0 });
    }
  }
  if (mentions.length === 0) return text;

  const NEXT_MEETING_RE =
    /(다음|차기|오는)\s*(회의|FOMC|금통위|금융통화위원회|정책결정회의|통화정책회의|통화정책방향\s*결정회의)/g;
  return text.replace(NEXT_MEETING_RE, (match, ...rest) => {
    const at = Number(rest[rest.length - 2]);
    // 이미 날짜가 붙어 있으면(재생성분 등) 건드리지 않는다.
    if (/^\s*\(\s*\d/.test(text.slice(at + match.length))) return match;
    const nearest = mentions.reduce((best, m) =>
      Math.abs(m.at - at) < Math.abs(best.at - at) ? m : best,
    );
    const next = meetings.find((m) => m.bank === nearest.bank && m.date > afterDate);
    if (!next) return match;
    const [, mo, d] = next.date.split("-");
    return `${match}(${Number(mo)}/${Number(d)})`;
  });
}

/** lo~hi(YYYY-MM) 구간에 해당 월이 한 번이라도 등장하는지. */
function monthsExistInWindow(lo: string, hi: string, month: number): boolean {
  const [ly, lm] = lo.split("-").map(Number);
  const [hy, hm] = hi.split("-").map(Number);
  for (let y = ly; y <= hy; y++) {
    const from = y === ly ? lm : 1;
    const to = y === hy ? hm : 12;
    if (month >= from && month <= to) return true;
  }
  return false;
}

/**
 * Gemini 가 그라운딩 인용 번호를 "[0]", "[1]", "[1, 2]" 형태로 본문에 박아
 * 넣는다. 출처 목록을 화면에 안 쓰므로 그 번호만 남아 읽는 사람에게는
 * 의미 없는 노이즈다(오너 지적 2026-09-21 — "0은 대체 먼 의미지?"). 문장
 * 부호 앞의 공백까지 같이 걷어낸다.
 *
 * "[1.1.6]"처럼 점으로 구간을 나눈 다단 인용 번호도 발견돼(오너 지적
 * 2026-10-01, 실측 — 쉼표 구분 패턴만 걷어내던 규칙이 이 형식을 놓침)
 * 숫자+점 조합까지 허용하도록 넓혔다.
 */
function stripCitations(text: string): string {
  return text
    .replace(/\s*\[\d+(?:[.,]\s*\d+)*\]/g, "")
    .replace(/\s+([.,!?])/g, "$1")
    .replace(/[ 	]{2,}/g, " ")
    .trim();
}

/**
 * 줄 목록("- 미국 연준: …" 처럼 줄마다 독립된 요약)은 **줄 단위로** 검증한다 —
 * 한 줄의 근거 없는 수치 때문에 세 은행 요약 전체를 버리던 문제(2026-10-05 운영
 * 재생성본, 금리정책이 통째로 빔). 걸린 줄만 빼고 사유를 남긴다.
 */
function verifyLines(raw: string, verify: (line: string) => VerifyResult): VerifyResult {
  const lines = raw.split(/\r?\n/);
  if (lines.filter((l) => l.trim()).length < 2) return verify(raw);
  const kept: string[] = [];
  const reasons: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const r = verify(line);
    if (r.text) kept.push(r.text);
    else if (r.reason) reasons.push(`${line.trim().slice(0, 24)}… — ${r.reason}`);
  }
  if (kept.length === 0) return { text: "", reason: reasons.join(" / ") || null };
  if (reasons.length > 0) console.warn(`[weekly] 일부 줄 폐기 — ${reasons.join(" / ")}`);
  return { text: kept.join("\n"), reason: reasons.length > 0 ? `일부 줄 폐기: ${reasons.join(" / ")}` : null };
}

function verifyComment(raw: string, allowed: number[], trustGrounded: boolean): VerifyResult {
  const text = stripCitations(raw);
  if (!text) return { text: "", reason: null };
  if (trustGrounded) return { text, reason: null };
  for (const m of text.matchAll(CLAIM_NUM_RE)) {
    const n = Number(m[1]);
    const unit = m[2];
    const tol = unit === "bp" ? 1 : unit === "건" ? 0.5 : 0.15;
    // "70%대"·"5.2%대" 는 구간 표현이다 — 근거 수치가 그 구간 안에 있으면 인정
    // (2026-10-05 운영 재생성본: FedWatch "70%대 후반"이 근거 78% 류와 대조 실패로
    // 금리정책 요약 전체가 버려졌다).
    const isRange = text.slice((m.index ?? 0) + m[0].length).startsWith("대");
    const decimals = (m[1].split(".")[1] ?? "").length;
    const step = decimals > 0 ? 10 ** -decimals : n % 10 === 0 ? 10 : 1;
    const ok = allowed.some((a) => Math.abs(a - n) <= tol || (isRange && a >= n && a < n + step));
    if (!ok) {
      const reason = `근거 없는 수치 "${m[0]}"가 포함됨(원본 데이터와 대조 실패)`;
      console.warn(`[weekly] 코멘트 검증 실패 — ${reason}, 폐기: ${text}`);
      return { text: "", reason };
    }
  }
  return { text, reason: null };
}

/**
 * 그라운딩 실패 시 1회 재시도. 원래는 매크로 호출에만 붙어 있었는데(오너
 * 지시 2026-09-18 — 정책요약·캘린더가 그라운딩 미스로 자주 비던 문제),
 * **두 호출 모두에 적용한다**(오너 결정 2026-09-21).
 *
 * "코멘트 호출은 이런 문제가 덜하다"는 원래 전제가 실측으로 깨졌다 —
 * 2026-09-20 비교 실행에서 매크로·코멘트 양쪽 다 출처 0건이었다(같은 주
 * 입력으로 하루 전 저장된 초안은 검색어 3건·출처 7건이었다. 즉 모델이
 * 검색할지 말지를 실행마다 다르게 판단한다. 문서상 강제 옵션은 없다).
 * 코멘트 쪽은 스냅샷 16개 자산의 "왜"를 채워야 해서 검색 의존도가 오히려
 * 더 높다 — 우리가 가진 이슈 근거 3개로는 나머지 13개를 못 채운다.
 *
 * 재시도 발생분까지 usage 를 전부 합산해서 돌려준다(실제로 청구된 비용).
 */
async function callWithGroundingRetry(
  system: string,
  userJson: string,
  label: string,
  modelOverride?: string,
  /** 검색 사실(webFacts)을 이미 받았으면 1 — 큰 호출은 재시도해도 검색을 거의 안 해(실측) 비용만 든다 */
  maxAttempts = 2,
): Promise<{ result: GeminiResult; attempts: GeminiResult[] }> {
  const attempts: GeminiResult[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await geminiGenerate({
      system,
      model: modelOverride,
      user: userJson,
      grounding: true,
      temperature: 0.25,
      maxOutputTokens: 16_000,
    });
    attempts.push(r);
    if (r.groundingSources.length > 0) break;
    if (attempt < maxAttempts) {
      console.warn(`[weekly] ${label} 호출 그라운딩 실패 — 1회 재시도`);
    }
  }
  return { result: attempts[attempts.length - 1], attempts };
}

export interface WebFact {
  topic: string;
  fact: string;
  source: string;
  date?: string;
}

const RESEARCH_PROMPT = `# 역할
너는 매크로 리서치 보조다. 사용자 JSON 의 reportWeek(월~금) 동안 실제로 있었던
사실을 **반드시 Google 검색으로 확인해서** 모은다. 해석·전망은 쓰지 않는다.

# 모을 것
1. policy — 미국 연준(FOMC·의장 발언·FedWatch 금리 확률), 한국은행, 일본은행의
   이번 주 발언·결정·시장 반응. 은행별 1~3건.
2. data — 이번 주에 발표된 주요국(미국·중국·유로존·일본·한국) 경제지표의 실제
   결과와 예상치(예: 비농업 고용, CPI, PMI, 수출). 5~10건.
3. asset — assets 목록 중 주간 변동이 큰 자산(movers)의 그 주 등락 원인. 자산별 1건.

# 규칙
- 검색으로 확인한 것만. 확인 못 하면 그 항목은 빼라(지어내지 마라).
- 숫자는 기사에 나온 그대로 쓴다. assets 의 종가·변동은 이미 확정값이니 다시 찾지 않는다.
- 각 fact 는 한 문장, 80자 내외.

# 출력
코드펜스·머리말 없이 한 줄에 사실 하나, 칸은 " || " 로 나눈다:
topic || fact || source(매체명) || date(YYYY-MM-DD)
topic 은 policy, data, asset:<자산명> 중 하나. 예)
policy || 존 윌리엄스 뉴욕 연은 총재는 추가 인상을 서두를 필요가 없다고 말했다. || 로이터 || 2026-09-29`;

/**
 * **웹검색 전용 소형 호출**(2026-10-05). 매크로·코멘트 호출은 입력이 6만~7만
 * 토큰(증권사 리포트·뉴스 근거 전체)이라 모델이 "이미 근거가 있다"고 보고
 * 검색을 건너뛴다 — 10-04 21:00 UTC 실행은 4번 시도 전부 검색 0건, 같은 주를
 * 로컬에서 다시 돌려도 0건이었다(요청 형식 문제가 아님: 같은 키·모델·도구
 * 선언으로 짧은 질문을 보내면 매번 검색하고 groundingMetadata 가 정상으로 온다,
 * 실측). 그래서 검색이 필요한 사실(정책 발언·FedWatch 확률·그 주 지표 결과·
 * 자산별 등락 원인)은 입력이 작은 이 호출에서 먼저 모으고, 큰 호출에는
 * `webFacts` 로 넘긴다. 검색 출처가 0건이면 결과를 버린다(검증 안 된 사실을
 * 근거처럼 넘기지 않는다).
 */
async function researchWebFacts(
  payload: CommentPayload,
  modelOverride?: string,
): Promise<{ facts: WebFact[]; attempts: GeminiResult[]; note: string | null }> {
  const movers = [...payload.snapshot]
    .filter((r) => r.pct != null || r.diffBp != null)
    .sort((a, b) => Math.abs(b.pct ?? (b.diffBp ?? 0) / 10) - Math.abs(a.pct ?? (a.diffBp ?? 0) / 10))
    .slice(0, 8)
    .map((r) => r.name);
  const input = JSON.stringify({
    reportWeek: payload.reportWeek,
    assets: payload.snapshot.map((r) => ({ name: r.name, close: r.valueText, change: r.changeText })),
    movers,
    officialDataAlreadyKnown: payload.economyMetrics.map((m) => m.text),
  });
  try {
    const { result, attempts } = await callWithGroundingRetry(RESEARCH_PROMPT, input, "웹검색", modelOverride);
    if (result.groundingSources.length === 0) {
      return { facts: [], attempts, note: "웹검색 호출이 검색 출처 0건으로 끝나 검색 사실을 쓰지 않음" };
    }
    // 줄 단위 형식 — JSON 은 그라운딩 응답이 중간이 빠진 채 오면 통째로 깨졌다
    // (2026-10-05 실측: '{"facts":.", "source"…'). 줄 단위면 깨진 줄만 버린다.
    const facts: WebFact[] = result.text
      .split(/\r?\n/)
      .map((line) => line.split("||").map((c) => c.trim()))
      .filter((c) => c.length >= 3 && /^(policy|data|asset:)/.test(c[0]) && c[1].length >= 10)
      .map((c) => ({ topic: c[0], fact: stripCitations(c[1]), source: c[2], date: c[3] || undefined }))
      .slice(0, 40);
    return { facts, attempts, note: facts.length === 0 ? "웹검색 호출 응답에 사실이 없음" : null };
  } catch (err) {
    return { facts: [], attempts: [], note: `웹검색 호출 실패: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Gemini 로 스냅샷·이슈 코멘트를 생성한다. 설정이 없거나 이슈가 비면 null —
 * 호출부는 rule-based(빈 코멘트)로 조용히 폴백한다(이 프로젝트의 기존
 * "실패 시 해당 부분만 생략" 패턴과 동일).
 */
/** 모델(Gemini·claude.ai 커넥터) 응답을 검증해 코멘트로 확정한다 — 두 경로가 같은 검사를 거친다. */
interface AssembleInput {
  payload: CommentPayload;
  allMeetings: CbMeeting[];
  week: ReportWeek;
  extras: CommentExtras;
  macroParsed: MacroResponse | null;
  macroTrustGrounded: boolean;
  commentParsed: CommentsOnlyResponse | null;
  commentTrustGrounded: boolean;
  dropReasons: Map<string, string>;
  webFacts: WebFact[];
}

function assembleComments(a: AssembleInput): WeeklyComments {
  const { payload, allMeetings, week, extras, macroParsed, macroTrustGrounded, commentParsed, commentTrustGrounded, dropReasons } = a;
  const allowed = buildAllowedNumbers(payload);
  /**
   * 검증 두 단계를 한 번에 — 수치 대조(그라운딩 성공 시 건너뜀)와 중앙은행
   * 회의 월 대조(항상 적용). 어느 쪽이든 걸리면 그 코멘트를 통째로 버린다
   * (반쪽만 맞는 문장을 노출하지 않는다는 기존 원칙). `reason` 은 폐기됐을
   * 때만 채워진다 — 호출부가 `dropReasons` 에 기록한다.
   */
  const verify = (raw: string, trustGrounded: boolean): VerifyResult => {
    const step1 = verifyComment(raw, allowed, trustGrounded);
    if (step1.reason) return step1;
    const step2 = verifyMeetingMonths(step1.text, allMeetings, week.weekStart);
    if (step2.reason) return step2;
    const aligned = alignSnapshotNumbers(step2.text, payload.snapshot, allowed);
    return { text: annotateNextMeeting(aligned, allMeetings, week.weekEnd), reason: null };
  };
  const snapshotNames = payload.snapshot.map((r) => r.name);
  const issueLabels = payload.issues.map((i) => i.label);
  const sectorIds = payload.sectors.map((s) => s.id);
  const comments: WeeklyComments = {
    headline: null,
    economySummary: null,
    policySummary: null,
    calendar: null,
    snapshot: new Map(),
    issues: new Map(),
    sectors: new Map(),
    dropReasons,
    webFacts: a.webFacts,
  };

  if (macroParsed?.headline) {
    const r = verify(macroParsed.headline, macroTrustGrounded);
    comments.headline = r.text || null;
    if (r.reason) dropReasons.set("headline", r.reason);
  } else if (macroParsed) {
    dropReasons.set("headline", "모델이 한 줄 결론을 생성하지 않음");
  } else {
    dropReasons.set("headline", "매크로 응답 JSON 파싱 실패");
  }

  // economySummary — policySummary 와 같은 신뢰 조건(그라운딩 성공 또는
  // 이미 모아둔 economyEvidence 가 있을 때만)(오너 지시 2026-09-21 —
  // "경기와 관련된 내용은 여기서 요약하도록 하자").
  const hasEconomyEvidence = payload.economyEvidence.length > 0 || payload.economyMetrics.length > 0;
  if ((macroTrustGrounded || hasEconomyEvidence) && macroParsed?.economySummary) {
    const r = verifyLines(macroParsed.economySummary, (l) => verify(l, macroTrustGrounded));
    comments.economySummary = r.text || null;
    if (r.reason) dropReasons.set("economySummary", r.reason);
  }
  if (!comments.economySummary) {
    const reason = !macroParsed
      ? "매크로 응답 JSON 파싱 실패"
      : !macroTrustGrounded && !hasEconomyEvidence
        ? "그라운딩 실패 + 이미 확보한 근거자료(리포트·뉴스) 없음"
        : !macroParsed.economySummary
          ? "모델이 경제 요약을 생성하지 않음(또는 특별한 움직임 없음)"
          : (dropReasons.get("economySummary") ?? "알 수 없는 사유");
    dropReasons.set("economySummary", reason);
    console.warn(
      `[weekly] economySummary 미채움 — trustGrounded=${macroTrustGrounded}, hasEconomyEvidence=${hasEconomyEvidence}, parsed=${JSON.stringify(macroParsed?.economySummary ?? null)}`,
    );
  }

  // policySummary — 날짜·기관명 등 검증 불가능한 구체적 사실을 담을 수
  // 있으므로, 그라운딩 성공 **또는** 우리가 이미 모아둔 policyEvidence
  // (실제 리포트·뉴스)가 있을 때만 신뢰한다(오너 지시 2026-09-18 — "4번은
  // 사실밖에 없는 정책 얘기인데 없다는게 이상하다": 매번 실시간 검색
  // 성공에만 기대지 않고, 이미 검증된 근거가 있으면 그걸로도 충분히
  // 신뢰할 수 있다). 숫자 검증은 그라운딩 여부에 따라 그대로 적용.
  const hasPolicyEvidence = payload.policyEvidence.length > 0;
  if ((macroTrustGrounded || hasPolicyEvidence) && macroParsed?.policySummary) {
    const r = verifyLines(macroParsed.policySummary, (l) => verify(l, macroTrustGrounded));
    comments.policySummary = r.text || null;
    if (r.reason) dropReasons.set("policySummary", r.reason);
  }
  if (!comments.policySummary) {
    const reason = !macroParsed
      ? "매크로 응답 JSON 파싱 실패"
      : !macroTrustGrounded && !hasPolicyEvidence
        ? "그라운딩 실패 + 이미 확보한 근거자료(리포트·뉴스) 없음"
        : !macroParsed.policySummary
          ? "모델이 정책요약을 생성하지 않음"
          : (dropReasons.get("policySummary") ?? "알 수 없는 사유");
    dropReasons.set("policySummary", reason);
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
  // 코드 일정(FRED·회의·휴장·신한 주요 일정)은 generate.ts 가 미리 계산해 넘긴다
  // (buildCodeCalendar — Gemini 실패 시 렌더링 폴백에도 같은 목록을 쓴다).
  comments.calendar = mergeCalendar(comments.calendar, extras.codeCalendar);
  // 코드로 확정되는 fixedEvents 가 있으므로 그것까지 합친 뒤에도 비어 있을
  // 때만 진짜 "미채움"이다.
  if (!comments.calendar || comments.calendar.length === 0) {
    dropReasons.set(
      "calendar",
      !macroParsed
        ? "매크로 응답 JSON 파싱 실패"
        : !macroTrustGrounded
          ? "그라운딩 실패로 검색 기반 일정을 못 가져옴 + 코드로 확정되는 고정 일정도 이 기간엔 없음"
          : "모델이 캘린더를 생성하지 않음 + 코드로 확정되는 고정 일정도 이 기간엔 없음",
    );
  }

  for (const [rawName, text] of Object.entries(commentParsed?.snapshot ?? {})) {
    const canonical = matchCanonical(rawName, snapshotNames);
    if (!canonical) {
      console.warn(`[weekly] 스냅샷 코멘트 키 불일치 — "${rawName}" 는 알려진 자산명이 아님`);
      continue;
    }
    const r = verify(String(text ?? ""), commentTrustGrounded);
    if (r.text) comments.snapshot.set(canonical, r.text);
    else if (r.reason) dropReasons.set(`snapshot:${canonical}`, r.reason);
  }
  for (const [rawLabel, value] of Object.entries(commentParsed?.issues ?? {})) {
    const canonical = matchCanonical(rawLabel, issueLabels);
    if (!canonical) {
      console.warn(`[weekly] 이슈 코멘트 키 불일치 — "${rawLabel}" 는 알려진 이슈명이 아님`);
      continue;
    }
    // facts 는 더 이상 LLM 응답에서 안 읽는다(evidence.ts `buildFactsFromEvidence`
    // 가 이미 코드로 채워 둠, 오너 지시 2026-10-01). 예전 형식(문자열 하나)으로
    // 오는 응답도 버리지 않고 해석으로 받아 둔다 — 모델이 스키마를 놓치는
    // 경우가 있어서다.
    const raw =
      typeof value === "string"
        ? { headline: undefined as unknown, reading: value }
        : ((value ?? {}) as { headline?: unknown; reading?: unknown });

    // headline — label 을 그대로 베끼면 폴백(render.ts 가 label 을 쓰도록)과
    // 다를 게 없으니 null 로 버린다(오너 지시 2026-10-01 — "단편적으로
    // 정해진 제목을 쓰는건 금지"). 숫자가 섞여도(예: "유가 100달러 돌파")
    // 근거 없는 수치면 verify() 가 걸러낸다 — reading 과 동일 안전망.
    const rawHeadline = String(raw.headline ?? "").trim();
    const hv = rawHeadline ? verify(rawHeadline, commentTrustGrounded) : { text: "", reason: null };
    const headline = hv.text && hv.text.trim() !== canonical.trim() ? hv.text : null;

    const rd = verify(String(raw.reading ?? ""), commentTrustGrounded);

    if (rd.text) {
      comments.issues.set(canonical, { headline, reading: rd.text });
    } else if (rd.reason) {
      dropReasons.set(`issue:${canonical}`, rd.reason);
    }
  }
  for (const [rawId, text] of Object.entries(commentParsed?.sectors ?? {})) {
    // id 는 코드가 만든 단순 문자열(kr-up-1 등)이라 fuzzy 매칭 없이 정확히
    // 일치해야 한다 — 모델이 다른 값을 돌려주면 그냥 버린다(오염 방지).
    if (!sectorIds.includes(rawId)) {
      console.warn(`[weekly] 섹터 코멘트 키 불일치 — "${rawId}" 는 알려진 섹터 id 가 아님`);
      continue;
    }
    // 근거 없는 섹터 사유는 싣지 않는다(2026-10-05 — 솔브레인·동진쎄미켐(반도체
    // 소재)이 끈 코스닥 소재를 "2차전지 소재"로, 롯데에너지머티리얼즈·팬오션이 끈
    // 코스피 산업재를 "방산·조선 수주"로 지어냈다). 주도 종목의 그 주 기사가 없으면
    // 버리고, 한국 섹터는 코멘트가 주도 종목 이름을 하나라도 짚어야 한다(해외는
    // 한글 표기가 제각각이라 이름 검사는 하지 않는다).
    const sec = payload.sectors.find((s) => s.id === rawId)!;
    if (sec.headlines.length === 0) {
      if (String(text ?? "").trim()) {
        dropReasons.set(`sector:${rawId}`, "주도 종목의 그 주 기사를 찾지 못해 사유를 싣지 않음(근거 없음)");
      }
      continue;
    }
    const r = verify(String(text ?? ""), commentTrustGrounded);
    const isKr = sec.market === "코스피" || sec.market === "코스닥";
    const namesLeader = sec.leaders.some((l) => r.text.replace(/\s+/g, "").includes(l.name.replace(/\s+/g, "")));
    if (r.text && isKr && sec.leaders.length > 0 && !namesLeader) {
      dropReasons.set(`sector:${rawId}`, "사유가 주도 종목을 짚지 않음(근거 기사와 연결 안 됨)");
    } else if (r.text) comments.sectors.set(rawId, r.text);
    else if (r.reason) dropReasons.set(`sector:${rawId}`, r.reason);
  }

  // 검증을 통과했든 안 했든, **모델이 애초에 그 항목을 안 쓴 경우**도
  // "코멘트가 비어 있다"는 결과는 같다 — 이유가 없으면 검수 화면에서 왜
  // 비었는지 알 수 없다(오너 지적 2026-09-21, 실측: 3개 이슈 중 1개만
  // 코멘트가 비어 원인을 못 밝힘).
  for (const name of snapshotNames) {
    if (!comments.snapshot.has(name) && !dropReasons.has(`snapshot:${name}`)) {
      dropReasons.set(`snapshot:${name}`, "모델이 이 항목에 대한 코멘트를 생성하지 않음");
    }
  }
  for (const label of issueLabels) {
    if (!comments.issues.has(label) && !dropReasons.has(`issue:${label}`)) {
      dropReasons.set(`issue:${label}`, "모델이 이 항목에 대한 코멘트를 생성하지 않음");
    }
  }
  for (const id of sectorIds) {
    if (!comments.sectors.has(id) && !dropReasons.has(`sector:${id}`)) {
      const noNews = (payload.sectors.find((s) => s.id === id)?.headlines.length ?? 0) === 0;
      dropReasons.set(
        `sector:${id}`,
        noNews ? "주도 종목의 그 주 기사를 찾지 못해 사유를 싣지 않음(근거 없음)" : "모델이 이 항목에 대한 코멘트를 생성하지 않음",
      );
    }
  }

  const missingIssues = issueLabels.filter((l) => !comments.issues.has(l));
  if (missingIssues.length > 0) {
    console.warn(
      `[weekly] 이슈 코멘트 누락: [${missingIssues.join(", ")}] — Gemini 응답 issues 원본 키: ${JSON.stringify(Object.keys(commentParsed?.issues ?? {}))}, trustGrounded=${commentTrustGrounded}`,
    );
  }

  return comments;
}

export async function generateWeeklyComments(
  snapshot: SnapshotRow[],
  issues: WeeklyIssue[],
  week: ReportWeek,
  allIssues: WeeklyIssue[],
  sectors: WeeklySectors,
  extras: CommentExtras,
  /** 모델 비교용 — 주면 그 모델만 쓴다(폴백 없음). */
  modelOverride?: string,
): Promise<{ comments: WeeklyComments; result: GeminiResult } | null> {
  if (!isGeminiConfigured() || issues.length === 0) return null;

  // 중앙은행 회의 일정은 공식 소스에서 가져온다(cb-calendar.ts). 프롬프트
  // 입력과 "다음 주 일정" 캘린더가 같은 목록을 쓰도록 여기서 한 번만 조회.
  const allMeetings = await getCentralBankMeetings();
  // 프롬프트에는 앞으로 남은 것만 넘기고, 검증은 지난 회의 언급("9월
  // FOMC에서 인상")도 참으로 봐야 해서 전체 목록을 쓴다.
  const meetings = allMeetings.filter((m) => m.date >= week.weekStart);
  const payload = buildPayload(snapshot, issues, week, allIssues, sectors, meetings, extras);
  // 웹검색 전용 소형 호출을 먼저 돌려 그 주 사실을 모은다(아래 researchWebFacts 주석).
  const research = await researchWebFacts(payload, modelOverride);
  payload.webFacts = research.facts;
  const userJson = JSON.stringify(payload);
  const dropReasons = new Map<string, string>();
  if (research.note) dropReasons.set("webFacts", research.note);
  // 매크로 콜(한 줄 결론·정책요약·캘린더)은 sectors 를 전혀 안 쓴다 — 그런데도
  // 코멘트 콜과 같은 payload(userJson)를 그대로 넘기면 섹터 16개만큼 입력이
  // 불필요하게 커져서, 이미 그라운딩 미스가 잦다고 알려진 매크로 콜(재시도
  // 로직이 있는 이유)의 실패율을 더 키운다(실측 — sectors 추가 이후 "다음 주
  // 일정"이 옛 기사-표 폴백으로 자주 떨어짐). 매크로 콜에는 sectors 를 뺀
  // 별도 payload 를 준다.
  const nextWeekSchedule = extras.schedule;
  const macroJson = JSON.stringify({ ...payload, sectors: undefined, nextWeekSchedule });

  const [macroCall, commentCall] = await Promise.all([
    callWithGroundingRetry(MACRO_PROMPT, macroJson, "매크로", modelOverride, research.facts.length > 0 ? 1 : 2),
    callWithGroundingRetry(COMMENT_PROMPT, userJson, "코멘트", modelOverride, research.facts.length > 0 ? 1 : 2),
  ]);
  const macroResult = macroCall.result;
  const commentResult = commentCall.result;

  // --- 매크로(한 줄 결론·정책요약·캘린더) ---
  const macroParsed = parseJson<MacroResponse>(macroResult.text, "매크로");
  const macroTrustGrounded = macroResult.groundingSources.length > 0;
  console.warn(
    `[weekly] Gemini(매크로) 응답 요약 — model=${macroResult.model}, 응답길이=${macroResult.text.length}자, ` +
      `groundingSources=${macroResult.groundingSources.length}건, trustGrounded=${macroTrustGrounded}, ` +
      `parseJson성공=${macroParsed != null}`,
  );
  // --- 코멘트(스냅샷·이슈) ---
  const commentParsed = parseJson<CommentsOnlyResponse>(commentResult.text, "코멘트");
  const commentTrustGrounded = commentResult.groundingSources.length > 0;
  console.warn(
    `[weekly] Gemini(코멘트) 응답 요약 — model=${commentResult.model}, 응답길이=${commentResult.text.length}자, ` +
      `groundingSources=${commentResult.groundingSources.length}건, trustGrounded=${commentTrustGrounded}, ` +
      `parseJson성공=${commentParsed != null}`,
  );

  const comments = assembleComments({
    payload,
    allMeetings,
    week,
    extras,
    macroParsed,
    macroTrustGrounded,
    commentParsed,
    commentTrustGrounded,
    dropReasons,
    webFacts: research.facts,
  });

  // 재시도분까지 포함해 실제 청구된 비용을 전부 합산한다(재시도로 버린 첫
  // 응답도 돈은 이미 냈으므로 usage 에서 누락하면 안 됨). 이제 코멘트
  // 호출도 재시도를 타므로 두 호출의 attempts 를 함께 센다.
  const allAttempts = [...research.attempts, ...macroCall.attempts, ...commentCall.attempts];
  const totalUsage = allAttempts.reduce(
    (acc, r) => ({
      inputTokens: acc.inputTokens + r.usage.inputTokens,
      outputTokens: acc.outputTokens + r.usage.outputTokens,
      thoughtTokens: acc.thoughtTokens + r.usage.thoughtTokens,
      costUsd: acc.costUsd + r.usage.costUsd,
    }),
    { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, costUsd: 0 },
  );

  // 두 호출 결과를 하나로 합쳐서 돌려준다 — 호출부(generate.ts)는 여전히
  // "호출 하나" 인터페이스로 usage/그라운딩 출처를 저장한다.
  const mergedResult: GeminiResult = {
    text: `${macroResult.text}\n${commentResult.text}`,
    model: macroResult.model,
    usage: totalUsage,
    groundingQueries: allAttempts.flatMap((r) => r.groundingQueries),
    groundingSources: allAttempts.flatMap((r) => r.groundingSources),
  };

  return { comments, result: mergedResult };
}

// ---- claude.ai 커넥터(`/api/mcp`, 오너 지시 2026-10-10) -------------------------
// Anthropic API 대신 오너 구독의 claude.ai 가 이 앱 데이터를 받아 해석을 쓴다(추가 비용 0).
// 입력은 Gemini 와 같은 payload 에 리포트 요약 발췌·링크를 더한 것(rich), 출력은 같은
// 검증(assembleComments)을 거친다. 차이는 하나 — Claude 가 웹에서 확인한 출처(sources)를
// 같이 보내면 Gemini 그라운딩 성공과 같게 보고 숫자 대조를 건너뛴다. 회의 월 검사는 항상.

function beforeOutputSection(prompt: string): string {
  const i = prompt.indexOf("\n# 출력 형식");
  return (i >= 0 ? prompt.slice(0, i) : prompt).trim();
}

export const CONNECTOR_GUIDE = `${beforeOutputSection(MACRO_PROMPT)}

${beforeOutputSection(COMMENT_PROMPT).slice(beforeOutputSection(COMMENT_PROMPT).indexOf("# 작성 원칙")).replace("# 작성 원칙", "# 작성 원칙 (자산·이슈·섹터 코멘트)")}

# claude.ai 커넥터로 쓸 때 (위 규칙에 더해)
- 순서: get_weekly_data 로 받은 data 를 읽고 → 웹검색으로 그 주 사실을 확인하며 쓴 뒤 →
  save_weekly_draft 로 저장한다. preview:true 로 먼저 보내면 저장 없이 완성 본문과 폐기 사유를 돌려준다.
- data.webFacts 는 비어 있다(Gemini 전용 단계) — 필요한 사실은 직접 웹검색으로 확인한다.
- 리포트 근거(reports)에는 증권사 리포트 요약 발췌(summary)와 PDF 링크가 있다. 제목만 보지 말고 발췌를 읽고 쓴다.
- **issues.reading** 은 (a) 무엇이 일어났고 왜 중요한지(메커니즘) → (b) 다음에 무엇을 볼 것인가 →
  (c) 그에 따른 대응 방안(투자 시사점)을 이어서 한 문단으로 쓴다(오너 지시 2026-10-10 — "무엇을 볼 것인가 다음에
  이어 쓰면 된다"). 200~500자. 방안도 단정하지 말고 조건부로("~라면 ~유리").
- 웹에서 확인한 사실을 쓰면 그 출처를 sources 에 넣는다({title,url}). sources 가 비어 있으면 입력 data 에 없는
  수치(%·bp·배·pt·건)가 든 문장은 저장할 때 통째로 버려진다.
- calendar 에는 data.codeCalendar(코드가 이미 확정해 싣는 일정)에 **없는 것만** 넣는다 — 같은 행사를 다른 말로
  다시 쓰면 표에 두 번 나간다.
- **검증(오너 지시 2026-10-10 — "정보에 대한 검증은 철저해야", "일년전에 발표하고 우연히 지금 맞을수도 있기에")**:
  - 쓰는 사실은 모두 reportWeek(앞뒤 주말 포함)에 나온 것이어야 한다. 웹에서 찾은 글은 **발행일을 확인**하고 sources 에
    date(YYYY-MM-DD)로 넣는다 — 날짜가 없거나 기간 밖인 출처는 서버가 버리고, 남은 출처가 없으면 입력에 없는 수치가 든 문장은
    저장되지 않는다. 오래된 전망·리포트가 지금 상황과 맞아 보여도 이번 주 근거로 쓰지 않는다.
  - 핵심 주장에는 **수치를 명시**한다(지표 값·예상치·변동폭·금리 수준 등). issues.reading 과 headline 에 수치가 하나도 없으면
    저장 결과에 경고가 돌아온다.
  - 증권사 의견은 **여러 시각 중 하나**로 쓴다("○○증권은 ~로 봄"). 단정적 사실처럼 옮기지 말고, 가능하면 지표·가격 같은 시장
    데이터와 함께 쓴다. 증권사 이름은 data 의 reports 나 sources 에 실제로 있는 것만 — 없는 증권사를 인용하면 그 칸은 버려진다.
  - **뉴스가 가장 빠른 원천이다**(오너 2026-10-10). 그 주 화두는 issues[].news·policyEvidence/economyEvidence 의 news 와 웹 뉴스
    검색(그 주 날짜)으로 먼저 잡고, 증권사 리포트는 그 해석·전망 쪽 근거로 쓴다.
- 키는 data 의 값을 그대로: snapshot = snapshot[].name, issues = issues[].label, sectors = sectors[].id.
- 표·숫자·구조는 서버 코드가 만든다. 문장만 보낸다.`;

/** get_weekly_data 응답용 — 리포트 요약 발췌를 담은 payload(webFacts 는 비움) */
export async function buildConnectorPayload(
  snapshot: SnapshotRow[],
  issues: WeeklyIssue[],
  week: ReportWeek,
  allIssues: WeeklyIssue[],
  sectors: WeeklySectors,
  extras: CommentExtras,
): Promise<CommentPayload & { nextWeekSchedule: ScheduleItem[]; codeCalendar: { date: string; event: string }[] }> {
  const allMeetings = await getCentralBankMeetings();
  const meetings = allMeetings.filter((m) => m.date >= week.weekStart);
  return {
    ...buildPayload(snapshot, issues, week, allIssues, sectors, meetings, extras, true),
    nextWeekSchedule: extras.schedule,
    // 코드가 이미 확정해 "7. 다음 주 주시 일정"에 싣는 일정 — calendar 에는 여기 없는 것만 보내게(중복 방지)
    codeCalendar: extras.codeCalendar,
  };
}

/** save_weekly_draft 입력 — Gemini 두 호출의 응답 스키마를 합친 것 */
export interface ConnectorComments {
  headline?: string;
  economySummary?: string;
  policySummary?: string;
  calendar?: { date?: string; event?: string }[];
  snapshot?: Record<string, string>;
  issues?: Record<string, string | { headline?: unknown; reading?: unknown }>;
  sectors?: Record<string, string>;
}

export async function assembleConnectorComments(
  snapshot: SnapshotRow[],
  issues: WeeklyIssue[],
  week: ReportWeek,
  allIssues: WeeklyIssue[],
  sectors: WeeklySectors,
  extras: CommentExtras,
  input: ConnectorComments,
  /** 날짜 검사를 통과한 웹 출처(제목) — 0건이면 숫자 대조를 그대로 건다 */
  sourceTitles: string[],
): Promise<{ comments: WeeklyComments; warnings: string[] }> {
  const allMeetings = await getCentralBankMeetings();
  const meetings = allMeetings.filter((m) => m.date >= week.weekStart);
  const payload = buildPayload(snapshot, issues, week, allIssues, sectors, meetings, extras, true);
  const trusted = sourceTitles.length > 0;
  const { cleaned, reasons } = checkBrokerCitations(input, payload, sourceTitles);
  const comments = assembleComments({
    payload,
    allMeetings,
    week,
    extras,
    macroParsed: {
      headline: cleaned.headline,
      economySummary: cleaned.economySummary,
      policySummary: cleaned.policySummary,
      calendar: cleaned.calendar,
    },
    macroTrustGrounded: trusted,
    commentParsed: { snapshot: cleaned.snapshot, issues: cleaned.issues, sectors: cleaned.sectors },
    commentTrustGrounded: trusted,
    dropReasons: new Map(),
    webFacts: [],
  });
  // 증권사 인용 폐기 사유가 "모델이 생성하지 않음" 같은 일반 사유에 덮이지 않게 마지막에 덮어쓴다
  for (const [k, v] of reasons) comments.dropReasons.set(k, v);

  // 핵심 수치 명시(오너 지시 2026-10-10) — 버리지는 않고 경고로 돌려줘 고쳐 쓰게 한다
  const warnings: string[] = [];
  const hasNum = (t: string | null | undefined) => /\d/.test(t ?? "");
  if (comments.headline && !hasNum(comments.headline)) warnings.push("headline: 핵심 수치가 없음");
  for (const [label, c] of comments.issues) if (!hasNum(c.reading)) warnings.push(`issue:${label}: 해석에 핵심 수치가 없음`);
  if (!trusted) warnings.push("날짜가 확인된 웹 출처가 없음 — 입력 data 에 없는 수치는 문장째 버려짐");
  return { comments, warnings };
}

/**
 * 증권사 인용 검사(오너 지시 2026-10-10 — "증권사명을 넣는것도 좋지만 그건 여러개의 의견 중 하나일뿐이라 주간에 나온 이슈에
 * 대한것이 맞는지도 검증"). 문장에 "○○증권"이 나오면 그 주 data(reports 의 source — 수집 단계에서 이미 리포트 주로 걸러짐)나
 * 날짜 검사를 통과한 웹 출처 제목에 그 증권사가 있어야 한다. 없으면 그 칸(줄 목록은 그 줄)만 버린다.
 */
const BROKER_RE = /([가-힣A-Za-z]{1,10}(?:투자증권|금융투자|증권))(?!사)/g;

function checkBrokerCitations(
  input: ConnectorComments,
  payload: CommentPayload,
  sourceTitles: string[],
): { cleaned: ConnectorComments; reasons: Map<string, string> } {
  const known = new Set<string>();
  const add = (s: string) => known.add(s.replace(/\s+/g, ""));
  for (const i of payload.issues) for (const r of i.reports) add(r.source);
  for (const p of [...payload.policyEvidence, ...payload.economyEvidence]) for (const r of p.reports) add(r.source);
  const titles = sourceTitles.join(" ").replace(/\s+/g, "");
  const unknown = (text: string): string | null => {
    for (const m of text.matchAll(BROKER_RE)) {
      const name = m[1].replace(/\s+/g, "");
      if (known.has(name) || titles.includes(name)) continue;
      // data 에 "신한투자증권"이 있으면 본문의 "신한증권" 같은 줄임도 같은 회사로 본다
      const stem = name.replace(/(투자증권|금융투자|증권)$/, "");
      if (stem && [...known].some((k) => k.startsWith(stem))) continue;
      return `그 주 근거(data·출처)에 없는 증권사 인용 "${m[1]}"`;
    }
    return null;
  };
  const reasons = new Map<string, string>();
  const one = (key: string, text: string | undefined): string | undefined => {
    if (!text) return text;
    const r = unknown(text);
    if (!r) return text;
    reasons.set(key, r);
    return undefined;
  };
  const lines = (key: string, text: string | undefined): string | undefined => {
    if (!text) return text;
    const kept: string[] = [];
    const bad: string[] = [];
    for (const l of text.split(/\r?\n/)) {
      const r = l.trim() ? unknown(l) : null;
      if (r) bad.push(`${l.trim().slice(0, 24)}… — ${r}`);
      else kept.push(l);
    }
    if (bad.length) reasons.set(key, `일부 줄 폐기: ${bad.join(" / ")}`);
    return kept.join("\n").trim() || undefined;
  };
  const rec = (prefix: string, obj: Record<string, string> | undefined) => {
    if (!obj) return obj;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      const t = one(`${prefix}:${k}`, v);
      if (t) out[k] = t;
    }
    return out;
  };
  const issues: ConnectorComments["issues"] = {};
  for (const [k, v] of Object.entries(input.issues ?? {})) {
    const text = typeof v === "string" ? v : `${String(v?.headline ?? "")} ${String(v?.reading ?? "")}`;
    const r = unknown(text);
    if (r) reasons.set(`issue:${k}`, r);
    else issues[k] = v;
  }
  return {
    cleaned: {
      headline: one("headline", input.headline),
      economySummary: lines("economySummary", input.economySummary),
      policySummary: lines("policySummary", input.policySummary),
      calendar: input.calendar,
      snapshot: rec("snapshot", input.snapshot),
      issues,
      sectors: rec("sector", input.sectors),
    },
    reasons,
  };
}
