import "server-only";
import type { Collection } from "mongodb";
import { getDb, isDbConfigured } from "./index";
import type { TtmFlows } from "../markets/types";
import { ENGINE_VERSION } from "../fin";
import { snapshotBypassed } from "./snap-bypass";

/**
 * TTM 스냅샷 저장본(오너 결정 2026-10-01 (가) — 개요 시가총액이 첫 조회 때 SEC 원본 판독으로 6~40초 걸리던 문제).
 * 종목 TTM(현재 주식수·LTM 손익·EV 구성요소 등, getTtm 결과)을 그대로 저장하고 개요가 바로 읽는다.
 *  - 유효 = **같은 계산 판번호** + 24시간 안(2026-10-03 오너 결정 — 예전엔 "같은 배포판(커밋)"이라 계산과 무관한 푸시에도 전 종목이
 *    무효가 돼 매번 다시 계산했다: 이틀 푸시 35번 = Vercel CPU 351분, 한도 초과로 서비스 정지). 계산 판번호 = 재무 엔진판(ENGINE_VERSION,
 *    재무 조립 규칙) + TTM 규칙 판(TTM_RULES_VERSION, 현재 주식수·LTM·EV 구성 규칙). 둘 중 하나라도 바뀌면 전 종목이 다시 계산된다.
 *    ⚠️ TTM 계산 규칙(markets/us 의 getTtm·EV·주식수 등)을 고치면 TTM_RULES_VERSION 을 올린다 — 안 올리면 최대 24시간 옛 규칙 값이 남는다.
 *  - 24시간 넘은 저장본은 요청 시점에 다시 계산하고 저장한다. 판번호만 다른 24시간 안 저장본은 새 저장본(배치)이 생길 때까지 그대로 쓴다
 *    (오너 승인 2026-10-09 — 응답에 snapStale 표시, 요청마다 다시 계산하지 않음). 교체 때 바뀐 칸은 ttm_chg(30일 TTL)에 남긴다.
 *  - 불완전한 결과(조회 실패·SEC 원본 판독 경고·매출 조립 실패)는 저장하지 않는다 — 다음 조회에서 다시 계산.
 *  - 배치(오라클 타이머 fin-ttm-build, scripts/run/ttm-build.mts)가 매일 06:50·배포 직후 유니버스 미국 종목 중 무효인 것만 채운다.
 */
export interface TtmSnapDoc {
  _id: string;
  /** 계산 판번호(e{엔진판}.t{TTM 규칙판}) — 2026-10-03 전 저장본은 커밋 SHA */
  v: string;
  at: Date;
  ttm: TtmFlows;
  /** 화면에서 마지막으로 조회된 시각(배치가 쓴 것은 갱신 안 함) — 유니버스 밖 종목을 배치 갱신 대상에 넣는 기준(listRecentlyViewed) */
  seen?: Date;
}

const MAX_AGE_MS = 24 * 3_600_000;

/** TTM 계산 규칙 판 — 현재 주식수·LTM·EV 구성 규칙을 고치면 올린다(재무 조립 규칙은 ENGINE_VERSION 이 따로 따라간다) */
export const TTM_RULES_VERSION = 1;

export function ttmSnapVersion(): string {
  // 배포 환경(Vercel·구글·오라클 — 배포 커밋 변수가 있음)과 로컬을 가른다: 같은 DB 라 로컬이 쓴 저장본을 운영이 읽지 않게.
  const deployed = process.env.VERCEL_GIT_COMMIT_SHA || process.env.APP_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID;
  if (!deployed) return "local";
  return `e${ENGINE_VERSION}.t${TTM_RULES_VERSION}`;
}

async function col(): Promise<Collection<TtmSnapDoc>> {
  return (await getDb()).collection<TtmSnapDoc>("ttm_snap");
}

const key = (market: string, symbol: string) => `${market}:${symbol.toUpperCase()}`;

/** 유효한 저장본(같은 배포판·24시간 안)만. 없거나 DB 미설정이면 null */
export async function readTtmSnap(market: string, symbol: string): Promise<TtmFlows | null> {
  const r = await readTtmSnapAny(market, symbol);
  return r && r.current ? r.ttm : null;
}

/**
 * 24시간 안 저장본(배포판 무관) — current = 같은 배포판. 배포판만 다른 저장본은 화면이 먼저 바로 쓰고 뒤에서 다시 계산해 덮어쓴다(오너 지적
 * 2026-10-02 — 배포 직후 다시 채우기가 끝날 때까지 첫 조회가 수십 초, AXP). 계산 규칙이 바뀐 배포면 처음 한 번만 옛 규칙 값이 보일 수 있다
 */
export async function readTtmSnapAny(market: string, symbol: string, opts: { anyAge?: boolean } = {}): Promise<{ ttm: TtmFlows; current: boolean } | null> {
  if (!isDbConfigured() || (await snapshotBypassed())) return null;
  const d = await (await col()).findOne({ _id: key(market, symbol) });
  // anyAge — 24시간 넘은 저장본도(재무 저장본이 옛 판이라 새로 계산한 값을 저장할 수 없을 때, 새 값이 나올 때까지 옛 값 — 오너 결정 2026-10-09).
  // seen 만 있는 문서(touchTtmSeen upsert)는 저장본 없음
  if (!d || !d.ttm || !d.at || (!opts.anyAge && Date.now() - d.at.getTime() > MAX_AGE_MS)) return null;
  // 다른 환경(로컬 ↔ 운영)이 쓴 저장본은 읽지 않는다(같은 DB — api-snap.ts 와 같은 이유)
  if ((d.v === "local") !== (ttmSnapVersion() === "local")) return null;
  return { ttm: d.ttm, current: d.v === ttmSnapVersion() };
}

/** 저장해도 되는 완전한 결과인지 — 조회 실패·원본 판독 경고가 있으면 저장하지 않는다 */
export function isStorableTtm(t: TtmFlows | null): boolean {
  return !!t && !t.error && !t.degraded?.length && !t.staleInputs?.length;
}

/**
 * 저장본 교체 기록(오너 승인 2026-10-09) — 옛 저장본과 새 값을 비교해 바뀐 칸만 종목당 문서 1건(ttm_chg). 칸은 최대 CHG_MAX_FIELDS 개,
 * 30일 뒤 자동 삭제(TTL) — 쌓이지 않게. 재무 저장본(fin_sym·fin_stmt)의 같은 기록은 fin_chg(fin/store.ts persist, 180일)
 */
export interface TtmChgDoc {
  k: string;
  at: Date;
  /** 옛·새 판번호 */
  ov: string;
  nv: string;
  /** 바뀐 칸 수(전체) */
  n: number;
  /** [경로, 옛 값, 새 값] — 앞 CHG_MAX_FIELDS 개 */
  f: [string, unknown, unknown][];
}
const CHG_MAX_FIELDS = 40;
const CHG_TTL_S = 30 * 86_400;
let chgIndexed = false;
type Leaf = string | number | boolean | null;
function leaves(x: unknown, path: string, out: Map<string, Leaf>): void {
  if (x == null || typeof x !== "object") { out.set(path, (x ?? null) as Leaf); return; }
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) leaves(v, path ? `${path}.${k}` : k, out);
}
/** 옛 TTM 과 새 TTM 의 바뀐 칸(응답 전용 필드 snapStale 제외) */
export function ttmDiff(a: TtmFlows | null | undefined, b: TtmFlows): [string, unknown, unknown][] {
  const A = new Map<string, Leaf>(), B = new Map<string, Leaf>();
  leaves({ ...(a ?? {}), snapStale: undefined }, "", A);
  leaves({ ...b, snapStale: undefined }, "", B);
  const out: [string, unknown, unknown][] = [];
  for (const k of new Set([...A.keys(), ...B.keys()])) {
    const o = A.has(k) ? A.get(k)! : null, n = B.has(k) ? B.get(k)! : null;
    if (o !== n) out.push([k, o, n]);
  }
  return out.sort((x, y) => x[0].localeCompare(y[0]));
}
async function chgCol(): Promise<Collection<TtmChgDoc>> {
  const c = (await getDb()).collection<TtmChgDoc>("ttm_chg");
  if (!chgIndexed) {
    // TTL 인덱스가 없으면 기록이 쌓인다 — 실패를 알리고(던짐) 다음 호출에서 다시 시도. 조용히 삼키지 않는다
    try {
      await c.createIndex({ at: 1 }, { expireAfterSeconds: CHG_TTL_S });
      await c.createIndex({ k: 1, at: -1 });
      chgIndexed = true;
    } catch (e) {
      console.error(`[ttm_chg] 인덱스 생성 실패 — 이번 기록 건너뜀: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  }
  return c;
}

/**
 * 저장 — viewed: 화면 조회로 계산한 것(seen 도 갱신). 배치가 쓴 것은 seen 을 건드리지 않는다.
 * 옛 저장본이 있고 값이 바뀌었으면 ttm_chg 에 바뀐 칸을 남긴다(기록 실패는 저장에 영향 없음). 반환 = 바뀐 칸 수(옛 저장본 없으면 null)
 */
export async function writeTtmSnap(market: string, symbol: string, ttm: TtmFlows, opts: { viewed?: boolean } = {}): Promise<{ changed: number | null; from: string | null } | null> {
  if (!isDbConfigured() || !isStorableTtm(ttm) || (await snapshotBypassed())) return null;
  const now = new Date();
  const v = ttmSnapVersion();
  const store = { ...ttm };
  delete store.snapStale;
  const prev = await (await col()).findOneAndUpdate(
    { _id: key(market, symbol) },
    { $set: { v, at: now, ttm: store, ...(opts.viewed ? { seen: now } : {}) } },
    { upsert: true, returnDocument: "before", projection: { v: 1, ttm: 1 } },
  );
  if (!prev) return { changed: null, from: null };
  const d = ttmDiff(prev.ttm, store);
  // 교체 기록 실패는 저장본 교체 결과에 영향 없음(감사 추적용 부가 기록) — 실패는 로그로 남긴다
  if (d.length)
    await chgCol()
      .then((c) => c.insertOne({ k: key(market, symbol), at: now, ov: prev.v, nv: v, n: d.length, f: d.slice(0, CHG_MAX_FIELDS) }))
      .catch((e) => console.error(`[ttm_chg] ${key(market, symbol)} 기록 실패: ${e instanceof Error ? e.message : String(e)}`));
  return { changed: d.length, from: prev.v };
}

/**
 * 화면 조회 기록 — 저장본을 읽어 바로 돌려줄 때(1시간에 한 번만 쓴다). upsert — 저장본을 만들 수 없었던 조회(재무 저장본 옛 판 등)도 seen 만
 * 남겨 배치 대상(listRecentlyViewed)에 들어가게 한다(seen 만 있는 문서는 readTtmSnapAny 가 저장본 없음으로 본다)
 */
export async function touchTtmSeen(market: string, symbol: string, opts: { upsert?: boolean } = {}): Promise<void> {
  if (!isDbConfigured() || (await snapshotBypassed())) return;
  const now = new Date();
  const c = await col();
  const due = { $or: [{ seen: { $exists: false } }, { seen: { $lt: new Date(now.getTime() - 3_600_000) } }] };
  if (opts.upsert) {
    if (await c.findOne({ _id: key(market, symbol), seen: { $gte: new Date(now.getTime() - 3_600_000) } }, { projection: { _id: 1 } })) return;
    await c.updateOne({ _id: key(market, symbol) }, { $set: { seen: now } }, { upsert: true });
    return;
  }
  await c.updateOne({ _id: key(market, symbol), ...due }, { $set: { seen: now } });
}

/**
 * 최근 days 일 안에 화면에서 조회된 종목(유니버스 밖 포함) — 재무 배치(fin-build)·TTM 채우기(ttm-build)가 유니버스와 함께 갱신한다
 * (오너 결정 2026-10-01 ① — 한 번 연 종목은 저장본을 쓰고, 새 공시가 나오면 배치가 갱신. 안 보는 종목은 자연히 빠진다)
 */
export async function listRecentlyViewed(market: string, days = 30): Promise<string[]> {
  if (!isDbConfigured()) return [];
  const docs = await (await col())
    .find({ _id: { $regex: `^${market}:` }, seen: { $gte: new Date(Date.now() - days * 86_400_000) } }, { projection: { _id: 1 } })
    .toArray();
  return docs.map((d) => d._id.slice(market.length + 1));
}
