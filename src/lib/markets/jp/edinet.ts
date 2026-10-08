/**
 * EDINET API v2 어댑터 (일본 L1) — prd.md §4.1
 * 공식 무료 API. `EDINET_API_KEY` (Subscription-Key) 필요.
 *
 * 구현 상태:
 * - 회사정보: Edinetcode 목록 기반 (키 불필요)
 * - 공시목록: 최근 160일 날짜 목록(edinet-store.ts — 확정일은 디스크 캐시)에서 회사 것만 (키 필요)
 * - 재무제표: 최신 有価証券報告書 = DB 색인 jp_docs(src/lib/db/jp-docs.ts) — EDINET 은 날짜 인덱스라 종목별 조회가 없어
 *   예전엔 400일치 documents.json 을 요청마다 훑었다(25~44초, 날짜별 실패는 조용히 버림). 이제 색인은 배치
 *   (scripts/run/jp-edinet-index.mts)가 채우고, 화면 요청은 확정 안 된 최근 날만 보충한다(ensureIndexed).
 *   재무 표 = statements.ts(EDINET XBRL 본표 조립), 하이라이트·재무분석·개요 멀티플(getTtm) = jp-ev.ts 단일 기준(2026-10-08).
 */

import "server-only";
import { edinetDayList, recentDates, redactEdinet, type EdinetDoc } from "./edinet-store";
import { getJpFinModel, jpStatementView } from "./statements";
import { getJpTtm } from "./jp-views";
import { consensusDeepLinks, filingsDeepLink, newsDeepLinks } from "../deeplinks";
import {
  AdapterError,
  NotConfiguredError,
  type CompanyProfile,
  type DeepLink,
  type Filing,
  type FinancialStatement,
  type MarketAdapter,
  type TtmFlows,
} from "../types";
import { resolveEdinetByTicker } from "./edinetcode";
import { fetchJQuantsMaster } from "./jquants";

const HINT =
  "일본(EDINET) 공시 연결에는 API 키가 필요합니다. " +
  "api.edinet-fsa.go.jp 에서 Subscription-Key 를 발급받아 .env.local 의 EDINET_API_KEY 에 설정하세요.";

function key(): string | null {
  return process.env.EDINET_API_KEY ?? null;
}

const DOC_TYPE_LABEL: Record<string, string> = {
  "030": "有価証券届出書",
  "040": "訂正有価証券届出書",
  "080": "発行登録書",
  "090": "訂正発行登録書",
  "100": "発行登録追補書類",
  "120": "有価証券報告書",
  "130": "訂正有価証券報告書",
  "135": "確認書",
  "136": "訂正確認書",
  "140": "四半期報告書",
  "150": "訂正四半期報告書",
  "160": "半期報告書",
  "170": "訂正半期報告書",
  "180": "臨時報告書",
  "190": "訂正臨時報告書",
  "220": "自己株券買付状況報告書",
  "230": "訂正自己株券買付状況報告書",
  "235": "内部統制報告書",
  "236": "訂正内部統制報告書",
  "350": "大量保有報告書",
  "360": "訂正大量保有報告書",
};

/** 공시목록 범위(일) — 3月決算사의 6月 有価証券報告書를 11月까지 포착 */
const FILINGS_DAYS = 160;

export const jpEdinetAdapter: MarketAdapter = {
  market: "jp",
  currency: "JPY",

  isConfigured() {
    return Boolean(key());
  },
  configHint() {
    return HINT;
  },

  normalizeSymbol(input) {
    return input.replace(/\.(T|JP)$/i, "").replace(/[^0-9A-Za-z]/g, "").trim();
  },

  async getCompanyProfile(symbol): Promise<CompanyProfile> {
    const e = await resolveEdinetByTicker(symbol);
    // J-Quants 마스터는 보조 정보(시장구분·업종) — 실패하면 EDINET 코드 목록만으로 보여 주되 기록은 남긴다
    const master = await fetchJQuantsMaster(symbol).catch((err) => {
      console.warn(`[jp] J-Quants 마스터 조회 실패 ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });

    const identifiers: Record<string, string> = {
      EDINETコード: e.edinetCode,
      証券コード: e.secCode,
      ticker: e.ticker,
    };
    if (master?.scaleCategory) identifiers["規模区分"] = master.scaleCategory;
    if (master?.marketName) identifiers["市場区分"] = master.marketName;

    return {
      symbol,
      market: "jp",
      name: master?.nameEn || e.nameEng || e.name,
      nameLocal: master?.name || e.name,
      identifiers,
      industry: master?.sector33 || e.industry,
      address: e.address,
      description:
        `決算期: ${e.fiscalMonthDay}${e.consolidated ? " · 連結" : ""}` +
        (master?.sector17 ? ` · ${master.sector17}` : ""),
      source: master ? "EDINET + J-Quants" : "EDINET (Edinetcode)",
      sourceUrl: filingsDeepLink("jp", symbol)?.url,
    };
  },

  async getFinancials(symbol, periodType): Promise<FinancialStatement> {
    // JP 재무 = EDINET XBRL 본표 조립(statements.ts — 3대 재무제표 화면과 같은 저장본) 총괄 뷰. 연간 5개 사업연도 + 현재/LTM,
    // 분기 = 반기 열. 예전 有報 CSV 경영지표 요약(financials.ts)은 2026-10-08 폐지 — 멀티플·컨센서스는 jp-ev.ts 단일 기준을 쓴다
    if (!key()) throw new NotConfiguredError(HINT);
    const model = await getJpFinModel(symbol);
    return jpStatementView(model, symbol, "summary", periodType);
  },

  /** 개요 멀티플·유니버스 — jp-ev.ts 단일 기준(하이라이트 LTM 열과 같은 값) */
  async getTtm(symbol): Promise<TtmFlows | null> {
    if (!key()) throw new NotConfiguredError(HINT);
    return getJpTtm(symbol);
  },

  async getFilings(symbol, opts): Promise<Filing[]> {
    const apiKey = key();
    if (!apiKey) throw new NotConfiguredError(HINT);
    const e = await resolveEdinetByTicker(symbol);
    const limit = opts?.limit ?? 30;
    // 날짜 목록(확정일은 디스크, 최근 이틀은 새로 받음 — 요청은 edinet-store 가 한 줄로 세운다). 하루라도 실패하면 목록이 빠지므로 던진다
    const settled = await Promise.allSettled(recentDates(FILINGS_DAYS).map((d) => edinetDayList(d)));
    const failed = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    if (failed.length) {
      const r0 = failed[0].reason;
      throw new AdapterError(
        `EDINET 공시목록 조회 실패 ${failed.length}/${FILINGS_DAYS}일 — ${redactEdinet(r0 instanceof Error ? r0.message : String(r0))}`.slice(0, 300),
        { status: 502, cause: r0 },
      );
    }
    const docs = settled
      .flatMap((s) => (s.status === "fulfilled" ? s.value : []))
      .filter((r: EdinetDoc) => r.edinetCode === e.edinetCode && r.withdrawalStatus !== "1" && r.submitDateTime)
      .sort((a, b) => b.submitDateTime!.localeCompare(a.submitDateTime!));
    return docs.slice(0, limit).map((r) => ({
      id: r.docID,
      symbol,
      market: "jp" as const,
      date: r.submitDateTime!.slice(0, 10),
      title: r.docDescription?.trim() || DOC_TYPE_LABEL[r.docTypeCode ?? ""] || "書類",
      type: DOC_TYPE_LABEL[r.docTypeCode ?? ""] ?? r.docTypeCode ?? "書類",
      // EDINET은 docID 기반 공개 뷰어 URL이 불안정 → 서류검색 페이지로 (docID는 title에 표기)
      url: "https://disclosure2.edinet-fsa.go.jp/week0010.aspx",
      source: "EDINET",
    }));
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
