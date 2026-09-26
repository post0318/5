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
/**
 * 감사표 판정 — ① 일치 · ② 정의 차이(원인 확인) · ③ 오류 · SEC(SEC만 확인 · 외부 없음) ·
 * COMMON 공통모드 — 독립 검증 아님(앱과 같은 규칙·데이터로만 확인됨, ①·②·SEC 로 세지 않음 — 오너 결정 2026-09-26) ·
 * NA 대조값 없음·검증불가(외부 정밀도 부족) · 미결(닫히지 않은 지표의 원인 미규명 차이)
 */
export type AuditVerdict = "①" | "②" | "③" | "SEC" | "COMMON" | "NA" | "미결";
export const AUDIT_VERDICTS: readonly AuditVerdict[] = ["①", "②", "③", "SEC", "COMMON", "NA", "미결"];
/** 판정 표시 이름 — COMMON 은 코드값이라 화면에는 이 문구로 */
export const AUDIT_VERDICT_LABEL: Record<AuditVerdict, string> = { "①": "①", "②": "②", "③": "③", SEC: "SEC", COMMON: "공통모드 — 독립 검증 아님", NA: "NA", 미결: "미결" };
/** 종목별 감사표 한 줄(scripts/metrics/audit.mjs) — 지표 × (최근 사업연도 열 · LTM). 값이 없거나 정의가 다른 칸은 null */
export interface AuditRow {
  metric: string;
  /** "2025Y" · "LTM" */
  period: string;
  /** 기준 — "FY 2025-09-27" · "TTM 2026-06-27" · "결산일 …" · "현재가 · 재무 …" */
  basis: string;
  app: number | null;
  /** A층 SEC 원자료 기준값(배수는 null) */
  sec: number | null;
  yahoo: number | null;
  sa: number | null;
  infomax: number | null;
  verdict: AuditVerdict;
  note: string;
  /** 검증이 닫힌 지표인가(검증기 CLOSED_METRICS) */
  closed: boolean;
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
  /** common = 공통모드 검사(통과에 세지 않음), extCommon = 공통모드 소스만 일치한 외부 대조 — 2026-09-26 이전 결과엔 없음 */
  counts: { fail: number; unverifiable: number; pass: number; common?: number; extAllMatch: number; extCommon?: number; extMismatch: number; otherReview: number };
  fails: VerifyIssue[];
  unverifiable: VerifyIssue[];
  /** 공통모드 — 독립 검증 아님(앱과 같은 규칙·데이터로 판정한 통과). 2026-09-26 이전 결과엔 없음 */
  common?: VerifyIssue[];
  external: VerifyExternal[];
  /** 조회 실패 등 실행 자체의 문제 */
  errors: string[];
  /** 감사표 — 2026-09-26 이전 결과·한국 종목엔 없음 */
  audit?: AuditRow[];
}

export async function verifyResultsCol(): Promise<Collection<VerifyResultDoc>> {
  const db = await getDb();
  const col = db.collection<VerifyResultDoc>("verify_results");
  await col.createIndex({ market: 1, symbol: 1 }).catch(() => {});
  return col;
}
