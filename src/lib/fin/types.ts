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
  unit: "USD" | "KRW" | "shares" | "USD/shares";
  prov: Prov;
  why?: ReadWhy;
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
  | "cogs" | "gross" | "opinc" | "pretax" | "tax" | "ni" | "ni.parent";
export interface StmtLine {
  id: string;
  label: string;
  parent: number | null;
  w: 1 | -1 | 0;
  role: LineRole | null;
  v: number | null;
  why?: ReadWhy;
}
export interface AssembledIs {
  col: Column;
  lines: StmtLine[];
  identity: { ok: boolean; fails: string[] };
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
}
export interface MetricSeries {
  metric: "revenue";
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
  metrics: { revenue: MetricSeries };
  gaps: number;
  /** 원천 조회 실패 등 사람이 읽는 경고 */
  warnings: string[];
  /** 가장 최근 정기공시 accn */
  latestAccn: string | null;
  at: string;
}
