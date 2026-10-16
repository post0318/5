/**
 * 성장률(%) 재계산 대조 — 앱 검증기(verify-financials.mjs) C층 매출 성장률. 시험은 scripts/verify/raw/test/t11-same-growth.test.mjs.
 * (당기 ÷ 전기 − 1) × 100 의 부동소수 표현 차는 비율(≈1) 크기의 끝자리라, 결과(성장률)가 작을수록 상대값이 커진다
 * (PEP 2024 0.9475783534663594 vs …496, 차 9.9e-15 — 결과 대비 1.04e-14 로 상대 1e-14 를 넘어 실패, 2026-10-16 자동 검증).
 * 허용 = 비율 크기 × 8ε × 100(성장률 1% 근처 약 1.8e-13). 심은 오류(× (1 + 5e-10) — 0.95% 에서 4.7e-10)보다 1천 배 이상 작다.
 * 한계: 매출 절댓값이 약 5.6e14 를 넘으면 매출 1단위 차이가 허용 안에 든다(부동소수 분해능 — 미국 USD·일본 JPY 매출은 그 아래, 한국 검증기는 이 함수를 쓰지 않음).
 * @returns {{ok: boolean, note?: string}}
 */
export function growthMatch(app, cur, prev) {
  if (app == null) return { ok: false, note: `한쪽만 빈칸 (${app} vs 재계산)` };
  // 숫자가 아니면(문자열 "5" 등) 같은 값으로 보지 않는다(감사 10-16 3차 — 문자열이 뺄셈에서 숫자로 바뀌어 통과했다)
  for (const [n, v] of [["앱 성장률", app], ["당기 매출", cur], ["전기 매출", prev]]) {
    if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, note: `${n}이 유한한 숫자가 아님 (${typeof v} ${String(v).slice(0, 30)})` };
  }
  if (prev === 0) return { ok: false, note: "전기 매출 0 — 성장률 재계산 불가" };
  const yoy = (cur / prev - 1) * 100;
  const bound = 8 * Number.EPSILON * 100 * Math.max(1, Math.abs(cur / prev));
  return Math.abs(app - yoy) <= bound ? { ok: true } : { ok: false, note: `${app} vs ${yoy} (차 ${app - yoy}, 표현 차 한도 ${bound.toExponential(2)})` };
}
