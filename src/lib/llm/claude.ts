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
매체로 보이거나 제목이 확인되지 않은 루머·자극적 낚시성으로 보이면 제외하세요. 제목에
"Market Chatter"·"루머"·"~카더라"·"~라는 관측" 처럼 미확인 시장 소문임을 스스로 밝히는
표현이 있으면 출처가 통신사여도 제외하세요.

C. 중복 — 위에서 관련 있다고 고른 기사들 중, 서로 다른 매체가 문구만 다르게 써서 사실상
같은 사건을 보도한 것들이 있으면(예: "팀 쿡이 갤럭시폰으로 바꿨습니다"와 "팀 쿡도 갤럭시로
바꿨다"는 같은 사건) 번호를 그룹으로 묶어주세요. 단독 기사는 그룹에 넣지 마세요.

오직 아래 형식의 JSON 객체 하나만 출력하세요(다른 텍스트 없이):
{"relevant": [0,3,5], "duplicates": [[3,5]]}
relevant: 관련 있는 기사 번호 배열(없으면 []). duplicates: 중복 그룹 배열(없으면 []).`;

  const response = await anthropic().messages.create({
    model: MODEL,
    max_tokens: 600,
    system,
    messages: [{ role: "user", content: numbered }],
  });

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  const raw = textBlock?.text ?? "";
  const costUsd =
    response.usage.input_tokens * PRICE_PER_TOKEN.input +
    response.usage.output_tokens * PRICE_PER_TOKEN.output;

  let parsed: { relevant?: unknown; duplicates?: unknown } = {};
  try {
    // 비탐욕(non-greedy) 매칭 — 모델이 JSON 뒤에 분석 텍스트를 덧붙이면(지시를
    // 어김, 실측 확인) 탐욕적 매칭이 그 안의 중괄호까지 삼켜 파싱이 깨짐.
    const match = raw.match(/\{[\s\S]*?\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    parsed = {};
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
