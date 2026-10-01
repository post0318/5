/**
 * OpenAI 어댑터 — 자리만 잡아 둔 스텁(아직 API 호출 없음).
 *
 * 구현할 때(README "어댑터 추가" 참고):
 *  - 키는 OPENAI_API_KEY, 모델은 REF_OPENAI_MODEL.
 *  - 구조화 출력(JSON Schema strict 모드)은 모든 속성이 required 이고 additionalProperties:false 여야 하는 등
 *    방언이 다르다 — 공통 스키마를 여기서 변환한다(gemini.mjs 의 toGeminiSchema 와 같은 역할).
 *  - temperature 0, 호출별 토큰·비용을 usage 로 돌려준다(단가는 이 파일 상수로).
 *
 * @typedef {import("./types.mjs").Adapter} Adapter
 */

/** @returns {Adapter} */
export function createOpenAIAdapter() {
  return {
    name: "openai",
    estimateCostUsd() {
      return 0;
    },
    async extract() {
      throw new Error("openai 어댑터는 아직 구현되지 않았습니다(스텁).");
    },
  };
}
