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
  if (!isDbConfigured()) return null;
  const d = await (await col()).findOne({ _id: key(market, symbol) });
  if (!d || d.v !== ttmSnapVersion() || Date.now() - d.at.getTime() > MAX_AGE_MS) return null;
  return d.ttm;
}

/** 저장해도 되는 완전한 결과인지 — 조회 실패·원본 판독 경고가 있으면 저장하지 않는다 */
export function isStorableTtm(t: TtmFlows | null): boolean {
  return !!t && !t.error && !t.degraded?.length;
}

export async function writeTtmSnap(market: string, symbol: string, ttm: TtmFlows): Promise<void> {
  if (!isDbConfigured() || !isStorableTtm(ttm)) return;
  await (await col()).replaceOne(
    { _id: key(market, symbol) },
    { v: ttmSnapVersion(), at: new Date(), ttm },
    { upsert: true },
  );
}
