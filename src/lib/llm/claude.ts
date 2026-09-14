import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/**
 * 종목뉴스 선택 요약 전용 LLM 호출. 체크한 기사 1건에 대해 (필요시) 번역 +
 * 요약 + 진위(공신력 있는 실제 보도인지) 판단을 한 번의 호출로 수행 — 비용 절감.
 * 모델은 Haiku 4.5(가장 저렴한 현재 모델) — 번역·요약은 고난도 추론 불필요.
 */

const MODEL = "claude-haiku-4-5";
// 2026-06 기준 단가 (1M 토큰당, USD) — 가격 변경 시 갱신 필요.
const PRICE_PER_TOKEN = { input: 1.0 / 1_000_000, output: 5.0 / 1_000_000 };

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export interface SummarizeResult {
  translatedTitle: string;
  translatedText: string;
  summary: string;
  isLikelyGenuine: boolean;
  reason: string;
  costUsd: number;
}

/**
 * needsTranslation=false(한국 기사)면 번역 없이 요약+진위판단만 수행 —
 * translatedTitle/translatedText 는 원문 그대로 채워 반환(화면 표시 단순화).
 */
export async function summarizeArticle(input: {
  title: string;
  bodyText: string;
  publisher: string;
  needsTranslation: boolean;
}): Promise<SummarizeResult> {
  const { title, bodyText, publisher, needsTranslation } = input;
  const truncatedBody = bodyText.slice(0, 12000); // 입력 토큰 상한 방어

  const system = needsTranslation
    ? `당신은 금융 뉴스 번역·요약 도우미입니다. 아래 규칙을 따라 오직 JSON 객체 하나만 출력하세요(다른 텍스트 없이):
{
  "translatedTitle": "제목의 자연스러운 한국어 번역",
  "translatedText": "본문 전체의 자연스러운 한국어 번역(생략 없이, 단 과도하게 길면 핵심 유지하며 축약 가능)",
  "summary": "3~5문장의 한국어 핵심 요약",
  "isLikelyGenuine": true 또는 false (아래 기준으로 판단),
  "reason": "isLikelyGenuine 판단 근거 한 문장"
}
isLikelyGenuine 판단 기준: 실제 언론사(${publisher})가 작성한 정상적인 보도 기사로 보이는지
평가하세요. 본문이 비어있거나, 광고/스팸/페이월 안내문뿐이거나, 내용이 제목과 무관하거나,
명백히 조작된 것으로 보이면 false 로 판단하세요.`
    : `당신은 금융 뉴스 요약 도우미입니다. 아래 규칙을 따라 오직 JSON 객체 하나만 출력하세요(다른 텍스트 없이):
{
  "summary": "3~5문장의 한국어 핵심 요약",
  "isLikelyGenuine": true 또는 false (아래 기준으로 판단),
  "reason": "isLikelyGenuine 판단 근거 한 문장"
}
isLikelyGenuine 판단 기준: 실제 언론사(${publisher})가 작성한 정상적인 보도 기사로 보이는지
평가하세요. 본문이 비어있거나, 광고/스팸/페이월 안내문뿐이거나, 내용이 제목과 무관하거나,
명백히 조작된 것으로 보이면 false 로 판단하세요.`;

  const response = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 4000,
    system,
    messages: [{ role: "user", content: `제목: ${title}\n\n본문:\n${truncatedBody}` }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  const raw = textBlock?.text ?? "";
  const costUsd =
    response.usage.input_tokens * PRICE_PER_TOKEN.input +
    response.usage.output_tokens * PRICE_PER_TOKEN.output;

  let parsed: {
    translatedTitle?: string;
    translatedText?: string;
    summary?: string;
    isLikelyGenuine?: boolean;
    reason?: string;
  };
  try {
    // 비탐욕(non-greedy) 매칭 — 모델이 JSON 뒤에 설명 텍스트를 덧붙이면(지시를
    // 어김) 탐욕적 매칭이 그 안의 {}/[] 까지 삼켜서 파싱이 깨지는 문제 실측 확인.
    const match = raw.match(/\{[\s\S]*?\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    // 파싱 실패 — 안전하게 실패로 처리(저장하지 않도록 false)
    return {
      translatedTitle: title,
      translatedText: "",
      summary: "",
      isLikelyGenuine: false,
      reason: "LLM 응답 파싱 실패",
      costUsd,
    };
  }

  return {
    translatedTitle: needsTranslation ? (parsed.translatedTitle ?? title) : title,
    translatedText: needsTranslation ? (parsed.translatedText ?? "") : "",
    summary: parsed.summary ?? "",
    isLikelyGenuine: parsed.isLikelyGenuine !== false,
    reason: parsed.reason ?? "",
    costUsd,
  };
}

export interface BusinessProfile {
  bullets: string[];
  ecosystemCore: string;
  ecosystem: { label: string; category: string }[];
  costUsd: number;
}

/**
 * PPT 종목 원페이지의 "핵심 비즈니스 요약" 불릿 + "사업 생태계" 방사형
 * 다이어그램 데이터를 종목명만으로 자동 생성(오너 지시, 2026-09 — Gemini에
 * 한화에어로스페이스 이름만 주고 생태계 다이어그램까지 자동으로 뽑아낸
 * 사례를 보여주며 "내가 데이타 준거없음. 한화에어로스페이스만 줬음").
 *
 * Gemini는 실시간 웹 검색으로 사실을 확인했지만, 이 프로젝트엔 그런 검색
 * 도구가 없다 — Haiku의 학습 지식만으로 생성하므로 아주 최신 사업(수개월
 * 이내 발표) 은 못 담을 수 있음을 프롬프트에 명시하고, 널리 알려진 사업
 * 라인 위주로만 답하도록 유도한다. 재무 숫자(매출·EPS 등)는 절대 여기서
 * 만들지 않는다 — 그쪽은 DART/EDGAR/Yahoo 실측 데이터 전용(slide-data.ts
 * 다른 부분), LLM이 숫자를 지어내면 재무제표 신뢰도 자체가 깨짐.
 *
 * ecosystem 은 6~10개 노드, 각각 "카테고리"(색상 그룹, 예: "지상무기")와
 * "라벨"(원 안에 들어갈 짧은 이름, 예: "K9 썬더")을 가진다 — slide.ts가
 * 카테고리별로 색을 묶고 라벨을 원 안에 배치한다.
 */
export async function generateBusinessProfile(
  name: string,
  sector: string | null,
): Promise<BusinessProfile> {
  const system = `당신은 증권사 리서치 애널리스트입니다. 회사명만 보고 그 회사의 사업
구조를 요약해 오직 JSON 객체 하나만 출력하세요(다른 텍스트 없이):
{
  "bullets": ["핵심 투자 포인트 한국어 문장 1", "문장 2", "문장 3"],
  "ecosystemCore": "이 회사 사업의 본질을 나타내는 1~2단어(영문 가능, 예: Defense, Food, Semiconductor)",
  "ecosystem": [
    {"category": "사업 대분류(2~5글자)", "label": "구체적 제품·서비스·자회사명(2~8글자)"}
  ]
}
규칙:
- bullets 는 3개, 각 40자 내외 — 시장 지위·경쟁 우위·최근 방향성 위주로.
- ecosystem 은 6~10개 노드. 대분류(category)가 겹치는 노드가 자연스럽게
  섞여도 됨 — 실제 사업부/제품/자회사명을 최대한 구체적으로(일반적인
  "기타 사업" 같은 모호한 라벨 금지).
- 확실히 아는 사실만 답하세요. 최근 수개월 내 발표된 사업은 놓칠 수
  있음을 감안해 널리 알려진 주력 사업 위주로 답하고, 불확실하면 노드
  개수를 줄여 보수적으로 답하세요 — 지어내지 마세요.
- 숫자(매출액·점유율%·주가 등)는 이 응답에 절대 포함하지 마세요.`;
  const userMsg = sector ? `회사명: ${name}\n업종: ${sector}` : `회사명: ${name}`;

  const response = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 1200,
    system,
    messages: [{ role: "user", content: userMsg }],
  });
  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  const raw = textBlock?.text ?? "";
  const costUsd =
    response.usage.input_tokens * PRICE_PER_TOKEN.input +
    response.usage.output_tokens * PRICE_PER_TOKEN.output;

  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw) as {
      bullets?: unknown;
      ecosystemCore?: unknown;
      ecosystem?: unknown;
    };
    const bullets = Array.isArray(parsed.bullets)
      ? parsed.bullets.filter((b): b is string => typeof b === "string" && b.trim().length > 0)
      : [];
    const ecosystem = Array.isArray(parsed.ecosystem)
      ? parsed.ecosystem
          .filter(
            (n): n is { label: unknown; category: unknown } =>
              typeof n === "object" && n !== null,
          )
          .map((n) => ({
            label: String((n as { label?: unknown }).label ?? "").trim(),
            category: String((n as { category?: unknown }).category ?? "").trim(),
          }))
          .filter((n) => n.label.length > 0)
      : [];
    return {
      bullets,
      ecosystemCore: typeof parsed.ecosystemCore === "string" ? parsed.ecosystemCore.trim() : "",
      ecosystem,
      costUsd,
    };
  } catch {
    return { bullets: [], ecosystemCore: "", ecosystem: [], costUsd };
  }
}

/**
 * 뉴스 헤드라인 번역의 최종 폴백(오너 승인, 2026-09 — 무료 API 두 곳(Google
 * 번역 웹 엔드포인트·MyMemory)이 동시에 실패할 때만 호출). 무인증 Google
 * 번역 엔드포인트가 배포 IP 기준으로 간헐적으로 429(요청 과다)를 내고,
 * MyMemory는 그럴 때 번역 없이 원문을 그대로 돌려주는 경우가 실측으로
 * 확인돼(예: "Dow Jones Futures Fall..." 헤드라인) 무료 경로만으로는 일부
 * 헤드라인이 계속 영어로 남는 문제가 있었음 — src/lib/news/translate.ts 가
 * 두 무료 경로 다 실패했을 때만 이 함수를 부른다. 헤드라인 1건이라 비용은
 * 거의 무시할 수준(건당 $0.0001 미만)이지만, 그래도 월 $10 예산에는 포함
 * 시켜(incUsage) 상한 로직과 일관되게 관리한다 — 호출 전 예산 확인은
 * translate.ts 쪽에서 처리.
 */
export async function translateHeadline(
  text: string,
  sourceLang: "en" | "ja",
): Promise<{ ko: string | null; costUsd: number }> {
  const langName = sourceLang === "ja" ? "일본어" : "영어";
  const response = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 300,
    system: `당신은 금융 뉴스 헤드라인 번역기입니다. 주어진 ${langName} 헤드라인 1개를 자연스러운
한국어로 번역해 오직 JSON 객체 하나만 출력하세요(다른 텍스트 없이): {"ko": "번역된 헤드라인"}`,
    messages: [{ role: "user", content: text }],
  });
  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  const raw = textBlock?.text ?? "";
  const costUsd =
    response.usage.input_tokens * PRICE_PER_TOKEN.input +
    response.usage.output_tokens * PRICE_PER_TOKEN.output;
  try {
    const match = raw.match(/\{[\s\S]*?\}/);
    const parsed = JSON.parse(match ? match[0] : raw) as { ko?: string };
    return { ko: parsed.ko?.trim() || null, costUsd };
  } catch {
    return { ko: null, costUsd };
  }
}

/**
 * 종목뉴스 목록의 "이 기사가 진짜 이 종목 얘기인가" 판정 — 순수 키워드 매칭으로는
 * 판단 불가(회사명이 요약에 스치듯 언급만 돼도 통과되거나, 반대로 축약형만 써서
 * 걸러지는 문제 반복 확인됨). 국내+해외 후보를 한 번의 호출로 함께 판정해
 * 종목 조회 1회당 LLM 호출 1회로 비용을 묶는다.
 */
export interface RelevanceCandidate {
  id: string;
  title: string;
  excerpt?: string;
  /** 발행 도메인/언론사명 — 고정 화이트리스트를 안 거친 후보도 섞여 있어
   * 신뢰도 판단에 참고(예: 유명 신문사 도메인 vs 낯선 도메인). */
  publisher?: string;
}

export interface RelevanceResult {
  relevantIds: Set<string>;
  /** 서로 다른 매체가 문구만 다르게 보도한 같은 사건 그룹(각 배열 원소 2개 이상) — id 기준. */
  duplicateGroups: string[][];
  costUsd: number;
}

export async function judgeNewsRelevance(
  companyName: string,
  items: RelevanceCandidate[],
): Promise<RelevanceResult> {
  if (items.length === 0) return { relevantIds: new Set(), duplicateGroups: [], costUsd: 0 };

  const numbered = items
    .map(
      (it, i) =>
        `${i}. [${it.publisher ?? "?"}] ${it.title}${it.excerpt ? ` — ${it.excerpt}` : ""}`,
    )
    .join("\n");
  const system = `당신은 금융 뉴스 관련성·신뢰도 판정 도우미입니다. 아래 번호 매겨진 기사 목록
(각 줄 맨 앞 [ ]는 발행 매체) 중 아래 두 조건을 모두 만족하는 기사만 골라주세요:

A. 관련성 — 실제로 "${companyName}"에 관한 기사이거나 투자 판단에 참고가 되는 기사. 다음
중 하나에 해당하면 포함하세요:
1) 그 회사의 실적·사업·주가·경영진 행보 등을 직접 다루는 기사
2) 이름이 명시된 직접 경쟁사에 대한 기사로, 그 회사의 경쟁 지위에 참고가 될 만한 내용
   (예: 반도체 파운드리 경쟁사의 점유율 변화는 삼성전자에 참고가 됨)
3) 그 회사의 핵심 사업이 속한 산업/업종 자체를 깊이 있게 다루는 기사 — 회사 이름이 없어도
   됨(예: 반도체 업황·공급망·수요 전망, 방산 수출 동향 등 그 산업에 실질적으로 종사하는
   회사의 사업에 참고가 되는 심층 기사)

다음은 제외하세요:
- 여러 종목·업종을 나열하며 시황(주가 등락·금리·유가 등)을 설명하는 기사에서 그 회사가
  예시 중 하나로만 스쳐 지나가는 경우(예: "오늘 강세 종목: A, B, C…" 식 나열이나 "금리
  인상에 A·B·C 등락"처럼 여러 종목을 함께 설명하며 하나로만 언급)
- 같은 그룹 계열사 전체를 다루거나, 채용 통계·인물 동정 기사에서 소속으로만 언급되는 경우

B. 신뢰도 — 매체명·제목·요약을 보고 정상적인 보도로 보이는지 판단하세요. 매체명이 알려진
언론사가 아니어도 괜찮지만(전문지·지역지 등 정당한 매체일 수 있음), 광고/스팸/어뷰징성
매체로 보이면 제외하세요. 루머·미확인 보도라는 이유만으로 제외하지는 마세요.

C. 중복 — 위에서 관련 있다고 고른 기사들 중, 서로 다른 매체가 문구만 다르게 써서 사실상
같은 사건을 보도한 것들이 있으면(예: "팀 쿡이 갤럭시폰으로 바꿨습니다"와 "팀 쿡도 갤럭시로
바꿨다"는 같은 사건) 번호를 그룹으로 묶어주세요. 단독 기사는 그룹에 넣지 마세요.

오직 아래 형식의 JSON 객체 하나만 출력하세요(다른 텍스트 없이):
{"relevant": [0,3,5], "duplicates": [[3,5]]}
relevant: 관련 있는 기사 번호 배열(없으면 []). duplicates: 중복 그룹 배열(없으면 []).`;

  // 출력은 번호 배열이라 후보 수에 비례해 커진다. 600 고정이던 시절
  // 후보 69건(넷플릭스 국내뉴스, 실측)에서 JSON이 잘려 파싱이 깨졌고, 그러면
  // relevant 가 빈 배열이 되면서 호출부의 "전부 걸러냈으면 원본 그대로"
  // 안전장치가 발동해 관련성 판정도 중복 제거도 없이 통과해 버렸다.
  const maxTokens = Math.min(4000, 400 + items.length * 20);
  const response = await anthropic().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: numbered }],
  });
  if (response.stop_reason === "max_tokens") {
    throw new Error(
      `judgeNewsRelevance: 응답이 max_tokens(${maxTokens})에서 잘림 — 후보 ${items.length}건`,
    );
  }

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  const raw = textBlock?.text ?? "";
  const costUsd =
    response.usage.input_tokens * PRICE_PER_TOKEN.input +
    response.usage.output_tokens * PRICE_PER_TOKEN.output;

  let parsed: { relevant?: unknown; duplicates?: unknown };
  try {
    // 비탐욕(non-greedy) 매칭 — 모델이 JSON 뒤에 분석 텍스트를 덧붙이면(지시를
    // 어김, 실측 확인) 탐욕적 매칭이 그 안의 중괄호까지 삼켜 파싱이 깨짐.
    const match = raw.match(/\{[\s\S]*?\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    // 조용히 {} 로 넘기면 "관련 기사 0건" → 안전장치 → 필터 없이 전부 통과가
    // 되면서 실패가 relevance:"llm" 으로 위장된다. 호출부가 폴백을 타도록 던진다.
    throw new Error(`judgeNewsRelevance: JSON 파싱 실패 — ${raw.slice(0, 120)}`);
  }

  const isValidIndex = (i: unknown): i is number =>
    Number.isInteger(i) && (i as number) >= 0 && (i as number) < items.length;

  const relevantIndices = Array.isArray(parsed.relevant) ? parsed.relevant.filter(isValidIndex) : [];
  const relevantIds = new Set(relevantIndices.map((i) => items[i].id));

  const duplicateGroups = Array.isArray(parsed.duplicates)
    ? parsed.duplicates
        .filter((g): g is unknown[] => Array.isArray(g))
        .map((g) => g.filter(isValidIndex).map((i) => items[i].id))
        .filter((g) => g.length > 1)
    : [];

  return { relevantIds, duplicateGroups, costUsd };
}

/**
 * 유니버스통합뉴스(여러 종목의 "최신 기사 1건씩"을 한 화면에 모은 목록) 전용
 * 중복 판정 — 종목별로는 이미 1건씩만 뽑혀 있어도, 같은 사건(예: 계열사 공동
 * 투자 발표, 여러 종목이 함께 언급된 시황 기사)이 서로 다른 종목의 "최신
 * 기사"로 각각 집계돼 사실상 같은 내용이 여러 줄로 중복 노출되는 문제(오너
 * 지적, 2026-09: "미국 유니버스통합 뉴스 중복 뉴스가 많다"). judgeNewsRelevance
 * 와 달리 관련성 판정은 필요 없고(이미 종목별로 확정된 기사들) 순수 중복
 * 그룹 판정만 한다 — 종목명이 다르면 대개 다른 사건이니, 실제로 같은 사건을
 * 다른 매체가 다르게 표현한 경우만 좁게 묶는다(예: "오라클 실적 발표"와
 * "브로드컴 실적 발표"는 둘 다 실적 기사여도 별개 사건 — 절대 묶지 않음).
 */
export interface UniverseDupCandidate {
  id: string;
  title: string;
  /** 어느 종목 기사인지 — 같은 사건인지 판단에 참고(자회사·계열사 공동 이슈 등). */
  stockName?: string;
}

export async function findUniverseNewsDuplicates(
  items: UniverseDupCandidate[],
): Promise<{ duplicateGroups: string[][]; costUsd: number }> {
  if (items.length < 2) return { duplicateGroups: [], costUsd: 0 };

  const numbered = items
    .map((it, i) => `${i}. [${it.stockName ?? "?"}] ${it.title}`)
    .join("\n");
  const system = `당신은 금융 뉴스 중복 판정 도우미입니다. 아래는 서로 다른 종목의 "최신 기사"
목록입니다(각 줄 맨 앞 [ ]는 그 기사가 대표로 뽑힌 종목명, 번호는 기사 순번). 이 중 실제로
같은 사건을 보도한 기사들만 번호로 그룹핑하세요 — 예: 계열사 공동 투자·합병 발표처럼 여러
종목에 동시에 영향을 주는 사건이 각 종목의 "최신 기사"로 따로 집계된 경우, 또는 같은 기사가
검색 중복으로 다른 종목명 아래 다르게 잡힌 경우.

다음은 절대 묶지 마세요:
- 종목이 다르고 사건도 다른 경우(예: "A사 실적 발표"와 "B사 실적 발표"는 둘 다 실적 기사여도
  서로 다른 회사의 서로 다른 사건 — 절대 묶지 않음)
- 같은 산업/섹터를 다룬다는 이유만으로 묶지 않음(사건 자체가 같아야 함)

오직 아래 형식의 JSON 객체 하나만 출력하세요(다른 텍스트 없이):
{"duplicates": [[3,7]]}
duplicates: 같은 사건인 기사 번호 그룹 배열(각 그룹 2개 이상, 없으면 []).`;

  const maxTokens = Math.min(3000, 300 + items.length * 15);
  const response = await anthropic().messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: numbered }],
  });
  if (response.stop_reason === "max_tokens") {
    throw new Error(
      `findUniverseNewsDuplicates: 응답이 max_tokens(${maxTokens})에서 잘림 — 후보 ${items.length}건`,
    );
  }

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  const raw = textBlock?.text ?? "";
  const costUsd =
    response.usage.input_tokens * PRICE_PER_TOKEN.input +
    response.usage.output_tokens * PRICE_PER_TOKEN.output;

  let parsed: { duplicates?: unknown };
  try {
    const match = raw.match(/\{[\s\S]*?\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    throw new Error(`findUniverseNewsDuplicates: JSON 파싱 실패 — ${raw.slice(0, 120)}`);
  }

  const isValidIndex = (i: unknown): i is number =>
    Number.isInteger(i) && (i as number) >= 0 && (i as number) < items.length;

  const duplicateGroups = Array.isArray(parsed.duplicates)
    ? parsed.duplicates
        .filter((g): g is unknown[] => Array.isArray(g))
        .map((g) => g.filter(isValidIndex).map((i) => items[i].id))
        .filter((g) => g.length > 1)
    : [];

  return { duplicateGroups, costUsd };
}
