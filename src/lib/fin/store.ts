import "server-only";
import { finChgCol, finStmtCol, finSymCol, type FinChgDoc, type FinColTuple, type FinExc, type FinStmtDoc, type FinSymDoc } from "../db/fin";
import { Gap, type AssembledIs, type Column, type FinAssembly, type MetricValue, type Prov } from "./types";

/**
 * 저장·조회(architecture.md §3). 조립 결과만 저장한다(SEC 원자료 저장 안 함). 이전 판본은 복사하지 않고, 바뀐 칸만
 * fin_chg 에 쓴 뒤 본문서를 교체한다.
 */

/** 엔진판 — 판독·조립 규칙이 바뀌면 올린다(fin_chg 사유 "ev") */
export const ENGINE_VERSION = 2;
/** 문서 스키마판 — 압축 형식이 바뀌면 올린다 */
export const SCHEMA_VERSION = 1;

const MAX_DICT = 4096;
const MAX_LINES = 2047;

function colTuple(c: Column): FinColTuple {
  if (Array.isArray(c.src)) return [c.key, c.start, c.end, null, c.kind === "Q" ? "QD" : c.kind, null, c.gaps];
  const p = c.src as Prov;
  return [c.key, c.start, c.end, p.accn, p.form, p.filed, c.gaps];
}

function excOf(mv: MetricValue): FinExc | null {
  if (mv.why?.k === "derived") return { d: mv.why.parts.map((p) => [p.accn, p.sign]) };
  if (mv.why?.k === "fx") return { k: "fx", r: mv.why.rate };
  if (mv.why?.k === "yahoo-q") return { k: "yq", t: mv.why.through };
  return null;
}

export function toSymDoc(a: FinAssembly): FinSymDoc {
  const seen = new Set<string>();
  const cols: Column[] = [];
  for (const x of [...a.annual, ...a.quarterly]) if (!seen.has(x.col.key)) { seen.add(x.col.key); cols.push(x.col); }
  const rev = a.metrics.revenue.values;
  const x: Record<string, FinExc> = {};
  for (const c of cols) {
    const mv = rev[c.key];
    if (!mv) continue;
    const e = excOf(mv);
    if (e) x[c.key] = e;
  }
  return {
    _id: `${a.profile.market}:${a.profile.symbol}`,
    ev: ENGINE_VERSION, sv: SCHEMA_VERSION, at: new Date(), la: a.latestAccn,
    p: { t: a.profile.type, fl: a.profile.filer, sic: a.profile.sic, cur: a.profile.reportingCurrency, adr: a.profile.adrRatio },
    g: a.gaps,
    c: cols.map(colTuple),
    m: { rev: cols.map((c) => rev[c.key]?.v ?? null) },
    x: { rev: x },
  };
}

export function toStmtDoc(id: string, cols: AssembledIs[], labels: Map<string, string>): FinStmtDoc {
  const dict: [string, string][] = [];
  const di = new Map<string, number>();
  const s: number[][] = [];
  const v: (number | null)[][] = [];
  for (const a of cols) {
    if (a.lines.length > MAX_LINES) throw new Error(`fin_stmt ${id} ${a.col.key}: 열당 줄 상한 초과(${a.lines.length}) — sv 를 올려야 함`);
    const row: number[] = [];
    for (const ln of a.lines) {
      let k = di.get(ln.id);
      if (k == null) {
        k = dict.length;
        if (k >= MAX_DICT) throw new Error(`fin_stmt ${id}: 줄 사전 상한 초과 — sv 를 올려야 함`);
        di.set(ln.id, k);
        dict.push([ln.id, labels.get(ln.id) ?? ln.label]);
      }
      row.push(k * 4096 + (ln.parent == null ? 0 : (ln.parent + 1) * 2) + (ln.w < 0 ? 1 : 0));
    }
    s.push(row);
    v.push(a.lines.map((l) => l.v));
  }
  return { _id: id, ev: ENGINE_VERSION, l: dict, c: cols.map((a) => a.col.key), s, v };
}

/** 압축 구조 → (줄 id, 부모 위치, 가중치) */
export function decodeStmt(doc: FinStmtDoc, colKey: string): { id: string; label: string; parent: number | null; w: 1 | -1 | 0; v: number | null }[] | null {
  const ci = doc.c.indexOf(colKey);
  if (ci < 0) return null;
  return doc.s[ci].map((n, i) => {
    const dictIdx = Math.floor(n / 4096);
    const rest = n % 4096;
    const parent = rest >> 1 ? (rest >> 1) - 1 : null;
    return { id: doc.l[dictIdx][0], label: doc.l[dictIdx][1], parent, w: parent == null ? 0 : rest & 1 ? -1 : 1, v: doc.v[ci][i] };
  });
}

function stmtCells(doc: FinStmtDoc): Map<string, number | null> {
  const out = new Map<string, number | null>();
  doc.c.forEach((ck, ci) => doc.s[ci].forEach((n, i) => out.set(`${ck}|${doc.l[Math.floor(n / 4096)][0]}`, doc.v[ci][i])));
  return out;
}

/** 저장 — 바뀐 칸만 fin_chg, 본문서 교체. 원자료 조회 실패(부분 판독)면 기존 문서를 유지하고 gaps 비트만 올린다(§5.1) */
export async function persist(a: FinAssembly, stmts: { annual: FinStmtDoc; quarterly: FinStmtDoc }): Promise<{ changed: number; kept: boolean }> {
  const symCol = await finSymCol();
  const stmtCol = await finStmtCol();
  const chgCol = await finChgCol();
  const sym = toSymDoc(a);
  const old = await symCol.findOne({ _id: sym._id });
  if (old && a.gaps & (Gap.CF_FETCH | Gap.STALE)) {
    await symCol.updateOne({ _id: sym._id }, { $set: { g: old.g | a.gaps, at: new Date() } });
    return { changed: 0, kept: true };
  }
  const now = new Date();
  const chg: FinChgDoc[] = [];
  const r: FinChgDoc["r"] = old && old.ev !== ENGINE_VERSION ? "ev" : "data";
  if (old) {
    const o = new Map(old.c.map((c, i) => [c[0], old.m.rev?.[i] ?? null]));
    sym.c.forEach((c, i) => {
      const n = sym.m.rev[i];
      const ov = o.has(c[0]) ? o.get(c[0])! : null;
      if (ov !== n) chg.push({ k: sym._id, at: now, ev: ENGINE_VERSION, t: "m.rev", c: c[0], o: ov, n, r });
    });
  }
  for (const doc of [stmts.annual, stmts.quarterly]) {
    const prev = await stmtCol.findOne({ _id: doc._id });
    if (prev) {
      const pc = stmtCells(prev), nc = stmtCells(doc);
      const tag = doc._id.split(":").slice(2).join(".");
      for (const [k, n] of nc) {
        const ov = pc.has(k) ? pc.get(k)! : null;
        if (ov !== n) { const [c, line] = k.split("|"); chg.push({ k: sym._id, at: now, ev: ENGINE_VERSION, t: `${tag}:${line}`, c, o: ov, n, r }); }
      }
    }
    await stmtCol.replaceOne({ _id: doc._id }, doc, { upsert: true });
  }
  await symCol.replaceOne({ _id: sym._id }, sym, { upsert: true });
  if (chg.length) await chgCol.insertMany(chg);
  return { changed: chg.length, kept: false };
}

/** 조립 실패(원천 조회 불가) — 기존 문서가 있으면 gaps 만 올린다 */
export async function markFailed(id: string, gaps: number): Promise<void> {
  const symCol = await finSymCol();
  await symCol.updateOne({ _id: id }, { $bit: { g: { or: gaps } }, $set: { at: new Date() } });
}

export async function readSym(id: string): Promise<FinSymDoc | null> {
  return (await finSymCol()).findOne({ _id: id });
}
export async function readStmt(id: string): Promise<FinStmtDoc | null> {
  return (await finStmtCol()).findOne({ _id: id });
}
