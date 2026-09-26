import type { QuoteBar, YahooSplit } from "../types";

/**
 * **미국 체결가 호가 단위 정리 — 시세 가격 정리는 이 파일 한 곳에서만**(오너 결정 2026-09-26).
 *
 * Yahoo 종가는 float32 표현이 섞여 온다(146.92 → 146.9199981689453). 앱은 이 값에 SEC 주식수를 곱해
 * 시가총액을 냈고, 인포맥스(FactSet)는 센트 단위 실제 종가를 곱해 결산일 시가총액이 주식수 × 부동소수
 * 꼬리만큼 달랐다(177건). 실제 체결가로 되돌리면 같은 주식수에서 앱 시가총액 = 인포맥스가 된다.
 *
 * 규칙 — 미국 상장 종목(ADR 포함, 달러 호가)의 거래 단위: $1 이상은 센트(소수 둘째 자리), $1 미만은
 * $0.0001(넷째 자리). 반올림은 0.5 에서 0 으로부터 먼 쪽(검증기 roundHalfAway 와 같은 식 — 정수 배율).
 *
 * ⚠️ 분할 뒤 Yahoo 종가는 분할 소급 조정값이라 센트로 표현되지 않는 게 정상이다(NVDA 2024 10:1 이전 495.22
 * → 49.522). 조정값을 바로 반올림하면 실제 가격이 바뀐다 — 반드시 실제 체결가(조정값 × 그 날 뒤 분할비율
 * 누적곱)로 되돌려 정리한 뒤 다시 나눈다(`cleanUsdBars`). 가격 반올림을 다른 곳에 따로 두지 말 것.
 */
export function cleanUsdPrice(price: number): number;
export function cleanUsdPrice(price: number | null): number | null;
export function cleanUsdPrice(price: number | null): number | null {
  if (price == null || !Number.isFinite(price)) return price;
  const a = Math.abs(price);
  const k = a >= 1 ? 100 : 10_000;
  return (Math.sign(price) * Math.round(a * k)) / k;
}

/**
 * Yahoo 일별 시세(분할·분사 소급 조정) → 각 날짜의 실제 체결가를 호가 단위로 정리한 뒤 같은 조정 기준으로 되돌린다.
 * 조정 기준(분할 소급)은 그대로라 소비 쪽(분할 환산 주식수·secBasisBars 분사 되돌림)은 바뀌지 않고, 부동소수 꼬리만 없어진다:
 *   조정가' = cleanUsdPrice(조정가 × S) / S,  S = 그 날짜 뒤 Yahoo 분할 이력(분사 조정 포함) 비율의 누적곱.
 * splits 는 bars 뒤 오늘까지의 이력이 빠짐없이 있어야 한다(기간 상한을 과거로 둔 조회에는 쓰지 않는다 — yahoo.ts).
 */
export function cleanUsdBars(bars: QuoteBar[], splits: YahooSplit[]): QuoteBar[] {
  const valid = splits.filter((s) => s.ratio > 0 && s.ratio !== 1);
  return bars.map((b) => {
    const s = valid.reduce((m, x) => (b.date < x.date ? m * x.ratio : m), 1);
    const c = (v: number | null) => (v == null ? v : cleanUsdPrice(v * s) / s);
    return { ...b, open: c(b.open), high: c(b.high), low: c(b.low), close: c(b.close) };
  });
}
