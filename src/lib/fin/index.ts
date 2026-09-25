import "server-only";
import { latestPeriodicAccn, UsReader } from "./read";
import { assembleIncomeStatements } from "./assemble/is";
import { revenue } from "./metrics/revenue";
import { ENGINE_VERSION, markFailed, persist, readStmt, readSym, readSymMeta, toStmtDoc, toSymDoc, touchChecked } from "./store";
import { Gap, gapNames, type FinAssembly, type Market } from "./types";
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
  const cols = dedupe([...st.annual, ...st.quarterly]);
  const rev = revenue(cols, reader.profile);
  // 조립 항등식 불성립(Gap.IDENTITY) 노출 — 매출 경로는 3층이 이미 값을 비웠고(reason), 그 외 줄은 값을 두고 경고로만
  const issues: FinAssembly["issues"] = [];
  const warnings = [...reader.warnings];
  for (const a of cols) {
    if (a.identity.ok && !rev.values[a.col.key]?.unv?.length) continue;
    const r = rev.values[a.col.key]?.idFails ?? [];
    const unv = rev.values[a.col.key]?.unv ?? [];
    const other = a.identity.fails.filter((f) => !r.includes(f) && !unv.includes(f));
    issues.push({ col: a.col.key, rev: r, other, unv });
    if (r.length) warnings.push(`${a.col.key} 매출 비움 — 조립 항등식 불성립(매출 줄 포함): ${r.join("; ")}`);
    if (unv.length) warnings.push(`${a.col.key} 매출 항등식 미검증(판정 불완전 — 값 유지, 검증기 SEC 직접 대조): ${unv.join("; ")}`);
    if (other.length) warnings.push(`${a.col.key} 조립 항등식 불성립(매출 외 줄 — 값 유지, 다음 지표 미결): ${other.join("; ")}`);
  }
  const result: FinAssembly = {
    profile: reader.profile,
    annual: st.annual,
    quarterly: st.quarterly,
    metrics: { revenue: rev },
    gaps: reader.gaps | colsGaps,
    warnings,
    issues,
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
    // 엔진판이 다른 저장본(판독·조립 규칙이 바뀌기 전 배치)은 쓰지 않는다 — 배치(/api/cron/fin-build)가 다시 적재할 때까지 비저장 조립
    if (stored && stored.ev === ENGINE_VERSION) return stored;
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

/**
 * 배치 갱신(architecture.md §5.1, /api/cron/fin-build) — 대상 종목 중 **저장본이 없거나, 엔진판이 다르거나, 저장 후 새 정기공시가
 * 나온** 종목만 조립·저장한다. 호출당 최대 `max` 종목, `deadline`(epoch ms) 이후에는 새 조립을 시작하지 않는다(Vercel 함수 시간).
 * 판정 순서: 저장본 없음 → 엔진판 다름 → 새 공시 확인(제출 목록만 — 마지막 확인이 오래된 종목부터). 새 공시가 없으면 확인 시각만 남긴다.
 */
export interface RefreshResult {
  built: { symbol: string; why: "missing" | "engine" | "filing"; changed?: number; kept?: boolean; gaps: string[]; error?: string }[];
  upToDate: string[];
  /** 제출 목록 조회 실패(latestPeriodicAccn null) — 새 공시 여부를 판정 못해 건너뛴 종목(확인 시각을 남기지 않음, 다음 호출에서 다시) */
  skipped: string[];
  /** 시간·개수 한도로 이번 호출에서 보지 못한 종목 */
  pending: number;
}

/** 저장본의 최신 공시 accn 이 비어 있는(조립 때 정기공시를 못 찾은) 종목 — 매 배치 다시 조립하지 않고 이 간격마다만 */
const LA_NULL_REBUILD_MS = 7 * 86_400_000;

export async function refreshStored(market: Market, symbols: string[], opts: { max: number; deadline: number; minBuildMs?: number }): Promise<RefreshResult> {
  if (market !== "us") throw new Error("한국(DART) 어댑터는 아직 없음 — architecture.md §10");
  const syms = [...new Set(symbols.map((s) => s.toUpperCase()))];
  const meta = await readSymMeta(syms.map((s) => `${market}:${s}`));
  const m = (s: string) => meta.get(`${market}:${s}`);
  const rank = (s: string) => (!m(s) ? 0 : m(s)!.ev !== ENGINE_VERSION ? 1 : 2);
  const last = (s: string) => (m(s)?.ck ?? m(s)?.at)?.valueOf() ?? 0;
  const queue = syms.sort((a, b) => rank(a) - rank(b) || last(a) - last(b));
  const out: RefreshResult = { built: [], upToDate: [], skipped: [], pending: 0 };
  const minBuild = opts.minBuildMs ?? 60_000;
  let i = 0;
  for (; i < queue.length; i++) {
    if (out.built.length >= opts.max || Date.now() + minBuild > opts.deadline) break;
    const s = queue[i];
    let why: RefreshResult["built"][number]["why"] | null = rank(s) === 0 ? "missing" : rank(s) === 1 ? "engine" : null;
    if (!why) {
      const la = await latestPeriodicAccn(s).catch(() => null);
      // 제출 목록 조회 실패(la null)는 "새 공시 없음"으로 보지 않는다 — 확인 시각을 남기지 않고 skipped 로 돌려준다(다음 호출에서 다시)
      if (!la) { out.skipped.push(s); continue; }
      // 저장본 la 가 비어 있으면(조립 때 정기공시 accn 을 못 읽음) la 비교가 매번 "새 공시"가 되어 배치마다 다시 조립됐다 —
      // 마지막 적재가 LA_NULL_REBUILD_MS 보다 오래됐을 때만 다시 조립
      const stale = m(s)!.la == null ? Date.now() - (m(s)!.at?.valueOf() ?? 0) > LA_NULL_REBUILD_MS : la !== m(s)!.la;
      if (stale) why = "filing";
      else {
        await touchChecked(`${market}:${s}`).catch(() => {});
        out.upToDate.push(s);
        continue;
      }
    }
    try {
      const r = await assemble(market, s, { persist: true });
      out.built.push({ symbol: s, why, changed: r.persisted?.changed, kept: r.persisted?.kept, gaps: gapNames(r.gaps) });
    } catch (e) {
      out.built.push({ symbol: s, why, gaps: [], error: String((e as Error).message ?? e).slice(0, 200) });
    }
  }
  out.pending = queue.length - i;
  return out;
}
