import "server-only";

/**
 * Gemini API(REST) 최소 클라이언트 — 주간 리포트 전용. SDK 없이 fetch 한 번.
 * 결제: Google AI Pro 구독에 포함된 월 $10 Cloud 크레딧이 붙은 프로젝트의
 * API 키(GEMINI_API_KEY)를 쓴다(유료 등급 → 프롬프트가 모델 학습에 안 쓰임).
 * 모델은 GEMINI_MODEL 로 교체 가능(기본 gemini-3.8-flash).
 */

/**
 * 오너 결정 2026-09-21 — 같은 주(2026-09-14~18) 같은 입력으로
 * gemini-3.1-pro-preview 와 실측 비교(`compareWeeklyModels`)한 결과 3.8 Flash
 * 채택. Pro 대비 소요 73.7s→20.0s, 비용 $0.381→$0.270, 본문 품질은 오히려
 * 더 구체적이었다(사우디 환적 건에 "대체 수송로 확보", 한국은행 항목에
 * 금리차·환율·유가 세 요인을 짚는 식). 티어상 Pro 가 상위지만 세대 차가
 * 3.1 → 3.8 로 커서 뒤집힌 것으로 보인다. Pro 는 preview 라 안정성 면에서도
 * 불리했다(3.8/3.7/3.6 Flash 는 stable).
 *
 * **다시 비교하려면**: gh workflow run weekly-model-compare.yml
 *   -f models="gemini-3.8-flash,<비교대상>"
 */
const DEFAULT_MODEL = "gemini-3.8-flash";
// 기본 모델이 404(이름 변경·폐기)일 때 순서대로 시도. 2026-09 실측 ListModels
// 기준: 한 세대 아래 Flash → 별칭 두 개. 2.5 세대는 신규 사용자에겐 막혀 제외.
const FALLBACK_MODELS = ["gemini-3.7-flash", "gemini-flash-latest", "gemini-pro-latest"];

/**
 * 공식 단가(ai.google.dev/gemini-api/docs/pricing, 2026-09-21 확인. 1M 토큰당
 * USD). 사고(thinking) 토큰은 출력 단가로 과금된다.
 *
 * **2026-12-31 까지 프로모션 가격이다** — 2027-01-01 부터 입력 $1.50 /
 * 출력 $7.50 으로 두 배가 되니 그때 갱신해야 한다. 안 고치면 월 예산
 * (WEEKLY_MONTHLY_BUDGET_USD) 검사가 실제보다 느슨해진다.
 */
const PRICE = { input: 0.75 / 1e6, output: 3.75 / 1e6 };
/**
 * 웹검색 그라운딩 요청당 단가. 공식 표기는 **월 5,000건 무료, 초과분
 * $14/1,000건**이다(= 건당 $0.014). 주간 리포트는 회당 2~3콜이라 월 10건
 * 남짓 — 실제로는 무료 구간 안이라 $0 이다. 무료 한도를 코드로 세지는 않고
 * 상한(건당 $0.014)으로 잡아 둔다: 예산 검사가 과소평가되는 쪽보다 안전하다.
 * 종전 값 $0.035 는 근거 없는 추정치였다(2026-09-21 공식 단가로 교정).
 */
const GROUNDING_COST_PER_REQUEST = 0.014;

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
