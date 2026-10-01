import "server-only";
import type { Collection } from "mongodb";
import { getDb, isDbConfigured } from "./index";
import type { TtmFlows } from "../markets/types";

/**
 * TTM 스냅샷 저장본(오너 결정 2026-10-01 (가) — 개요 시가총액이 첫 조회 때 SEC 원본 판독으로 6~40초 걸리던 문제).
 * 종목 TTM(현재 주식수·LTM 손익·EV 구성요소 등, getTtm 결과)을 그대로 저장하고 개요가 바로 읽는다.
 *  - 유효 = **같은 배포판(커밋)** + 24시간 안. 계산 규칙이 바뀐 배포 뒤에 옛 규칙 값을 보이지 않게(화면 간 같은 값 원칙 — 하이라이트는
 *    요청 시점 계산). 판이 다르거나 오래됐으면 요청 시점에 다시 계산하고 저장한다.
 *  - 불완전한 결과(조회 실패·SEC 원본 판독 경고·매출 조립 실패)는 저장하지 않는다 — 다음 조회에서 다시 계산.
 *  - 배치(/api/cron/ttm-build)가 매일·배포 직후 유니버스 미국 종목을 미리 채운다.
 */
export interface TtmSnapDoc {
  _id: string;
  /** 배포판(커밋 SHA) */
  v: string;
  at: Date;
  ttm: TtmFlows;
  /** 화면에서 마지막으로 조회된 시각(배치가 쓴 것은 갱신 안 함) — 유니버스 밖 종목을 배치 갱신 대상에 넣는 기준(listRecentlyViewed) */
  seen?: Date;
}

const MAX_AGE_MS = 24 * 3_600_000;

export function ttmSnapVersion(): string {
  return process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || "local";
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
export async function readTtmSnapAny(market: string, symbol: string): Promise<{ ttm: TtmFlows; current: boolean } | null> {
  if (!isDbConfigured()) return null;
  const d = await (await col()).findOne({ _id: key(market, symbol) });
  if (!d || Date.now() - d.at.getTime() > MAX_AGE_MS) return null;
  return { ttm: d.ttm, current: d.v === ttmSnapVersion() };
}

/** 저장해도 되는 완전한 결과인지 — 조회 실패·원본 판독 경고가 있으면 저장하지 않는다 */
export function isStorableTtm(t: TtmFlows | null): boolean {
  return !!t && !t.error && !t.degraded?.length;
}

/** 저장 — viewed: 화면 조회로 계산한 것(seen 도 갱신). 배치가 쓴 것은 seen 을 건드리지 않는다 */
export async function writeTtmSnap(market: string, symbol: string, ttm: TtmFlows, opts: { viewed?: boolean } = {}): Promise<void> {
  if (!isDbConfigured() || !isStorableTtm(ttm)) return;
  const now = new Date();
  await (await col()).updateOne(
    { _id: key(market, symbol) },
    { $set: { v: ttmSnapVersion(), at: now, ttm, ...(opts.viewed ? { seen: now } : {}) } },
    { upsert: true },
  );
}

/** 화면 조회 기록 — 저장본을 읽어 바로 돌려줄 때(1시간에 한 번만 쓴다) */
export async function touchTtmSeen(market: string, symbol: string): Promise<void> {
  if (!isDbConfigured()) return;
  const now = new Date();
  await (await col()).updateOne(
    { _id: key(market, symbol), $or: [{ seen: { $exists: false } }, { seen: { $lt: new Date(now.getTime() - 3_600_000) } }] },
    { $set: { seen: now } },
  );
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
