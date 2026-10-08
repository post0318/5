/**
 * SEC EDGAR 어댑터 (미국 L1) — prd.md §4.1
 * 공식 무료 API. API 키 불필요. User-Agent 헤더 필수.
 * https://www.sec.gov/search-filings/edgar-application-programming-interfaces
 */

import { fetchJson } from "../http";
import { withFetchScope } from "../fetch-health";
import { blankYahooLtm, withYahooLtm, yahooLtm, yahooLtmPeriods, type YahooLtmResult } from "./edgar-yahoo-quarters";
import { sixKStatements } from "./edgar-6k";
import { fetchYahooFundamentals } from "../quote/yahoo";
import { fxToUsd } from "./edgar-foreign";
import { consensusDeepLinks, filingsDeepLink, newsDeepLinks } from "../deeplinks";
import {
  AdapterError,
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
import { type FactEntry, ttmFlow } from "./edgar-fundamentals";
import { dropRoundedRetags, entriesOf, instantOn, ltmAnchor, markNoRecast, splitFactorsByYear, fiscalYearOf } from "./edgar-series";
import { buildEvResolver, daAnnualByYear, daTtm, daTtmCell, opIncomeLtm, SYN_OP_INCOME, withOpIncome, type EvContext } from "./edgar-ev";
import { loadCaptiveDebt } from "./edgar-captive";
import { buildShareResolver } from "./edgar-shares";
import { withFilingGapFill } from "./edgar-gapfill";
import { toAdrBasis, withForeignNormalization } from "./edgar-foreign";
import { withContentAmortization } from "./edgar-content";
import { withRevenueDims } from "./edgar-revenue-dims";
import { withCashFlowWc } from "./edgar-cf-wc";
import { needsOpIncomeStructure, withIncomeStatementStructure } from "./edgar-is-structure";
import { withOneOffCharges } from "./edgar-oneoff";
import { withCustomFacePretax, withFacePretax } from "./edgar-pretax";
import { withRenamedCfLines } from "./edgar-renamed-lines";
import { withBalanceSheetDebt } from "./edgar-bs-structure";
import { withCashFlowDa } from "./edgar-cf-structure";
import { withEquityStatementShares } from "./edgar-equity-shares";
import { loadUsCurrentShares, type CurrentShares } from "./current-shares";
import { fyEps, ltmEpsOf, ltmNetIncomeOf, netIncomeAnnualByYear, parentEquityOf } from "./edgar-pershare";
import { isFinancialCompany } from "./edgar-financial";
import { loadUsRevenue, revLtm, revQuarterAt, type RevCol, type UsRevenue } from "./fin-revenue";
import { loadClassAFactsMarked } from "./class-facts-loader";
import { dartAdrFinancials, dartAdrOf, dartAdrTtm } from "./dart-adr";
import type { ClassAFacts } from "./edgar-classfacts";
import { fetchFailureReason, type SourceFeature, type SourceUnavailableMap } from "./sec-unavailable";

const UA =
  process.env.SEC_USER_AGENT ??
  "global-market-research (personal use) contact@example.com";

const SEC_HEADERS = { "user-agent": UA, "accept-encoding": "gzip, deflate" };

function cik10(cik: number | string): string {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

// ---- ticker → CIK 매핑 (캐시) --------------------------------------------

interface TickerRow {
  cik_str: number;
  ticker: string;
  title: string;
}
let tickerMap: Map<string, TickerRow> | null = null;

async function loadTickerMap(): Promise<Map<string, TickerRow>> {
  if (tickerMap) return tickerMap;
  const data = await fetchJson<Record<string, TickerRow>>(
    "https://www.sec.gov/files/company_tickers.json",
    { headers: SEC_HEADERS, revalidate: 60 * 60 * 24 },
  );
  const map = new Map<string, TickerRow>();
  for (const row of Object.values(data)) map.set(row.ticker.toUpperCase(), row);
  tickerMap = map;
  return map;
}

/**
 * company_tickers.json 이 잘못된 엔티티로 매핑하는 티커 보정.
 * XOM: 신설 지주사 "ExxonMobil Holdings Corp"(2115436) → 영업회사 Exxon Mobil Corp(34088).
 * 과거 재무는 34088 에만 있다. 2026-07-01 재편 뒤 공시(2분기 10-Q~)는 XBRL 이 새 CIK
 * 로만 집계되지만 34088 공시 목록에도 공동 제출로 올라오므로 edgar-gapfill.ts 가
 * 인스턴스에서 채운다(없으면 LTM 이 03-31 에 멈춘다 — 2026-09-24 실측).
 */
const CIK_OVERRIDE: Record<string, number> = {
  XOM: 34088,
};

async function resolveCik(symbol: string): Promise<{ cik: string; row: TickerRow }> {
  const map = await loadTickerMap();
  const sym = symbol.toUpperCase();
  const row = map.get(sym);
  const override = CIK_OVERRIDE[sym];
  if (override != null)
    return {
      cik: cik10(override),
      row: row ?? { cik_str: override, ticker: sym, title: sym },
    };
  if (!row) throw new AdapterError(`EDGAR에서 티커를 찾을 수 없습니다: ${symbol}`, { status: 404 });
  return { cik: cik10(row.cik_str), row };
}

/** EDGAR 티커 목록 전체(대문자 티커 → 행). 유니버스 일괄 업로드가 정확 일치 판정에 쓴다 */
export async function getEdgarTickerMap(): Promise<
  ReadonlyMap<string, { ticker: string; title: string }>
> {
  return loadTickerMap();
}

/** 티커 또는 회사명으로 EDGAR 상장사 검색 */
export async function searchEdgarTickers(
  query: string,
): Promise<{ ticker: string; title: string }[]> {
  const map = await loadTickerMap();
  const q = query.trim().toUpperCase();
  if (!q) return [];
  const starts: { ticker: string; title: string }[] = [];
  const contains: { ticker: string; title: string }[] = [];
  for (const row of map.values()) {
    const ticker = row.ticker.toUpperCase();
    const title = row.title.toUpperCase();
    if (ticker === q || title.startsWith(q)) {
      starts.push({ ticker: row.ticker, title: row.title });
    } else if (ticker.startsWith(q) || title.includes(q)) {
      contains.push({ ticker: row.ticker, title: row.title });
    }
    if (starts.length >= 8) break;
  }
  return [...starts, ...contains].slice(0, 8);
}

// ---- submissions (프로필 + 공시) ----------------------------------------

interface SubmissionsResponse {
  cik: string;
  name: string;
  tickers: string[];
  exchanges: string[];
  sic: string;
  sicDescription: string;
  category: string;
  fiscalYearEnd: string;
  addresses?: { business?: Record<string, string> };
  website?: string;
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      form: string[];
      primaryDocument: string[];
      primaryDocDescription: string[];
    };
  };
}

async function getSubmissions(cik: string): Promise<SubmissionsResponse> {
  return fetchJson<SubmissionsResponse>(
    `https://data.sec.gov/submissions/CIK${cik}.json`,
    { headers: SEC_HEADERS, revalidate: 60 * 30 },
  );
}

// companyfacts 응답은 종종 2MB 초과 → Next fetch 캐시 불가.
// 프로세스 메모리에 짧게 캐시한다 (본격적으로는 배치→DB, prd.md §4.5).
const factsCache = new Map<string, { at: number; data: CompanyFacts; ttl: number }>();
const FACTS_TTL = 1000 * 60 * 60 * 6;
/**
 * 보완 단계(누락 공시·본표 구조 등)의 SEC 조회가 일시 오류로 실패한 결과는 짧게만 캐시한다 — 실패를 정상
 * 결과로 6시간 붙잡아 TSM FY2025 가 통째로 빠졌던 문제(SEC 429, 2026-09-25). 화면에는 fetchWarnings 로 경고.
 */
const FACTS_TTL_DEGRADED = 1000 * 60 * 2;
const FACTS_TTL_DEGRADED_MAX = 1000 * 60 * 60;
/** CIK 별 연속 불완전 조립 횟수 — 짧은 캐시 주기 확대용 */
const degradedStreak = new Map<string, number>();
// getStockOverview 는 getFinancials("annual")·getTtm 을 Promise.all 로 동시에
// 부르는데, 둘 다 같은 CIK 의 companyfacts 가 필요하다 — 캐시는 fetch 가 끝나야
// 채워지므로 둘 다 "미스"로 보고 SEC 에 같은 URL 을 중복 요청했다(실측 확인,
// 2026-09 — 유니버스 통합 뷰의 미국 종목 전원에 경고 배지가 뜬 원인. 새로고침이
// 종목당 20개 동시성으로 도는데, 이 중복까지 겹쳐 SEC 응답이 느려지거나
// 속도 제한에 걸려 15초 타임아웃을 넘기는 것으로 추정). in-flight Promise 를
// 공유해 같은 CIK 로 몰리는 동시 요청을 1건으로 합친다.
const factsInFlight = new Map<string, Promise<CompanyFacts>>();

async function getCompanyFacts(cik: string): Promise<CompanyFacts> {
  const hit = factsCache.get(cik);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.data;
  const inFlight = factsInFlight.get(cik);
  if (inFlight) return inFlight;
  const extraWarnings: string[] = [];
  // 이 조립에 쓰인 조회의 실패만 모은다(fetch-health.ts withFetchScope — 같은 CIK 의 다른 로더 실패는 섞이지 않음)
  const p = withFetchScope(() => fetchJson<CompanyFacts>(
    `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
    { headers: SEC_HEADERS, revalidate: false },
  )
    // 반올림 재태깅 제거 + 영업이익 단일 기준 합성(edgar-ev.ts) — 모든 소비 모듈이
    // 같은 정제본을 쓰게 로더에서 한 번만
    // companyfacts 누락 공시·복수 클래스 표지 주식수 보완(edgar-gapfill.ts) → 정제
    .then(async (raw) => {
      // **원본 조회 실패 = 공란 + 사유**(sec-unavailable.ts) — 본표 판독이 조회 실패(429·시간 초과·목록에 있는 파일의
      // 404 등)로 끝나면 그 판독 값은 옛 태그 규칙으로 대체하지 않고 공란으로 두도록 sourceUnavailable 에 적는다.
      // "원래 없음"(구조·파일 없음)은 각 판독기가 facts 그대로 돌려주므로 종전 규칙 그대로.
      const unavailable: SourceUnavailableMap = {};
      const step = async (feature: SourceFeature, prev: CompanyFacts, run: () => Promise<CompanyFacts>): Promise<CompanyFacts> => {
        try {
          return await run();
        } catch (e) {
          unavailable[feature] = { reason: fetchFailureReason(e) ?? `원본 판독 오류 · ${e instanceof Error ? e.message : String(e)}` };
          return prev;
        }
      };
      const subErr: { reason: string | null } = { reason: null };
      const sub = await getSubmissions(cik).catch((e) => {
        subErr.reason = fetchFailureReason(e) ?? "제출 목록 판독 오류";
        return null;
      });
      const recent = sub?.filings.recent ?? null;
      const sicN = sub?.sic ? Number(sub.sic) : null;
      // 제출 목록(submissions) 조회 실패 — 본표 판독을 하나도 못 하므로 판독이 필요한 값은 모두 공란(예전엔 전부 태그
      // 규칙으로 조용히 대체). 영업이익은 판독 대상 회사(영업이익 태그 없음·의심)만 — 나머지는 공시 태그 그대로
      if (subErr.reason) {
        const reason = `제출 목록 · ${subErr.reason}`;
        for (const f of ["debt", "da", "oneOff", "yearEndShares", "filings", "cover"] as const) unavailable[f] = { reason };
        if (needsOpIncomeStructure(raw.facts["us-gaap"] ?? {})) unavailable.opIncome = { reason };
      }
      const filled0 = await step("filings", raw, () => withFilingGapFill(cik, raw, recent));
      // 20-F 현금흐름표 — 옛 공시가 회사 고유 태그로 단 본표 줄을 최신 공시의 표준 개념으로(같은 라벨, TSM 2022 자기주식 취득 — edgar-renamed-lines.ts)
      const filled = await step("filings", filled0, () => withRenamedCfLines(cik, filled0, recent));
      // 외화·IFRS 공시(ASML·TSM·SPOT) → us-gaap·USD(edgar-foreign.ts, 연준 H.10). 환율 조회 실패 시 원본을 쓴다 —
      // 앱은 USD 단위만 읽으므로 원통화 숫자가 USD 로 섞이지 않고 빈칸이 된다.
      const normalized = await withForeignNormalization(filled).catch(() => {
        extraWarnings.push("외화 환산 환율(연준 H.10) 조회 실패 — 환산 값 비움");
        return filled;
      });
      // 콘텐츠 상각(NFLX 등 미디어) → 감가상각비에 포함(edgar-content.ts, 오너 결정 2026-09-24)
      const withContent = await step("da", normalized, () => withContentAmortization(cik, normalized, recent, sicN));
      // 총수익 안의 지분법·기타수익 분리(XOM — 영업이익 태그 없는 회사, edgar-revenue-dims.ts)
      // 세전이익 = 손익계산서 본표 소계(지분법 이익을 법인세 아래에 두는 AMD 형 — edgar-pretax.ts)
      const withPt0 = await step("opIncome", withContent, () => withFacePretax(cik, withContent, recent));
      // 본표 세전이익 소계가 회사 고유 태그(MCD·ORCL·MRVL 10-Q) — 공시 원본 값으로 표준 세전이익 기간을 채움(edgar-pretax.ts)
      const withPt = await step("opIncome", withPt0, () => withCustomFacePretax(cik, withPt0, recent));
      const withDims = await step("opIncome", withPt, () => withRevenueDims(cik, withPt, recent));
      // 영업이익 소계가 없는 손익계산서 — 계산 구조로 영업외 항목 분리(DIS·FOXA, edgar-is-structure.ts)
      const withIs = await step("opIncome", withDims, () => withIncomeStatementStructure(cik, withDims, recent, sicN));
      // 손익계산서 별도 줄로 공시된 일회성비용(주석 행, edgar-oneoff.ts)
      const withOneOff = await step("oneOff", withIs, () => withOneOffCharges(cik, withIs, recent));
      // 총차입금 = 대차대조표 본표 차입금 줄(edgar-bs-structure.ts)
      const withDebt = await step("debt", withOneOff, () => withBalanceSheetDebt(cik, withOneOff, recent));
      // 감가상각비 = 현금흐름표 본표 감가상각·상각 줄(edgar-cf-structure.ts). 콘텐츠 상각 판독이 실패했으면(NFLX) 본표 줄로
      // 대신하지 않는다 — 콘텐츠 상각이 빠진 값이 된다
      const withDa = unavailable.da ? withDebt : await step("da", withDebt, () => withCashFlowDa(cik, withDebt, recent));
      // 운전자본 변동 합계 = 현금흐름표 본표 운전자본 줄 합(edgar-cf-wc.ts — 분기 요약형 공시 회사의 LTM 운전자본)
      const withWc = await step("da", withDa, () => withCashFlowWc(cik, withDa, recent));
      // 연말 유통주식수가 자본변동표 차원으로만 있는 회사(WMT·BE·META, edgar-equity-shares.ts)
      const withShares = await step("yearEndShares", withWc, () => withEquityStatementShares(cik, withWc, recent));
      // 20-F 발행사(분기 XBRL 없음) — LTM 열을 Yahoo 분기(원통화) 최근 4개 분기로(edgar-yahoo-quarters.ts, 오너 결정
      // 2026-09-25). 조회 실패 시 SEC 사업연도 유지 + 경고(짧은 캐시), 다른 원천으로 대체하지 않는다.
      let withLtm = withShares;
      const latestPeriodic = recent?.form.find((f) => /^(10-[QK]|20-F|40-F)(\/A)?$/.test(f)) ?? null;
      const ticker = sub?.tickers?.[0] ?? null;
      if (latestPeriodic && /^20-F/.test(latestPeriodic) && ticker) {
        const cur = withShares.reportingCurrency ?? "USD";
        const [yq, fx] = await Promise.all([
          fetchYahooFundamentals(ticker).catch(() => null),
          fxToUsd(cur).catch(() => null),
        ]);
        if (yq && fx) {
          // 회사 6-K 분기 재무제표(연결재무보고서 HTML) — 야후 정의가 SEC 와 다른 항목을 회사 줄로(edgar-6k.ts). 없거나 못 읽으면 null(야후 경로 그대로)
          const per = yahooLtmPeriods(withShares, yq);
          const sixK = per ? await sixKStatements(cik, recent, per.last, per.E, per.yearAgo).catch(() => null) : null;
          // 이번 보고서에 1년 전 분기말 열이 없으면(SPOT) 1년 전 같은 분기 6-K — 평균 잔액(ROIC 등)의 기초 값
          const shift12 = (d: string) => { const x = new Date(`${d}T00:00:00Z`); return new Date(Date.UTC(x.getUTCFullYear() - 1, x.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); };
          const sixKPrev = per && sixK && !sixK.bsDates.includes(per.yearAgo)
            ? await sixKStatements(cik, recent, per.yearAgo, shift12(per.E), shift12(per.yearAgo)).catch(() => null)
            : null;
          const r = withYahooLtm(withShares, yq, fx, cur, sixK, sixKPrev);
          withLtm = { ...r.facts, ltmQuarterSource: r.result };
        } else if (!fx) {
          // H.10 조회 실패 — 사업연도 값을 LTM 으로 대체하지 않고 LTM 열 공란(미고시와 같은 처리)
          extraWarnings.push("연준 H.10 환율 조회 실패(LTM 최신 분기)");
          const r = blankYahooLtm(withShares, "연준 H.10 공식 환율 조회 실패");
          withLtm = { ...r.facts, ltmQuarterSource: r.result };
        } else {
          // Yahoo 분기 조회 실패 — 사업연도 뒤 분기가 있는지 알 수 없으니 사업연도 값을 LTM 으로 쓰지 않고 공란(그림자 채우기 금지)
          extraWarnings.push("Yahoo 분기 조회 실패(LTM 최신 분기)");
          const r = blankYahooLtm(withShares, "Yahoo 분기 조회 실패");
          withLtm = { ...r.facts, ltmQuarterSource: r.result };
        }
      }
      return { withLtm, sicN, unavailable };
    }))
    .then(({ result: { withLtm, sicN, unavailable }, failures }) => {
      // 판독기가 일부 날짜만 실패로 적은 것(withLtm.sourceUnavailable)과 판독 전체 실패(unavailable)를 합친다
      const sourceUnavailable: SourceUnavailableMap = { ...withLtm.sourceUnavailable, ...unavailable };
      // 판독 실패 사유도 경고에 싣는다 — 404 처럼 일시 오류로 기록되지 않는 실패도 짧은 캐시가 되게(화면의 공란 주석은
      // 각 화면 모듈이 unavailableNote 로)
      const warnings = [
        ...new Set([...failures, ...extraWarnings, ...Object.values(sourceUnavailable).map((u) => u!.reason)]),
      ];
      const data = withOpIncome(dropRoundedRetags({
        ...withLtm,
        financialSector: sicN != null && sicN >= 6000 && sicN <= 6499,
        sourceUnavailable: Object.keys(sourceUnavailable).length ? sourceUnavailable : undefined,
        ...(warnings.length ? { fetchWarnings: warnings } : {}),
      }));
      // 현금흐름표 개념(감가상각비 제외)은 회사 재분류 1분기 규칙 대상 밖 — 배열 표시(edgar-series.ts markNoRecast)
      markNoRecast(data);
      // 불완전한 결과가 연달아 나오면(늘 실패하는 원본) 짧은 캐시를 2분·4분·8분 …(최대 1시간)으로 늘린다
      const streak = warnings.length ? (degradedStreak.get(cik) ?? 0) + 1 : 0;
      if (streak) degradedStreak.set(cik, streak);
      else degradedStreak.delete(cik);
      const ttl = streak ? Math.min(FACTS_TTL_DEGRADED * 2 ** (streak - 1), FACTS_TTL_DEGRADED_MAX) : FACTS_TTL;
      factsCache.set(cik, { at: Date.now(), data, ttl });
      return data;
    })
    .finally(() => {
      factsInFlight.delete(cik);
    });
  factsInFlight.set(cik, p);
  return p;
}

/** 하이라이트/외부 계산용 raw companyfacts (+ CIK). */
export async function fetchUsCompanyFacts(
  symbol: string,
  opts: { revenue?: boolean } = {},
): Promise<{ cik: string; facts: CompanyFacts }> {
  const { cik } = await resolveCik(symbol);
  return { cik, facts: await getSymbolFacts(cik, symbol, opts) };
}

/**
 * 종목 단위 companyfacts — CIK 캐시본에 현재 주식수 보정값(current-shares.ts)을 얹는다.
 * 주식수 해석(edgar-shares.ts)을 쓰는 모든 경로가 이 함수를 거쳐야 화면끼리 같은
 * 시가총액이 나온다. 캐시본은 CIK 단위라 복사본에 붙인다(GOOG·GOOGL 공유).
 */
async function getSymbolFacts(cik: string, symbol: string, opts: { revenue?: boolean } = {}): Promise<CompanyFacts> {
  const [facts, currentShares, revenue] = await Promise.all([
    getCompanyFacts(cik),
    loadUsCurrentShares(symbol).catch(() => null),
    // 매출 = 재무 5층 구조(src/lib/fin) 매출 지표(fin-revenue.ts). 매출을 안 쓰는 경로는 건너뛴다
    opts.revenue === false ? Promise.resolve(null) : loadUsRevenue(symbol),
  ]);
  // 20-F ADR(TSM 1:5) — 주식수·주당 값을 ADR 1주 기준으로(edgar-foreign.ts toAdrBasis)
  const adr = toAdrBasis(facts, currentShares?.val);
  return { ...adr.facts, currentShares, revenue };
}

/** SIC 코드 (은행·카드사 등 금융회사 레이아웃 분기 판정용). */
export async function fetchUsSic(symbol: string): Promise<string | null> {
  const { cik } = await resolveCik(symbol);
  const sub = await getSubmissions(cik);
  return sub.sic ?? null;
}

// ---- companyfacts (재무제표) -------------------------------------------

export interface FactUnitEntry {
  start?: string;
  end: string;
  val: number;
  fy: number;
  fp: string; // "FY" | "Q1".."Q4"
  form: string; // "10-K" | "10-Q" | ...
  frame?: string;
  /** 공시(제출)일 YYYY-MM-DD. 같은 기간의 재작성(액면분할 소급 등)은 최신 filed 우선. */
  filed?: string;
  /**
   * 외화 공시만 — 이 기간을 분기별 평균 환율로 환산해 더한 USD 값(edgar-foreign.ts quarterSummer).
   * LTM 조합 전용(edgar-series.ttmCombine). 표시·연간 값은 val(기간 평균 환율).
   */
  ltmQ?: number;
  /** 20-F Yahoo 분기 LTM 에서 채우지 못한 항목의 최근 FY(edgar-yahoo-quarters.ts) — LTM 공란 */
  ltmNone?: boolean;
  /** 20-F LTM 항목의 출처(edgar-yahoo-quarters LtmSrc) — verify-row 가 나열하고 검증기가 다시 계산한다 */
  ltmSrc?: { via: string } & Record<string, unknown>;
  /**
   * 합성 영업이익(edgar-ev.ts opIncomeEntries)의 산식 — "pretax" = 세전이익 그대로(이자비용 태그 없음), "ebit" = 세전이익 +
   * 이자비용 (− 지분법), "structure" = 손익계산서 계산 구조로 영업외 항목 차감, "fin" = 금융업 세전이익. 화면 라벨용(G6)
   */
  synBasis?: "pretax" | "ebit" | "structure" | "fin";
  /** 감가상각비 본표 판독값(edgar-cf-structure.ts SYN_DA_CF)의 판독 구조 식별자(그 값을 낸 공시 접수번호) — 파생 열 기준 혼합 판정 */
  basis?: string;
}
export interface CompanyFacts {
  entityName: string;
  /** 보완 단계의 원본 조회 일시 오류(SEC 429·시간 초과 등, fetch-health.ts) — 있으면 결과가 불완전할 수 있다 */
  fetchWarnings?: string[];
  /** 본표 판독이 원본 조회 실패로 빠진 값 — 소비 모듈은 대체 계산 없이 공란 + 사유(sec-unavailable.ts) */
  sourceUnavailable?: SourceUnavailableMap;
  /** 20-F 발행사 LTM 열(Yahoo 분기, edgar-yahoo-quarters.ts) 결과 — 화면 출처 표기·LTM 잔액 기준일 */
  ltmQuarterSource?: YahooLtmResult;
  /** 현재 주식수 보정값(인포맥스 → Yahoo) — 종목 단위 로더만 채운다 */
  currentShares?: CurrentShares | null;
  /** 공시 통화(외화 공시면 USD 로 환산됨 — edgar-foreign.ts) */
  reportingCurrency?: string;
  /** 외화 환산에서 H.10 공식 환율 미고시로 비운 값이 있으면 사유(edgar-foreign.ts) — 화면 주석 */
  fxPending?: string;
  /** IFRS 개념을 us-gaap 으로 매핑했는지 */
  ifrsMapped?: boolean;
  /** ADR 1주 = 보통주 몇 주(1 이면 1:1) */
  adrRatio?: number;
  /** 감가상각비에 콘텐츠 상각을 포함했는지(edgar-content.ts) */
  contentAmortization?: boolean;
  /** 감가상각 줄 기준이 서로 다른 판독 구조 쌍("접수번호A|접수번호B", 정렬) — 두 구조의 값을 빼서 만든 열(누적 차·Q4·LTM)은 공란(edgar-cf-structure.ts) */
  daBasisMix?: string[];
  /** 총수익에서 지분법·기타수익을 분리했는지(edgar-revenue-dims.ts) */
  nonopInRevenues?: boolean;
  /** 은행·증권·보험(SIC 6000~6499) — 이자가 본업이라 영업이익 근사에 이자를 더하지 않는다. 리츠·부동산(65xx·67xx)은
   *  아니다 — 이자가 조달비용이라 빼면 EBITDA 가 줄고 EV/EBITDA 가 부푼다(재감사 2026-09-24: VTR −28%) */
  financialSector?: boolean;
  /** 손익계산서 계산 구조로 영업외 항목을 분리했는지(edgar-is-structure.ts) */
  opIncomeFromStructure?: boolean;
  /** 영업이익 태그가 부문 주석에만 있어 쓰지 않았는지(DIS) */
  segmentOpIncomeOnly?: boolean;
  /**
   * 매출 — 재무 5층 구조(src/lib/fin)의 매출 지표(fin-revenue.ts). 종목 단위 로더만 채운다. 화면 모듈은 매출을
   * 이 값에서만 읽는다(매출 태그 직접 사용 금지). null = 조립 실패(빈칸).
   */
  revenue?: UsRevenue | null;
  facts: {
    "us-gaap"?: Record<
      string,
      { label?: string; description?: string; units: Record<string, FactUnitEntry[]> }
    >;
    dei?: Record<
      string,
      { label?: string; description?: string; units: Record<string, FactUnitEntry[]> }
    >;
  };
}

/**
 * companyfacts 에서 개념 후보들의 unit 배열을 전부 합친다.
 *
 * 예전엔 "먼저 존재하는 개념 하나만" 썼는데, 기업이 도중에 개념 태그를
 * 갈아탄 경우(실측, 2026-09-23 — Bloom Energy: `NetIncomeLoss`를 2023년
 * 사업연도까지만 쓰고 2024년부터 `ProfitLoss`로 전환) 먼저 나열된 개념이
 * 이후 연도엔 데이터가 없어도 "존재는 한다"는 이유로 그 개념만 쓰고
 * 최신 연도로 못 넘어갔다 — 개요 탭 TTM 순이익이 2023년 값(-3.02억 달러)
 * 에 고정되고, 그 값으로 계산되는 TTM EPS도 같이 틀어졌다(당기순이익은
 * 실제로 +996만 달러 흑자). ttmFlow() 자신이 이미 "가장 최근 end" 기준
 * 으로 연간·YTD를 고르므로, 여기서는 후보 개념 전부의 항목을 하나로
 * 합쳐 넘기기만 하면 어느 개념으로 갈아탔든 최신 데이터를 제대로 고른다.
 */
function factEntries(
  facts: CompanyFacts,
  ns: "us-gaap" | "dei",
  names: string[],
  units: string[],
): FactEntry[] | undefined {
  const bag = facts.facts[ns];
  if (!bag) return undefined;
  let merged: FactEntry[] | undefined;
  for (const n of names) {
    const node = bag[n];
    if (!node) continue;
    for (const u of units) {
      const entries = node.units[u] as FactEntry[] | undefined;
      if (entries?.length) merged = merged ? [...merged, ...entries] : entries;
    }
  }
  return merged;
}

/**
 * TTM 흐름 + 최근분기 재무상태표 스냅샷 + D&A + 주당배당금 (EDGAR companyfacts).
 * prd.md §4.1 — 공식 무료 API, 라이선스 무관.
 *
 * **그림자 채우기 금지(오너 규칙 2026-09-27)**: 각 값은 정의 그대로의 값만 — 없으면 null 과 사유(reasons). 예전엔 자기자본·
 * 부채·현금·주식수를 550일 안의 "가장 최근" 태그 값(서로 다른 기준일)과 자산 − 부채 파생으로 채웠다.
 */
function buildUsTtm(
  facts: CompanyFacts,
  evCtx: EvContext & { classFacts?: ClassAFacts | null } = {},
): TtmFlows {
  const anchor = ltmAnchor(facts);
  const reasons: NonNullable<TtmFlows["reasons"]> = {};
  const eps = ttmFlow(
    factEntries(facts, "us-gaap", ["EarningsPerShareDiluted", "EarningsPerShareBasic"], [
      "USD/shares",
    ]),
    anchor,
  );
  // 매출 LTM = 재무 5층 구조 매출 지표(fin-revenue.ts) — 하이라이트·손익계산서·재무분석과 같은 값
  const revenueLtm = revLtm(facts.revenue);
  if (revenueLtm == null) reasons.revenue = facts.revenue?.ltm ? "LTM 매출 조립 불완전(fin)" : "LTM 매출 없음(fin)";
  // 영업이익 LTM — 재무 5층 구조 영업이익 지표(edgar-ev.ts opIncomeLtm — fin LTM 열, 금융사만 옛 시계열). 하이라이트·재무분석·
  // 손익계산서와 같은 값. 빈칸은 fin 사유 그대로(옛 합성 시계열로 채우지 않음)
  const opL = opIncomeLtm(facts);
  const opIncome = { ttm: opL.value, ttmLabel: ttmFlow(factEntries(facts, "us-gaap", [SYN_OP_INCOME], ["USD"]), anchor).ttmLabel };
  if (opIncome.ttm == null) reasons.opIncome = opL.reason ?? "LTM 영업이익 없음";
  // 감가상각비 — edgar-ev.ts 단일 규칙(하이라이트·분석 지표와 동일).
  const daByYear = daAnnualByYear(facts);
  const daLatestYear = [...daByYear.keys()].sort((a, b) => b - a)[0];
  const da = {
    annual: daLatestYear != null ? (daByYear.get(daLatestYear) ?? null) : null,
    ttm: daTtm(facts),
  };
  if (da.ttm == null) reasons.daTtm = daTtmCell(facts).reason ?? "LTM 감가상각비 구성 분기 없음";
  const dps = ttmFlow(
    factEntries(facts, "us-gaap", ["CommonStockDividendsPerShareDeclared"], ["USD/shares"]),
    anchor,
  );
  if (dps.ttm == null && dps.reason) reasons.dpsTtm = dps.reason;

  // 20-F Yahoo 분기 LTM — 잔액은 그 기준일(최신 분기말) 값만. 채우지 못한 잔액(FY말 값)은 섞지 않고 비운다
  const yl = yahooLtm(facts);
  // EV 브릿지 — 하이라이트 LTM 열과 같은 모듈·같은 기준일(자산총계 최근일).
  const evRes = buildEvResolver(facts, evCtx);
  const evDate = yl ? yl.through : evRes.latestBalanceDate();
  const balOn = (c: string) => (evDate ? instantOn(entriesOf(facts, c), evDate) : null);
  const evBridge0 = evDate ? evRes.bridgeAt(evDate) : null;
  // Yahoo 분기 LTM: EV 구성요소가 전부 같은 기준일이어야 한다(아니면 비움 — edgar-yahoo-quarters.ts evComplete)
  const evBridge = evBridge0 && yl && (!yl.evComplete || evBridge0.balanceDate !== yl.through) ? null : evBridge0;
  const evBlocker = evDate ? evRes.blocker(evDate) : null;
  if (!evBridge && !evBlocker)
    reasons.evNetDebt = !evDate
      ? "재무상태표 없음"
      : evBridge0 && yl
        ? (yl.evReason ?? "Yahoo 분기 EV 구성요소 불완전")
        : (evRes.bridgeReason(evDate) ?? "EV 구성요소 없음");
  // 개요 멀티플이 하이라이트 LTM 열과 같은 값을 내도록 주식수·순이익·자기자본을
  // 공통 기준으로(edgar-shares·edgar-pershare) — 검증 체계 2층에서 PER·PBR 불일치 발견.
  const shareRes = buildShareResolver(facts, { classFacts: evCtx.classFacts ?? null });
  const evShares = shareRes.current();
  const shareNote = shareRes.currentNote();
  if (shareNote) reasons.evShares = shareNote;
  const ni = ltmNetIncomeOf(facts);
  if (ni.value == null) reasons.netIncome = ni.reason ?? "LTM 순이익 없음";
  const le = ltmEpsOf(facts, evShares);
  if (le.value == null) reasons.eps = le.reason ?? "LTM EPS 없음";
  const eq = evDate ? parentEquityOf(facts, evDate) : { value: null, reason: "재무상태표 없음" };
  if (eq.value == null) reasons.equity = eq.reason ?? "자기자본 없음";
  // 최근 사업연도 희석 EPS — 하이라이트·재무분석과 같은 규칙(ADR 은 ADR 1주 기준 facts)
  const niByYear = netIncomeAnnualByYear(facts);
  const lastFyE = [...(facts.revenue?.annual ?? [])].reverse().find((c) => c.end);
  const lastFy = lastFyE?.fy ?? ([...niByYear.keys()].sort((a, b) => b - a)[0] ?? null);
  const fe = lastFy != null
    ? fyEps(facts, lastFy, {
        classFacts: evCtx.classFacts ?? null,
        fyShares: lastFyE ? shareRes.atFiscalYearEnd(lastFy, lastFyE.end) : null,
        fyNetIncome: niByYear.get(lastFy) ?? null,
      })
    : null;
  if (fe && fe.note) reasons.fyEps = fe.note;

  return {
    // 20-F Yahoo 분기 LTM 이면 그 기간으로 표기(EPS 태그는 보강 대상 아님 — LTM EPS 는 순이익 ÷ 주식수)
    periodLabel: yl
      ? `최근 4개 분기(~${yl.through}) · Yahoo 분기(원통화 ${yl.currency}, 분기 평균 환율 환산)`
      : eps.ttmLabel || opIncome.ttmLabel || "",
    netIncome: ni.value,
    revenue: revenueLtm,
    opIncome: opIncome.ttm,
    eps: le.value,
    reasons,
    fyEps: fe ? { eps: fe.eps, year: lastFy, note: fe.note } : null,
    snapshot: {
      label: evDate ?? "",
      equity: eq.value,
      // 부채총계·현금 — 같은 기준일(evDate) 값만(표시·감사용, 미국 EV 는 evNetDebt)
      liabilities: balOn("Liabilities"),
      cash: balOn("CashAndCashEquivalentsAtCarryingValue"),
      shares: evShares,
      evNetDebt: evBridge ? evBridge.debt + evBridge.preferred + evBridge.nci - evBridge.cash : null,
      evBlocker,
      evShares,
      evOpNciBook: evBridge?.opUnitNciBook ?? null,
      isReit: evCtx.sic === "6798",
      is20F: /^20-F/.test(
        (facts.facts.dei?.["EntityCommonStockSharesOutstanding"]?.units?.shares ?? []).reduce<
          FactUnitEntry | null
        >((b, e) => (!b || e.end > b.end ? e : b), null)?.form ?? "",
      ),
    },
    daAnnual: da.annual,
    daTtm: da.ttm,
    dpsAnnual:
      dps.annual != null ? { dps: dps.annual, label: dps.annualLabel } : null,
    dpsTtm:
      dps.ttm != null && dps.from && dps.to
        ? { dps: dps.ttm, from: dps.from, to: dps.to }
        : null,
  };
}

/** getTtm 실패 — 값 전부 null + 사유(조용히 null 을 돌려주면 화면이 다른 원천으로 채웠다) */
function failedTtm(reason: string): TtmFlows {
  return { periodLabel: "", error: reason, netIncome: null, revenue: null, opIncome: null, eps: null, snapshot: null };
}

/**
 * 표시할 us-gaap 계정. 원본 XBRL 개념을 그대로 쓰되, 사람이 읽는 라벨과
 * 강조/소계 플래그, 섹션 분류를 붙인다 (prd.md §6).
 */
interface ConceptSpec {
  concept: string;
  label: string;
  section: "손익계산서" | "재무상태표" | "현금흐름표";
  depth: number;
  isSubtotal: boolean;
  isHighlight: boolean;
}

const CONCEPTS: ConceptSpec[] = [
  // 손익계산서
  // 매출·매출원가·매출총이익·연구개발비·판관비 행은 태그가 아니라 재무 5층 구조 지표(fin-revenue.ts)로 따로 채운다(getFinancials) — FIN_IS_ROWS
  { concept: "OperatingIncomeLoss", label: "Operating Income", section: "손익계산서", depth: 0, isSubtotal: true, isHighlight: true },
  { concept: "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", label: "Pretax Income", section: "손익계산서", depth: 0, isSubtotal: true, isHighlight: false },
  { concept: "IncomeTaxExpenseBenefit", label: "Income Tax Expense", section: "손익계산서", depth: 1, isSubtotal: false, isHighlight: false },
  { concept: "NetIncomeLoss", label: "Net Income", section: "손익계산서", depth: 0, isSubtotal: true, isHighlight: true },
  { concept: "ProfitLoss", label: "Net Income (incl. NCI)", section: "손익계산서", depth: 0, isSubtotal: true, isHighlight: false },
  { concept: "EarningsPerShareBasic", label: "EPS (Basic)", section: "손익계산서", depth: 1, isSubtotal: false, isHighlight: false },
  { concept: "EarningsPerShareDiluted", label: "EPS (Diluted)", section: "손익계산서", depth: 1, isSubtotal: false, isHighlight: true },
  // 재무상태표
  { concept: "CashAndCashEquivalentsAtCarryingValue", label: "Cash & Equivalents", section: "재무상태표", depth: 1, isSubtotal: false, isHighlight: false },
  { concept: "AssetsCurrent", label: "Current Assets", section: "재무상태표", depth: 0, isSubtotal: true, isHighlight: false },
  { concept: "Assets", label: "Total Assets", section: "재무상태표", depth: 0, isSubtotal: true, isHighlight: true },
  { concept: "LiabilitiesCurrent", label: "Current Liabilities", section: "재무상태표", depth: 0, isSubtotal: true, isHighlight: false },
  { concept: "Liabilities", label: "Total Liabilities", section: "재무상태표", depth: 0, isSubtotal: true, isHighlight: true },
  { concept: "StockholdersEquity", label: "Stockholders' Equity", section: "재무상태표", depth: 0, isSubtotal: true, isHighlight: true },
  { concept: "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", label: "Stockholders' Equity (incl. NCI)", section: "재무상태표", depth: 0, isSubtotal: true, isHighlight: false },
  { concept: "LongTermDebtNoncurrent", label: "Long-term Debt", section: "재무상태표", depth: 1, isSubtotal: false, isHighlight: false },
  // 현금흐름표
  { concept: "NetCashProvidedByUsedInOperatingActivities", label: "Operating Cash Flow", section: "현금흐름표", depth: 0, isSubtotal: true, isHighlight: true },
  { concept: "NetCashProvidedByUsedInInvestingActivities", label: "Investing Cash Flow", section: "현금흐름표", depth: 0, isSubtotal: true, isHighlight: false },
  { concept: "NetCashProvidedByUsedInFinancingActivities", label: "Financing Cash Flow", section: "현금흐름표", depth: 0, isSubtotal: true, isHighlight: false },
  { concept: "PaymentsToAcquirePropertyPlantAndEquipment", label: "CapEx", section: "현금흐름표", depth: 1, isSubtotal: false, isHighlight: false },
];

/** getFinancials 의 매출 행 id — 멀티플·컨센서스가 이 id 로 찾는다 */
export const REVENUE_ROW_ID = "fin:revenue";
/** getFinancials 의 매출원가·매출총이익 행 id(fin cogs·gp 지표, docs/metrics/cogs.md) — 멀티플이 이 id 로 찾는다 */
export const COGS_ROW_ID = "fin:cogs";
export const GROSS_PROFIT_ROW_ID = "fin:grossProfit";

/** getFinancials 의 연구개발비·판관비 행 id(fin rnd·sga 지표, docs/metrics/sga.md) */
export const RND_ROW_ID = "fin:rnd";
export const SGA_ROW_ID = "fin:sga";

/** fin 지표 행(매출·매출원가·매출총이익·연구개발비·판관비) — 태그가 아니라 fin-revenue.ts 열 값 */
const FIN_IS_ROWS: { id: string; label: string; pick: "v" | "cogs" | "gp" | "rnd" | "sga"; depth: number; isSubtotal: boolean; isHighlight: boolean }[] = [
  { id: REVENUE_ROW_ID, label: "Revenue", pick: "v", depth: 0, isSubtotal: false, isHighlight: true },
  { id: COGS_ROW_ID, label: "Cost of Revenue", pick: "cogs", depth: 1, isSubtotal: false, isHighlight: false },
  { id: GROSS_PROFIT_ROW_ID, label: "Gross Profit", pick: "gp", depth: 0, isSubtotal: true, isHighlight: false },
  { id: RND_ROW_ID, label: "R&D Expense", pick: "rnd", depth: 1, isSubtotal: false, isHighlight: false },
  { id: SGA_ROW_ID, label: "SG&A Expense", pick: "sga", depth: 1, isSubtotal: false, isHighlight: false },
];

function periodKey(e: FactUnitEntry): string {
  // 연간은 종료 연도로 키를 잡는다 → 최신 10-K 의 재작성된 비교연도(액면분할 소급 등)를
  // 원 공시값 대신 채택할 수 있다. (e.fy 는 "공시" 회계연도라 비교연도 값이 엉뚱한 키로 감)
  return e.fp === "FY" ? `FY${fiscalYearOf(e.end)}` : `${e.fy} ${e.fp}`;
}

function pickEntries(
  entries: FactUnitEntry[],
  periodType: FinancialPeriodType,
): Map<string, FactUnitEntry> {
  const wanted = periodType === "annual" ? ["10-K", "10-K/A", "20-F"] : ["10-Q", "10-Q/A"];
  const byPeriod = new Map<string, FactUnitEntry>();
  for (const e of entries) {
    if (periodType === "annual" && e.fp !== "FY") continue;
    if (periodType === "quarter" && e.fp === "FY") continue;
    if (!wanted.includes(e.form)) continue;
    // 90일 분기에도 fp="FY" 를 붙이는 기업(NVIDIA) → 연간은 duration 으로 거른다
    if (periodType === "annual" && e.start) {
      const dur = Math.round((Date.parse(e.end) - Date.parse(e.start)) / 86_400_000);
      if (dur < 300 || dur > 400) continue;
    }
    const key = periodKey(e);
    // 같은 기간 중복이면 최신 end, 동률이면 최신 공시(액면분할 소급 재작성) 우선
    const prev = byPeriod.get(key);
    if (
      !prev ||
      e.end > prev.end ||
      (e.end === prev.end && (e.filed ?? "") >= (prev.filed ?? ""))
    )
      byPeriod.set(key, e);
  }
  return byPeriod;
}

// ---- 어댑터 ------------------------------------------------------------

export const usEdgarAdapter: MarketAdapter = {
  market: "us",
  currency: "USD",

  isConfigured() {
    return true; // 키 불필요
  },
  configHint() {
    return "SEC EDGAR는 API 키가 필요 없습니다. (SEC_USER_AGENT 환경변수로 User-Agent를 지정하는 것을 권장)";
  },

  normalizeSymbol(input) {
    return input.trim().toUpperCase();
  },

  async getCompanyProfile(symbol): Promise<CompanyProfile> {
    const { cik, row } = await resolveCik(symbol);
    const sub = await getSubmissions(cik);
    const biz = sub.addresses?.business;
    const address = biz
      ? [biz.street1, biz.street2, biz.city, biz.stateOrCountry, biz.zipCode].filter(Boolean).join(", ")
      : undefined;
    return {
      symbol: this.normalizeSymbol(symbol),
      market: "us",
      name: sub.name || row.title,
      identifiers: { CIK: cik, ticker: symbol.toUpperCase(), SIC: sub.sic ?? "" },
      industry: sub.sicDescription,
      homepage: sub.website,
      address,
      source: "SEC EDGAR",
      sourceUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=&dateb=&owner=include&count=40`,
    };
  },

  async getFinancials(symbol, periodType): Promise<FinancialStatement> {
    // SEC XBRL 이 없는 ADR(SKHY) — 본국 DART 재무를 USD·ADR 기준으로(dart-adr.ts)
    const dartAdr = dartAdrOf(symbol);
    if (dartAdr) return dartAdrFinancials(dartAdr, periodType);
    const { cik } = await resolveCik(symbol);
    const [facts, revenue] = await Promise.all([getCompanyFacts(cik), loadUsRevenue(symbol)]);
    const gaap = facts.facts["us-gaap"] ?? {};

    // 1) 모든 컨셉에서 기간 집합 수집
    const periodEntries = new Map<string, Map<string, FactUnitEntry>>(); // concept -> period -> entry
    const periodMeta = new Map<string, FinancialPeriod>();

    for (const spec of CONCEPTS) {
      const node = gaap[spec.concept];
      if (!node) continue;
      const usd = node.units["USD"] ?? node.units["USD/shares"] ?? node.units["shares"];
      if (!usd) continue;
      const picked = pickEntries(usd, periodType);
      periodEntries.set(spec.concept, picked);
      for (const [key, e] of picked) {
        if (!periodMeta.has(key)) {
          periodMeta.set(key, {
            label: key,
            fiscalYear: e.fp === "FY" ? fiscalYearOf(e.end) : e.fy,
            fiscalQuarter: e.fp === "FY" ? null : Number(e.fp.replace("Q", "")),
            endDate: e.end,
          });
        }
      }
    }

    // 매출·매출원가·매출총이익 = 재무 5층 구조 지표(fin-revenue.ts). 연간 열은 사업연도 키(FY{연도})로, 분기 열은 결산일(±6일)로 맞춘다
    const finByKey = new Map<string, RevCol>();
    if (periodType === "annual")
      for (const c of revenue?.annual ?? []) {
        const key = `FY${c.fy}`;
        finByKey.set(key, c);
        if (!periodMeta.has(key) && c.v != null)
          periodMeta.set(key, { label: key, fiscalYear: c.fy, fiscalQuarter: null, endDate: c.end });
      }
    else
      for (const [key, meta] of periodMeta) {
        const q = meta.endDate ? revQuarterAt(revenue, meta.endDate) : null;
        if (q) finByKey.set(key, q);
      }

    // 2) 최근 기간 우선, 최대 5개 (개요·재무 하이라이트와 동일)
    const periods = [...periodMeta.values()]
      .sort((a, b) => (b.endDate ?? "").localeCompare(a.endDate ?? ""))
      .slice(0, 5);
    const periodLabels = periods.map((p) => p.label);

    // 액면분할 보정: 소급 재작성 안 된 과거 연도의 주당 지표를 최신 연도 기준으로 환산
    const splitF =
      periodType === "annual" ? splitFactorsByYear(facts) : new Map<number, number>();
    const yearByLabel = new Map(periodLabels.map((l) => [l, periodMeta.get(l)?.fiscalYear ?? 0]));

    // 3) 섹션별 라인 구성
    const sectionsOrder = ["손익계산서", "재무상태표", "현금흐름표"] as const;
    const sections = sectionsOrder.map((title) => {
      const items: FinancialLineItem[] = [];
      if (title === "손익계산서")
        for (const r of FIN_IS_ROWS) {
          const values = Object.fromEntries(periodLabels.map((l) => [l, finByKey.get(l)?.[r.pick] ?? null]));
          if (periodLabels.some((l) => values[l] != null))
            items.push({ accountName: r.label, accountId: r.id, depth: r.depth, isSubtotal: r.isSubtotal, isHighlight: r.isHighlight, values });
        }
      for (const spec of CONCEPTS) {
        if (spec.section !== title) continue;
        const picked = periodEntries.get(spec.concept);
        if (!picked || picked.size === 0) continue;
        const isPerShare = /EarningsPerShare/.test(spec.concept);
        const values: Record<string, number | null> = {};
        let hasAny = false;
        for (const label of periodLabels) {
          const e = picked.get(label);
          const f = isPerShare ? (splitF.get(yearByLabel.get(label) ?? 0) ?? 1) : 1;
          values[label] = e ? e.val * f : null;
          if (e) hasAny = true;
        }
        if (!hasAny) continue;
        items.push({
          accountName: spec.label,
          accountId: spec.concept,
          depth: spec.depth,
          isSubtotal: spec.isSubtotal,
          isHighlight: spec.isHighlight,
          values,
        });
      }
      return { title, items };
    }).filter((s) => s.items.length > 0);

    return {
      symbol: this.normalizeSymbol(symbol),
      market: "us",
      periodType,
      unit: "USD",
      currency: "USD",
      consolidation: "consolidated",
      periods,
      sections,
      source: "SEC EDGAR (XBRL companyfacts)",
      sourceUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=10-K`,
    };
  },

  async getTtm(symbol): Promise<TtmFlows | null> {
    // 실패를 삼키지 않는다 — 사유를 싣고 모든 값 null(그림자 채우기 금지, 2026-09-27). 화면은 멀티플을 계산하지 않고 사유를 보인다
    try {
      const dartAdr = dartAdrOf(symbol);
      if (dartAdr) return (await dartAdrTtm(dartAdr)) ?? failedTtm("TTM 조회 실패 — DART 분기 재무 없음");
      const { cik } = await resolveCik(symbol);
      const [facts0, sic] = await Promise.all([
        getSymbolFacts(cik, symbol),
        getSubmissions(cik).then((s) => s.sic ?? null).catch(() => null),
      ]);
      const [captive, cls] = await Promise.all([
        // 금융 자회사 판별 조회 실패 = "unknown"(금융 자회사 없음으로 단정하지 않음 — EV 미표시)
        loadCaptiveDebt(cik, sic).catch(() => "unknown" as const),
        // 듀얼클래스(Visa 등) — 하이라이트와 같은 주식수를 쓰려면 클래스별 보정이 필요. 실패는 facts 에 기록(공란)
        loadClassAFactsMarked(cik, facts0),
      ]);
      const facts = cls.facts;
      const ttm = buildUsTtm(facts, {
        sic,
        captive,
        classFacts: cls.classFacts,
        isFinancial: isFinancialCompany(facts, sic),
      });
      // 불완전한 계산 표시(TTM 스냅샷 저장 제외 — db/ttm-snap.ts): SEC 원본 판독 경고, 매출(fin) 조립 실패, 금융 자회사 판별 실패
      const degraded = [
        ...(facts.fetchWarnings ?? []),
        ...(facts.revenue == null ? ["매출(fin) 조립 실패"] : []),
        ...(captive === "unknown" ? ["금융 자회사 판별 조회 실패"] : []),
      ];
      return degraded.length ? { ...ttm, degraded } : ttm;
    } catch (e) {
      return failedTtm(`TTM 조회 실패 — ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  async getFilings(symbol, opts): Promise<Filing[]> {
    const { cik } = await resolveCik(symbol);
    const sub = await getSubmissions(cik);
    const r = sub.filings.recent;
    const limit = opts?.limit ?? 20;
    const out: Filing[] = [];
    for (let i = 0; i < r.accessionNumber.length && out.length < limit; i++) {
      const accession = r.accessionNumber[i].replace(/-/g, "");
      const doc = r.primaryDocument[i];
      out.push({
        id: r.accessionNumber[i],
        symbol: symbol.toUpperCase(),
        market: "us",
        date: r.filingDate[i],
        title: r.primaryDocDescription[i] || r.form[i],
        type: r.form[i],
        url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession}/${doc}`,
        source: "SEC EDGAR",
      });
    }
    return out;
  },

  consensusDeepLinks(symbol): DeepLink[] {
    return consensusDeepLinks("us", symbol);
  },
  newsDeepLinks(symbol): DeepLink[] {
    return newsDeepLinks("us", symbol);
  },
  filingsDeepLink(symbol): DeepLink | null {
    return filingsDeepLink("us", symbol);
  },
};
