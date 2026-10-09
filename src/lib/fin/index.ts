import "server-only";
import { latestPeriodicAccn, UsReader } from "./read";
import { assembleIncomeStatements } from "./assemble/is";
import { revenue } from "./metrics/revenue";
import { cogsGp } from "./metrics/cogs";
import { opincOpex } from "./metrics/opinc";
import { cogsRuleFor } from "./metrics/cogs-rules";
import { sgaRnd } from "./metrics/sga";
import { sgaRuleFor } from "./metrics/sga-rules";
import { finalizeDerived } from "./derived";
import { ENGINE_VERSION, markFailed, persist, readStmt, readSym, readSymMeta, toStmtDoc, toSymDoc, touchChecked } from "./store";
import { Gap, gapNames, type FinAssembly, type Market } from "./types";
import { isDbConfigured } from "../db";
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
export { COGS_NOTE, FIN_TYPES } from "./metrics/cogs";
export { OPINC_NOTE } from "./metrics/opinc";
export { SGA_NOTE } from "./metrics/sga";
export { ENGINE_VERSION } from "./store"; // 재무 엔진판 — TTM 저장본 판번호(db/ttm-snap.ts)가 쓴다

export interface AssembleOpts {
  persist?: boolean;
  annual?: number;
  quarterly?: number;
}

export async function assemble(market: Market, symbol: string, opts: AssembleOpts = {}): Promise<FinAssembly & { stmts: { annual: FinStmtDoc; quarterly: FinStmtDoc }; persisted?: { changed: number; kept: boolean }; readerGaps: number }> {
  if (market !== "us") throw new Error("한국(DART) 어댑터는 아직 없음 — architecture.md §10");
  const sym = symbol.toUpperCase();
  let reader: UsReader;
  try {
    reader = await UsReader.open(sym);
  } catch (e) {
    if (opts.persist) await markFailed(`${market}:${sym}`, Gap.CF_FETCH).catch(() => {});
    throw e;
  }
  const st = await assembleIncomeStatements(reader, { annual: opts.annual ?? 10, quarterly: opts.quarterly ?? 20 }, cogsRuleFor(sym)?.rule?.terms, sgaRuleFor(sym)?.hint);
  const colsGaps = [...st.annual, ...st.quarterly].reduce((g, a) => g | a.col.gaps, 0);
  const cols = dedupe([...st.annual, ...st.quarterly]);
  const rev = revenue(cols, reader.profile);
  // 매출원가·매출총이익(docs/metrics/cogs.md) — 매출 지표 값을 받아 합성 매출총이익을 만든다
  const { cogs, gp } = cogsGp(cols, reader.profile, rev);
  // 영업이익·영업비용(본표 소계, 없으면 공시 계산 구조 합성 — cogs.md §8). 화면은 markets/us/edgar-ev.ts 영업이익 함수로 이 값을 쓴다
  const { opinc, opex } = opincOpex(cols, reader.profile, gp);
  // 판관비·연구개발비(본표 영업이익 식의 판관비·연구개발비 성격 줄 — docs/metrics/sga.md)
  const { sga, rnd } = sgaRnd(cols, reader.profile);
  // 회사 재분류 1분기 칸 주석(read/index.ts recastQ1) — 줄 하나를 그대로 쓴 지표 칸에 줄 주석을 싣는다(다른 정의 메모가 있으면 그것 우선)
  for (const s of [rev, cogs, gp, opinc, opex, sga, rnd])
    for (const a of cols) {
      const mv = s.values[a.col.key];
      const ln = mv?.line && mv.v != null && !mv.note ? a.lines.find((l) => l.id === mv.line) : null;
      if (ln?.note) s.values[a.col.key] = { ...mv!, note: ln.note };
    }
  const at = new Date().toISOString();
  // 파생값 입력 참조 압축·자기 검사(입력 합 = 값) — 불일치는 값을 두고 issues.der·경고로(조용히 통과시키지 않음)
  const derErr = await finalizeDerived(reader, cols, [rev, cogs, gp, opinc, opex, sga, rnd], at);
  // 조립 항등식 불성립(Gap.IDENTITY) 노출 — 매출 경로는 3층이 이미 값을 비웠고(reason), 그 외 줄은 값을 두고 경고로만
  const issues: FinAssembly["issues"] = [];
  const warnings = [...reader.warnings];
  // H.10 공식 환율 미고시 창(최신 고시일 뒤) — 빈칸의 사유로 남기고 경고(Yahoo 등으로 대체하지 않는다, architecture.md §1.3)
  for (const [key, why] of reader.fxPending) {
    for (const s of [rev, cogs, gp, opinc, opex, sga, rnd]) {
      const mv = s.values[key];
      if (mv && mv.v == null && !mv.reason) s.values[key] = { ...mv, reason: why };
    }
    warnings.push(`${key} ${why} — 환산 값 비움`);
  }
  for (const a of cols) {
    const der = derErr.get(a.col.key) ?? [];
    if (a.identity.ok && !rev.values[a.col.key]?.unv?.length && !der.length) continue;
    const r = rev.values[a.col.key]?.idFails ?? [];
    const unv = rev.values[a.col.key]?.unv ?? [];
    const other = a.identity.fails.filter((f) => !r.includes(f) && !unv.includes(f));
    issues.push({ col: a.col.key, rev: r, other, unv, ...(der.length ? { der } : {}) });
    if (der.length) warnings.push(`${a.col.key} 파생값 입력 자기 검사 불일치(값 유지): ${der.join("; ")}`);
    if (r.length) warnings.push(`${a.col.key} 매출 비움 — 조립 항등식 불성립(매출 줄 포함): ${r.join("; ")}`);
    if (unv.length) warnings.push(`${a.col.key} 매출 항등식 미검증(판정 불완전 — 값 유지, 검증기 SEC 직접 대조): ${unv.join("; ")}`);
    if (other.length) warnings.push(`${a.col.key} 조립 항등식 불성립(매출 외 줄 — 값 유지, 다음 지표 미결): ${other.join("; ")}`);
  }
  for (const a of cols) {
    const c = cogs.values[a.col.key], g = gp.values[a.col.key];
    const idf = [...new Set([...(c?.idFails ?? []), ...(g?.idFails ?? [])])];
    if (idf.length) warnings.push(`${a.col.key} 매출원가·매출총이익 비움 — 조립 항등식 불성립: ${idf.join("; ")}`);
    const xn = opex.values[a.col.key]?.note;
    if (xn) warnings.push(`${a.col.key} 영업비용: ${xn}`);
    const sf = [...new Set([...(sga.values[a.col.key]?.idFails ?? []), ...(rnd.values[a.col.key]?.idFails ?? [])])];
    if (sf.length) warnings.push(`${a.col.key} 판관비·연구개발비 비움 — 조립 항등식 불성립: ${sf.join("; ")}`);
  }
  const result: FinAssembly = {
    profile: reader.profile,
    annual: st.annual,
    quarterly: st.quarterly,
    metrics: { revenue: rev, cogs, gp, opinc, opex, sga, rnd },
    gaps: reader.gaps | colsGaps,
    warnings,
    issues,
    latestAccn: reader.latestPeriodic(),
    at,
  };
  const id = `${market}:${sym}`;
  const stmts = { annual: toStmtDoc(`${id}:is:a`, st.annual, st.labels), quarterly: toStmtDoc(`${id}:is:q`, st.quarterly, st.labels) };
  // readerGaps — 저장(persist)에 넘기는 결손 표시(배치 저장과 같은 값 — loadFinSym 의 조회 시 저장이 쓴다)
  if (!opts.persist) return { ...result, stmts, readerGaps: reader.gaps };
  // 판독 단계 실패(최신 공시 판독 불가·원천 조회 실패)는 기존 문서를 유지 — store.persist 가 판정
  const persisted = await persist({ ...result, gaps: reader.gaps }, stmts);
  return { ...result, stmts, persisted, readerGaps: reader.gaps };
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
/** 엔진판이 다른 저장본을 계속 쓰는 기한 — 마지막 배치 손길(적재 at·확인 ck 중 늦은 쪽) 기준 */
const STALE_ENGINE_MAX_MS = 7 * 86_400_000;
type LookupEntry = { at: number; ttl: number; p: Promise<FinSymDoc | null> };
const lookupCache: Map<string, LookupEntry> = ((globalThis as { __finSymLookup?: Map<string, LookupEntry> }).__finSymLookup ??= new Map());

export function loadFinSym(market: Market, symbol: string): Promise<FinSymDoc | null> {
  const id = `${market}:${symbol.toUpperCase()}`;
  // 캐시 키에 엔진판 — 캐시가 globalThis 라 코드 교체(개발 서버 HMR)를 넘어 살아남는다. 판이 바뀌면 옛 규칙의 비저장 조립을 쓰지 않게
  const ck = `${id}@${ENGINE_VERSION}`;
  const hit = lookupCache.get(ck);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.p;
  const entry: LookupEntry = { at: Date.now(), ttl: LOOKUP_TTL_MS.stored, p: Promise.resolve(null) };
  entry.p = (async () => {
    const stored = await getFinSym(market, symbol).catch(() => null);
    if (stored && stored.ev === ENGINE_VERSION) return stored;
    // 엔진판이 다른 저장본(판독·조립 규칙이 바뀌기 전 배치)도 새 저장본이 생길 때까지 그대로 쓴다(오너 승인 2026-10-09 — 판번호가 바뀌면 배치가
    // 다시 채우기 전까지 종목마다 30~40초 기다렸다). 응답에는 staleEv(옛 엔진판)를 남긴다. 배치(fin-build)는 엔진판이 다른 것을 다시 채운다.
    // 단 배치가 7일 넘게 손대지 않은 저장본(유니버스 밖·30일 넘게 안 연 종목 — 배치 대상이 아님)은 요청 시점 조립(아래)으로 새로 만든다
    if (stored && Date.now() - Math.max(stored.at?.valueOf() ?? 0, stored.ck?.valueOf() ?? 0) <= STALE_ENGINE_MAX_MS) return { ...stored, staleEv: stored.ev };
    try {
      const a = await assemble(market, symbol, { persist: false });
      // 환율·Yahoo 조회 실패로 결손이 생긴 조립은 일시적 — 6시간 캐시하지 않고 실패와 같이 5분 뒤 다시 조립(2026-09-26)
      const transient = a.gaps & (Gap.FX | Gap.YAHOO | Gap.CF_FETCH | Gap.STALE);
      entry.ttl = transient ? LOOKUP_TTL_MS.failed : LOOKUP_TTL_MS.assembled;
      // 유니버스 밖 종목도 완전한 조립은 DB 에 저장(오너 결정 2026-10-01 ① — 두 번째 조회부터 어느 서버든 0.5초대). 새 공시 갱신은
      // 배치(fin-build)가 최근 30일 안에 조회된 종목까지 맡는다(db/ttm-snap.ts listRecentlyViewed). 저장 실패는 조회 결과에 영향 없음
      if (!transient && isDbConfigured()) await persist({ ...a, gaps: a.readerGaps }, a.stmts).catch(() => {});
      return toSymDoc(a);
    } catch {
      entry.ttl = LOOKUP_TTL_MS.failed;
      return null;
    }
  })();
  lookupCache.set(ck, entry);
  return entry.p;
}

const METRIC_KEY = { revenue: "rev", cogs: "cogs", gp: "gp", opinc: "opinc", opex: "opex", sga: "sga", rnd: "rnd" } as const;
export function metricAt(sym: FinSymDoc, metric: keyof typeof METRIC_KEY, colKey: string): number | null {
  const i = sym.c.findIndex((c) => c[0] === colKey);
  return i < 0 ? null : (sym.m[METRIC_KEY[metric]]?.[i] ?? null);
}

/** 저장본에서 지표 한 칸의 사유·주석(빈칸 사유 또는 정의 메모 — 예: COGS_NOTE.synth). 없으면 null */
export function metricNoteAt(sym: FinSymDoc, metric: "cogs" | "gp" | "opinc" | "opex" | "sga" | "rnd", colKey: string): string | null {
  for (const [text, keys] of sym.n?.[METRIC_KEY[metric]] ?? []) if (keys.includes(colKey)) return text;
  return null;
}

/**
 * 저장본의 판관비·연구개발비 하위 줄(여러 줄 합·소계의 항 — docs/metrics/sga.md §4) — [줄 id, 라벨, 열키 → 값]. 하위 줄이 없으면 빈 목록
 */
export function metricPartsAt(sym: FinSymDoc, metric: "sga" | "rnd"): { id: string; label: string; v: Map<string, number | null> }[] {
  return (sym.sp?.[metric] ?? []).map(([id, label, vs]) => ({ id, label, v: new Map(sym.c.map((c, i) => [c[0], vs[i] ?? null])) }));
}

/**
 * 배치 갱신(architecture.md §5.1, /api/cron/fin-build) — 대상 종목 중 **저장본이 없거나, 엔진판이 다르거나, 저장 후 새 정기공시가
 * 나온** 종목만 조립·저장한다. 호출당 최대 `max` 종목, `deadline`(epoch ms) 이후에는 새 조립을 시작하지 않는다(Vercel 함수 시간).
 * 판정 순서: 저장본 없음 → 엔진판 다름 → 새 공시 확인(제출 목록만 — 마지막 확인이 오래된 종목부터). 새 공시가 없으면 확인 시각만 남긴다.
 */
export interface RefreshResult {
  built: { symbol: string; why: "missing" | "engine" | "filing"; changed?: number; kept?: boolean; gaps: string[]; cols?: string[]; error?: string }[];
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
      // gaps = 저장본 결손(fin_sym.g — 판독 단계), cols = 열 표시(조립 항등식 불성립 IDENTITY·기준 변경 BASIS_SHIFT 등 — 열 단위 메모, 화면 값은 정상).
      // 예전엔 둘을 합쳐 "결손"으로 찍어 거의 전 종목이 결손처럼 보였다(2026-10-09 — 배포 전후 저장본 비트 동일 확인)
      const rg = r.readerGaps ?? r.gaps;
      out.built.push({ symbol: s, why, changed: r.persisted?.changed, kept: r.persisted?.kept, gaps: gapNames(rg), cols: gapNames(r.gaps & ~rg) });
    } catch (e) {
      out.built.push({ symbol: s, why, gaps: [], error: String((e as Error).message ?? e).slice(0, 200) });
    }
  }
  out.pending = queue.length - i;
  return out;
}
