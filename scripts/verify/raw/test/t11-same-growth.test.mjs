// 시험 — 앱 검증기(verify-financials.mjs) 매출 성장률 대조 growthMatch(감사 10-16 3차: 시험이 없었다). 원자료 어댑터가 아니지만 같은 시험 명령으로 돌린다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { growthMatch } from "../../same-growth.mjs";

test("성장률 대조: 같은 정의를 다른 순서로 계산한 부동소수 끝자리 차는 통과", () => {
  // 합성 매출(2026-10-16 PEP·TSLA 실패 원인 = 계산 순서에 따른 끝자리 차)
  const cur = 91854321987, prev = 91471234567;
  const yoy = (cur / prev - 1) * 100;
  assert.equal(growthMatch(yoy, cur, prev).ok, true);
  assert.equal(growthMatch(((cur - prev) / prev) * 100, cur, prev).ok, true, "(당기 − 전기) ÷ 전기 순서");
  assert.equal(growthMatch((cur / prev) * 100 - 100, cur, prev).ok, true, "비율 × 100 − 100 순서");
});

test("성장률 대조: 실제 값 차이는 실패", () => {
  const cur = 91854321987, prev = 91471234567;
  const yoy = (cur / prev - 1) * 100;
  assert.equal(growthMatch(((cur + 1) / prev - 1) * 100, cur, prev).ok, false, "매출 1달러 차이");
  assert.equal(growthMatch(yoy * (1 + 5e-10), cur, prev).ok, false, "심은 오류 × (1 + 5e-10)");
  assert.equal(growthMatch(Math.round(yoy * 1e4) / 1e4, cur, prev).ok, false, "성장률 넷째 자리 반올림");
  assert.equal(growthMatch(((Math.round(cur / 1e6) * 1e6) / prev - 1) * 100, cur, prev).ok, false, "매출 백만 단위 반올림");
});

test("성장률 대조: 숫자가 아니거나 빈칸·0 이면 실패", () => {
  assert.equal(growthMatch(null, 110, 100).ok, false);
  assert.equal(growthMatch("10", 110, 100).ok, false, "문자열 성장률");
  assert.equal(growthMatch(10, "110", 100).ok, false, "문자열 매출");
  assert.equal(growthMatch(10, 110, null).ok, false, "전기 빈칸");
  assert.equal(growthMatch(Infinity, 110, 0).ok, false, "전기 0");
  assert.equal(growthMatch(NaN, 110, 100).ok, false);
});
