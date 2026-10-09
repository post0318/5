import "server-only";
import { getAdapter } from "../registry";
import { getEodQuote } from "../quote";

/**
 * 유니버스 통합뷰용 한국 종목 지표 — DART(account_id 기반, dart-facts) + KRX 시세.
 * 기존 서비스 경로(adapter.getFinancials 원본 라벨 + multiples.ts 문자열 매칭)는
 * 계정명 편차(가온전선·현대로템·대한전선 등)로 구멍이 많이 나 dart-facts 기반으로 교체.
 */
export interface KrOverviewMetrics {
  marketCap: number | null;
  perTtm: number | null;
  pbr: number | null;
  revenueAnnual: number | null; // TTM
  opMargin: number | null; // 0~1
  netMargin: number | null; // 0~1
  last: number | null;
  changePct: number | null;
  currency: "KRW" | null;
  /** 조회 실패·대체 사유(감사 2차 ⑥ — 예전엔 TTM 실패를 삼키고 연간 값으로 PER·PBR 을 계산해 캐시했다). 유니버스 행 warnings 로 */
  warnings: string[];
}

export async function computeKrOverviewMetrics(
  symbol: string,
  yahooOverride?: string | null,
): Promise<KrOverviewMetrics> {
  const adapter = getAdapter("kr");
  // 조회 실패는 경고로 남기고 그 값에 기대는 칸은 비운다(감사 2차 ⑥) — 경고 문구에 "조회 실패"가 들어가 keepLastGood 이 직전 정상 스냅샷을 유지한다
  const warnings: string[] = [];
  const warnOf = (what: string) => (e: unknown) => {
    warnings.push(`${what} 조회 실패 — ${e instanceof Error ? e.message : String(e)}`);
    return null;
  };
  const [quote, ttm] = await Promise.all([
    // KRX 가 실패해도 getEodQuote 내부에서 Stooq → Yahoo 로 폴백된다(사유는 quote.warnings)
    getEodQuote("kr", symbol, { yahooOverride }).catch(warnOf("시세")),
    adapter.getTtm?.(symbol).catch(warnOf("손익 TTM")) ?? Promise.resolve(null),
  ]);
  for (const w of quote?.warnings ?? []) warnings.push(`시세: ${w}`);

  const price = quote?.last ?? quote?.bars.at(-1)?.close ?? null;
  const shares = quote?.sharesOutstanding ?? null;
  const marketCap = quote?.marketCap ?? (price != null && shares != null ? price * shares : null);

  // 재무 값은 TTM(getKrTtm — 하이라이트 LTM 열과 같은 값)만. TTM 이 없거나 항목이 비면 그 칸은 빈칸 + 경고(감사 9차 ② — 예전엔 최근 사업연도 값·
  // 사업연도 지배주주 자본·시가총액 ÷ 순이익으로 채웠다. 그림자 채우기 금지)
  if (ttm?.error) warnings.push(`손익 TTM: ${ttm.error}`);
  const t = ttm && !ttm.error ? ttm : null;
  const equity = t?.snapshot?.equity ?? null;
  const revenue = t?.revenue ?? null;
  const opIncome = t?.opIncome ?? null;
  const netIncome = t?.netIncome ?? null;
  const eps = t?.eps ?? null;
  const missing = [revenue == null && "매출", opIncome == null && "영업이익", netIncome == null && "순이익", eps == null && "EPS", equity == null && "지배주주 자본"].filter(Boolean);
  if (t && missing.length) warnings.push(`TTM 항목 없음(${missing.join("·")}) — 해당 칸 빈칸`);

  // 부호 규칙(전 화면 공통): EPS ≤ 0 이면 PER 빈칸
  const perTtm = price != null && eps != null && eps > 0 ? price / eps : null;
  const pbr = marketCap != null && equity != null && equity > 0 ? marketCap / equity : null;
  const opMargin = revenue && opIncome != null ? opIncome / revenue : null;
  const netMargin = revenue && netIncome != null ? netIncome / revenue : null;

  return {
    marketCap,
    perTtm,
    pbr,
    revenueAnnual: revenue,
    opMargin,
    netMargin,
    last: price,
    changePct: quote?.changePct ?? null,
    currency: quote ? "KRW" : null,
    warnings,
  };
}
