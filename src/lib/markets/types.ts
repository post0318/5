/**
 * 시장별 데이터 어댑터 인터페이스 (prd.md §4)
 *
 * 모든 외부 소스는 이 인터페이스 뒤에 격리한다.
 * 개인용 → 팀/대외 확장 시 구현체만 교체 (prd.md §4.3).
 */

export type MarketId = "kr" | "us" | "jp";

export const MARKETS: { id: MarketId; label: string; locale: string }[] = [
  { id: "kr", label: "한국", locale: "ko-KR" },
  { id: "us", label: "미국", locale: "en-US" },
  { id: "jp", label: "일본", locale: "ja-JP" },
];

export function isMarketId(v: string): v is MarketId {
  return v === "kr" || v === "us" || v === "jp";
}

export type Currency = "KRW" | "USD" | "JPY";

export const MARKET_CURRENCY: Record<MarketId, Currency> = {
  kr: "KRW",
  us: "USD",
  jp: "JPY",
};

/** 재무제표 주기 */
export type FinancialPeriodType = "annual" | "quarter";

/** 재무제표 한 컬럼(한 기간). */
export interface FinancialPeriod {
  /** 표시 라벨: "FY2024", "2024 Q3" 등 */
  label: string;
  /** 회계연도 */
  fiscalYear: number;
  /** 분기(1~4). 연간이면 null */
  fiscalQuarter: number | null;
  /** 기준일 (YYYY-MM-DD) */
  endDate: string | null;
}

/** 재무제표 한 행(한 계정). 원본 표현 그대로 유지 (prd.md §6). */
export interface FinancialLineItem {
  /** 원본 계정과목명 (재가공 금지) */
  accountName: string;
  /** 원본 계정 코드/ID (있으면) */
  accountId?: string;
  /** 들여쓰기 depth (0=최상위) */
  depth: number;
  /** 소계/합계 행 여부 */
  isSubtotal: boolean;
  /** 주요 강조 대상 계정 여부 (배경색). prd.md §6 */
  isHighlight: boolean;
  /** period.label -> 값. 원본 단위 유지 */
  values: Record<string, number | null>;
  /** 표준화 상세표(CF·IS)의 값 표시 방식. 미지정 시 통화(백만). */
  numberFormat?: "money" | "shares" | "eps" | "pct";
  /** 참고성 라인 — 기울임꼴로 표시 */
  italic?: boolean;
  /** 값을 괄호로 감싸 표시 (참고/내역 라인) */
  paren?: boolean;
}

export interface FinancialStatement {
  symbol: string;
  market: MarketId;
  periodType: FinancialPeriodType;
  /** 원본 단위 설명: "원", "천원", "USD", "百万円" 등 */
  unit: string;
  currency: Currency;
  /** 연결(consolidated) / 별도(separate) */
  consolidation: "consolidated" | "separate" | "unknown";
  periods: FinancialPeriod[];
  /** 재무상태표 / 손익계산서 / 현금흐름표 순서 무관, 섹션으로 구분 */
  sections: {
    title: string;
    items: FinancialLineItem[];
  }[];
  /** 데이터 출처 표기 */
  source: string;
  /** 원문/딥링크 */
  sourceUrl?: string;
}

export interface CompanyProfile {
  symbol: string;
  market: MarketId;
  name: string;
  nameLocal?: string;
  /** 종목코드 외 식별자 (CIK, 종목코드, EDINET 코드 등) */
  identifiers: Record<string, string>;
  sector?: string;
  industry?: string;
  ceo?: string;
  homepage?: string;
  address?: string;
  listedDate?: string;
  description?: string;
  source: string;
  sourceUrl?: string;
}

export interface Filing {
  id: string;
  symbol: string;
  market: MarketId;
  /** 공시일 (YYYY-MM-DD) */
  date: string;
  title: string;
  /** 공시 유형 (10-K, 사업보고서, 有価証券報告書 등) */
  type: string;
  /** 원문 링크 (딥링크) */
  url: string;
  source: string;
}

export interface QuoteBar {
  /** YYYY-MM-DD */
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

export interface EodQuote {
  symbol: string;
  market: MarketId;
  currency: Currency;
  /** 최근 종가 */
  last: number | null;
  lastDate: string | null;
  /** 전일 대비 등락 */
  change: number | null;
  changePct: number | null;
  bars: QuoteBar[];
  source: string;
  /** 상장주식수 (제공 소스에서만 — KRX 등) */
  sharesOutstanding?: number | null;
  /** 시가총액 (제공 소스에서만) */
  marketCap?: number | null;
}

/** 트레일링 멀티플 (L3, 자체 계산). */
export interface TrailingMultiples {
  symbol: string;
  market: MarketId;
  asOf: string;
  per: number | null;
  /** TTM(최근 4분기) 기준 PER. 분기 데이터가 없으면 null. */
  perTtm: number | null;
  pbr: number | null;
  psr: number | null;
  evEbitda: number | null;
  /** EV/EBITDA 가 D&A 없이 EV/EBIT 로 근사된 경우 true */
  evEbitdaIsApprox: boolean;
  /** 주당순이익 (희석) */
  eps: number | null;
  /** 주당순자산 */
  bps: number | null;
  dividendYield: number | null;
  marketCap: number | null;
  currency: Currency;
  /** 계산에 쓴 값들 (감사 추적용) */
  inputs: Record<string, number | null>;
}

/** TTM(최근 4분기 누적) 플로우 지표. */
export interface TtmFlows {
  /** 계산 기준 라벨 (예: "FY2025 + 2026 반기 − 2025 반기") */
  periodLabel: string;
  netIncome: number | null;
  revenue: number | null;
  opIncome: number | null;
  /** 주당순이익 (희석 우선, 없으면 기본) */
  eps: number | null;
  /**
   * 미국(EDGAR) 확장 필드 — 최근 분기(MRQ) 재무상태표 스냅샷 + D&A + 주당배당금.
   * 시장/야후는 최근 분기 재무상태표 + TTM 흐름으로 멀티플을 계산하는데
   * 우리 기본 로직은 최근 "연간"만 써서 BPS·PBR·PSR·EV 가 최대 11개월 낡는다.
   */
  snapshot?: {
    /** 스냅샷 기준일 (예: "2026-06-27") */
    label: string;
    equity: number | null;
    liabilities: number | null;
    cash: number | null;
    shares: number | null;
  } | null;
  /** 감가상각비+무형자산상각비 — 최근 사업연도(연간, PER 과 동일 기준) */
  daAnnual?: number | null;
  /** D&A TTM (참고) */
  daTtm?: number | null;
  /** 주당배당금 — 최근 사업연도 */
  dpsAnnual?: { dps: number; label: string } | null;
  /** 주당배당금 — 최근 12개월(TTM) */
  dpsTtm?: { dps: number; from: string; to: string } | null;
}

/** 포워드 컨센서스 (L4). 개인용: yahoo-finance2. */
export interface ForwardConsensus {
  symbol: string;
  market: MarketId;
  currency: Currency;
  forwardPer: number | null;
  /** Yahoo summaryDetail.trailingPE (TTM). 국내는 신뢰도 낮아 미사용. */
  trailingPer: number | null;
  targetMeanPrice: number | null;
  targetHighPrice: number | null;
  targetLowPrice: number | null;
  numberOfAnalysts: number | null;
  recommendationKey: string | null;
  /** 부수 요약 지표 (yahoo summaryDetail — 컨센서스는 아니지만 같은 호출로 확보) */
  fiftyTwoWeekHigh: number | null;
  fiftyTwoWeekLow: number | null;
  beta: number | null;
  currentRatio: number | null;
  dividendPerShare: number | null;
  /** 배당수익률 (소수: 0.021 = 2.1%) */
  dividendYield: number | null;
  /**
   * TTM/최근분기 지표 (Yahoo). 무료 분기 공시가 없는 일본에서 PER(TTM)·EPS(TTM)·
   * PBR·BPS·PSR·EV/EBITDA·DPS(TTM) 산출에 사용. 미국(EDGAR)·한국(DART)은 자체 계산.
   */
  trailingEps: number | null;
  trailingAnnualDividendRate: number | null;
  bookValue: number | null;
  sharesOutstanding: number | null;
  marketCap: number | null;
  revenueTtm: number | null;
  ebitdaTtm: number | null;
  enterpriseValue: number | null;
  /** 회계연도별 EPS/매출 추정 */
  estimates: {
    period: string;
    epsAvg: number | null;
    epsLow: number | null;
    epsHigh: number | null;
    revenueAvg: number | null;
  }[];
  source: string;
  /** 상세 확인 딥링크 (prd.md §4.6) */
  deepLinks: DeepLink[];
}

export interface NewsItem {
  id: string;
  title: string;
  publisher: string;
  date: string;
  url: string;
}

export interface DeepLink {
  label: string;
  url: string;
}

/** 시장 어댑터. 각 시장 구현이 채운다. */
export interface MarketAdapter {
  readonly market: MarketId;
  readonly currency: Currency;
  /** 이 어댑터가 실제로 동작하는지 (API 키 등). false면 UI가 안내 표시 */
  isConfigured(): boolean;
  /** 미설정 시 사용자 안내 메시지 */
  configHint(): string;

  /** 심볼 정규화 (대문자, 접미사 등) */
  normalizeSymbol(input: string): string;

  getCompanyProfile(symbol: string): Promise<CompanyProfile>;
  getFinancials(symbol: string, periodType: FinancialPeriodType): Promise<FinancialStatement>;
  getFilings(symbol: string, opts?: { limit?: number }): Promise<Filing[]>;

  /**
   * TTM(최근 4분기) 플로우 지표 — 트레일링 멀티플용.
   * 분기 누적데이터로 `직전연간 + 당기누적 − 전년동기누적` 계산.
   * 구현하지 않은 어댑터는 생략 (그 시장은 트레일링PER 미표시).
   */
  getTtm?(symbol: string): Promise<TtmFlows | null>;

  /** L4/L5 딥링크 빌더 */
  consensusDeepLinks(symbol: string): DeepLink[];
  newsDeepLinks(symbol: string): DeepLink[];
  filingsDeepLink(symbol: string): DeepLink | null;
}

/** 어댑터 공통 에러 */
export class AdapterError extends Error {
  constructor(
    message: string,
    readonly opts: { status?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

export class NotConfiguredError extends AdapterError {
  constructor(hint: string) {
    super(hint, { status: 501 });
    this.name = "NotConfiguredError";
  }
}
