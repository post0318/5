/**
 * EDINET API v2 어댑터 (일본 L1) — prd.md §4.1
 * 공식 무료 API. `EDINET_API_KEY` (Subscription-Key) 필요.
 *
 * 구현 상태:
 * - 회사정보: Edinetcode 목록 기반 (키 불필요)
 * - 공시목록: documents.json 최근 120일 스캔 (키 필요)
 * - 재무제표: 준비 중 — EDINET은 날짜 인덱스라 종목별 조회가 없음.
 *   본격 지원은 배치 수집→DB (prd.md §4.5). 그 전까지는 EDINET/IR BANK 딥링크.
 */

import "server-only";
import { fetchJson } from "../http";
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
import { fetchJQuantsFinancials, hasJQuants } from "./jquants";

const HINT =
  "일본(EDINET) 공시 연결에는 API 키가 필요합니다. " +
  "api.edinet-fsa.go.jp 에서 Subscription-Key 를 발급받아 .env.local 의 EDINET_API_KEY 에 설정하세요.";

const BASE = "https://api.edinet-fsa.go.jp/api/v2";

function key(): string | null {
  return process.env.EDINET_API_KEY ?? null;
}

interface DocResult {
  docID: string;
  edinetCode: string | null;
  secCode: string | null;
  filerName: string;
  docTypeCode: string | null;
  docDescription: string | null;
  submitDateTime: string;
  periodStart: string | null;
  periodEnd: string | null;
}
interface DocumentsResponse {
  metadata: { status: string; message: string };
  results?: DocResult[];
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

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 최근 `days`일 documents.json 을 제한 병렬(6)로 스캔 */
async function scanDocuments(
  apiKey: string,
  days: number,
  filter: (r: DocResult) => boolean,
): Promise<DocResult[]> {
  const today = new Date();
  const dates = Array.from({ length: days }, (_, i) =>
    ymd(new Date(today.getTime() - i * 86_400_000)),
  );

  const found: DocResult[] = [];
  let cursor = 0;
  const workers = Array.from({ length: 6 }, async () => {
    while (cursor < dates.length) {
      const date = dates[cursor++];
      try {
        const res = await fetchJson<DocumentsResponse>(
          `${BASE}/documents.json?date=${date}&type=2&Subscription-Key=${apiKey}`,
          { revalidate: 60 * 60 * 12 },
        );
        for (const r of res.results ?? []) if (filter(r)) found.push(r);
      } catch {
        // 개별 날짜 실패는 무시
      }
    }
  });
  await Promise.all(workers);
  return found.sort((a, b) => b.submitDateTime.localeCompare(a.submitDateTime));
}

// edinetCode → 최근 有価証券報告書 docID 캐시
const asrCache = new Map<string, { at: number; doc: DocResult | null }>();
const ASR_TTL = 1000 * 60 * 60 * 24;

async function findLatestAnnual(apiKey: string, edinetCode: string): Promise<DocResult | null> {
  const hit = asrCache.get(edinetCode);
  if (hit && Date.now() - hit.at < ASR_TTL) return hit.doc;
  // 有価証券報告書는 연 1회 → 최대 400일 스캔
  const docs = await scanDocuments(
    apiKey,
    400,
    (r) => r.edinetCode === edinetCode && r.docTypeCode === "120",
  );
  const doc = docs[0] ?? null;
  asrCache.set(edinetCode, { at: Date.now(), doc });
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
    return {
      symbol,
      market: "jp",
      name: e.nameEng || e.name,
      nameLocal: e.name,
      identifiers: { EDINETコード: e.edinetCode, 証券コード: e.secCode, ticker: e.ticker },
      industry: e.industry,
      address: e.address,
      description: `決算期: ${e.fiscalMonthDay}${e.consolidated ? " · 連結" : ""}`,
      source: "EDINET (Edinetcode)",
      sourceUrl: filingsDeepLink("jp", symbol)?.url,
    };
  },

  async getFinancials(symbol, periodType): Promise<FinancialStatement> {
    // 1순위: J-Quants (분기·연간 모두, 깔끔한 JSON) — 네트워크/자격증명 실패 시 폴백
    if (hasJQuants()) {
      try {
        const jq = await fetchJQuantsFinancials(symbol, periodType);
        if (jq) return jq;
      } catch {
        // J-Quants 실패 → EDINET
      }
    }

    // 2순위: EDINET 有価証券報告書 (연간만)
    if (periodType === "quarter") {
      throw new AdapterError(
        "일본 분기 재무는 J-Quants 연결 시 제공됩니다. 연간 또는 딥링크를 이용하세요.",
        { status: 501 },
      );
    }
    const apiKey = key();
    if (!apiKey) throw new NotConfiguredError(HINT);
    const e = await resolveEdinetByTicker(symbol);
    const doc = await findLatestAnnual(apiKey, e.edinetCode);
    if (!doc) {
      throw new AdapterError(
        "최근 400일 내 有価証券報告書를 찾지 못했습니다. EDINET 딥링크를 이용하세요.",
        { status: 404 },
      );
    }
    const peYear = doc.periodEnd ? Number(doc.periodEnd.slice(0, 4)) : new Date().getFullYear();
    const statement = await fetchEdinetSummary(apiKey, doc.docID, peYear);
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
    // 160일: 3月決算사의 6月 有価証券報告書를 11月까지 포착
    const docs = await scanDocuments(apiKey, 160, (r) => r.edinetCode === e.edinetCode);
    return docs.slice(0, limit).map((r) => ({
      id: r.docID,
      symbol,
      market: "jp" as const,
      date: r.submitDateTime.slice(0, 10),
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
