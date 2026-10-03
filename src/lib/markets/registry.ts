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

