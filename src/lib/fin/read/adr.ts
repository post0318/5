import { adrRatio } from "../../markets/adr";
import type { FactIndex } from "../source/us/sec";

/**
 * 1층 — ADR 비율(architecture.md §1). 규칙은 `markets/adr.ts` 를 그대로 쓴다(1.5배 안이면 1:1).
 * 공시 쪽 주식수 = 최근 표지 주식수(dei). 매출에는 쓰지 않는다(주식수·주당 지표 단계에서 사용) — 프로필에만 싣는다.
 */
export function adrRatioOf(isForeignFiler: boolean, idx: FactIndex, quoteShares: number | null): number {
  const cover = idx.get("dei:EntityCommonStockSharesOutstanding").filter((f) => f.unit === "shares" && !f.start);
  const last = cover.reduce<(typeof cover)[number] | null>((b, f) => (!b || f.end > b.end ? f : b), null);
  return adrRatio(isForeignFiler, last?.val ?? null, quoteShares);
}
