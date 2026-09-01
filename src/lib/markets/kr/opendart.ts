/**
 * OpenDART 어댑터 (한국 L1) — prd.md §4.1
 * 공식 무료 API. `DART_API_KEY` 환경변수 필요 (https://opendart.fss.or.kr).
 *
 * 현재 상태: 골격 구현.
 * - 딥링크(L4/L5), 심볼 정규화는 동작.
 * - 회사정보/재무제표/공시는 DART_API_KEY 설정 후 corp_code 매핑 구현 필요.
 *   corp_code 매핑은 opendart.fss.or.kr/api/corpCode.xml (zip) 를 받아 캐시해야 한다.
 */

import { consensusDeepLinks, filingsDeepLink, newsDeepLinks } from "../deeplinks";
import {
  NotConfiguredError,
  type CompanyProfile,
  type DeepLink,
  type Filing,
  type FinancialStatement,
  type MarketAdapter,
} from "../types";

const HINT =
  "한국(OpenDART) 데이터는 아직 연결되지 않았습니다. " +
  "opendart.fss.or.kr에서 API 키를 발급받아 .env.local의 DART_API_KEY에 설정하세요. " +
  "그동안 공시·컨센서스·뉴스는 아래 딥링크로 확인할 수 있습니다.";

function hasKey(): boolean {
  return Boolean(process.env.DART_API_KEY);
}

export const krOpenDartAdapter: MarketAdapter = {
  market: "kr",
  currency: "KRW",

  isConfigured() {
    return hasKey();
  },
  configHint() {
    return HINT;
  },

  normalizeSymbol(input) {
    // "A005930", "005930", "5930" → "005930"
    const digits = input.replace(/[^0-9]/g, "");
    return digits.padStart(6, "0").slice(-6);
  },

  async getCompanyProfile(): Promise<CompanyProfile> {
    throw new NotConfiguredError(HINT);
  },
  async getFinancials(): Promise<FinancialStatement> {
    throw new NotConfiguredError(HINT);
  },
  async getFilings(): Promise<Filing[]> {
    throw new NotConfiguredError(HINT);
  },

  consensusDeepLinks(symbol): DeepLink[] {
    return consensusDeepLinks("kr", symbol);
  },
  newsDeepLinks(symbol): DeepLink[] {
    return newsDeepLinks("kr", symbol);
  },
  filingsDeepLink(symbol): DeepLink | null {
    return filingsDeepLink("kr", symbol);
  },
};
