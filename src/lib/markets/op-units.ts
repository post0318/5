/**
 * UP-REIT 운영 파트너십 지분 수 = Yahoo impliedShares − sharesOutstanding.
 * 서버(edgar-ev.ts)와 브라우저(종목분석 화면의 멀티플 계산)가 같이 쓰도록
 * server-only 가 아닌 파일로 뺐다.
 *
 * 오너 결정 2026-09-23 — SEC 에 수량 태그가 표준화돼 있지 않아 배당 역산은
 * 31개 중 9개만 맞았고, 검증 가능한 10개에선 Yahoo 값이 모두 맞았다.
 * 리츠만 — 일반 기업은 implied 가 전 클래스 합(GOOGL 등)이라 파트너 지분으로
 * 오인하면 안 된다. 0.5% 미만 차이는 무시.
 */
export function opUnitsFrom(
  isReit: boolean,
  sharesOutstanding: number | null | undefined,
  impliedShares: number | null | undefined,
): number | null {
  if (!isReit) return null;
  if (sharesOutstanding == null || impliedShares == null) return null;
  if (impliedShares <= sharesOutstanding * 1.005) return null;
  return impliedShares - sharesOutstanding;
}
