import "server-only";

/**
 * 현재 발행주식수 **힌트** — 공시 주식수가 없는 기간(태그 누락·클래스별로만 공시하는
 * Visa 등·20-F ADR)에 edgar-shares.ts 가 대신 쓰는 값. 시가총액 ÷ 주가(전 클래스
 * 경제적 주식수) 우선, 없으면 Yahoo sharesOutstanding.
 *
 * 한 곳으로 모은 이유 — 하이라이트·재무분석 라우트와 컨센서스가 힌트를 서로 다르게
 * 만들어, 주식수 태그가 없는 해(BKR 2021~2022)에 컨센서스만 주식수가 비어 PBR·
 * EV/EBITDA 가 빈칸이 됐다(검증 체계, 2026-09-23).
 */
export function usSharesHint(
  quote: { last?: number | null; marketCap?: number | null; sharesOutstanding?: number | null } | null,
  fwd: { marketCap?: number | null; sharesOutstanding?: number | null } | null,
): number | null {
  const mcap = fwd?.marketCap ?? quote?.marketCap ?? null;
  return (
    (mcap != null && quote?.last ? mcap / quote.last : null) ??
    fwd?.sharesOutstanding ??
    quote?.sharesOutstanding ??
    null
  );
}
