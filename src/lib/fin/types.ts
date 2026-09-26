/**
 * 재무 숫자 5층 구조 — 데이터 계약(docs/metrics/architecture.md §2).
 * 이 파일은 층 사이의 약속만 담는다. 계산 코드는 넣지 않는다.
 *
 * 설계와 다른 점: `Gap` 은 `const enum` 대신 `as const` 객체 — `isolatedModules`·jiti(스크립트 실행)가
 * const enum 인라인을 지원하지 않는다. 값·이름은 설계 그대로.
 */

export type Market = "us" | "kr";
export type FormType =
  | "10-K" | "10-K/A" | "10-Q" | "10-Q/A" | "20-F" | "20-F/A" | "40-F" | "40-F/A"
  | "8-K" | "6-K" | "YAHOO-Q" | "DART-11011" | "DART-11012" | "DART-11013" | "DART-11014";
export type SourceId = "sec-cf" | "sec-inst" | "sec-htm" | "yahoo" | "infomax" | "ecos" | "dart";

/** 0층 — 모든 값에 붙는 출처. */
export interface Prov {
  accn: string | null;
  form: FormType;
  filed: string | null;
  source: SourceId;
  dims?: Record<string, string>;
  /**
   * 값 하나의 사실 좌표 — 개념·기간·단위(파생값 입력 추적, architecture.md §2.1). 1층이 `ReadValue` 를 만들 때 채운다(열 머리글
   * `Column.src` 처럼 공시 단위 출처에는 없음). 원문 URL 은 저장하지 않는다 — accn + CIK 로 생성.
   */
  concept?: string;
  start?: string | null;
  end?: string;
  unit?: string;
}

/** 완전성 비트마스크. 0 = 완전. 실패를 다른 원천으로 조용히 대체하지 않고 이 비트로 남긴다. */
export const Gap = {
  CF_FETCH: 1,
  INSTANCE: 2,
  LINKBASE: 4,
  HTML: 8,
  YAHOO: 16,
  FX: 32,
  /** 조립 항등식 불성립 */
  IDENTITY: 64,
  /** 파생 열(Q4·LTM) 구성요소의 기준이 다름(중단사업 재분류 등) */
  BASIS_SHIFT: 128,
  /** 최신 정기공시가 SEC 목록에 있는데 판독 못함 */
  STALE: 256,
} as const;

export function gapNames(g: number): string[] {
  return Object.entries(Gap).filter(([, b]) => (g & b) !== 0).map(([k]) => k);
}

/** 0층 산출 — 사실 하나(차원 포함). */
export interface RawFact {
  concept: string; // "us-gaap:Revenues" 형식(네임스페이스 포함)
  start: string | null;
  end: string;
  val: number;
  unit: string;
  dims: Record<string, string>;
  decimals: number | null;
  prov: Prov;
}

/** 표시·계산 구조 트리(_pre·_cal) — 한 역할(role) 안의 부모→자식 관계. */
export interface LinkArc { from: string; to: string; order: number; weight: number; preferredLabel?: string }
export interface LinkRole { role: string; arcs: LinkArc[] }
export type PresentationTree = LinkRole[];
export type CalculationTree = LinkRole[];

/** 0층 산출 — 공시 하나의 원자료 (DB 저장 안 함). */
export interface RawFiling {
  accn: string;
  form: FormType;
  filed: string;
  fyEnd: string;
  periodEnd: string;
  facts: RawFact[];
  pre: PresentationTree | null;
  cal: CalculationTree | null;
  labels: Map<string, string>;
  gaps: number;
}

/** 1층 산출 — 판본이 확정된 값. */
export interface ReadValue {
  val: number;
  /** 공시 단위 그대로(보고 통화 "USD"·"TWD"…, "shares" 등) — prov.unit 과 같음 */
  unit: string;
  /** concept·start·end·unit 까지 채운 출처 */
  prov: Prov;
  why?: ReadWhy;
}

/**
 * 파생값 입력(architecture.md §2.1) — 값 = Σ op × 값(ref) × (x ? x.v : 1). 값을 복사하지 않고 참조만 남긴다(시장 데이터만 값·기준 시각).
 *  - `f:{accn}|{개념}|{start}|{end}[|축=멤버,…]` SEC 사실(보고 통화) — accn + CIK 로 원공시를 다시 읽어 재현
 *  - `c:{열키}|{줄id}`                          저장 칸(fin_stmt) — 그 칸이 파생이면 그 칸의 입력으로 재귀 전개
 *  - `y:{Yahoo 필드}|{분기말}`                   Yahoo 분기(20-F·40-F LTM, 보고 통화) — 원천을 저장하지 않으므로 v·asOf 동반
 *  - `x:{통화}|avg|{start}|{end}`               기간 평균 환율(통화 → USD) — `x` 자리(곱하는 입력), v·asOf 동반
 */
export interface DerivedInput {
  ref: string;
  op: 1 | -1;
  /** 구성 역할(fy·9m·ytd·ytd-prior·cum·cum-prev·yq·nonop …) — 표시용 */
  role?: string;
  /** 시장 데이터 입력만 — 값·조회 시각 */
  v?: number;
  asOf?: string;
  /** 곱할 시장 데이터(환율) */
  x?: MarketInput;
}
export interface MarketInput {
  ref: string;
  v: number;
  /** 조회 시각(ISO) — 화면 간 다른 시점 시세를 구분 */
  asOf: string;
}
export type ReadWhy =
  | { k: "fx"; cur: string; rate: number; basis: "avg" | "spot" }
  | { k: "yahoo-q"; through: string }
  | { k: "derived"; parts: { accn: string; form: FormType; sign: 1 | -1 }[] };

/** 2층 — 한 열 = 한 공시(또는 명시된 파생). */
export type ColKind = "FY" | "Q" | "Q4D" | "LTM";
export interface Column {
  key: string; // "FY2025" | "2026Q2" | "2025Q4" | "LTM"
  kind: ColKind;
  fy: number;
  fq: 0 | 1 | 2 | 3 | 4;
  start: string;
  end: string;
  src: Prov | Prov[];
  gaps: number;
}
export type LineRole =
  | "revenue" | "revenue.total" | "revenue.net" | "revenue.nonop"
  | "cogs" | "cogs.part" | "gross" | "opinc" | "pretax" | "tax" | "ni" | "ni.parent";
export interface StmtLine {
  id: string;
  label: string;
  parent: number | null;
  w: 1 | -1 | 0;
  role: LineRole | null;
  v: number | null;
  why?: ReadWhy;
  /** 파생 칸(Q4·누적 차·LTM·환산)의 입력 — 없으면 열 출처 = 칸 출처 */
  inputs?: DerivedInput[];
}
export interface AssembledIs {
  col: Column;
  lines: StmtLine[];
  /**
   * 항등식(계산 구조 합계식: 부모 = Σ 가중치 × 항) 검사 — fails[k] 는 줄 at[k](부모)의 불성립, terms[k] = 그 식의 항 줄 위치,
   * partial[k] = 판정 불완전(값 없는 항·표시 줄에 없는 항·둘 이상 식의 항·식 밖 값 있는 줄·파생 열 구성 공시의 식 구성 다름 — is.ts)
   */
  identity: {
    ok: boolean; fails: string[]; at: number[]; partial: boolean[]; terms: number[][];
    /** 어느 합계식에도 속하지 않는 값 있는 줄 위치(계산 구조가 없는 열은 값 있는 줄 전부) — 항등식 검사가 닿지 않는 줄 */
    uncovered: number[];
  };
  /**
   * 매출원가 줄을 어떻게 찾았나(docs/metrics/cogs.md §1) — "gp" = 본표 계산 구조의 매출총이익 식에서 빼는 항(소계가 있으면 소계),
   * "label" = 매출총이익 식이 없어 원가 개념 + 원가 라벨(cost of revenue/sales/goods)인 본표 줄, null = 찾지 못함(`cogsWhy`)
   */
  cogsBy: "gp" | "label" | null;
  cogsWhy?: string;
  /** 줄 구조가 그 열 원천 공시의 본표(_pre)에서 왔는가 — false 면 기본 개념 목록(Gap.LINKBASE)이라 "본표 소계"로 볼 수 없다 */
  faceShape: boolean;
}

/** 3층 — 지표 값. */
export interface MetricValue {
  v: number | null;
  col: string;
  end: string;
  line: string | null;
  rule: string;
  gaps: number;
  why?: ReadWhy;
  /** 파생값 입력(구조) — 없으면 열 출처 = 값 출처. `rule`·`why` 는 호환용으로 그대로 둔다 */
  inputs?: DerivedInput[];
  /** 파생값 계산 시각(ISO) — inputs 가 있을 때만 */
  calculatedAt?: string;
  /** 값을 비운 사유(예: 매출 줄이 걸린 조립 항등식 불성립) */
  reason?: string;
  /** 이 값을 비운 항등식 불성립(매출 경로) — AssembledIs.identity.fails 의 부분집합 */
  idFails?: string[];
  /** 매출 경로의 판정 불완전 불성립 — 값은 두되 "항등식 미검증"(검증기가 SEC 직접 대조를 강제) */
  unv?: string[];
  /** 값은 두되 화면에 알릴 정의 메모(예: 매출총이익 합성 "본표 소계 없음 · 매출 − 매출원가", "회사 공시 자체") */
  note?: string;
}
export type MetricId = "revenue" | "cogs" | "gp" | "opinc" | "opex";
export interface MetricSeries {
  metric: MetricId;
  unit: "USD" | "KRW";
  values: Record<string, MetricValue>;
}
export type CompanyType = "general" | "bank" | "broker" | "insurer" | "captive" | "reit";
export interface CompanyProfile {
  market: Market;
  symbol: string;
  cik: string;
  sic: number | null;
  type: CompanyType;
  filer: "domestic" | "20-F" | "40-F";
  adrRatio: number;
  reportingCurrency: string;
}

/** 조립 결과(공개 API `assemble` 반환). */
export interface FinAssembly {
  profile: CompanyProfile;
  annual: AssembledIs[];
  quarterly: AssembledIs[];
  metrics: { revenue: MetricSeries; cogs: MetricSeries; gp: MetricSeries; opinc: MetricSeries; opex: MetricSeries };
  gaps: number;
  /** 원천 조회 실패 등 사람이 읽는 경고(조립 항등식 불성립 포함) */
  warnings: string[];
  /**
   * 조립 항등식 불성립 열 — rev = 매출 경로 완전 판정 불성립(그 열 매출을 비움), unv = 매출 경로 판정 불완전(값은 두고 "항등식
   * 미검증" — 검증기 SEC 직접 대조 필수), other = 매출과 무관한 줄(값은 둠, 다음 지표 미결), der = 파생값 입력 자기 검사
   * 불일치(입력을 부호대로 더해 값이 재현되지 않음 — 값은 두고 표시, derived.ts)
   */
  issues: { col: string; rev: string[]; other: string[]; unv: string[]; der?: string[] }[];
  /** 가장 최근 정기공시 accn */
  latestAccn: string | null;
  at: string;
}
