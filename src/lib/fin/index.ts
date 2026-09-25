import "server-only";
import { UsReader } from "./read";
import { assembleIncomeStatements } from "./assemble/is";
import { revenue } from "./metrics/revenue";
import { markFailed, persist, readStmt, readSym, toStmtDoc, toSymDoc } from "./store";
import { Gap, type FinAssembly, type Market } from "./types";
import type { FinStmtDoc, FinSymDoc } from "../db/fin";

/**
 * 재무 5층 구조 공개 API(architecture.md §2·§4). 소비처는 이 파일만 import 한다(eslint S1).
 *  - assemble(market, symbol, {persist}) — 0~3층 실행. persist=true 면 저장(유니버스 종목, §5.1), false 면 비저장 조립(§5.3)
 *  - getFinSym / getFinStmt — 저장본 조회(§5.2)
 *  - metricAt — 저장본에서 지표 한 칸
 */

export type { FinAssembly, Market } from "./types";
export type { FinStmtDoc, FinSymDoc } from "../db/fin";
export { gapNames } from "./types";

export interface AssembleOpts {
  persist?: boolean;
  annual?: number;
  quarterly?: number;
}

export async function assemble(market: Market, symbol: string, opts: AssembleOpts = {}): Promise<FinAssembly & { stmts: { annual: FinStmtDoc; quarterly: FinStmtDoc }; persisted?: { changed: number; kept: boolean } }> {
  if (market !== "us") throw new Error("한국(DART) 어댑터는 아직 없음 — architecture.md §10");
  const sym = symbol.toUpperCase();
  let reader: UsReader;
  try {
    reader = await UsReader.open(sym);
  } catch (e) {
    if (opts.persist) await markFailed(`${market}:${sym}`, Gap.CF_FETCH).catch(() => {});
    throw e;
  }
  const st = await assembleIncomeStatements(reader, { annual: opts.annual ?? 10, quarterly: opts.quarterly ?? 20 });
  const colsGaps = [...st.annual, ...st.quarterly].reduce((g, a) => g | a.col.gaps, 0);
  const result: FinAssembly = {
    profile: reader.profile,
    annual: st.annual,
    quarterly: st.quarterly,
    metrics: { revenue: revenue(dedupe([...st.annual, ...st.quarterly]), reader.profile) },
    gaps: reader.gaps | colsGaps,
    warnings: reader.warnings,
    latestAccn: reader.latestPeriodic(),
    at: new Date().toISOString(),
  };
  const id = `${market}:${sym}`;
  const stmts = { annual: toStmtDoc(`${id}:is:a`, st.annual, st.labels), quarterly: toStmtDoc(`${id}:is:q`, st.quarterly, st.labels) };
  if (!opts.persist) return { ...result, stmts };
  // 판독 단계 실패(최신 공시 판독 불가·원천 조회 실패)는 기존 문서를 유지 — store.persist 가 판정
  const persisted = await persist({ ...result, gaps: reader.gaps }, stmts);
  return { ...result, stmts, persisted };
}

function dedupe<T extends { col: { key: string } }>(xs: T[]): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(x.col.key) ? false : (seen.add(x.col.key), true)));
}

export async function getFinSym(market: Market, symbol: string): Promise<FinSymDoc | null> {
  return readSym(`${market}:${symbol.toUpperCase()}`);
}

export async function getFinStmt(market: Market, symbol: string, stmt: "is", period: "a" | "q"): Promise<FinStmtDoc | null> {
  return readStmt(`${market}:${symbol.toUpperCase()}:${stmt}:${period}`);
}

/**
 * 조회 모드(architecture.md §5.2·§5.3) — 소비처(화면·라우트)가 지표를 받는 입구.
 *  - 저장본(유니버스 종목, 배치 적재)이 있으면 그대로 쓴다(요청 시점에 0~3층을 다시 돌리지 않음).
 *  - 없으면(유니버스 밖 종목) 비저장 조립 후 **프로세스 메모리에만** 캐시(DB 에 쓰지 않음).
 * 조립 실패는 null — 다른 원천으로 대체하지 않는다(소비처는 빈칸).
 */
const LOOKUP_TTL_MS = { stored: 10 * 60_000, assembled: 6 * 3_600_000, failed: 5 * 60_000 };
type LookupEntry = { at: number; ttl: number; p: Promise<FinSymDoc | null> };
const lookupCache: Map<string, LookupEntry> = ((globalThis as { __finSymLookup?: Map<string, LookupEntry> }).__finSymLookup ??= new Map());

export function loadFinSym(market: Market, symbol: string): Promise<FinSymDoc | null> {
  const id = `${market}:${symbol.toUpperCase()}`;
  const hit = lookupCache.get(id);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.p;
  const entry: LookupEntry = { at: Date.now(), ttl: LOOKUP_TTL_MS.stored, p: Promise.resolve(null) };
  entry.p = (async () => {
    const stored = await getFinSym(market, symbol).catch(() => null);
    if (stored) return stored;
    try {
      const a = await assemble(market, symbol, { persist: false });
      entry.ttl = LOOKUP_TTL_MS.assembled;
      return toSymDoc(a);
    } catch {
      entry.ttl = LOOKUP_TTL_MS.failed;
      return null;
    }
  })();
  lookupCache.set(id, entry);
  return entry.p;
}

const METRIC_KEY = { revenue: "rev" } as const;
export function metricAt(sym: FinSymDoc, metric: keyof typeof METRIC_KEY, colKey: string): number | null {
  const i = sym.c.findIndex((c) => c[0] === colKey);
  return i < 0 ? null : (sym.m[METRIC_KEY[metric]]?.[i] ?? null);
}
