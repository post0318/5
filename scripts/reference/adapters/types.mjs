/**
 * 모델 어댑터 공통 인터페이스(JSDoc). 어댑터 파일은 모델마다 하나 — 모델별 특이점(스키마 방언,
 * 폴백, 과금 단가)은 어댑터 안에만 둔다. 공통 파이프라인은 이 인터페이스만 안다.
 *
 * @typedef {{ inputTokens: number; outputTokens: number; costUsd: number }} Usage
 *
 * @typedef {{ html: string; instructions: string; schema: object }} ExtractInput
 *   schema 는 표준 JSON Schema 부분집합(type/properties/required/items/enum, type 배열로 null 허용).
 *
 * @typedef {{ json: unknown; model: string; version: string; usage: Usage }} ExtractOutput
 *
 * @typedef {{
 *   name: string;
 *   estimateCostUsd(input: ExtractInput): number;   // 호출 전 예산 검사용 상한 추정
 *   extract(input: ExtractInput): Promise<ExtractOutput>;
 * }} Adapter
 */
export {};
