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
 * 웹검색 그라운딩 비용 — **0 으로 둔다**(오너 판단 2026-09-21 — "검색비용
 * 이면 없는거고").
 *
 * 공식 단가(2026-09-21 확인): **월 5,000건 무료, 초과분 $14/1,000건**.
 * 과금 단위는 API 요청이 아니라 **모델이 실제로 날린 검색 쿼리 하나하나**다
 * ("A customer-submitted request to Gemini may result in one or more queries
 * to Google Search. You will be charged for each individual search query
 * performed.").
 *
 * 이 앱에서 그라운딩을 쓰는 곳은 주간 리포트 코멘트(`comment.ts`, 주 1회 × 2~3콜)
 * 하나뿐이다(발표자료 PPT 는 2026-09-25 삭제). 쿼리를 넉넉히 잡아도 월 수백 건이라 무료 한도의
 * 한 자릿수 % 수준 — 실제 청구액은 $0 이다.
 *
 * 그래서 추정치를 얹지 않는다. 종전 $0.035(근거 없는 추정)는 회당 $0.07~0.10 을
 * 없는 비용으로 잡아 월 예산(WEEKLY_MONTHLY_BUDGET_USD, 기본 $8)을 헛되이
 * 갉아먹고 있었다.
 *
 * **다시 켜야 할 때**: 주간 리포트 외에 그라운딩을 쓰는 기능이 늘어 월
 * 검색 쿼리가 5,000건에 근접하면 건당 $0.014 로 되살린다. 검색으로 가져온
 * 본문은 입력 토큰으로 과금되지 않으므로 토큰 쪽은 따로 볼 필요 없다.
 */
const GROUNDING_COST_PER_REQUEST = 0;

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

/**
 * 그라운딩 진단(오너 지시 2026-09-21) — 검색이 실제로 도는지, 응답 어디에
 * 담기는지 확인한다. 모델 비교에서 두 모델 다 groundingSources: 0 이 나와
 * 원인을 좁혀야 했다.
 *
 * 세 가지 tools 선언을 같은 프롬프트로 각각 시도하고, 응답 candidate 의
 * **키 목록까지 그대로 돌려준다** — 필드 이름이 바뀌었으면 파서가 조용히
 * 0 을 반환하므로 값만 봐서는 구분이 안 된다.
 *
 * 프롬프트는 검색 없이는 답할 수 없는 것으로 잡는다(모델은 필요할 때만
 * 검색한다 — 문서상 강제 옵션이 없다).
 */
export async function geminiGroundingDiagnostic(model?: string): Promise<unknown> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY 미설정");
  const target = model?.trim() || process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  const today = new Date().toISOString().slice(0, 10);
  const user =
    `오늘은 ${today}이다. 최근 일주일 안에 보도된 미국 연방준비제도(Fed) 관련 ` +
    `뉴스 한 건을 매체명과 함께 알려줘. 반드시 웹검색으로 확인한 실제 기사여야 한다.`;

  const variants: { label: string; tools: unknown }[] = [
    { label: "google_search", tools: [{ google_search: {} }] },
    { label: "googleSearch", tools: [{ googleSearch: {} }] },
    { label: "none(대조군)", tools: undefined },
  ];

  const out = [];
  for (const v of variants) {
    const payload: Record<string, unknown> = {
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4000 },
    };
    if (v.tools) payload.tools = v.tools;
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${target}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(90_000),
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        candidates?: Record<string, unknown>[];
        error?: { message?: string };
      };
      const cand = body.candidates?.[0];
      const gm = cand?.groundingMetadata as
        | { webSearchQueries?: string[]; groundingChunks?: unknown[] }
        | undefined;
      const parts = (cand?.content as { parts?: { text?: string; thought?: boolean }[] })?.parts ?? [];
      out.push({
        tools: v.label,
        httpStatus: res.status,
        error: body.error?.message ?? null,
        // 필드 이름이 바뀌었는지 보려고 키를 그대로 노출한다.
        candidateKeys: cand ? Object.keys(cand) : [],
        groundingMetadataKeys: gm ? Object.keys(gm) : [],
        webSearchQueries: gm?.webSearchQueries ?? [],
        groundingChunkCount: gm?.groundingChunks?.length ?? 0,
        textPreview: parts
          .filter((p) => !p.thought && typeof p.text === "string")
          .map((p) => p.text)
          .join("")
          .slice(0, 240),
      });
    } catch (err) {
      out.push({ tools: v.label, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { model: target, today, results: out };
}
