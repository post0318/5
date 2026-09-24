import "server-only";
import type { Collection } from "mongodb";
import { getDb } from "./index";
import type { MarketId } from "../markets/types";

/**
 * 재무 숫자 검증 결과(scripts/verify-financials.mjs) — 종목별 **최신 1건**.
 *
 * 검증 스크립트는 GitHub Actions(하루 1회 전 종목 + 수시로 미검증 종목)에서 배포된 앱 API 를 불러 사용자가
 * 보는 숫자를 SEC 원자료·외부 소스(Yahoo·StockAnalysis·인포맥스)와 대조하고, 결과를 `/api/cron/verify-results`
 * 로 보낸다. 앱은 저장·조회만 한다 — 외부 대조 코드는 배포본에 없다(오너 결정 2026-09-24 "검증 스크립트에만").
 * 관리자 화면(`/admin/verify`)이 이 컬렉션을 읽는다.
 *
 * 통과 항목은 건수만 남기고, 실패·검증불가·외부 대조만 항목째 저장한다(문서 크기 관리).
 */
export interface VerifyIssue {
  layer: string;
  name: string;
  col: string;
  note?: string;
}
export interface VerifyExternal {
  item: string;
  ours?: number | null;
  sources?: Record<string, number>;
  matched?: string[];
  verdict?: string;
  note?: string;
}
export interface VerifyResultDoc {
  /** `${market}:${symbol}` */
  _id: string;
  market: MarketId;
  symbol: string;
  runAt: string;
  /** 검증한 앱 주소(배포본) */
  base: string;
  /** 검증 당시 저장소 커밋(Actions 의 GITHUB_SHA) */
  commit: string | null;
  counts: { fail: number; unverifiable: number; pass: number; extAllMatch: number; extMismatch: number; otherReview: number };
  fails: VerifyIssue[];
  unverifiable: VerifyIssue[];
  external: VerifyExternal[];
  /** 조회 실패 등 실행 자체의 문제 */
  errors: string[];
}

export async function verifyResultsCol(): Promise<Collection<VerifyResultDoc>> {
  const db = await getDb();
  const col = db.collection<VerifyResultDoc>("verify_results");
  await col.createIndex({ market: 1, symbol: 1 }).catch(() => {});
  return col;
}
