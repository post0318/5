import { krOpenDartAdapter } from "./kr/opendart";
import { jpEdinetAdapter } from "./jp/edinet";
import { usEdgarAdapter } from "./us/edgar";
import type { MarketAdapter, MarketId } from "./types";

const ADAPTERS: Record<MarketId, MarketAdapter> = {
  kr: krOpenDartAdapter,
  us: usEdgarAdapter,
  jp: jpEdinetAdapter,
};

export function getAdapter(market: MarketId): MarketAdapter {
  return ADAPTERS[market];
}

export function marketStatus(): { market: MarketId; configured: boolean; hint: string }[] {
  return (Object.keys(ADAPTERS) as MarketId[]).map((m) => ({
    market: m,
    configured: ADAPTERS[m].isConfigured(),
    hint: ADAPTERS[m].configHint(),
  }));
}
