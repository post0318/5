import "server-only";
import { ensureIndexed, listJpReports, type JpDocRow } from "@/lib/db/jp-docs";
import { getJpFinStored, saveJpFin } from "@/lib/db/jp-fin";
import { addDays, redactEdinet } from "./edinet-store";
import { resolveEdinetByTicker } from "./edinetcode";
import { JP_PARSE_VERSION, loadJpDocFin, pkDur, pkInst, type JpDocFin, type JpLine, type JpStmtKind } from "./xbrl-fin";
import { AdapterError, type FinancialLineItem, type FinancialPeriod, type FinancialStatement } from "../types";

/**
 * **일본 3대 재무제표(손익·재무상태·현금흐름) 조립**(오너 결정 2026-10-08 — 미국·한국과 같은 페이지 구성, 원본 표현 그대로).
 *
 * 흐름: 종목 → EDINET 코드 → 공시 색인(jp_docs)에서 有価証券報告書(120)·訂正(130)·半期報告書(160)·訂正(170)·옛 四半期報告書 第2四半期(140)·訂正(150)
 *   → 서류마다 본표 판독(xbrl-fin.ts, 디스크 캐시) → 열·줄 조립 → DB(jp_fin) 저장 → 화면 DTO(FinancialStatement).
 *
 * 규칙
 *  - **열마다 출처 서류 하나**: 그 기간을 실은 서류 중 가장 나중 제출본(訂正 포함 — 이듬해 有報의 전기 열 = 재작성 값). 한 열 안에서 서류를 섞지 않는다
 *    (합계 = Σ 내역이 그 서류 안에서 성립).
 *  - **줄 = 표시 구조 그대로**: 최신 서류의 본표 줄 순서를 기준으로, 옛 서류에만 있는 줄은 그 서류에서 바로 앞 줄 뒤에 끼운다. 출처 서류 본표에
 *    없는 줄은 0 으로 채우지 않고 빈칸 + "본표에 별도 줄 없음".
 *  - 연간 = 최근 5개 사업연도 + 현재/LTM(최근 사업연도 + 그 뒤 반기 − 전년 같은 반기, 재무상태표는 반기말). 반기 보고서가 사업연도 뒤에 없으면 LTM = 최근 사업연도.
 *  - 분기 탭 = 반기 열(H1 = 반기 보고서, H2 = 사업연도 − 상반기, 재무상태표 H2 = 사업연도 말). 1·3분기 열은 아직 없음(TDnet·J-Quants 연결은 다음 단계).
 *  - 회계기준이 최신 서류와 다른 옛 서류(J-GAAP → IFRS 전환 등)는 섞지 않는다 — 그 연도는 열에서 빠지고 출처 문구에 적는다.
 *  - 금액은 엔 그대로(화면이 백만 단위로 나눠 표시), 부호 = 공시 그대로(표시 구조가 negatedLabel 인 줄만 뒤집음).
 * 저장: jp_fin(종목당 1건, 엔진판 JP_FIN_ENGINE + 서류 목록 서명) — 서명이 같으면 판독·조립 없이 저장본을 쓴다.
 */

export const JP_FIN_ENGINE = 3; // 2: 연간 열 부가 정보(x — EPS·BPS·DPS·주식수·리스부채 주석, 판독판 2) · 3: 기준이 다른 옛 有報의 주식수·DPS

const N_FY = 5;
const N_HALF = 6;
const LTM = "현재/LTM";

const NOTE = {
  noLine: "본표에 별도 줄 없음",
  noVal: "본표 해당 기간 값 없음(－)",
  noStmt: "이 기간 본표 공시 없음",
  ltmNoLine: "반기 본표에 별도 줄 없음 — LTM 계산 안 함",
  h2NoLine: "사업연도·상반기 본표 중 한쪽에 줄 없음 — 하반기 계산 안 함",
  perShare: "주당 지표 — 기간 차감·합산 안 함",
} as const;

/**
 * 저장 꼴 줄 사전(연간·반기 공통): [id(접두 줄임 — p: jppfs, g: jpigp, c: jpcrp, x: 회사 고유), 이름표, 표시(1 제목·2 합계·4 강조), 값 형식].
 * 용량(무료 DB 512MB) — 두 화면 단위가 같은 줄을 한 번만 담는다.
 */
type CLine = [string, string, number, ("eps" | "shares" | "pct")?];
interface Dict {
  L: CLine[];
  at: Map<string, number>;
}
const PREFIX: [string, string][] = [["jppfs_cor:", "p:"], ["jpigp_cor:", "g:"], ["jpcrp_cor:", "c:"], ["ext:", "x:"]];
const shortId = (id: string) => {
  for (const [a, b] of PREFIX) if (id.startsWith(a)) return b + id.slice(a.length);
  return id;
};
export const longId = (id: string) => {
  for (const [a, b] of PREFIX) if (id.startsWith(b)) return a + id.slice(b.length);
  return id;
};
interface CStmt {
  /** [줄 사전 번호, 들여쓰기] */
  lines: [number, number][];
  /** 줄 × 열 */
  v: (number | null)[][];
  /** [줄, 열, 주석 번호] */
  n?: [number, number, number][];
}
export interface JpFinView {
  cols: FinancialPeriod[];
  stmts: Partial<Record<JpStmtKind, CStmt>>;
  notes: string[];
  src: string[];
  /** 연간 열마다 주당 지표·주식수·리스부채 주석(하이라이트·재무분석 — jp-ev.ts). 엔진판 2 부터 */
  x?: JpColX[];
}
/**
 * 열 부가 정보 — 본표 밖(경영지표·株式の総数等·주석)에서 읽은 값. 계산은 jp-ev.ts 한 곳에서.
 *  eps: 손익 열과 같은 서류(그 기간을 실은 가장 나중 서류)의 경영지표 희석 EPS(없거나 "－"면 기본 EPS, 그것도 없으면 본표 EPS 줄)
 *  epsAt: 그 서류 제출일 — 그 뒤 분할만 주가에 되돌려 같은 주식 기준으로 맞춘다
 *  bps: 재무상태표 열과 같은 서류의 경영지표 BPS(IFRS 1株当たり親会社所有者帰属持分, J-GAAP 1株当たり純資産額)
 *  dps: 그 사업연도 有報 자신(당기)의 1株当たり配当額(개별 — 회사 단위) · dpsNil: 공시 "－"(무배당)
 *  sh: 그 기간 서류 자신의 기말 유통주식수(발행 − 회사 명의 자기주식) — 그 날의 실제 주식 기준
 */
export interface JpColX {
  eps?: number | null;
  epsK?: "diluted" | "basic" | "face";
  epsAt?: string | null;
  bps?: number | null;
  dps?: number | null;
  dpsNil?: 1;
  dpsInterim?: number | null;
  dpsAt?: string | null;
  sh?: number | null;
  shAt?: string | null;
  shIssued?: number | null;
  shIssuedFiling?: number | null;
  shWhy?: string | null;
  /** 리스부채 주석 문단 이름 · 이 열(전기/당기) 금액 */
  lease?: { tb: string[]; amt: number | null; doc: string } | null;
  isDoc?: string | null;
  bsDoc?: string | null;
}
export interface JpFinModel {
  ev: number;
  std: string | null;
  cons: boolean;
  /** 줄 사전 */
  L: CLine[];
  annual: JpFinView;
  half: JpFinView;
  warn: string[];
}

// ── 날짜 ──
function addYears(d: string, n: number): string {
  const y = Number(d.slice(0, 4)) + n;
  const md = d.slice(5) === "02-29" ? "02-28" : d.slice(5);
  return `${y}-${md}`;
}
const days = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5;

// ── 서류 ──
export interface Src {
  row: JpDocRow;
  fin: JpDocFin;
  at: string;
}
const keysOf = (s: Src, kind: JpStmtKind) => {
  const st = s.fin.stmts[kind];
  return st ? new Set(st.lines.filter((l) => !l.ab).map((l) => l.k)) : null;
};
/**
 * 그 서류 본표(kind)가 기간 열쇠 pk 의 열을 싣고 있나 — 그 기간 값이 있는 줄 수가 가장 많은 기간의 절반 이상일 때만.
 * "값이 하나라도 있으면"으로 보면 현금흐름표 기초 잔액(전전기 말 현금)이 재무상태표 현금 줄과 같은 개념이라 재무상태표 열이 있는 것처럼
 * 잡혀(도요타 FY2024 有報 → 2022-03-31) 다른 줄이 모두 빈 열의 출처가 됐다(2026-10-08 실측).
 */
const periodMemo = new WeakMap<Src, Map<JpStmtKind, Set<string>>>();
export function periodsOf(s: Src, kind: JpStmtKind): Set<string> {
  let m = periodMemo.get(s);
  if (!m) periodMemo.set(s, (m = new Map()));
  let set = m.get(kind);
  if (set) return set;
  const st = s.fin.stmts[kind];
  const count = new Map<string, number>();
  for (const l of st?.lines ?? []) {
    if (l.ab || l.ps) continue;
    for (const pk of Object.keys(s.fin.facts[l.k] ?? {})) {
      if ((kind === "bs") !== pk.startsWith("I")) continue;
      count.set(pk, (count.get(pk) ?? 0) + 1);
    }
  }
  const max = Math.max(0, ...count.values());
  set = new Set([...count].filter(([, n]) => n >= max / 2).map(([pk]) => pk));
  m.set(kind, set);
  return set;
}
const hasPeriod = (s: Src, kind: JpStmtKind, pk: string) => periodsOf(s, kind).has(pk);

/** 서류의 전기 사업연도 기간(당기 시작 전날로 끝나는 가장 긴 기간 — 변칙 결산 대비) */
function priorFy(f: JpDocFin): { start: string; end: string } | null {
  if (!f.fyStart) return null;
  const end = addDays(f.fyStart, -1);
  let best: string | null = null;
  for (const o of Object.values(f.facts))
    for (const pk of Object.keys(o)) {
      if (!pk.startsWith("D") || !pk.endsWith(`_${end}`)) continue;
      const st = pk.slice(1, 11);
      if (days(st, end) < 180) continue;
      if (!best || st < best) best = st;
    }
  return best ? { start: best, end } : null;
}

/** 공시 색인 — 확정 색인이 안 된 최근 날이 찾은 최신 서류보다 뒤면 더 새 서류를 놓쳤을 수 있다 → 503(옛 표를 조용히 보여 주지 않음) */
async function reportsChecked(edinetCode: string): Promise<JpDocRow[]> {
  const ix = await ensureIndexed({ days: 400 });
  const rows = await listJpReports(edinetCode);
  const gaps = [...ix.pending, ...ix.failed.map((f) => f.date)].sort();
  const newestGap = gaps.at(-1);
  const newest = rows[0]?.submitDateTime?.slice(0, 10);
  if (newestGap && (!newest || newestGap >= newest)) {
    const why = ix.failed[0] ? ` — 예: ${ix.failed[0].date} ${redactEdinet(ix.failed[0].error)}` : " — 배치 scripts/run/jp-edinet-index.mts 실행 필요";
    throw new AdapterError(`EDINET 서류 색인 미완료(${gaps.length}일, 최근 ${newestGap})${why}`.slice(0, 300), { status: 503 });
  }
  return rows;
}

/** 쓸 서류 고르기 — 有報 최근 5건 + 그 訂正, 반기(半期·옛 四半期 第2四半期) 최근 3건 + 그 訂正 */
function pickRows(rows: JpDocRow[]): { annual: JpDocRow[]; half: JpDocRow[] } {
  const by = (t: string) => rows.filter((r) => r.docTypeCode === t);
  const a120 = by("120").slice(0, N_FY);
  const aIds = new Set(a120.map((r) => r._id));
  const a130 = by("130").filter((r) => r.parentDocID && aIds.has(r.parentDocID));
  // 옛 四半期報告書는 第2四半期(상반기 누적)만 — 서류 설명에 "第2四半期"가 없는 회사가 있어(三菱重工 "四半期報告書") 기간으로도 판정:
  // 그 분기 시작월 = 사업연도 시작월 + 3
  const fyStartMonth = Number(a120[0]?.periodStart?.slice(5, 7) ?? NaN);
  const isQ2 = (r: JpDocRow) => {
    if (/第[2２]四半期/.test(r.docDescription ?? "")) return true;
    const m = Number(r.periodStart?.slice(5, 7) ?? NaN);
    return Number.isFinite(m) && Number.isFinite(fyStartMonth) && (m - fyStartMonth + 12) % 12 === 3;
  };
  const halves = rows.filter((r) => r.docTypeCode === "160" || (r.docTypeCode === "140" && isQ2(r))).slice(0, N_HALF / 2);
  const hIds = new Set(halves.map((r) => r._id));
  const hCorr = rows.filter((r) => (r.docTypeCode === "170" || r.docTypeCode === "150") && r.parentDocID && hIds.has(r.parentDocID));
  return { annual: [...a120, ...a130], half: [...halves, ...hCorr] };
}

// ── 줄 병합 ──
interface MLine extends JpLine {
  id: string;
}
function withIds(lines: JpLine[]): MLine[] {
  const occ = new Map<string, number>();
  return lines.map((l) => {
    const n = occ.get(l.k) ?? 0;
    occ.set(l.k, n + 1);
    return { ...l, id: `${l.k}#${n}` };
  });
}
/** 최신 서류 줄 순서 기준, 옛 서류에만 있는 줄은 그 서류에서 바로 앞 줄 뒤에 */
function mergeLines(docs: Src[], kind: JpStmtKind): MLine[] {
  const master: MLine[] = [];
  for (const s of docs) {
    const st = s.fin.stmts[kind];
    if (!st) continue;
    let after: string | null = null;
    for (const l of withIds(st.lines)) {
      const at = master.findIndex((m) => m.id === l.id);
      if (at >= 0) {
        after = l.id;
        continue;
      }
      const pos = after == null ? 0 : master.findIndex((m) => m.id === after) + 1;
      master.splice(pos, 0, l);
      after = l.id;
    }
  }
  return master;
}

// ── 강조 줄(주요 계정 — 배경색) ──
const HIGHLIGHT = new Set([
  "jppfs_cor:NetSales", "jppfs_cor:OperatingRevenue1", "jppfs_cor:OperatingRevenue2", "jppfs_cor:OrdinaryIncome1",
  "jppfs_cor:OperatingIncome", "jppfs_cor:OrdinaryIncome", "jppfs_cor:ProfitLossAttributableToOwnersOfParent",
  "jppfs_cor:Assets", "jppfs_cor:Liabilities", "jppfs_cor:NetAssets", "jppfs_cor:LiabilitiesAndNetAssets",
  "jppfs_cor:NetCashProvidedByUsedInOperatingActivities", "jppfs_cor:NetCashProvidedByUsedInInvestmentActivities",
  "jppfs_cor:NetCashProvidedByUsedInFinancingActivities", "jppfs_cor:CashAndCashEquivalents",
  "jpigp_cor:RevenueIFRS", "jpigp_cor:NetSalesIFRS", "jpigp_cor:OperatingProfitLossIFRS", "jpigp_cor:ProfitLossAttributableToOwnersOfParentIFRS",
  "jpigp_cor:AssetsIFRS", "jpigp_cor:LiabilitiesIFRS", "jpigp_cor:EquityIFRS", "jpigp_cor:LiabilitiesAndEquityIFRS",
  "jpigp_cor:NetCashProvidedByUsedInOperatingActivitiesIFRS", "jpigp_cor:NetCashProvidedByUsedInInvestingActivitiesIFRS",
  "jpigp_cor:NetCashProvidedByUsedInFinancingActivitiesIFRS", "jpigp_cor:CashAndCashEquivalentsIFRS",
]);
const HIGHLIGHT_LABEL = /^(売上収益|売上高|営業収益|収益|営業収益合計|売上収益合計|収益合計|経常収益)$/;

// ── 열 ──
interface Col {
  p: FinancialPeriod;
  start: string;
  end: string;
  kind: "FY" | "H1" | "H2" | "LTM";
}

class Cells {
  v: (number | null)[][];
  notes: string[] = [];
  n: [number, number, number][] = [];
  constructor(rows: number, cols: number) {
    this.v = Array.from({ length: rows }, () => Array<number | null>(cols).fill(null));
  }
  note(r: number, c: number, text: string) {
    let i = this.notes.indexOf(text);
    if (i < 0) i = this.notes.push(text) - 1;
    this.n.push([r, c, i]);
  }
}

/**
 * 한 칸 값 — 출처 서류 s 의 본표 kind 에서 줄 l 의 기간 값. 반환 [값, 사유]
 *  bs: 기말 시점, 그 밖: 기간 값(기초·기말 잔액 줄은 시점)
 */
function cell(s: Src | null, kind: JpStmtKind, l: MLine, start: string, end: string): [number | null, string | null] {
  if (!s) return [null, NOTE.noStmt];
  const ks = keysOf(s, kind);
  if (!ks) return [null, NOTE.noStmt];
  if (!ks.has(l.k)) return [null, NOTE.noLine];
  const pk = kind === "bs" || l.ps === "e" ? pkInst(end) : l.ps === "s" ? pkInst(addDays(start, -1)) : pkDur(start, end);
  const raw = s.fin.facts[l.k]?.[pk];
  if (raw == null) return [null, NOTE.noVal];
  return [l.neg ? -raw : raw, null];
}
const isPerShare = (docs: Src[], k: string) => docs.some((d) => d.fin.units[k] === "ps");

function fmtOf(docs: Src[], k: string): CLine[3] {
  for (const d of docs) {
    const u = d.fin.units[k];
    if (u === "ps") return "eps";
    if (u === "sh") return "shares";
    if (u === "p") return "pct";
    if (u === "m") return undefined;
  }
  return undefined;
}

function compactStmt(lines0: MLine[], cells: Cells, docs: Src[], notes: string[], dict: Dict): CStmt {
  // 이 화면 단위(연간·반기)의 어느 열에도 값이 없는 줄은 저장하지 않는다(용량 — 옛 서류에만 있던 줄). 아래 남은 줄이 없는 제목 줄도 뺀다
  const hasVal = lines0.map((l, r) => !l.ab && cells.v[r].some((x) => x != null));
  const keep = lines0.map((l, r) => {
    if (!l.ab) return hasVal[r];
    for (let j = r + 1; j < lines0.length && lines0[j].d > l.d; j++) if (hasVal[j]) return true;
    return false;
  });
  const idx = lines0.map((_, r) => r).filter((r) => keep[r]);
  const remap = new Map(idx.map((r, i) => [r, i]));
  const lines = idx.map((r) => lines0[r]);
  const out: CStmt = {
    lines: lines.map((l) => {
      const flags = (l.ab ? 1 : 0) | (l.tot ? 2 : 0) | (!l.ab && l.ps !== "s" && (HIGHLIGHT.has(l.k) || HIGHLIGHT_LABEL.test(l.l)) ? 4 : 0);
      const f = fmtOf(docs, l.k);
      const def = (f ? [shortId(l.id), l.l, flags, f] : [shortId(l.id), l.l, flags]) as CLine;
      const key = JSON.stringify(def);
      let i = dict.at.get(key);
      if (i == null) {
        i = dict.L.push(def) - 1;
        dict.at.set(key, i);
      }
      return [i, l.d] as [number, number];
    }),
    v: idx.map((r) => cells.v[r]),
  };
  // 주석 번호는 화면 단위(view) 공통 사전으로
  const kept = cells.n.filter(([r]) => remap.has(r));
  if (kept.length)
    out.n = kept.map(([r0, c, i]) => {
      const r = remap.get(r0)!;
      const t = cells.notes[i];
      let j = notes.indexOf(t);
      if (j < 0) j = notes.push(t) - 1;
      return [r, c, j];
    });
  return out;
}

const KINDS: JpStmtKind[] = ["is", "ci", "bs", "cf"];
const latestFirst = (a: Src, b: Src) => b.at.localeCompare(a.at);

function buildAnnual(annual: Src[], halfDocs: Src[], src: string[], dict: Dict, otherStd: Src[] = []): JpFinView {
  // 사업연도 열 후보 — 서류마다 당기·전기
  const fys = new Map<string, { start: string; end: string }>();
  for (const s of annual) {
    const f = s.fin;
    if (f.fyStart && f.fyEnd) fys.set(f.fyEnd, { start: f.fyStart, end: f.fyEnd });
    const p = priorFy(f);
    if (p && !fys.has(p.end)) fys.set(p.end, p);
  }
  const fyList = [...fys.values()].sort((a, b) => a.end.localeCompare(b.end)).slice(-N_FY);
  const cols: Col[] = fyList.map((x) => ({
    p: { label: `FY${x.end.slice(0, 4)}`, fiscalYear: Number(x.end.slice(0, 4)), fiscalQuarter: null, endDate: x.end },
    start: x.start,
    end: x.end,
    kind: "FY",
  }));
  const lastFy = cols.at(-1);
  // LTM — 최근 사업연도 뒤 반기 보고서(다음 사업연도 상반기)
  const h = lastFy
    ? [...halfDocs].sort(latestFirst).find((s) => s.fin.fyStart === addDays(lastFy.end, 1) && s.fin.perEnd && s.fin.perEnd > lastFy.end)
    : undefined;
  if (lastFy) {
    cols.push({
      p: { label: LTM, fiscalYear: lastFy.p.fiscalYear, fiscalQuarter: null, endDate: h ? h.fin.perEnd! : lastFy.end },
      start: h ? addDays(addYears(h.fin.perEnd!, -1), 1) : lastFy.start,
      end: h ? h.fin.perEnd! : lastFy.end,
      kind: "LTM",
    });
    src.push(
      h
        ? `현재/LTM = ${lastFy.p.label} + ${h.fin.perEnd} 반기 누적 − 전년 같은 반기(반기 보고서 ${h.row._id}), 재무상태표는 ${h.fin.perEnd} 반기말`
        : `현재/LTM = ${lastFy.p.label}(그 뒤 반기 보고서 아직 없음)`,
    );
  }

  const view: JpFinView = { cols: cols.map((c) => c.p), stmts: {}, notes: [], src };
  const sorted = [...annual].sort(latestFirst);
  for (const kind of KINDS) {
    const lines = mergeLines(sorted, kind);
    if (!lines.length) continue;
    const cells = new Cells(lines.length, cols.length);
    const fySrc = new Map<string, Src | null>();
    cols.forEach((c, ci) => {
      if (c.kind === "FY") {
        const pk = kind === "bs" ? pkInst(c.end) : pkDur(c.start, c.end);
        const s = sorted.find((d) => hasPeriod(d, kind, pk)) ?? null;
        fySrc.set(c.end, s);
        lines.forEach((l, r) => {
          if (l.ab) return;
          const [v, why] = cell(s, kind, l, c.start, c.end);
          cells.v[r][ci] = v;
          if (why) cells.note(r, ci, why);
        });
        return;
      }
      // LTM
      const F = lastFy!;
      const fs = fySrc.get(F.end) ?? null;
      lines.forEach((l, r) => {
        if (l.ab) return;
        if (!h) {
          const [v, why] = cell(fs, kind, l, F.start, F.end);
          cells.v[r][ci] = v;
          if (why) cells.note(r, ci, why);
          return;
        }
        if (kind === "bs" || l.ps) {
          // 시점 값 — 반기 보고서(재무상태표 반기말, 현금흐름표 기초 = 전년 반기말·기말 = 반기말)
          const [v, why] = cell(h, kind, l, c.start, c.end);
          cells.v[r][ci] = v;
          if (why) cells.note(r, ci, why === NOTE.noLine ? NOTE.ltmNoLine : why);
          return;
        }
        if (isPerShare(sorted, l.k)) {
          cells.note(r, ci, NOTE.perShare);
          return;
        }
        const [fy, w1] = cell(fs, kind, l, F.start, F.end);
        const [hc, w2] = cell(h, kind, l, h.fin.fyStart!, h.fin.perEnd!);
        const [hp, w3] = cell(h, kind, l, F.start, addYears(h.fin.perEnd!, -1));
        if (fy == null || hc == null || hp == null) {
          const why = w2 === NOTE.noLine ? NOTE.ltmNoLine : (w1 ?? w2 ?? w3 ?? NOTE.noVal);
          cells.note(r, ci, why);
          return;
        }
        cells.v[r][ci] = fy + hc - hp;
      });
    });
    view.stmts[kind] = compactStmt(lines, cells, sorted, view.notes, dict);
    // 열별 출처
    const used = cols.filter((c) => c.kind === "FY").map((c) => `${c.p.label} ${fySrc.get(c.end)?.row._id ?? "없음"}`);
    if (kind === "is" || kind === "bs") src.push(`${kind === "is" ? "손익" : "재무상태"} 열 출처: ${used.join(", ")}`);
  }
  // 주식수·DPS 는 회계기준과 무관(株式の総数等·경영지표 개별) — 기준이 달라 본표에서 뺀 옛 有報(무라타 US GAAP)도 그 해 자신의 서류로 쓴다
  const own = [...sorted, ...[...otherStd].sort(latestFirst)];
  view.x = cols.map((c) => colExtra(c, sorted, h ?? null, own));
  return view;
}

// 경영지표 주당 지표 태그(jpcrp_cor) — xbrl-fin.ts SUM_TAGS
const EPS_D = ["DilutedEarningsLossPerShareIFRSSummaryOfBusinessResults", "DilutedEarningsPerShareSummaryOfBusinessResults"];
const EPS_B = ["BasicEarningsLossPerShareIFRSSummaryOfBusinessResults", "BasicEarningsLossPerShareSummaryOfBusinessResults"];
const BPS = ["EquityToAssetRatioIFRSSummaryOfBusinessResults", "NetAssetsPerShareSummaryOfBusinessResults"];
const FACE_EPS = [
  "jpigp_cor:DilutedEarningsLossPerShareIFRS",
  "jpigp_cor:BasicAndDilutedEarningsLossPerShareIFRS",
  "jpigp_cor:BasicEarningsLossPerShareIFRS",
];

/** 경영지표 값 — 연결(차원 없음) 우선, 연결 재무제표가 없는 회사는 개별(|nc). [값, 태그가 있었나(nil 포함)] */
function sumOf(s: Src | null, tags: string[], pk: string): [number | null, boolean] {
  if (!s?.fin.sum) return [null, false];
  const keys = s.fin.cons === false ? [`${pk}|nc`] : [pk];
  let seen = false;
  for (const t of tags)
    for (const k of keys) {
      const o = s.fin.sum[t];
      if (!o || !(k in o)) continue;
      seen = true;
      if (o[k] != null) return [o[k], true];
    }
  return [null, seen];
}

/** 열 부가 정보(JpColX) — 출처 서류 고르기 규칙은 본표 열과 같다(그 기간을 실은 가장 나중 서류) */
function colExtra(c: Col, sorted: Src[], h: Src | null, ownDocs: Src[]): JpColX {
  const x: JpColX = {};
  const shOf = (s: Src | null) => {
    const r = s?.fin.shares;
    if (!s || !r) {
      x.sh = null;
      x.shWhy = s ? `${s.row._id} 株式の総数等 판독 없음` : "그 기간 서류 없음";
      return;
    }
    x.shAt = r.at ?? s.fin.perEnd ?? s.fin.fyEnd;
    x.shIssued = r.issued;
    x.shIssuedFiling = r.issuedFiling;
    x.sh = r.issued != null && r.treasury != null ? r.issued - r.treasury : null;
    x.shWhy = x.sh == null ? (r.issued == null ? "발행주식수 판독 없음" : r.how) : r.how;
  };
  const leaseOf = (s: Src | null, end: string) => {
    const tb = s?.fin.leaseTb;
    if (!s || !tb) return;
    const cur = end === (s.fin.perEnd ?? s.fin.fyEnd);
    const withAmt = tb.find((t) => t.amt);
    x.lease = { tb: tb.map((t) => t.n), amt: withAmt?.amt ? withAmt.amt[cur ? 1 : 0] : null, doc: s.row._id };
  };
  if (c.kind === "LTM" && h) {
    // 반기 보고서 뒤 LTM — 재무상태표·주식수는 반기말. 주당 지표는 jp-ev.ts 가 LTM 순이익 ÷ 주식수로(흐름식 주당 지표 금지)
    shOf(h);
    leaseOf(h, c.end);
    x.bsDoc = h.row._id;
    return x;
  }
  const pkD = pkDur(c.start, c.end);
  const isS = sorted.find((d) => hasPeriod(d, "is", pkD)) ?? null;
  const bsS = sorted.find((d) => hasPeriod(d, "bs", pkInst(c.end))) ?? null;
  // 그 사업연도 有報 자신(당기 = 이 열) — 訂正 포함 가장 나중 것
  const own = ownDocs.find((d) => d.fin.fyEnd === c.end && (d.fin.perEnd ?? d.fin.fyEnd) === c.end) ?? null;
  x.isDoc = isS?.row._id ?? null;
  x.bsDoc = bsS?.row._id ?? null;
  // EPS — 희석(“－” 이면 희석 증권 없음 → 기본), 경영지표에 없으면 본표 EPS 줄
  const [d] = sumOf(isS, EPS_D, pkD);
  const [b] = sumOf(isS, EPS_B, pkD);
  x.eps = null;
  if (d != null) [x.eps, x.epsK] = [d, "diluted"];
  else if (b != null) [x.eps, x.epsK] = [b, "basic"];
  else
    for (const k of FACE_EPS) {
      const v = isS?.fin.facts[k]?.[pkD];
      if (v != null) {
        [x.eps, x.epsK] = [v, "face"];
        break;
      }
    }
  x.epsAt = isS?.at ?? null;
  x.bps = sumOf(bsS, BPS, pkInst(c.end))[0];
  // DPS — 회사 단위(개별) 경영지표. 그 사업연도 有報 자신의 당기 값, 없으면 손익 열 서류의 그 기간 값
  const dpsDoc = own ?? isS;
  const o = dpsDoc?.fin.sum?.["DividendPaidPerShareSummaryOfBusinessResults"];
  const kNc = `${pkD}|nc`;
  if (o && kNc in o) {
    x.dps = o[kNc];
    if (o[kNc] == null) x.dpsNil = 1;
  } else x.dps = null;
  x.dpsInterim = dpsDoc?.fin.sum?.["InterimDividendPaidPerShareSummaryOfBusinessResults"]?.[kNc] ?? null;
  x.dpsAt = dpsDoc?.at ?? null;
  shOf(own);
  leaseOf(bsS, c.end);
  return x;
}

function buildHalf(annual: Src[], halfDocs: Src[], src: string[], dict: Dict): JpFinView {
  const sortedH = [...halfDocs].sort(latestFirst);
  const sortedA = [...annual].sort(latestFirst);
  // 상반기 열 후보 — 반기 서류마다 당기·전년 같은 반기
  const h1 = new Map<string, { start: string; end: string }>();
  for (const s of sortedH) {
    const f = s.fin;
    if (!f.fyStart || !f.perEnd) continue;
    h1.set(f.perEnd, { start: f.fyStart, end: f.perEnd });
    const ps = addYears(f.fyStart, -1);
    const pe = addYears(f.perEnd, -1);
    if (!h1.has(pe) && sortedH.some((d) => hasPeriod(d, "is", pkDur(ps, pe)))) h1.set(pe, { start: ps, end: pe });
  }
  const cols: Col[] = [];
  for (const x of [...h1.values()].sort((a, b) => a.end.localeCompare(b.end))) {
    const fyEnd = addDays(addYears(x.start, 1), -1);
    const fyLabel = fyEnd.slice(0, 4);
    cols.push({ p: { label: `${fyLabel} H1`, fiscalYear: Number(fyLabel), fiscalQuarter: 2, endDate: x.end }, start: x.start, end: x.end, kind: "H1" });
    // 하반기 — 그 사업연도 有報가 있을 때만
    if (sortedA.some((d) => hasPeriod(d, "is", pkDur(x.start, fyEnd)) || hasPeriod(d, "bs", pkInst(fyEnd))))
      cols.push({ p: { label: `${fyLabel} H2`, fiscalYear: Number(fyLabel), fiscalQuarter: 4, endDate: fyEnd }, start: addDays(x.end, 1), end: fyEnd, kind: "H2" });
  }
  const shown = cols.slice(-N_HALF);
  const view: JpFinView = { cols: shown.map((c) => c.p), stmts: {}, notes: [], src };
  if (shown.some((c) => c.kind === "H2")) src.push("H2(하반기) = 사업연도(有価証券報告書) − 상반기(반기 보고서), 재무상태표 H2 = 사업연도 말");
  src.push("1·3분기 열 없음 — EDINET 은 2024년 4월부터 반기·연간만(옛 四半期報告書·TDnet 분기 연결은 다음 단계)");
  for (const kind of KINDS) {
    const lines = mergeLines(sortedH, kind);
    if (!lines.length) continue;
    const cells = new Cells(lines.length, shown.length);
    const h1Src = new Map<string, Src | null>();
    const srcOf = (c: Col) => {
      const pk = kind === "bs" ? pkInst(c.end) : pkDur(c.start, c.end);
      return sortedH.find((d) => hasPeriod(d, kind, pk)) ?? null;
    };
    shown.forEach((c, ci) => {
      if (c.kind === "H1") {
        const s = srcOf(c);
        h1Src.set(c.end, s);
        lines.forEach((l, r) => {
          if (l.ab) return;
          const [v, why] = cell(s, kind, l, c.start, c.end);
          cells.v[r][ci] = v;
          if (why) cells.note(r, ci, why);
        });
        return;
      }
      // H2 — 사업연도 출처 서류와 상반기 출처 서류
      const fyStart = addYears(addDays(c.end, 1), -1);
      const h1End = addDays(c.start, -1);
      const pkFy = kind === "bs" ? pkInst(c.end) : pkDur(fyStart, c.end);
      const fs = sortedA.find((d) => hasPeriod(d, kind, pkFy)) ?? null;
      const hs = h1Src.get(h1End) ?? srcOf({ ...c, start: fyStart, end: h1End, kind: "H1" });
      lines.forEach((l, r) => {
        if (l.ab) return;
        if (kind === "bs" || l.ps === "e") {
          const [v, why] = cell(fs, kind, l, fyStart, c.end);
          cells.v[r][ci] = v;
          if (why) cells.note(r, ci, why);
          return;
        }
        if (l.ps === "s") {
          // 하반기 기초 = 상반기 말 잔액
          const [v, why] = cell(hs, kind, { ...l, ps: "e" }, fyStart, h1End);
          cells.v[r][ci] = v;
          if (why) cells.note(r, ci, why);
          return;
        }
        if (isPerShare(sortedH, l.k)) {
          cells.note(r, ci, NOTE.perShare);
          return;
        }
        const [fy, w1] = cell(fs, kind, l, fyStart, c.end);
        const [hv, w2] = cell(hs, kind, l, fyStart, h1End);
        if (fy == null || hv == null) {
          cells.note(r, ci, w1 === NOTE.noLine || w2 === NOTE.noLine ? NOTE.h2NoLine : (w1 ?? w2 ?? NOTE.noVal));
          return;
        }
        cells.v[r][ci] = fy - hv;
      });
    });
    view.stmts[kind] = compactStmt(lines, cells, sortedH, view.notes, dict);
    if (kind === "is") src.push(`상반기 열 출처: ${shown.filter((c) => c.kind === "H1").map((c) => `${c.p.label} ${h1Src.get(c.end)?.row._id ?? "없음"}`).join(", ")}`);
  }
  return view;
}

/** 종목 → 쓸 서류 목록과 서명(판독판 + docID) */
export async function jpPickedRows(symbol: string): Promise<{ annual: JpDocRow[]; half: JpDocRow[]; sig: string }> {
  const e = await resolveEdinetByTicker(symbol);
  const rows = await reportsChecked(e.edinetCode);
  const picked = pickRows(rows);
  if (!picked.annual.length && !picked.half.length) {
    throw new AdapterError("EDINET 색인에 有価証券報告書·半期報告書가 없습니다(2021-07 이후)", { status: 404 });
  }
  const sig = `p${JP_PARSE_VERSION}|` + [...picked.annual, ...picked.half].map((r) => r._id).sort().join(",");
  return { ...picked, sig };
}

export interface JpSources {
  annual: Src[];
  half: Src[];
  /** 회계기준이 최신 서류와 달라 본표에서 뺀 有報 — 주식수·DPS(기준 무관)에만 쓴다 */
  otherStd: Src[];
  std: string | null;
  cons: boolean;
  warn: string[];
}
/** 서류 판독(디스크 캐시) + 회계기준 정리 — 최신 서류 기준과 다른 옛 서류는 뺀다. 서류별 판독 실패는 warn 에 */
export async function jpLoadSources(picked: { annual: JpDocRow[]; half: JpDocRow[] }): Promise<JpSources> {
  const warn: string[] = [];
  const load = async (rs: JpDocRow[]): Promise<Src[]> => {
    const out: Src[] = [];
    for (const row of rs) {
      try {
        const fin = await loadJpDocFin(row._id);
        if (!Object.keys(fin.stmts).length) {
          // 訂正 서류 중 재무제표를 다시 싣지 않은 것 — 원 서류를 쓴다(정상)
          if (row.docTypeCode !== "130" && row.docTypeCode !== "170" && row.docTypeCode !== "150") warn.push(`${row._id} 본표 없음`);
          continue;
        }
        for (const w of fin.warn) warn.push(`${row._id}: ${w}`);
        out.push({ row, fin, at: row.submitDateTime ?? "" });
      } catch (err) {
        warn.push(`${row._id} 판독 실패 — ${redactEdinet(err instanceof Error ? err.message : String(err))}`);
      }
    }
    return out;
  };
  let annual = await load(picked.annual);
  let half = await load(picked.half);
  const latest = [...annual, ...half].sort(latestFirst)[0];
  const std = latest?.fin.std ?? null;
  const dropped = [...annual, ...half].filter((s) => s.fin.std !== std);
  if (dropped.length) warn.push(`회계기준이 다른 옛 서류 제외(${std} 기준): ${dropped.map((s) => `${s.row._id}(${s.fin.std})`).join(", ")}`);
  const otherStd = annual.filter((s) => s.fin.std !== std);
  annual = annual.filter((s) => s.fin.std === std);
  half = half.filter((s) => s.fin.std === std);
  const cons = latest ? (Object.values(latest.fin.stmts)[0]?.cons ?? false) : false;
  return { annual, half, otherStd, std, cons, warn };
}

const inflight = new Map<string, Promise<JpFinModel>>();
/**
 * 종목의 조립 결과 — 저장본(엔진판·서명 일치)이 있으면 그대로, 없으면 서류 판독·조립 후 저장. 화면이 손익·재무상태·현금흐름·총괄을 동시에
 * 부르므로 같은 종목 조립은 프로세스 안에서 한 번만 돈다.
 */
export function getJpFinModel(symbol: string): Promise<JpFinModel> {
  let p = inflight.get(symbol);
  if (!p) {
    p = buildJpFinModel(symbol).finally(() => inflight.delete(symbol));
    inflight.set(symbol, p);
  }
  return p;
}

async function buildJpFinModel(symbol: string): Promise<JpFinModel> {
  const picked = await jpPickedRows(symbol);
  const id = `jp:${symbol}`;
  const stored = await getJpFinStored(id, JP_FIN_ENGINE, picked.sig);
  if (stored) return stored;
  const { annual, half, otherStd, std, cons, warn } = await jpLoadSources(picked);
  const head = `EDINET XBRL 본표(${std ?? "기준 미상"} · ${cons ? "連結" : "個別"}) — 회사 표시 구조·계정명·부호 그대로`;
  const dict: Dict = { L: [], at: new Map() };
  const model: JpFinModel = {
    ev: JP_FIN_ENGINE,
    std,
    cons,
    L: dict.L,
    annual: buildAnnual(annual, half, [head], dict, otherStd),
    half: buildHalf(annual, half, [head], dict),
    warn: [...new Set(warn)].slice(0, 40),
  };
  // 판독 실패가 있으면 저장하지 않는다(다음 요청이 다시 시도)
  if (!warn.some((w) => /판독 실패/.test(w))) await saveJpFin(id, JP_FIN_ENGINE, picked.sig, model);
  return model;
}

const TITLES: Record<JpStmtKind, string> = { is: "손익계산서", ci: "포괄손익계산서", bs: "재무상태표", cf: "현금흐름표" };

/** 저장 꼴 → 화면 DTO. view: is(손익+포괄손익)·bs·cf·summary(합계·주요 줄만) */
export function jpStatementView(
  model: JpFinModel,
  symbol: string,
  view: "is" | "bs" | "cf" | "summary",
  period: "annual" | "quarter",
): FinancialStatement {
  const v = period === "annual" ? model.annual : model.half;
  const kinds: JpStmtKind[] = view === "is" ? ["is", "ci"] : view === "bs" ? ["bs"] : view === "cf" ? ["cf"] : ["is", "bs", "cf"];
  const sections = kinds
    .filter((k) => v.stmts[k])
    .map((k) => {
      const st = v.stmts[k]!;
      const noteAt = new Map<string, string>();
      for (const [r, c, i] of st.n ?? []) noteAt.set(`${r}:${c}`, v.notes[i]);
      const items: FinancialLineItem[] = [];
      st.lines.forEach(([li, depth], r) => {
        const [sid, label, flags, fmt] = model.L[li];
        const id = longId(sid);
        const ab = (flags & 1) !== 0;
        const tot = (flags & 2) !== 0;
        const hl = (flags & 4) !== 0;
        if (view === "summary" && (ab || !(tot || hl))) return;
        // 보이는 열 어디에도 값이 없는 줄(옛 서류에만 있던 줄 등)은 숨긴다 — 미국·한국 화면의 "있는 경우에만 표시"(2026-10-01)와 같은 원칙
        if (!ab && v.cols.every((_, c) => st.v[r][c] == null)) return;
        const values: Record<string, number | null> = {};
        const cellNotes: Record<string, string> = {};
        v.cols.forEach((p, c) => {
          values[p.label] = ab ? null : st.v[r][c];
          const n = noteAt.get(`${r}:${c}`);
          if (n && !ab) cellNotes[p.label] = n;
        });
        items.push({
          accountName: label,
          accountId: `${k}:${id}`,
          depth: view === "summary" ? 0 : depth,
          isSubtotal: ab || tot,
          isHighlight: hl,
          values,
          ...(fmt ? { numberFormat: fmt } : {}),
          ...(Object.keys(cellNotes).length ? { cellNotes } : {}),
        });
      });
      // 아래에 남은 줄이 없는 제목 줄(Abstract) 정리
      const kept = items.filter((it, i) => {
        if (!(it.isSubtotal && v.cols.every((p) => it.values[p.label] == null) && !it.cellNotes)) return true;
        const next = items[i + 1];
        return next != null && next.depth > it.depth;
      });
      return { title: TITLES[k], items: kept };
    })
    .filter((s) => s.items.length);
  return {
    symbol,
    market: "jp",
    periodType: period,
    unit: "JPY",
    currency: "JPY",
    consolidation: model.cons ? "consolidated" : "separate",
    periods: v.cols,
    sections,
    source: v.src.join(" · "),
    sourceUrl: "https://disclosure2.edinet-fsa.go.jp/week0010.aspx",
    ...(model.warn.length ? { warnings: model.warn.slice(0, 10) } : {}),
  };
}
