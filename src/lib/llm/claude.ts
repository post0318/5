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
    const match = raw.match(/\{[\s\S]*\}/);
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
