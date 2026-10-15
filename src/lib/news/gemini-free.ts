import "server-only";

/**
 * 해외 시황 뉴스 요약 전용 Gemini REST 클라이언트(2026-10-14, post0318/4 src/lib/server/gemini.ts 이식).
 *
 * **비용 0 원칙**: 키는 `NEWS_GEMINI_API_KEY` — 결제(Billing)를 연결하지 않은 Google 프로젝트의 무료 키여야 한다.
 * 그런 키는 한도를 넘으면 429 로 거절될 뿐 청구되지 않는다. 주간 리포트의 `GEMINI_API_KEY` 는 결제가 붙어 있어
 * (월 상한·지출 상한으로 막을 뿐 유료) 여기서 **절대 쓰지 않는다** — 그래서 변수 이름을 따로 둔다.
 * 뉴스 쪽 LLM 은 Gemini 만(오너 2026-10-03).
 */

// 무료 등급에서 최신 Flash 는 100초+ 지연 — 3.5 Flash 는 ~9초(4번 2026-10-11 실측)
const DEFAULT_MODEL = "gemini-3.5-flash";
// 기본 모델이 혼잡(503)·한도(429)·시간초과·폐기(404)면 다음 모델
const FALLBACK_MODELS = ["gemini-3.5-flash-lite", "gemini-flash-lite-latest"];

export function isNewsGeminiConfigured(): boolean {
  return Boolean(process.env.NEWS_GEMINI_API_KEY?.trim());
}

/** 모든 모델이 무료 한도(429) — 이번 회차는 멈추고 다음 회차에 이어서 */
export class NewsGeminiQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NewsGeminiQuotaError";
  }
}

interface RawResponse {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
  }[];
  error?: { message?: string; status?: string };
}

/** 한 회차 안에서 429 가 난 모델은 다시 부르지 않는다(호출부가 회차마다 새 Set 을 넘긴다) */
export async function newsGeminiText(opts: {
  system: string;
  user: string;
  timeoutMs: number;
  /** 모델이 user 안의 URL 을 직접 읽게 한다(url_context 도구) */
  readUrls?: boolean;
  exhausted?: Set<string>;
}): Promise<{ text: string; model: string }> {
  const key = process.env.NEWS_GEMINI_API_KEY?.trim();
  if (!key) throw new Error("NEWS_GEMINI_API_KEY 미설정");
  const primary = process.env.NEWS_GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  const chain = [primary, ...FALLBACK_MODELS.filter((m) => m !== primary)];
  const exhausted = opts.exhausted ?? new Set<string>();

  let lastErr = "";
  for (const model of chain) {
    if (exhausted.has(model)) continue;
    const payload: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: opts.system }] },
      contents: [{ role: "user", parts: [{ text: opts.user }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 8000 },
    };
    if (opts.readUrls) payload.tools = [{ url_context: {} }];
    let res: Response;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (e) {
      lastErr = `${model}: ${e instanceof Error ? e.message : String(e)}`; // 시간초과 — 다음 모델
      continue;
    }
    const body = (await res.json().catch(() => ({}))) as RawResponse;
    if (res.status === 429) {
      exhausted.add(model);
      lastErr = `${model} 429: ${body.error?.message?.slice(0, 160) ?? "quota"}`;
      continue;
    }
    if (res.status === 404 || res.status === 503) {
      lastErr = `${model} ${res.status}: ${body.error?.message?.slice(0, 160) ?? ""}`;
      continue;
    }
    if (!res.ok) throw new Error(`Gemini ${model} ${res.status}: ${body.error?.message?.slice(0, 200) ?? "unknown"}`);
    const cand = body.candidates?.[0];
    const text = (cand?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("");
    if (!text.trim()) throw new Error(`Gemini ${model}: 빈 응답 (finishReason=${cand?.finishReason ?? "?"})`);
    return { text, model };
  }
  if (chain.every((m) => exhausted.has(m))) throw new NewsGeminiQuotaError(`모든 모델 무료 한도 — ${lastErr}`);
  throw new Error(`Gemini 호출 실패 — ${lastErr || "알 수 없음"}`);
}
