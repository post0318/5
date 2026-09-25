import "server-only";
import { gapNames, loadFinSym, metricAt, type FinSymDoc } from "@/lib/fin";

/**
 * 미국 매출 — **재무 5층 구조(src/lib/fin)의 매출 지표만** 받아 화면 모듈에 나눠 준다(docs/metrics/revenue.md §3).
 * 손익계산서·총괄·재무분석·하이라이트·컨센서스·개요 PSR·TTM·유니버스가 모두 이 값을 쓴다 — 화면 모듈이 매출 태그를
 * 다시 고르거나 기간·판본을 다시 정하지 않는다(eslint: 매출 태그 직접 사용 금지).
 *
 * 열 = fin 열 그대로: 연간(FY, 최신 판본), 분기(3개월 — Q4 는 사업연도 − 9개월 누적), LTM.
 */

export interface RevCol {
  /** fin 열 키 — "FY2025" | "2026Q2" | "LTM" */
  key: string;
  kind: "FY" | "Q" | "LTM";
  fy: number;
  /** 분기 번호(1~4), 연간·LTM 은 0 */
  fq: number;
  start: string;
  end: string;
  v: number | null;
}

export interface UsRevenue {
  /** 연간 — 결산일 오름차순 */
  annual: RevCol[];
  /** 분기(Q4 포함) — 결산일 오름차순 */
  quarters: RevCol[];
  ltm: RevCol | null;
  /** fin 완전성 비트(0 = 완전) */
  gaps: number;
  /**
   * 완전하지 않은 열 — gaps 이름(IDENTITY·BASIS_SHIFT 등)과 조립 항등식 불성립. rev = 매출 줄이 걸린 불성립(그 열 매출은
   * 비어 있음), other = 매출과 무관한 줄의 불성립(매출 값은 유지 — 다음 지표 착수 때 닫을 미결)
   */
  issues: FinColIssue[];
}

export interface FinColIssue {
  col: string;
  gaps: string[];
  rev: string[];
  other: string[];
}

const Q_KEY = /^(\d{4})Q([1-4])$/;

export function revenueFromFinSym(sym: FinSymDoc): UsRevenue {
  const annual: RevCol[] = [];
  const quarters: RevCol[] = [];
  let ltm: RevCol | null = null;
  for (const c of sym.c) {
    const [key, start, end] = c;
    const v = metricAt(sym, "revenue", key);
    if (key === "LTM") ltm = { key, kind: "LTM", fy: 0, fq: 0, start, end, v };
    else if (/^FY\d{4}$/.test(key)) annual.push({ key, kind: "FY", fy: Number(key.slice(2)), fq: 0, start, end, v });
    else {
      const m = Q_KEY.exec(key);
      if (m) quarters.push({ key, kind: "Q", fy: Number(m[1]), fq: Number(m[2]), start, end, v });
    }
  }
  annual.sort((a, b) => a.end.localeCompare(b.end));
  quarters.sort((a, b) => a.end.localeCompare(b.end));
  const idf = new Map((sym.i ?? []).map(([k, r, o]) => [k, { rev: r, other: o }]));
  const issues: FinColIssue[] = sym.c
    .filter((c) => c[6] || idf.has(c[0]))
    .map((c) => ({ col: c[0], gaps: gapNames(c[6]), rev: idf.get(c[0])?.rev ?? [], other: idf.get(c[0])?.other ?? [] }));
  return { annual, quarters, ltm, gaps: sym.g, issues };
}

/** 종목의 매출 — 저장본(유니버스) 또는 비저장 조립(fin loadFinSym). 실패하면 null(소비처는 빈칸) */
export async function loadUsRevenue(symbol: string): Promise<UsRevenue | null> {
  const sym = await loadFinSym("us", symbol).catch(() => null);
  return sym ? revenueFromFinSym(sym) : null;
}

/** 사업연도 → 매출(값 있는 해만) */
export function revAnnualMap(r: UsRevenue | null | undefined): Map<number, number> {
  const out = new Map<number, number>();
  for (const c of r?.annual ?? []) if (c.v != null) out.set(c.fy, c.v);
  return out;
}

/** 사업연도 → 결산일 — fin 연간 열 전부(매출 값이 없는 열도 열 자체는 있다: 값만 빈칸) */
export function revAnnualEnds(r: UsRevenue | null | undefined): Map<number, string> {
  const out = new Map<number, string>();
  for (const c of r?.annual ?? []) out.set(c.fy, c.end);
  return out;
}

/** 표시할 사업연도 — fin 연간 열 최근 n개(오름차순) */
export function revAnnualYears(r: UsRevenue | null | undefined, n: number): number[] {
  return (r?.annual ?? []).map((c) => c.fy).slice(-n);
}

export function revLtm(r: UsRevenue | null | undefined): number | null {
  return r?.ltm?.v ?? null;
}

/** 분기 열(Q4 포함) — 최근 n개, 결산일 오름차순(매출 값이 없는 열도 열은 둔다 — 값만 빈칸) */
export function revQuarterCols(r: UsRevenue | null | undefined, n: number): RevCol[] {
  return (r?.quarters ?? []).slice(-n);
}

export const revQuarterLabel = (c: RevCol): string => `${c.fy} Q${c.fq}`;

/** 결산일(±6일)이 같은 분기 열 */
export function revQuarterAt(r: UsRevenue | null | undefined, end: string): RevCol | null {
  const t = Date.parse(end);
  return r?.quarters.find((c) => Math.abs(Date.parse(c.end) - t) <= 6 * 86_400_000) ?? null;
}

/** 재무제표 출처 표기용 한 줄 — 완전하지 않은 열(gaps·항등식). 없으면 null */
export function finIssueNote(r: UsRevenue | null | undefined): string | null {
  const xs = r?.issues ?? [];
  if (!xs.length) return null;
  return `fin 조립 미완전 열: ${xs
    .map((q) => `${q.col}[${q.gaps.join("·")}]${q.rev.length ? ` 매출 비움(항등식 ${q.rev.join("; ")})` : ""}${q.other.length ? ` 매출 외 항등식 ${q.other.join("; ")}` : ""}`)
    .join(" / ")}`;
}
