/**
 * 종목 티커 없이 나오는 산업분석/투자전략 리포트의 라벨 추출 — 대괄호 우선,
 * 없으면 첫 콜론(또는 세미콜론) 앞을 라벨로 삼는다. 삼성증권 수집기에서
 * 처음 만들었고(2026-09-24), 키움증권 국내 산업분석 게시판도 같은 형식이라
 * 공용으로 뺐다.
 */
const BRACKET_RE = /^\[([^\]]+)\]\s*(.*)$/;
const COLON_RE = /^([^:：;]+)[:：;]\s*(.+)$/;

export function industryLabelAndHeadline(title) {
  const t = String(title ?? "");
  const bm = t.match(BRACKET_RE);
  if (bm) {
    const rest = bm[2].trim();
    return rest ? { label: bm[1].trim(), headline: rest } : { label: "산업", headline: bm[1].trim() };
  }
  const cm = t.match(COLON_RE);
  if (cm) return { label: cm[1].trim(), headline: cm[2].trim() };
  return { label: "산업", headline: t };
}
