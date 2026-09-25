import "server-only";
import { getAdapter } from "./registry";
import { getEodQuote } from "./quote";
import { fetchKrxCloseOn } from "./quote/krx";
import { fetchForwardConsensus, fetchYahooEstimates, type AnalystRating } from "./quote/yahoo";
import { consensusDeepLinks } from "./deeplinks";
import { fetchUsCompanyFacts, fetchUsSic } from "./us/edgar";
import {
  buildEvResolver,
  daAnnualByYear,
  opIncomeAnnualByYear,
  reitOpUnits,
  type EvResolver,
} from "./us/edgar-ev";
import { loadCaptiveDebt } from "./us/edgar-captive";
import { loadClassAFacts } from "./us/class-facts-loader";
import { buildShareResolver, secBasisBars, type ShareResolver } from "./us/edgar-shares";
import { estimatesToUsd } from "./us/edgar-foreign";
import { usSharesHint } from "./us/shares-hint";
import { dartAdrConsensusInputs, dartAdrEstimatesToUsd, dartAdrOf } from "./us/dart-adr";
import {
  buildKrEvResolver,
  krEpsByYear,
  krEv,
  krOpIncomeByYear,
  krParentEquityByYear,
  loadKrCaps,
  type KrCaps,
  type KrEvResolver,
} from "./kr/dart-ev";
import { daAndAmortSeries, fetchKrFacts } from "./kr/dart-facts";
import { resolveCorpCode } from "./kr/corpcode";
import { getKrDaDoc } from "@/lib/db/kr-da";
import { isFinancialCompany } from "./us/edgar-financial";
import { fyEps, netIncomeAnnualByYear, parentEquityAt, positiveRatio } from "./us/edgar-pershare";
import type { ClassAFacts } from "./us/edgar-classfacts";
import type { CompanyFacts } from "./us/edgar";
import {
  AdapterError,
  type DeepLink,
  type FinancialStatement,
  type MarketId,
  type QuoteBar,
} from "./types";

/**
 * 컨센서스 패널 데이터 (FnGuide "주가 & 컨센서스" 근사판).
 *  - 실적: OpenDART / EDGAR / EDINET 연간 재무제표
 *  - 추정: yahoo-finance2 earningsTrend (개인용) — 매출·EPS 만. 영업이익·순이익
 *    컨센서스는 무료 소스에 없어 빈칸.
 *  - 연도별 PER/PBR: 각 회계연도 말 시점 주가 기준
 */

const norm = (s: string) => s.replace(/\s/g, "");
const ACCT = {
  revenue: [
    "매출액", "수익(매출액)", "매출", "영업수익",
    "Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax",
    "売上高", "営業収益 (IFRS)",
  ],
  opIncome: [
    "영업이익", "영업이익(손실)", "OperatingIncomeLoss", "Operating Income",
    "営業利益", "営業利益 (IFRS)",
  ],
  netIncome: [
    // 지배주주 귀속분 우선 (FnGuide 방식). "지배기업 소유주지분"(자본 계정)과
    // 혼동 금지 — 반드시 "순이익"이 붙은 계정만.
    "지배기업의 소유주에게 귀속되는 당기순이익",
    "지배기업의소유주에게귀속되는당기순이익",
    "지배기업지분순이익", "지배기업소유주지분순이익", "당기순이익(지배)",
    "Net income attributable to owners of parent", "当期利益（親会社の所有者帰属）",
    // fallback: 전체
    "당기순이익", "당기순이익(손실)", "연결당기순이익",
    "NetIncomeLoss", "Net Income", "当期純利益",
  ],
  equity: [
    // 지배주주 지분 우선
    "지배기업의 소유주에게 귀속되는 자본", "지배기업 소유주지분", "지배기업소유주지분",
    "지배기업의소유주에게귀속되는자본",
    "Equity attributable to owners of parent", "親会社の所有者に帰属する持分",
    // fallback: 전체
    "자본총계", "StockholdersEquity", "Stockholders' Equity", "純資産額",
  ],
  liabilities: ["부채총계", "Liabilities", "Total Liabilities"],
  cash: [
    "현금및현금성자산", "기말현금및현금성자산",
    "CashAndCashEquivalentsAtCarryingValue", "Cash & Equivalents",
  ],
  eps: [
    "희석주당이익", "희석주당순이익", "기본주당이익", "주당이익",
    "EarningsPerShareDiluted", "EarningsPerShareBasic", "EPS (Diluted)",
    "基本的1株当たり当期利益 (円)", "1株当たり当期純利益 (円)",
  ],
  depreciation: [
    "감가상각비", "유형자산감가상각비", "유형자산 감가상각비",
    "감가상각비와상각비", "감가상각비 및 상각비",
    "무형자산상각비", "무형자산 상각비",
    "DepreciationDepletionAndAmortization", "DepreciationAmortizationAndAccretionNet",
    "減価償却費", "減価償却費及び償却費",
  ],
};

function valueForYear(
  fs: FinancialStatement,
  fy: number,
  accountIds: string[],
): number | null {
  const label = `FY${fy}`;
  // accountIds 우선순위대로: 먼저 나오는 이름이 값이 있으면 그걸 채택
  for (const wanted of accountIds) {
    const w = norm(wanted);
    for (const sec of fs.sections) {
      for (const it of sec.items) {
        if (norm(it.accountId ?? it.accountName) !== w) continue;
        const v = it.values[label];
        if (v != null) return v;
      }
    }
  }
  return null;
}

function closeFromBars(bars: QuoteBar[], onIso: string): number | null {
  let best: number | null = null;
  for (const b of bars) {
    if (b.date <= onIso && b.close != null) best = b.close;
  }
  return best;
}

/** 컨센서스 차트 X축 라벨 — 종전 "2026.12"(4자리 연도)에서 이 프로젝트가
 * 다른 차트 축에 이미 쓰는 "YY-MM" 표기로 통일한다(오너 지시 2026-09-21;
 * price-chart-panel.tsx·macro-dashboard.tsx 의 xTick = d.slice(2, 7) 과
 * 같은 규칙). */
function chartLabel(fy: number, fiscalMonth: number): string {
  return `${String(fy).slice(2)}-${String(fiscalMonth).padStart(2, "0")}`;
}

export interface ConsensusRow {
  fy: number;
  label: string; // "26-12" — 컨센서스 차트 X축 라벨
  isEstimate: boolean;
  revenue: number | null;
  revenueYoY: number | null;
  opIncome: number | null;
  netIncome: number | null;
  eps: number | null;
  bps: number | null;
  per: number | null;
  pbr: number | null;
  roe: number | null;
  evEbitda: number | null;
  /** PER/PBR 계산에 쓴 주가 (실적행=연말가, 추정행=현재가) */
  priceBasis: number | null;
}

export interface ConsensusData {
  currency: string;
  /** 금액 원본 단위 (예: "원") */
  unit: string;
  fiscalMonth: number; // 결산월 (대개 12)
  price: number | null;
  targetPrice: number | null;
  recommendationMean: number | null;
  rows: ConsensusRow[];
  /** EPS 추정치 리비전 (현재/1주전/1개월전/3개월전) — 당해년도 + 차년도 각각 EPS·PER */
  epsRevision:
    | {
        asOf: string[];
        eps: (number | null)[];
        per: (number | null)[];
        epsNext: (number | null)[];
        perNext: (number | null)[];
        nextFy: number | null;
      }
    | null;
  /** 최근 분기 EPS 어닝 서프라이즈 */
  earningsSurprise: {
    period: string;
    epsEstimate: number | null;
    epsActual: number | null;
    surprisePct: number | null;
  }[];
  /** 증권사별 투자의견 이력 (최신 → 과거). Yahoo 특성상 미국만 실질적으로 채워진다. */
  analystRatings: AnalystRating[];
  deepLinks: DeepLink[];
  asOf: string;
  notes: string[];
}

export async function getConsensusData(
  market: MarketId,
  rawSymbol: string,
  yahooOverride?: string | null,
): Promise<ConsensusData> {
  const adapter = getAdapter(market);
  const symbol = adapter.normalizeSymbol(rawSymbol);
  const notes: string[] = [];

  const [annual, quote, estimatesRaw] = await Promise.all([
    adapter.getFinancials(symbol, "annual").catch((e) => {
      throw new AdapterError(
        e instanceof AdapterError ? e.message : "연간 재무제표 조회 실패",
        { status: 502 },
      );
    }),
    getEodQuote(market, symbol, { yahooOverride }).catch(() => null),
    fetchYahooEstimates(market, symbol, yahooOverride).catch(() => null),
  ]);
  let estimates = estimatesRaw;
  if (!estimates) notes.push("추정치(yahoo) 조회 실패 — 실적만 표시");

  const price = quote?.last ?? null;
  // SEC XBRL 이 없는 ADR(SKHY) — 실적은 본국 DART 재무를 USD·ADR 기준으로 환산해 한국 경로로
  // 계산한다(us/dart-adr.ts). 시세·예상치는 ADR 그대로.
  const dartAdr = market === "us" ? dartAdrOf(symbol) : null;
  let shares =
    quote?.sharesOutstanding ??
    (quote?.marketCap != null && price ? quote.marketCap / price : null);

  const fiscalMonth = annual.periods[0]?.endDate
    ? Number(annual.periods[0].endDate.slice(5, 7)) || 12
    : 12;

  // ── 실적 행 ──────────────────────────────────────────────────────
  const years = [...annual.periods.map((p) => p.fiscalYear)]
    .filter((y, i, a) => a.indexOf(y) === i)
    .sort((a, b) => a - b)
    .slice(-4);

  // 미국: 하이라이트와 같은 단일 기준(edgar-shares·edgar-ev) — 과거 연도 시가총액은
  // 그 연도말 주식수(분할 보정)로, EV 는 차입금 기준으로. 예전엔 현재 주식수와
  // 부채총계를 써서 같은 연도 PER·PBR·EV/EBITDA 가 하이라이트와 달랐다(감사 2026-09-23).
  let us: {
    shares: ShareResolver;
    ev: EvResolver;
    da: Map<number, number>;
    op: Map<number, number>;
    facts: CompanyFacts;
    classFacts: ClassAFacts | null;
  } | null = null;
  if (market === "us" && !dartAdr) {
    try {
      const { cik, facts } = await fetchUsCompanyFacts(symbol);
      const sic = await fetchUsSic(symbol).catch(() => null);
      const [captive, fwd, classFacts] = await Promise.all([
        loadCaptiveDebt(cik, sic).catch(() => null),
        fetchForwardConsensus(market, symbol, yahooOverride).catch(() => null),
        loadClassAFacts(cik, facts).catch(() => null),
      ]);
      const opUnits = reitOpUnits(sic, fwd?.sharesOutstanding, fwd?.impliedSharesOutstanding);
      us = {
        // 힌트는 하이라이트·재무분석 라우트와 같은 규칙(us/shares-hint.ts)
        shares: buildShareResolver(facts, { classFacts, sharesHint: usSharesHint(quote, fwd) }),
        ev: buildEvResolver(facts, { sic, captive, opUnits, isFinancial: isFinancialCompany(facts, sic) }),
        da: daAnnualByYear(facts),
        op: opIncomeAnnualByYear(facts),
        facts,
        classFacts,
      };
    } catch {
      us = null;
    }
    // 외화 공시 기업(ASML·TSM·SPOT) — Yahoo 예상치를 USD 로(edgar-foreign.ts). 환산 실패 시 예상치를
    // 숨긴다(원통화 숫자를 USD 로 섞지 않음).
    if (us?.facts.fetchWarnings?.length) notes.push(`⚠ 일부 공시 조회 실패(${us.facts.fetchWarnings.slice(0, 3).join(", ")}) — 잠시 뒤 다시 계산`);
    if (us && estimates) {
      const conv = await estimatesToUsd(estimates, us.facts).catch(() => null);
      if (!conv) notes.push("외화 예상치 환산 실패 — 예상치 숨김");
      else if (conv.fxNote) notes.push(conv.fxNote);
      estimates = conv;
    }
  }

  // 한국: 하이라이트와 같은 EV 단일 기준(kr/dart-ev.ts) — 부채총계 대신 차입금, KRX 연말
  // 실제 시가총액(보통주·우선주), 감가상각비는 사업보고서 주석 실측(daAndAmortSeries).
  // 예전엔 부채총계를 더하고 D&A 계정 매칭 실패 시 영업이익만 써서 EV/EBITDA 가 하이라이트의
  // 2~16배였고, 40배 초과를 숨기는 필터까지 있어 화면마다 갈렸다(B16, 2026-09-23).
  if (dartAdr && estimates) {
    const conv = await dartAdrEstimatesToUsd(dartAdr, estimates).catch(() => null);
    if (!conv) notes.push("외화 예상치 환산 실패 — 예상치 숨김");
    else if (conv.fxNote) notes.push(conv.fxNote);
    estimates = conv;
  }

  let kr: {
    ev: KrEvResolver;
    caps: KrCaps | null;
    da: Map<number, number>;
    eps: Map<number, number>;
    equity: Map<number, number>;
    op: Map<number, number>;
  } | null = null;
  // DART 연결 ADR — BPS 분모는 사업연도말 자사주 제외 유통주식수(시가총액 주식수와 별개)
  let dartBookShares: Map<number, number> | null = null;
  if (dartAdr) {
    try {
      const x = await dartAdrConsensusInputs(dartAdr, years);
      if (x) {
        kr = {
          ev: buildKrEvResolver(x.facts, x.code),
          caps: x.caps,
          da: daAndAmortSeries(x.facts, x.daDoc).byYear,
          eps: krEpsByYear(x.facts),
          equity: krParentEquityByYear(x.facts),
          op: krOpIncomeByYear(x.facts),
        };
        shares = x.adrShares ?? shares;
        dartBookShares = x.bookShares;
        notes.push(`실적: ${x.code} OpenDART 재무 USD 환산(손익 = 기간 평균 환율, 재무상태표·연말 시가총액 = 결산일 환율), 주당 값은 ADR 1주 기준`);
      }
    } catch {
      kr = null;
    }
  }
  if (market === "kr") {
    try {
      const { corpCode } = resolveCorpCode("", symbol);
      const [facts, daDoc, caps] = await Promise.all([
        fetchKrFacts(corpCode, "annual"),
        getKrDaDoc(symbol).catch(() => null),
        loadKrCaps(symbol, years).catch(() => null),
      ]);
      if (facts)
        kr = {
          ev: buildKrEvResolver(facts, symbol),
          caps,
          da: daAndAmortSeries(facts, daDoc).byYear,
          eps: krEpsByYear(facts),
          equity: krParentEquityByYear(facts),
          op: krOpIncomeByYear(facts),
        };
    } catch {
      kr = null;
    }
  }

  const actualRows: ConsensusRow[] = [];
  for (const fy of years) {
    const revenue = valueForYear(annual, fy, ACCT.revenue);
    // 미국: 영업이익 단일 기준 시계열(edgar-ev.ts — 공시 → 세전+이자 → 세전)
    // 한국: dart-ev.ts 공통 영업이익(하이라이트·재무분석과 같은 값)
    const opIncome = us
      ? (us.op.get(fy) ?? null)
      : kr
        ? (kr.op.get(fy) ?? null)
        : valueForYear(annual, fy, ACCT.opIncome);
    // 미국: 지배주주 순이익 공통 규칙(하이라이트·손익계산서와 같은 값)
    const netIncome = us
      ? (netIncomeAnnualByYear(us.facts).get(fy) ?? null)
      : valueForYear(annual, fy, ACCT.netIncome);
    // 미국: 자기자본은 하이라이트와 같은 단일 기준(재작성본 우선) — 계정명 매칭은
    // T·VZ 처럼 지배주주 자본 태그가 다른 회사에서 빈칸이 됐다(검증 체계로 발견).
    const periodEndUs = annual.periods.find((p) => p.fiscalYear === fy)?.endDate ?? null;
    const equity =
      us && periodEndUs
        ? parentEquityAt(us.facts, periodEndUs)
        : kr
          ? (kr.equity.get(fy) ?? null) // 한국: 지배주주 자본(dart-ev.ts — 하이라이트와 같은 값)
          : valueForYear(annual, fy, ACCT.equity);
    const liab = valueForYear(annual, fy, ACCT.liabilities);
    const cash = valueForYear(annual, fy, ACCT.cash);
    const epsStmt = valueForYear(annual, fy, ACCT.eps);

    // 미국은 연도말 주식수(단일 기준), 그 외는 종전대로 현재 주식수
    const periodEnd0 = annual.periods.find((p) => p.fiscalYear === fy)?.endDate ?? null;
    const fyShares = us && periodEnd0 ? (us.shares.atFiscalYearEnd(fy, periodEnd0) ?? shares) : shares;
    // 미국: 하이라이트와 같은 연도 EPS 규칙(공시값·분할 보정 → Class A 실측 → 근사)
    const eps = us
      ? fyEps(us.facts, fy, { classFacts: us.classFacts, fyShares, fyNetIncome: netIncome }).eps
      : kr
        ? (kr.eps.get(fy) ?? null) // 한국: dart-ev.ts 공통 EPS
        : (epsStmt ?? (netIncome != null && fyShares ? netIncome / fyShares : null));
    // DART 연결 ADR 은 유통주식수가 없으면 BPS 를 비운다(시가총액 주식수로 대체하지 않음)
    const bookSh = dartAdr ? (dartBookShares?.get(fy) ?? null) : fyShares;
    const bps = equity != null && bookSh ? equity / bookSh : null;

    // 해당 회계연도의 실제 마감일 시점 주가 (없으면 결산월 28일로 근사)
    const periodEnd =
      annual.periods.find((p) => p.fiscalYear === fy)?.endDate ??
      `${fy}-${String(fiscalMonth).padStart(2, "0")}-28`;
    let yePrice: number | null = null;
    if (dartAdr) {
      // 연말 가격 = KRX 종가 × 결산일 환율 × ADR 비율(환산 caps) — ADR 상장 전 연도도 같은 기준
      yePrice = kr?.caps?.byYear.get(fy)?.close ?? null;
    } else if (market === "kr") {
      yePrice =
        kr?.caps?.byYear.get(fy)?.close ??
        (await fetchKrxCloseOn(symbol, periodEnd.replace(/-/g, "")).catch(() => null));
    } else if (us) {
      // 주식수와 같은 기준의 가격 — Yahoo 가 분할로 기록한 분사 되돌림(edgar-shares.ts secBasisBars)
      yePrice = closeFromBars(secBasisBars(us.facts, quote), periodEnd);
    } else if (quote?.bars?.length) {
      yePrice = closeFromBars(quote.bars, periodEnd);
    }
    // 못 구하면 현재가로 대체 — 미국은 하지 않는다. 상장 전 연도(분사 GEV·SNDK
    // 2022~2023)에 현재가 × 옛 자본으로 PBR 22배 같은 가짜 값이 생겨 하이라이트
    // (빈칸)와 갈렸다(검증 체계, 2026-09-23 유니버스 전수).
    // 한국도 같다(산일전기 2024 상장 — 2023 연도에 현재가로 가짜 PER·PBR). 일본만 종전대로.
    if (market === "jp") yePrice = yePrice ?? price;

    // 미국: 분모 0 이하면 비운다(하이라이트·재무분석과 같은 부호 규칙). 한국·일본은
    // B16 결정 전까지 종전 그대로.
    // 미국·한국: 분모 0 이하면 비운다(하이라이트·재무분석과 같은 부호 규칙). 한국 PBR 은
    // 하이라이트와 같게 KRX 연말 실제 시가총액 ÷ 지배주주 자본. 일본은 종전 그대로.
    const krCommon = kr?.caps?.byYear.get(fy)?.common ?? null;
    const per = us || kr ? positiveRatio(yePrice, eps) : yePrice != null && eps ? yePrice / eps : null;
    const pbr = us
      ? positiveRatio(yePrice, bps)
      : kr
        ? positiveRatio(krCommon ?? (yePrice != null && fyShares ? yePrice * fyShares : null), equity)
        : yePrice != null && bps ? yePrice / bps : null;
    let roe = netIncome != null && equity ? (netIncome / equity) * 100 : null;
    // netIncome 이 자본 계정과 잘못 매칭되면 ROE≈100 → 숨김
    if (roe != null && (Math.abs(roe - 100) < 0.001 || roe > 100 || roe < -100)) roe = null;
    const mcap = yePrice != null && fyShares ? yePrice * fyShares : null;
    let evEbitda: number | null;
    if (us) {
      // 하이라이트와 동일: EV = edgar-ev 브릿지, EBITDA = 영업이익 + D&A(단일 규칙),
      // EBITDA ≤ 0 만 비운다(40배 초과 숨김은 하이라이트와 달라져 미국은 적용 안 함).
      // D&A 구성요소가 없으면(매핑 누락 — IFRS 20-F 등) EBITDA 도 공란(0 으로 보지
      // 않음, 하이라이트·재무분석과 같은 원칙 — 독립 감사 지적 2026-09-25 NVO·SAP)
      const ev = us.ev.evAt(periodEnd, mcap, yePrice);
      const op = opIncome;
      const usDa = us.da.get(fy);
      const ebitda = op != null && usDa != null ? op + usDa : null;
      evEbitda = ev != null && ebitda && ebitda > 0 ? ev / ebitda : null;
    } else if (kr) {
      const common = kr.caps?.byYear.get(fy)?.common ?? mcap;
      const ev = krEv(kr.ev, fy, common, kr.caps?.byYear.get(fy)?.preferred ?? null);
      const d = kr.da.get(fy);
      const ebitda = opIncome != null && d != null ? opIncome + d : null;
      evEbitda = ev != null && ebitda != null && ebitda > 0 ? ev / ebitda : null;
    } else {
      const ev = mcap != null ? mcap + (liab ?? 0) - (cash ?? 0) : null;
      // EBITDA = 영업이익 + 감가상각비(+무형상각). 상각비 계정을 못 찾으면 영업이익 근사.
      const dep = valueForYear(annual, fy, ACCT.depreciation);
      const ebitda = opIncome != null ? opIncome + Math.abs(dep ?? 0) : null;
      evEbitda = ev != null && ebitda && ebitda > 0 ? ev / ebitda : null;
      // 영업이익이 급감한 해 등 비정상값은 숨김
      if (evEbitda != null && (evEbitda > 40 || evEbitda < 0)) evEbitda = null;
    }

    actualRows.push({
      fy,
      label: chartLabel(fy, fiscalMonth),
      isEstimate: false,
      revenue,
      revenueYoY: null,
      opIncome,
      netIncome,
      eps,
      bps,
      per: fin(per),
      pbr: fin(pbr),
      roe: fin(roe),
      evEbitda: fin(evEbitda),
      priceBasis: yePrice,
    });
  }

  // ── 추정 행 ──────────────────────────────────────────────────────
  const estRows: ConsensusRow[] = [];
  const fyPeriods = (estimates?.periods ?? []).filter((p) =>
    ["0y", "+1y", "+2y"].includes(p.period),
  );
  for (const p of fyPeriods) {
    const fy = p.endDate ? Number(p.endDate.slice(0, 4)) : null;
    if (fy == null) continue;
    if (actualRows.some((r) => r.fy === fy)) continue; // 이미 실적 있음
    const eps = p.epsAvg;
    const per = price != null && eps ? price / eps : null;
    estRows.push({
      fy,
      label: chartLabel(fy, fiscalMonth),
      isEstimate: true,
      revenue: p.revenueAvg,
      revenueYoY: null,
      opIncome: null,
      netIncome: null,
      eps,
      bps: null,
      per: fin(per),
      pbr: null,
      roe: null,
      evEbitda: null,
      priceBasis: price,
    });
  }

  const rows = [...actualRows, ...estRows].sort((a, b) => a.fy - b.fy);
  // YoY (매출)
  for (let i = 1; i < rows.length; i++) {
    const cur = rows[i].revenue;
    const prev = rows[i - 1].revenue;
    if (cur != null && prev != null && prev !== 0) {
      rows[i].revenueYoY = ((cur - prev) / Math.abs(prev)) * 100;
    }
  }

  // ── EPS 리비전 (당해년도 + 차년도) ───────────────────────────────
  let epsRevision: ConsensusData["epsRevision"] = null;
  const cy = estimates?.periods.find((p) => p.period === "0y");
  const ny = estimates?.periods.find((p) => p.period === "+1y");
  if (cy?.epsTrend) {
    const t = cy.epsTrend;
    const eps = [t.current, t.d7, t.d30, t.d90];
    const nt = ny?.epsTrend;
    const epsNext = nt ? [nt.current, nt.d7, nt.d30, nt.d90] : eps.map(() => null);
    const perOf = (e: number | null) => (price != null && e ? price / e : null);
    epsRevision = {
      asOf: ["현재", "1주 전", "1개월 전", "3개월 전"],
      eps,
      per: eps.map(perOf),
      epsNext,
      perNext: epsNext.map(perOf),
      nextFy: ny?.endDate ? Number(ny.endDate.slice(0, 4)) : null,
    };
  }

  return {
    currency: quote?.currency ?? "USD",
    unit: annual.unit || (market === "kr" ? "원" : market === "jp" ? "円" : "USD"),
    fiscalMonth,
    price,
    targetPrice: estimates?.targetMeanPrice ?? null,
    recommendationMean: estimates?.recommendationMean ?? null,
    rows,
    epsRevision,
    earningsSurprise: (estimates?.surprises ?? []).slice(-4),
    analystRatings: estimates?.ratings ?? [],
    deepLinks: consensusDeepLinks(market, symbol),
    asOf: quote?.lastDate ?? new Date().toISOString().slice(0, 10),
    notes: [...new Set(notes)],
  };
}

/**
 * 유한한 숫자만 통과(반올림하지 않는다). 소수점 처리는 화면의 공통 포맷
 * (lib/format.ts, 버림)에서만 한다 — 여기서 반올림하면 같은 값이 다른 화면과
 * 0.01 다르게 보인다(감사 2026-09-23: VZ 2023 EV/EBITDA 7.616 → 컨센서스 7.62,
 * 하이라이트 7.61).
 */
function fin(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
