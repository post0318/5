/**
 * Gemini 어댑터 — REST 직접 호출(SDK 없음). 앱의 Gemini 클라이언트(src/lib/weekly/gemini.ts)는 쓰지 않는다.
 *
 * - 키: GEMINI_API_KEY (헤더 x-goog-api-key 로만 보낸다 — URL 쿼리에 남기지 않음)
 * - 모델: REF_GEMINI_MODEL(기본 gemini-3.8-flash). 404 면 ListModels 로 generateContent 를 지원하는
 *   flash 계열 모델 중 가장 최신을 골라 한 번 더 시도하고, 실제 쓴 모델을 결과에 남긴다.
 * - 구조화 출력: responseMimeType=application/json + responseSchema, temperature 0.
 * - 단가(1M 토큰당, 3.x Flash 프로모션): 입력 $0.75 / 출력 $3.75. thinking 토큰은 출력으로 과금.
 *
 * Gemini responseSchema 방언 특이점: type 은 대문자 enum(OBJECT/STRING/...), null 허용은
 * type 배열이 아니라 nullable:true — 표준 스키마를 여기서 변환한다.
 *
 * @typedef {import("./types.mjs").Adapter} Adapter
 */

const API = "https://generativelanguage.googleapis.com/v1beta";
const PRICE_IN = 0.75 / 1e6;
const PRICE_OUT = 3.75 / 1e6;
const MAX_OUTPUT_TOKENS = 32768;

function toGeminiSchema(s) {
  const out = {};
  let types = Array.isArray(s.type) ? s.type : [s.type];
  if (types.includes("null")) {
    out.nullable = true;
    types = types.filter((t) => t !== "null");
  }
  out.type = String(types[0]).toUpperCase();
  if (s.enum) out.enum = s.enum;
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    out.propertyOrdering = Object.keys(s.properties);
  }
  if (s.required) out.required = s.required;
  if (s.items) out.items = toGeminiSchema(s.items);
  return out;
}

function apiKey() {
  const k = process.env.GEMINI_API_KEY;
  if (!k) throw new Error("GEMINI_API_KEY 가 없습니다(.env.local).");
  return k;
}

async function pickFallbackModel(exclude) {
  const res = await fetch(`${API}/models?pageSize=200`, { headers: { "x-goog-api-key": apiKey() } });
  if (!res.ok) throw new Error(`ListModels ${res.status}`);
  const { models = [] } = await res.json();
  const names = models
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => /^gemini-[\d.]+-flash$/.test(n) && n !== exclude);
  names.sort((a, b) => parseFloat(b.slice(7)) - parseFloat(a.slice(7)));
  return names[0] ?? null;
}

/** @returns {Adapter} */
export function createGeminiAdapter() {
  let model = process.env.REF_GEMINI_MODEL || "gemini-3.8-flash";
  return {
    name: "gemini",
    estimateCostUsd({ html, instructions }) {
      // 영어·HTML 은 대략 3.5자/토큰. 출력은 상한의 절반을 넉넉히 가정.
      const inTok = (html.length + instructions.length) / 3.5;
      return inTok * PRICE_IN + (MAX_OUTPUT_TOKENS / 2) * PRICE_OUT;
    },
    async extract({ html, instructions, schema }) {
      const body = {
        contents: [{ role: "user", parts: [{ text: `${instructions}\n\n<input>\n${html}\n</input>` }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: toGeminiSchema(schema),
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      };
      let res;
      for (let attempt = 0; attempt < 4; attempt++) {
        res = await fetch(`${API}/models/${model}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey() },
          body: JSON.stringify(body),
        });
        if (res.status === 404) {
          const fb = await pickFallbackModel(model);
          if (!fb) break;
          console.warn(`  [gemini] ${model} 404 → ${fb} 로 폴백`);
          model = fb;
          continue;
        }
        if (res.status === 429 || res.status >= 500) {
          console.warn(`  [gemini] ${res.status} — 20초 후 재시도`);
          await new Promise((r) => setTimeout(r, 20_000));
          continue;
        }
        break;
      }
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const data = await res.json();
      const u = data.usageMetadata ?? {};
      const inputTokens = u.promptTokenCount ?? 0;
      const outputTokens = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
      const usage = { inputTokens, outputTokens, costUsd: inputTokens * PRICE_IN + outputTokens * PRICE_OUT };
      const cand = data.candidates?.[0];
      const text = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("");
      if (!text) throw Object.assign(new Error(`Gemini 빈 응답(finishReason=${cand?.finishReason})`), { usage, model });
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw Object.assign(new Error(`Gemini JSON 파싱 실패(finishReason=${cand?.finishReason})`), { usage, model });
      }
      return { json, model, version: data.modelVersion ?? model, usage };
    },
  };
}
