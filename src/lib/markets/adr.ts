/**
 * **ADR 비율 보정** — 20-F 제출 외국 기업의 EDGAR 주식수는 본국 보통주 기준이라
 * 미국 상장 ADR 가격과 곱하면 시가총액이 ADR 비율만큼 틀린다(TSM: 보통주 259억
 * 주 × ADR 가격 → 실제의 5배, 1 ADR = 보통주 5주. 검증 체계 3층 시가총액 대조로
 * 발견, 2026-09-23). ADR 비율은 XBRL 에 없어 Yahoo 주식수(ADR 환산)로 역산한다.
 *
 * 10-K 제출사·1:1 상장(ASML·SPOT)은 비율이 1.5배 안이라 보정하지 않는다.
 * 서버(edgar-shares.ts)와 브라우저(멀티플)가 같이 쓰도록 server-only 가 아니다.
 */
export function adrRatio(
  is20F: boolean,
  filerShares: number | null | undefined,
  quoteShares: number | null | undefined,
): number {
  if (!is20F || !filerShares || !quoteShares || filerShares <= 0 || quoteShares <= 0) return 1;
  const r = filerShares / quoteShares;
  return r <= 1.5 && r >= 1 / 1.5 ? 1 : r;
}
