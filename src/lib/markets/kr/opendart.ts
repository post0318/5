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
  type TtmFlows,
} from "../types";
import { resolveCorpCode } from "./corpcode";
import { annualSeries, daAndAmortSeries, fetchKrFacts, seriesOf } from "./dart-facts";
import { buildKrEvResolver, krEpsByYear, krLtmBalance, krOpIncomeByYear, loadKrCaps } from "./dart-ev";
import { getKrDaDoc } from "@/lib/db/kr-da";

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
  jurir_no: string; // 법인등록번호 (13자리)
}

/** 종목코드 → 법인등록번호 (금융위 권리일정 API `crno` 파라미터용) */
export async function getKrJurirNo(symbol: string): Promise<string | null> {
  try {
    const entry = await resolveCorpCode(key(), symbol);
    const res = await fetchJson<CompanyResponse>(
      `${BASE}/company.json?crtfc_key=${key()}&corp_code=${entry.corpCode}`,
      { revalidate: 60 * 60 * 24 },
    );
    const jn = (res.jurir_no ?? "").replace(/\D/g, "");
    return jn.length === 13 ? jn : null;
  } catch {
    return null;
  }
}

const CORP_CLS_LABEL: Record<string, string> = {
  Y: "유가증권시장",
  K: "코스닥",
  N: "코넥스",
  E: "기타",
};

// ── 공시목록 ─────────────────────────────────────────────────────────

interface FilingRow {
  rcept_no: string;
  rcept_dt: string; // YYYYMMDD
  report_nm: string;
  flr_nm: string;
  corp_name: string;
}
interface ListResponse extends DartEnvelope {
  list?: FilingRow[];
}

// ── 전체 재무제표 ────────────────────────────────────────────────────

interface FnlttRow {
  sj_div: string; // BS/IS/CIS/CF/SCE
  sj_nm: string;
  account_id?: string;
  account_nm: string;
  account_detail: string;
  thstrm_nm: string;
  thstrm_amount: string;
  thstrm_add_amount?: string; // 당기 누적 (분기·반기 보고서)
  frmtrm_nm: string;
  frmtrm_amount: string;
  frmtrm_add_amount?: string; // 전기 누적 (분기·반기 보고서)
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
    .slice(0, 5);
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

// ── TTM (최근 4분기) ─────────────────────────────────────────────────

// DART는 해당 기(연간/반기/분기)에 영업손실·순손실이 나면 계정과목명을 "…이익"
// 대신 부호중립 표기 "…손익"으로 바꿔 공시한다(실측: 삼성SDI, 2025 사업연도
// 영업손실·순손실 전환 이후 "영업이익"→"영업손익", "당기순이익"→"당기순손익"/
// "반기순손익", EPS도 "…주당이익"→"…주당손익" — 오너 지적, 2026-09). 과거
// 연도(FY) 컬럼은 별도의 관대한 통합 빌더(union-find 계정 병합, dart-facts.ts)
// 를 써서 영향 없었고, 이 TTM 전용 계정명 목록만 "손익" 변형이 빠져 최신
// 분기·직전 사업연도가 전부 null이 되는 문제였음 — "당기순손익"(연간
// 총당기순손익, 중단영업 포함)은 부분치인 "계속영업당기순손익"보다 정확한
// 총순이익이라 그쪽을 추가했다(계속영업만 담는 계정명은 의도적으로 미포함).
const TTM_ACCOUNTS = {
  netIncome: [
    "당기순이익",
    "당기순이익(손실)",
    "분기순이익",
    "반기순이익",
    "연결당기순이익",
    "당기순손익",
    "반기순손익",
    "분기순손익",
    "연결당기순손익",
  ],
  revenue: ["매출액", "수익(매출액)", "매출", "영업수익", "매출및지분법손익"],
  opIncome: ["영업이익", "영업이익(손실)", "영업손익"],
  eps: [
    "희석주당이익",
    "희석주당순이익",
    "희석주당이익(손실)",
    "기본주당이익",
    "기본주당순이익",
    "기본주당이익(손실)",
    "기본희석주당이익",
    "기본및희석주당이익",
    "주당이익",
    "주당순이익",
    "보통주 기본주당손익",
    "보통주 희석주당손익",
    "기본주당손익",
    "주당손익",
  ],
} as const;

// 계정명 앞 번호("Ⅳ. 영업이익"·"1. 매출액"·"(1) 매출액")는 떼고 비교 — 가온전선처럼 번호를
// 붙이는 회사는 정확 일치가 전부 실패해 TTM 매출·영업이익·순이익이 비었다(2026-09-23).
const norm = (s: string) =>
  s.replace(/\s/g, "").replace(/^(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]+\.?|\d+[.)]|\(\d+\)|[가-하][.)])/, "");

/**
 * TTM 계정 ID — dart-facts·dart-ev(하이라이트·재무분석)와 같은 ID 를 먼저 본다. 계정명은
 * 회사마다 표기가 달라(번호·괄호) ID 가 있으면 ID 가 우선.
 */
const TTM_IDS: Record<keyof typeof TTM_ACCOUNTS, readonly string[]> = {
  netIncome: ["ifrs-full_ProfitLoss"],
  revenue: ["ifrs-full_Revenue", "dart_Revenue"],
  opIncome: ["dart_OperatingIncomeLoss", "ifrs-full_ProfitLossFromOperatingActivities"],
  eps: [
    "ifrs-full_DilutedEarningsLossPerShare",
    "ifrs-full_BasicEarningsLossPerShare",
    "ifrs-full_DilutedEarningsLossPerShareFromContinuingOperations",
    "ifrs-full_BasicEarningsLossPerShareFromContinuingOperations",
  ],
};
// EPS 계정명은 회사·보고서별 편차가 커서 부분일치 허용
const EPS_LOOSE = /주당(순)?이익/;

/** 손익/포괄손익 계정에서 값 추출. col: 당기누적 | 전기동기누적 | 연간(당기) */
function isValue(
  rows: FnlttRow[],
  names: readonly string[],
  col: "cumCur" | "cumPrior" | "annual",
  loose?: RegExp,
  ids?: readonly string[],
): number | null {
  const set = new Set(names.map(norm));
  const pick = (r: FnlttRow) => {
    if (col === "annual") return parseAmount(r.thstrm_amount);
    if (col === "cumCur")
      return parseAmount(r.thstrm_add_amount) ?? parseAmount(r.thstrm_amount);
    return parseAmount(r.frmtrm_add_amount) ?? parseAmount(r.frmtrm_amount);
  };
  // ID 우선(목록 순서 = 우선순위)
  for (const id of ids ?? []) {
    const r = rows.find((x) => (x.sj_div === "IS" || x.sj_div === "CIS") && x.account_id === id);
    if (r) {
      const v = pick(r);
      if (v != null) return v;
    }
  }
  let looseHit: number | null = null;
  for (const r of rows) {
    if (r.sj_div !== "IS" && r.sj_div !== "CIS") continue;
    const nm = norm(r.account_nm ?? "");
    if (set.has(nm)) return pick(r);
    if (loose && looseHit == null && loose.test(nm)) looseHit = pick(r);
  }
  return looseHit;
}

const INTERIM_RANK: Record<string, number> = { "11014": 3, "11012": 2, "11013": 1 };

/**
 * TTM 값의 구성 기간 — 값 = Σ v. 외화 환산(DART 연결 ADR, us/dart-adr.ts)이 각 기간을 그 기간의
 * 평균 환율로 바꿔 더한다(미국 외국기업 규칙과 같다 — 연간·누적 공시값을 각자 환산한 뒤 TTM 조합).
 */
export interface KrTtmPart {
  v: number;
  start: string;
  end: string;
}
export type KrTtmParts = Partial<Record<"netIncome" | "revenue" | "opIncome" | "eps" | "daTtm", KrTtmPart[]>>;

/** 손익 TTM + 그 TTM 의 마지막 분기(재무상태표 기준일 — getTtm 스냅샷용). */
type KrTtmResult = TtmFlows & { lastQuarter: { year: number; quarter: number }; parts: KrTtmParts };

async function getKrTtm(corpCode: string): Promise<KrTtmResult | null> {
  const y = new Date().getFullYear();

  // 1) 최근 가용 당기 분기/반기 보고서
  let interim:
    | { year: number; code: string; rows: FnlttRow[]; fsDiv: "CFS" | "OFS" }
    | null = null;
  for (const fsDiv of ["CFS", "OFS"] as const) {
    for (const year of [y, y - 1]) {
      const found = await Promise.all(
        Object.keys(INTERIM_RANK).map((code) =>
          fetchFnlttYear(corpCode, year, code, fsDiv).then((rows) => ({ code, rows })),
        ),
      );
      const hit = found
        .filter((f) => f.rows && f.rows.length)
        .sort((a, b) => INTERIM_RANK[b.code] - INTERIM_RANK[a.code])[0];
      if (hit) {
        interim = { year, code: hit.code, rows: hit.rows!, fsDiv };
        break;
      }
    }
    if (interim) break;
  }
  if (!interim) return null;

  // 2) 직전 사업보고서
  let annualRows: FnlttRow[] | null = null;
  let annualYear = 0;
  const fsOrder: ("CFS" | "OFS")[] =
    interim.fsDiv === "CFS" ? ["CFS", "OFS"] : ["OFS", "CFS"];
  for (const fsDiv of fsOrder) {
    for (const yr of [interim.year - 1, interim.year - 2]) {
      const rows = await fetchFnlttYear(corpCode, yr, "11011", fsDiv);
      if (rows && rows.length) {
        annualRows = rows;
        annualYear = yr;
        break;
      }
    }
    if (annualRows) break;
  }
  if (!annualRows) return null;

  // 3) 전년 동기 누적이 보고서에 없으면, 전년 동일 보고서를 따로 조회
  let priorInterimRows: FnlttRow[] | null = null;
  const needPriorFetch =
    isValue(interim.rows, TTM_ACCOUNTS.netIncome, "cumPrior", undefined, TTM_IDS.netIncome) == null;
  if (needPriorFetch) {
    for (const fsDiv of fsOrder) {
      const rows = await fetchFnlttYear(corpCode, interim.year - 1, interim.code, fsDiv);
      if (rows && rows.length) {
        priorInterimRows = rows;
        break;
      }
    }
  }

  // 구성 기간(외화 환산용) — 연간·당기 누적·전년 동기 누적
  const qMd = { "11013": "03-31", "11012": "06-30", "11014": "09-30" }[interim.code] ?? "12-31";
  const fySpan = { start: `${annualYear}-01-01`, end: `${annualYear}-12-31` };
  const curSpan = { start: `${interim.year}-01-01`, end: `${interim.year}-${qMd}` };
  const priorSpan = { start: `${interim.year - 1}-01-01`, end: `${interim.year - 1}-${qMd}` };

  const ttm = (key: keyof typeof TTM_ACCOUNTS): { v: number | null; ttm: boolean; parts: KrTtmPart[] } => {
    const names = TTM_ACCOUNTS[key];
    const lz = key === "eps" ? EPS_LOOSE : undefined;
    const ids = TTM_IDS[key];
    const annual = isValue(annualRows!, names, "annual", lz, ids);
    const cur = isValue(interim!.rows, names, "cumCur", lz, ids);
    let prior = isValue(interim!.rows, names, "cumPrior", lz, ids);
    if (prior == null && priorInterimRows)
      prior = isValue(priorInterimRows, names, "cumCur", lz, ids);
    if (annual == null) return { v: null, ttm: false, parts: [] };
    if (cur == null || prior == null) return { v: annual, ttm: false, parts: [{ v: annual, ...fySpan }] }; // 분기 데이터 부족 → 연간값
    return {
      v: annual + cur - prior,
      ttm: true,
      parts: [{ v: annual, ...fySpan }, { v: cur, ...curSpan }, { v: -prior, ...priorSpan }],
    };
  };

  const ni = ttm("netIncome");
  const rev = ttm("revenue");
  const op = ttm("opIncome");
  const epsR = ttm("eps");

  // EPS 분기데이터가 없으면 TTM 순이익 / (연간 순이익 ÷ 연간 EPS) 로 환산
  // 적자여도 EPS 는 음수 그대로 낸다(오너 지시 2026-09-24 — "적자여도 eps 는 나오는 것
  // 아닌가"). PER 등 배수는 소비하는 쪽이 분모 0 이하면 비운다(미국과 같은 부호 규칙).
  let eps = epsR.ttm && epsR.v != null ? epsR.v : null;
  let epsParts: KrTtmPart[] = eps != null ? epsR.parts : [];
  if (eps == null && ni.ttm && ni.v != null) {
    const annualNi = isValue(annualRows!, TTM_ACCOUNTS.netIncome, "annual", undefined, TTM_IDS.netIncome);
    const annualEps = isValue(annualRows!, TTM_ACCOUNTS.eps, "annual", EPS_LOOSE, TTM_IDS.eps);
    // 주식수 환산은 연간 순이익·EPS 부호가 같으면(적자 해 포함) 성립
    if (annualNi && annualEps) {
      const shares = annualNi / annualEps;
      if (shares > 0) {
        eps = ni.v / shares; // 반올림하지 않음 — 표시 포맷(버림)에서 처리
        epsParts = ni.parts.map((p) => ({ ...p, v: p.v / shares }));
      }
    }
  }

  const q = QUARTER_LABEL[interim.code] ?? "분기";
  return {
    periodLabel: `FY${annualYear} + ${interim.year} ${q} − ${interim.year - 1} ${q}`,
    lastQuarter: { year: interim.year, quarter: INTERIM_RANK[interim.code] },
    netIncome: ni.v,
    revenue: rev.v,
    opIncome: op.v,
    eps,
    parts: { netIncome: ni.parts, revenue: rev.parts, opIncome: op.parts, eps: epsParts },
  };
}

/**
 * 한국 getTtm 본체 + 외화 환산용 부가 정보(구성 기간·재무상태표 기준일). getTtm 은 ttm 만 돌려준다
 * — 부가 정보는 DART 연결 ADR(us/dart-adr.ts)이 각 값을 그 기간의 환율로 바꾸는 데만 쓴다.
 */
export interface KrTtmDetail {
  ttm: TtmFlows;
  parts: KrTtmParts;
  /** snapshot.evBridge·cash 의 기준일 / snapshot.equity 의 기준일 */
  bridgeEnd: string | null;
  equityEnd: string | null;
}

export async function loadKrTtmDetail(symbol: string): Promise<KrTtmDetail | null> {
  const entry = await resolveCorpCode(key(), symbol);
  try {
    const code = symbol.replace(/\D/g, "").padStart(6, "0").slice(-6);
    const [ttmRes, facts, quarterFacts, daDoc, caps] = await Promise.all([
      getKrTtm(entry.corpCode),
      fetchKrFacts(entry.corpCode, "annual").catch(() => null),
      // LTM 재무상태표(최신 분기말) — 분기 재무제표 화면과 같은 캐시(fetchKrFacts)를 공유
      fetchKrFacts(entry.corpCode, "quarter").catch(() => null),
      getKrDaDoc(code).catch(() => null),
      loadKrCaps(code, []).catch(() => null),
    ]);
    const lastQuarter = ttmRes?.lastQuarter ?? null;
    const flows: TtmFlows | null = ttmRes
      ? { periodLabel: ttmRes.periodLabel, netIncome: ttmRes.netIncome, revenue: ttmRes.revenue, opIncome: ttmRes.opIncome, eps: ttmRes.eps }
      : null;
    const parts: KrTtmParts = { ...(ttmRes?.parts ?? {}) };
    // 구성 기간을 최근 4개 분기로 다시 쪼갠다(외화 환산 LTM = 분기별 평균 환율 합, 오너 결정 2026-09-25 —
    // 인포맥스·Finviz 방식). 분기 재무제표(fetchKrFacts quarter)의 단일분기 값 4개 합이 원화 TTM 과 정확히 같을
    // 때만 바꾼다 — 계정 선택이 달라 합이 안 맞으면 종전 구성 기간(연간·누적)을 그대로 둔다.
    if (ttmRes && quarterFacts && lastQuarter) {
      const want: string[] = [];
      for (let i = 3; i >= 0; i--) {
        const idx = lastQuarter.year * 4 + (lastQuarter.quarter - 1) - i;
        want.push(`${Math.floor(idx / 4)} Q${(idx % 4) + 1}`);
      }
      const qp = want.map((l) => quarterFacts.periods.find((p) => p.label === l));
      if (qp.every(Boolean)) {
        for (const k of ["revenue", "opIncome", "netIncome", "eps"] as const) {
          const krw = ttmRes[k];
          const cur = parts[k];
          if (krw == null || !cur || cur.length < 3) continue; // 연간값만 있는 TTM 은 그대로
          const series = seriesOf(quarterFacts, [...TTM_IDS[k]], [...TTM_ACCOUNTS[k]], ["IS", "CIS"]);
          const qs = qp.map((p) => ({ v: series[p!.label], start: `${p!.year}-${String(p!.quarter! * 3 - 2).padStart(2, "0")}-01`, end: p!.endDate }));
          if (qs.some((q) => q.v == null)) continue;
          const sum = qs.reduce((a, q) => a + q.v!, 0);
          if (Math.abs(sum - krw) > Math.max(1e-6, Math.abs(krw) * 1e-9)) continue;
          parts[k] = qs.map((q) => ({ v: q.v!, start: q.start, end: q.end }));
        }
      }
    }
    if (!facts) return flows ? { ttm: flows, parts, bridgeEnd: null, equityEnd: null } : null;
    // TTM 항목이 비면(계정 매칭 실패·분기 보고서 없음) 최근 사업연도 값으로 채운다 —
    // getKrTtm 이 분기 데이터가 부족할 때 연간값을 쓰는 것과 같은 의미. 여기서 채워야
    // 하이라이트·재무분석·개요가 같은 값을 쓴다(예전엔 재무분석만 연간값으로 대체해
    // LTM 열이 화면마다 갈렸다, 2026-09-23 가온전선).
    const fyLast = (m: Map<number, number>, k: keyof KrTtmParts) => {
      const ys = [...m.keys()].sort((a, b) => a - b);
      const y = ys.at(-1);
      if (y == null) return null;
      const v = m.get(y) ?? null;
      if (v != null) parts[k] = [{ v, start: `${y}-01-01`, end: facts.annualEndByYear.get(y) ?? `${y}-12-31` }];
      return v;
    };
    const base: TtmFlows = flows ?? {
      periodLabel: "",
      netIncome: null,
      revenue: null,
      opIncome: null,
      eps: null,
    };
    const filled: TtmFlows = {
      ...base,
      revenue: base.revenue ?? fyLast(annualSeries(facts, ["ifrs-full_Revenue", "dart_Revenue"], ["매출액", "수익(매출액)", "영업수익"], ["IS", "CIS"]), "revenue"),
      opIncome: base.opIncome ?? fyLast(krOpIncomeByYear(facts), "opIncome"),
      netIncome: base.netIncome ?? fyLast(annualSeries(facts, ["ifrs-full_ProfitLoss"], ["당기순이익", "분기순이익", "반기순이익"], ["IS", "CIS"]), "netIncome"),
      // 적자여도 EPS 는 음수 그대로(PER 은 소비하는 쪽이 부호 규칙으로 비움, 오너 지시 2026-09-24)
      eps: base.eps ?? fyLast(krEpsByYear(facts), "eps"),
    };
    if (!base.periodLabel) filled.periodLabel = `FY${facts.periods.at(-1)?.year ?? ""} (연간)`;
    // EV 스냅샷 — 하이라이트·재무분석 LTM 열이 이 값을 그대로 쓴다(dart-ev.ts 단일 기준).
    // 기준일 = 손익 TTM 의 마지막 분기말 재무상태표(오너 결정 2026-09-24, 미국 MRQ 와 같은
    // 원칙). TTM 이 연간값이면 사업연도말. 분기 BS 를 못 구하면 연말값 + 라벨에 표기.
    const ev = buildKrEvResolver(facts, code);
    const bal = krLtmBalance(facts, quarterFacts, lastQuarter, code);
    const b = bal.bridge;
    // LTM D&A — 하이라이트와 같은 함수(사업보고서 주석 실측 → 연간 폴백)
    const da = daAndAmortSeries(facts, daDoc);
    if (da.ltm != null) {
      const lastY = [...facts.annualEndByYear.keys()].sort((a, b) => a - b).at(-1);
      const docTtm = daDoc?.ttmDepreciation != null;
      // 주석 TTM 은 손익 TTM 과 같은 12개월(마지막 분기말까지)로 본다 — 없으면 최근 사업연도
      const qEnd = bal.bridgeEnd ?? `${lastY}-12-31`;
      const s = new Date(`${qEnd}T00:00:00Z`);
      s.setUTCFullYear(s.getUTCFullYear() - 1);
      s.setUTCDate(s.getUTCDate() + 1);
      parts.daTtm = [
        docTtm
          ? { v: da.ltm, start: s.toISOString().slice(0, 10), end: qEnd }
          : { v: da.ltm, start: `${lastY}-01-01`, end: `${lastY}-12-31` },
      ];
    }
    return {
      parts,
      bridgeEnd: bal.bridgeEnd,
      equityEnd: bal.equityEnd,
      ttm: {
        ...filled,
        daTtm: da.ltm,
        snapshot: {
          label: bal.label,
          equity: bal.parentEquity,
          liabilities: null,
          cash: b?.cash ?? null,
          shares: null,
          evNetDebt: b ? b.debt + b.nci - b.cash : null,
          evBlocker: ev.blocker(),
          evPreferredMcap: caps?.current?.preferred ?? 0,
          evBridge: b,
        },
      },
    };
  } catch {
    return null;
  }
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
        // 당기/전기 두 해를 병렬 조회 (순차 시 왕복 지연이 2배)
        const results = await Promise.all(
          [y - 1, y - 2].map((year) =>
            fetchFnlttYear(entry.corpCode, year, "11011", fsDiv).then((rows) => ({ year, rows })),
          ),
        );
        const yearRows = results
          .filter((r): r is { year: number; rows: FnlttRow[] } => r.rows != null)
          .sort((a, b) => b.year - a.year);
        if (yearRows.length) {
          return rowsToStatement(symbol, "annual", fsDiv, yearRows);
        }
      }
      throw new AdapterError("연간 재무제표를 찾을 수 없습니다", { status: 404 });
    }

    // 분기: 가장 최근 가용 분기 보고서 1건. (fsDiv, year) 조합마다 4개 보고서
    // 코드를 병렬 조회하고 데이터가 있는 것 중 최신 분기를 고른다 (순차 루프는
    // 연초처럼 대부분 "데이터 없음"일 때 십수 번 왕복해 매우 느림).
    const quarterRank: Record<string, number> = {
      "11014": 3, // 3분기
      "11012": 2, // 반기
      "11013": 1, // 1분기
      "11011": 0, // 사업보고서
    };
    const quarterCodes = Object.keys(quarterRank);
    for (const fsDiv of ["CFS", "OFS"] as const) {
      for (const year of [y, y - 1]) {
        const found = await Promise.all(
          quarterCodes.map((code) =>
            fetchFnlttYear(entry.corpCode, year, code, fsDiv).then((rows) => ({ code, rows })),
          ),
        );
        const hit = found
          .filter((f) => f.rows && f.rows.length)
          .sort((a, b) => quarterRank[b.code] - quarterRank[a.code])[0];
        if (hit) {
          const st = rowsToStatement(symbol, "quarter", fsDiv, [{ year, rows: hit.rows! }]);
          st.source += ` · ${year} ${QUARTER_LABEL[hit.code]}`;
          return st;
        }
      }
    }
    throw new AdapterError("분기 재무제표를 찾을 수 없습니다", { status: 404 });
  },

  async getTtm(symbol): Promise<TtmFlows | null> {
    return (await loadKrTtmDetail(symbol))?.ttm ?? null;
  },

  async getFilings(symbol, opts): Promise<Filing[]> {
    const entry = await resolveCorpCode(key(), symbol);
    const now = new Date();
    const end = now.toISOString().slice(0, 10).replace(/-/g, "");
    const core = opts?.scope === "core";
    // 주요공시도 최근 1년 이내로 제한
    const spanDays = 365;
    const begin = new Date(now.getTime() - spanDays * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, "");
    const pageCount = Math.min(opts?.limit ?? 30, 100);

    const listOf = async (pblntfTy?: string): Promise<FilingRow[]> => {
      const res = await fetchJson<ListResponse>(
        `${BASE}/list.json?crtfc_key=${key()}&corp_code=${entry.corpCode}` +
          `&bgn_de=${begin}&end_de=${end}&page_count=${pageCount}` +
          (pblntfTy ? `&pblntf_ty=${pblntfTy}` : ""),
        { revalidate: 60 * 30 },
      );
      if (res.status === "013") return [];
      checkStatus(res, "공시목록");
      return res.list ?? [];
    };

    let rows: FilingRow[];
    if (core) {
      // A 정기공시 · B 주요사항보고 · F 외부감사(감사보고서) · C 발행공시 · I 거래소공시(실적·자기주식·공급계약 등)
      const [a, b, f, c, i] = await Promise.all([
        listOf("A"),
        listOf("B"),
        listOf("F"),
        listOf("C"),
        listOf("I"),
      ]);
      const iCore = /실적|잠정|손익구조|매출액|자기주식|공급계약|주식소각/;
      const cCore = /증자|사채|감자|주식배당|합병|분할|양수|양도/;
      const seen = new Set<string>();
      rows = [
        ...a,
        ...b,
        ...f,
        ...c.filter((r) => cCore.test(r.report_nm)),
        ...i.filter((r) => iCore.test(r.report_nm)),
      ]
        .filter((r) => (seen.has(r.rcept_no) ? false : (seen.add(r.rcept_no), true)))
        .sort((x, y) => (x.rcept_dt < y.rcept_dt ? 1 : -1))
        .slice(0, pageCount);
    } else {
      rows = await listOf();
    }

    return rows.map((r) => ({
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
