import "server-only";

/**
 * Gemini API(REST) 최소 클라이언트 — 주간 리포트 전용. SDK 없이 fetch 한 번.
 * 결제: Google AI Pro 구독에 포함된 월 $10 Cloud 크레딧이 붙은 프로젝트의
 * API 키(GEMINI_API_KEY)를 쓴다(유료 등급 → 프롬프트가 모델 학습에 안 쓰임).
 * 모델은 GEMINI_MODEL 로 교체 가능(기본 gemini-3.1-pro-preview).
 */

const DEFAULT_MODEL = "gemini-3.1-pro-preview";
// 기본 모델이 404(이름 변경·폐기)일 때 순서대로 시도. 2026-09 실측 ListModels 기준:
// gemini-pro-latest(별칭) → 최신 Flash. 2.5 세대는 신규 사용자에겐 이미 막혀 제외.
const FALLBACK_MODELS = ["gemini-pro-latest", "gemini-3.6-flash", "gemini-flash-latest"];

// 공식 단가(2026-09 기준, 1M 토큰당 USD, 프롬프트 20만 토큰 이하 구간) — 변경 시 갱신.
// 사고(thinking) 토큰은 출력 단가로 과금된다.
const PRICE = { input: 2.0 / 1e6, output: 12.0 / 1e6 };
// 웹검색 그라운딩은 요청당 별도 과금(추정치 — 실제 청구서로 보정할 것).
const GROUNDING_COST_PER_REQUEST = 0.035;

export interface GeminiUsage {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  costUsd: number;
}

export interface GeminiResult {
  text: string;
  model: string;
  usage: GeminiUsage;
  groundingQueries: string[];
  groundingSources: { title: string; uri: string }[];
}

/** Gemini API 가 4xx/5xx 로 응답한 경우 — 라우트에서 메시지를 그대로 노출(502) */
export class GeminiApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "GeminiApiError";
  }
}

export function isGeminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

interface GenerateOpts {
  system: string;
  user: string;
  /** 모델 비교용 오버라이드 — 주면 폴백 체인 없이 이 모델만 쓴다
   *  (generate.ts 의 compareWeeklyModels). 평소엔 비워 둔다. */
  model?: string;
  grounding?: boolean;
  maxOutputTokens?: number;
  temperature?: number;
}

interface RawResponse {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: { web?: { uri?: string; title?: string } }[];
    };
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  error?: { code?: number; message?: string; status?: string };
}

async function callOnce(model: string, opts: GenerateOpts, key: string): Promise<{ status: number; body: RawResponse }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const payload: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: opts.system }] },
    contents: [{ role: "user", parts: [{ text: opts.user }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.3,
      maxOutputTokens: opts.maxOutputTokens ?? 16_000,
    },
  };
  if (opts.grounding) payload.tools = [{ google_search: {} }];
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(240_000),
  });
  const body = (await res.json().catch(() => ({}))) as RawResponse;
  return { status: res.status, body };
}

export async function geminiGenerate(opts: GenerateOpts): Promise<GeminiResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY 미설정");
  const primary = opts.model?.trim() || process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  const chain = primary === DEFAULT_MODEL ? [primary, ...FALLBACK_MODELS] : [primary];

  let lastErr = "";
  for (const model of chain) {
    const { status, body } = await callOnce(model, opts, key);
    if (status === 404 || body.error?.status === "NOT_FOUND") {
      lastErr = `${model}: ${body.error?.message ?? "not found"}`;
      continue; // 모델명이 바뀐 경우 다음 후보
    }
    if (status !== 200) {
      throw new GeminiApiError(`Gemini ${model} ${status}: ${body.error?.message ?? "unknown error"}`, status);
    }
    const cand = body.candidates?.[0];
    const text = (cand?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("");
    if (!text.trim()) {
      throw new GeminiApiError(`Gemini ${model}: 빈 응답 (finishReason=${cand?.finishReason ?? "?"})`, 502);
    }
    const u = body.usageMetadata ?? {};
    const inputTokens = u.promptTokenCount ?? 0;
    const outputTokens = u.candidatesTokenCount ?? 0;
    const thoughtTokens = u.thoughtsTokenCount ?? 0;
    const costUsd =
      inputTokens * PRICE.input +
      (outputTokens + thoughtTokens) * PRICE.output +
      (opts.grounding ? GROUNDING_COST_PER_REQUEST : 0);
    const gm = cand?.groundingMetadata;
    return {
      text,
      model,
      usage: { inputTokens, outputTokens, thoughtTokens, costUsd },
      groundingQueries: gm?.webSearchQueries ?? [],
      groundingSources: (gm?.groundingChunks ?? [])
        .map((c) => ({ title: c.web?.title ?? "", uri: c.web?.uri ?? "" }))
        .filter((s) => s.uri),
    };
  }
  throw new GeminiApiError(`Gemini 모델을 찾지 못함 — ${lastErr}`, 404);
}
