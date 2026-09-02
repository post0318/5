/**
 * OpenDART 어댑터 (한국 L1) — prd.md §4.1
 * 공식 무료 API. `DART_API_KEY` 환경변수 필요 (https://opendart.fss.or.kr).
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
  type FinancialLineItem,
  type FinancialPeriod,
  type FinancialPeriodType,
  type FinancialStatement,
  type MarketAdapter,
} from "../types";
import { resolveCorpCode } from "./corpcode";

const HINT =
  "한국(OpenDART) 데이터는 아직 연결되지 않았습니다. " +
  "opendart.fss.or.kr에서 API 키를 발급받아 .env.local의 DART_API_KEY에 설정하세요.";

function key(): string {
  const k = process.env.DART_API_KEY;
  if (!k) throw new NotConfiguredError(HINT);
  return k;
}

const BASE = "https://opendart.fss.or.kr/api";

interface DartEnvelope {
  status: string;
  message: string;
}

function checkStatus(res: DartEnvelope, ctx: string): void {
  if (res.status === "000") return;
  if (res.status === "013") {
    throw new AdapterError(`${ctx}: 조회된 데이터가 없습니다`, { status: 404 });
  }
  if (res.status === "020" || res.status === "021") {
    throw new AdapterError("OpenDART 사용 한도를 초과했습니다", { status: 429 });
  }
  if (res.status === "900" || res.status === "901") {
    throw new AdapterError("OpenDART API 키 오류", { status: 401 });
  }
  throw new AdapterError(`${ctx}: ${res.message} (${res.status})`, { status: 502 });
}

/** "1,234,567" | "-" | "" → number | null */
function parseAmount(v: string | undefined): number | null {
  if (!v || v === "-" || v.trim() === "") return null;
  const n = Number(v.replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

// ── 기업개황 ─────────────────────────────────────────────────────────

interface CompanyResponse extends DartEnvelope {
  corp_name: string;
  corp_name_eng: string;
  stock_name: string;
  ceo_nm: string;
  corp_cls: string; // Y 유가 / K 코스닥 / N 코넥스 / E 기타
  adres: string;
  hm_url: string;
  ind_cd: string;
  est_dt: string; // YYYYMMDD
  acc_mt: string; // 결산월
}

const CORP_CLS_LABEL: Record<string, string> = {
  Y: "유가증권시장",
  K: "코스닥",
  N: "코넥스",
  E: "기타",
};

// ── 공시목록 ─────────────────────────────────────────────────────────

interface ListResponse extends DartEnvelope {
  list?: {
    rcept_no: string;
    rcept_dt: string; // YYYYMMDD
    report_nm: string;
    flr_nm: string;
    corp_name: string;
  }[];
}

// ── 전체 재무제표 ────────────────────────────────────────────────────

interface FnlttRow {
  sj_div: string; // BS/IS/CIS/CF/SCE
  sj_nm: string;
  account_nm: string;
  account_detail: string;
  thstrm_nm: string;
  thstrm_amount: string;
  frmtrm_nm: string;
  frmtrm_amount: string;
  bfefrmtrm_nm?: string;
  bfefrmtrm_amount?: string;
  ord: string;
}
interface FnlttResponse extends DartEnvelope {
  list?: FnlttRow[];
}

const SECTION_BY_SJ: Record<string, string> = {
  BS: "재무상태표",
  IS: "손익계산서",
  CIS: "포괄손익계산서",
  CF: "현금흐름표",
  SCE: "자본변동표",
};
const SECTION_ORDER = ["재무상태표", "손익계산서", "포괄손익계산서", "현금흐름표"];

const HIGHLIGHT_ACCOUNTS = new Set([
  "매출액",
  "수익(매출액)",
  "매출",
  "영업수익",
  "영업이익",
  "영업이익(손실)",
  "당기순이익",
  "당기순이익(손실)",
  "분기순이익",
  "반기순이익",
  "자산총계",
  "부채총계",
  "자본총계",
  "영업활동현금흐름",
  "영업활동으로인한현금흐름",
  "영업활동으로 인한 현금흐름",
]);

function isSubtotal(name: string): boolean {
  return /총계$|총이익$|총포괄|순이익|영업이익/.test(name);
}

async function fetchFnlttYear(
  corpCode: string,
  bsnsYear: number,
  reprtCode: string,
  fsDiv: "CFS" | "OFS",
): Promise<FnlttRow[] | null> {
  const url =
    `${BASE}/fnlttSinglAcntAll.json?crtfc_key=${key()}&corp_code=${corpCode}` +
    `&bsns_year=${bsnsYear}&reprt_code=${reprtCode}&fs_div=${fsDiv}`;
  const res = await fetchJson<FnlttResponse>(url, { revalidate: 60 * 60 * 6 });
  if (res.status === "013") return null; // 데이터 없음
  checkStatus(res, "재무제표");
  return res.list ?? null;
}

function rowsToStatement(
  symbol: string,
  periodType: FinancialPeriodType,
  fsDiv: "CFS" | "OFS",
  yearRows: { year: number; rows: FnlttRow[] }[],
): FinancialStatement {
  // 기간(컬럼) 구성: 각 연도 호출의 당기/전기/전전기 라벨을 fiscalYear로 환산
  const periodMap = new Map<number, FinancialPeriod>();
  // account_nm -> (fiscalYear -> amount)
  const accounts = new Map<
    string,
    { sj: string; ord: number; values: Map<number, number | null> }
  >();

  for (const { year, rows } of yearRows) {
    for (const r of rows) {
      const section = SECTION_BY_SJ[r.sj_div];
      if (!section || section === "자본변동표") continue;
      const k = `${r.sj_div}|${r.account_nm}`;
      if (!accounts.has(k)) {
        accounts.set(k, {
          sj: r.sj_div,
          ord: Number(r.ord) || 0,
          values: new Map(),
        });
      }
      const acc = accounts.get(k)!;
      const cols: [number, string | undefined][] = [
        [year, r.thstrm_amount],
        [year - 1, r.frmtrm_amount],
        [year - 2, r.bfefrmtrm_amount],
      ];
      for (const [fy, amt] of cols) {
        if (amt === undefined) continue;
        if (!periodMap.has(fy)) {
          periodMap.set(fy, {
            label: `FY${fy}`,
            fiscalYear: fy,
            fiscalQuarter: null,
            endDate: `${fy}-12-31`,
          });
        }
        const parsed = parseAmount(amt);
        if (!acc.values.has(fy) || acc.values.get(fy) == null) {
          acc.values.set(fy, parsed);
        }
      }
    }
  }

  const periods = [...periodMap.values()]
    .sort((a, b) => b.fiscalYear - a.fiscalYear)
    .slice(0, 6);
  const periodYears = periods.map((p) => p.fiscalYear);

  const sections = SECTION_ORDER.map((title) => {
    const items: FinancialLineItem[] = [];
    const entries = [...accounts.entries()]
      .filter(([, a]) => SECTION_BY_SJ[a.sj] === title)
      .sort((a, b) => a[1].ord - b[1].ord);
    for (const [k, a] of entries) {
      const accountName = k.split("|")[1];
      const values: Record<string, number | null> = {};
      let hasAny = false;
      for (const fy of periodYears) {
        const v = a.values.get(fy) ?? null;
        values[`FY${fy}`] = v;
        if (v != null) hasAny = true;
      }
      if (!hasAny) continue;
      items.push({
        accountName,
        depth: 0,
        isSubtotal: isSubtotal(accountName),
        isHighlight: HIGHLIGHT_ACCOUNTS.has(accountName.replace(/\s/g, "")),
        values,
      });
    }
    return { title, items };
  }).filter((s) => s.items.length > 0);

  return {
    symbol,
    market: "kr",
    periodType,
    unit: "원",
    currency: "KRW",
    consolidation: fsDiv === "CFS" ? "consolidated" : "separate",
    periods,
    sections,
    source: `OpenDART 전체 재무제표 (${fsDiv === "CFS" ? "연결" : "별도"})`,
    sourceUrl: filingsDeepLink("kr", symbol)?.url,
  };
}

// ── 어댑터 ───────────────────────────────────────────────────────────

export const krOpenDartAdapter: MarketAdapter = {
  market: "kr",
  currency: "KRW",

  isConfigured() {
    return Boolean(process.env.DART_API_KEY);
  },
  configHint() {
    return HINT;
  },

  normalizeSymbol(input) {
    const digits = input.replace(/[^0-9]/g, "");
    return digits.padStart(6, "0").slice(-6);
  },

  async getCompanyProfile(symbol): Promise<CompanyProfile> {
    const entry = await resolveCorpCode(key(), symbol);
    const res = await fetchJson<CompanyResponse>(
      `${BASE}/company.json?crtfc_key=${key()}&corp_code=${entry.corpCode}`,
      { revalidate: 60 * 60 * 24 },
    );
    checkStatus(res, "기업개황");
    return {
      symbol,
      market: "kr",
      name: res.corp_name,
      nameLocal: res.corp_name,
      identifiers: {
        corp_code: entry.corpCode,
        종목코드: symbol,
        시장: CORP_CLS_LABEL[res.corp_cls] ?? res.corp_cls,
      },
      ceo: res.ceo_nm,
      homepage: res.hm_url ? `https://${res.hm_url.replace(/^https?:\/\//, "")}` : undefined,
      address: res.adres,
      listedDate: res.est_dt
        ? `${res.est_dt.slice(0, 4)}-${res.est_dt.slice(4, 6)}-${res.est_dt.slice(6, 8)}`
        : undefined,
      source: "OpenDART",
      sourceUrl: filingsDeepLink("kr", symbol)?.url,
    };
  },

  async getFinancials(symbol, periodType): Promise<FinancialStatement> {
    const entry = await resolveCorpCode(key(), symbol);
    const now = new Date();
    const y = now.getFullYear();

    if (periodType === "annual") {
      for (const fsDiv of ["CFS", "OFS"] as const) {
        const yearRows: { year: number; rows: FnlttRow[] }[] = [];
        for (const year of [y - 1, y - 2]) {
          const rows = await fetchFnlttYear(entry.corpCode, year, "11011", fsDiv);
          if (rows) yearRows.push({ year, rows });
        }
        if (yearRows.length) {
          return rowsToStatement(symbol, "annual", fsDiv, yearRows);
        }
      }
      throw new AdapterError("연간 재무제표를 찾을 수 없습니다", { status: 404 });
    }

    // 분기: 가장 최근 가용 분기 보고서 1건
    const quarterCodes = ["11014", "11012", "11013", "11011"];
    for (const fsDiv of ["CFS", "OFS"] as const) {
      for (const year of [y, y - 1]) {
        for (const code of quarterCodes) {
          const rows = await fetchFnlttYear(entry.corpCode, year, code, fsDiv);
          if (rows && rows.length) {
            const st = rowsToStatement(symbol, "quarter", fsDiv, [{ year, rows }]);
            st.source += ` · ${year} ${QUARTER_LABEL[code]}`;
            return st;
          }
        }
      }
    }
    throw new AdapterError("분기 재무제표를 찾을 수 없습니다", { status: 404 });
  },

  async getFilings(symbol, opts): Promise<Filing[]> {
    const entry = await resolveCorpCode(key(), symbol);
    const now = new Date();
    const end = now.toISOString().slice(0, 10).replace(/-/g, "");
    const begin = new Date(now.getTime() - 365 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "");
    const res = await fetchJson<ListResponse>(
      `${BASE}/list.json?crtfc_key=${key()}&corp_code=${entry.corpCode}` +
        `&bgn_de=${begin}&end_de=${end}&page_count=${Math.min(opts?.limit ?? 30, 100)}`,
      { revalidate: 60 * 30 },
    );
    if (res.status === "013") return [];
    checkStatus(res, "공시목록");
    return (res.list ?? []).map((r) => ({
      id: r.rcept_no,
      symbol,
      market: "kr" as const,
      date: `${r.rcept_dt.slice(0, 4)}-${r.rcept_dt.slice(4, 6)}-${r.rcept_dt.slice(6, 8)}`,
      title: r.report_nm.replace(/\s+/g, " ").trim(),
      type: r.report_nm.split(/[\s(]/)[0] || "공시",
      url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${r.rcept_no}`,
      source: "DART",
    }));
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

const QUARTER_LABEL: Record<string, string> = {
  "11013": "1분기",
  "11012": "반기",
  "11014": "3분기",
  "11011": "사업보고서",
};
