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
 */

import "server-only";
import { ensureIndexed, listJpReports, type JpDocRow } from "@/lib/db/jp-docs";
import { edinetDayList, recentDates, redactEdinet, type EdinetDoc } from "./edinet-store";
import { consensusDeepLinks, filingsDeepLink, newsDeepLinks } from "../deeplinks";
import {
  AdapterError,
  NotConfiguredError,
  type CompanyProfile,
  type DeepLink,
  type Filing,
  type FinancialStatement,
  type MarketAdapter,
} from "../types";
import { resolveEdinetByTicker } from "./edinetcode";
import { fetchEdinetSummary } from "./financials";
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

/** 有報를 찾는 범위(일) — 有価証券報告書는 연 1회 */
const ANNUAL_DAYS = 400;
/** 공시목록 범위(일) — 3月決算사의 6月 有価証券報告書를 11月까지 포착 */
const FILINGS_DAYS = 160;

/**
 * 최신 有価証券報告書(120, 取下げ 제외, 최근 400일) — DB 색인(jp_docs). 먼저 최근 400일 중 확정 색인 안 된 날을 보충한다(보통 최근 이틀).
 * 색인 못 한 날(배치 미완료·조회 실패)이 찾은 有報 제출일 이후에 있으면(또는 못 찾았으면) 더 새 有報를 놓쳤을 수 있다 — 옛 有報를
 * 조용히 보여 주지 않고 503 으로 알린다(예전엔 날짜별 실패를 버렸다).
 */
async function findLatestAnnual(edinetCode: string): Promise<JpDocRow | null> {
  const ix = await ensureIndexed({ days: ANNUAL_DAYS });
  const since = recentDates(ANNUAL_DAYS).at(-1)!;
  const doc = (await listJpReports(edinetCode, ["120"])).find((r) => (r.submitDateTime ?? "").slice(0, 10) >= since) ?? null;
  const gaps = [...ix.pending, ...ix.failed.map((f) => f.date)].sort();
  const newestGap = gaps.at(-1);
  const docDate = doc?.submitDateTime?.slice(0, 10);
  if (newestGap && (!docDate || newestGap >= docDate)) {
    const why = ix.failed[0] ? ` — 예: ${ix.failed[0].date} ${redactEdinet(ix.failed[0].error)}` : " — 배치 scripts/run/jp-edinet-index.mts 실행 필요";
    throw new AdapterError(`EDINET 서류 색인 미완료(${gaps.length}일, 최근 ${newestGap})${why}`.slice(0, 300), { status: 503 });
  }
  return doc;
}

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
    // JP 재무 = EDINET 有価証券報告書 (연간 경영지표 5기).
    // J-Quants /fins/details 는 유료 플랜 전용이라 미사용.
    if (periodType === "quarter") {
      throw new AdapterError(
        "일본 분기 재무는 미지원입니다 (四半期報告書 폐지, J-Quants 재무는 유료). 연간 또는 딥링크를 이용하세요.",
        { status: 501 },
      );
    }
    const apiKey = key();
    if (!apiKey) throw new NotConfiguredError(HINT);
    const e = await resolveEdinetByTicker(symbol);
    const doc = await findLatestAnnual(e.edinetCode);
    if (!doc) {
      throw new AdapterError(
        `최근 ${ANNUAL_DAYS}일 내 有価証券報告書를 찾지 못했습니다. EDINET 딥링크를 이용하세요.`,
        { status: 404 },
      );
    }
    const peYear = doc.periodEnd ? Number(doc.periodEnd.slice(0, 4)) : new Date().getFullYear();
    const statement = await fetchEdinetSummary(doc._id, peYear);
    if (!statement) {
      throw new AdapterError("有価証券報告書 CSV를 해석하지 못했습니다.", { status: 502 });
    }
    statement.symbol = symbol;
    return statement;
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
