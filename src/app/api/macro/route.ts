import { after } from "next/server";
import { jsonError, ok } from "@/lib/api";
import { getMacroDashboard, getSeriesLongTermMean } from "@/lib/macro/fred";
import { getIndices } from "@/lib/macro/indices";
import { getFearGreed } from "@/lib/macro/feargreed";
import { getFedWatch } from "@/lib/macro/fedwatch";
import { getFedWatchComparison } from "@/lib/db/fedwatch";
import { isDbConfigured } from "@/lib/db";
import { getKrFearGreed } from "@/lib/macro/kr/fear-greed";
import { autoBackfillKrFg } from "@/lib/macro/kr/batch";

// 1시간이면 실시간 지수(KRX/Yahoo)·한국 F&G 가 그대로 고정되고 새로고침 버튼도
// 무력화됨 — FRED(일간 지표라 변동 적음)·CNN(자체 1시간 캐시)은 각자 내부
// 캐시가 있어 이 라우트 캐시를 짧게 잡아도 상위 API 호출이 급증하지 않는다
// (2026-09 수정).
export const revalidate = 120;
// KRX 지수 조회(최대 5영업일) 등 외부 호출이 겹치면 기본 제한(10~15s)을
// 넘길 수 있어 명시 (2026-09 수정).
export const maxDuration = 30;

export async function GET() {
  try {
    const [dashboard, indices, fearGreed, vixMean, krFearGreed, fedWatch] = await Promise.all([
      // 다른 호출은 모두 .catch 로 감싸 개별 실패해도 나머지가 나가는데
      // getMacroDashboard() 만 안 감싸져 있어 여기서 던지면 라우트 전체가
      // 500 이 됨 (2026-09 수정).
      getMacroDashboard().catch(() => ({
        asOf: new Date().toISOString().slice(0, 10),
        indicators: [],
        summary: { positive: 0, negative: 0, neutral: 0 },
      })),
      getIndices().catch(() => []),
      getFearGreed().catch(() => null),
      getSeriesLongTermMean("VIXCLS", "1990-01-01").catch(() => null),
      getKrFearGreed().catch(() => null),
      getFedWatch().catch(() => null),
    ]);
    after(() => autoBackfillKrFg(krFearGreed?.asOf ?? null));
    // 전일·전주 비교(오너 지시 2026-09-20, CME/investing.com 스타일) — DB
    // 미설정(로컬 초기 상태)이거나 조회 실패해도 카드는 "현재"만으로 그대로 뜬다.
    const fedWatchCompare =
      fedWatch && isDbConfigured() ? await getFedWatchComparison(fedWatch.meetingDate).catch(() => null) : null;
    return ok({
      ...dashboard,
      indices,
      fearGreed: fearGreed
        ? { ...fearGreed, vixHistoricalAvg: vixMean?.mean ?? null }
        : null,
      krFearGreed,
      fedWatch: fedWatch ? { ...fedWatch, compare: fedWatchCompare } : null,
    });
  } catch (err) {
    return jsonError(err);
  }
}
