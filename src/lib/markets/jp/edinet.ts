/**
 * EDINET API v2 어댑터 (일본 L1) — prd.md §4.1
 * 공식 무료 API. `EDINET_API_KEY` 환경변수 필요 (api.edinet-fsa.go.jp).
 *
 * 현재 상태: 골격 구현.
 * - 딥링크(L4/L5), 심볼 정규화는 동작.
 * - 회사정보/재무제표/공시는 EDINET_API_KEY 설정 후 문서목록 API + XBRL 파싱 구현 필요.
 *   (documents.json 으로 서류 조회 → ZIP 다운로드 → XBRL 파싱)
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
  "일본(EDINET) 데이터는 아직 연결되지 않았습니다. " +
  "api.edinet-fsa.go.jp에서 API 키를 발급받아 .env.local의 EDINET_API_KEY에 설정하세요. " +
  "그동안 공시·컨센서스·뉴스는 아래 딥링크로 확인할 수 있습니다.";

function hasKey(): boolean {
  return Boolean(process.env.EDINET_API_KEY);
}

export const jpEdinetAdapter: MarketAdapter = {
  market: "jp",
  currency: "JPY",

  isConfigured() {
    return hasKey();
  },
  configHint() {
    return HINT;
  },

  normalizeSymbol(input) {
    // "7203", "7203.T", "7203.JP" → "7203"
    return input.replace(/\.(T|JP)$/i, "").replace(/[^0-9A-Za-z]/g, "").trim();
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
    return consensusDeepLinks("jp", symbol);
  },
  newsDeepLinks(symbol): DeepLink[] {
    return newsDeepLinks("jp", symbol);
  },
  filingsDeepLink(symbol): DeepLink | null {
    return filingsDeepLink("jp", symbol);
  },
};
