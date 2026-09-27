/** 감사표 판정·한 줄 형식 — 관리자 화면(클라이언트)과 서버가 함께 쓴다. DB 모듈(server-only)과 분리 */
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

/**
 * 관리자 화면 상태 판정에 쓰는 지표 — 닫았거나 지금 닫는 지표만(오너 지시 2026-09-27 — 나머지 지표 경고는 "미결 지표" 건수로만).
 * 지표를 닫거나 다음 지표 작업을 시작할 때 여기에 추가한다(검증기 CLOSED_METRICS·golden.mjs GOLDEN_CHECKS 와 함께).
 */
export const FOCUS_METRICS = ["매출", "매출원가", "매출총이익", "영업이익"] as const;
const FOCUS_RE = new RegExp(`(^|[ (])(${FOCUS_METRICS.join("|")})($|[ ()])`);
/** 검사 이름에 다른(아직 안 닫은) 지표가 섞였는지 — PSR·성장률처럼 매출을 재료로 쓰는 파생 지표는 그 지표 몫 */
const OTHER_RE = /PSR|PER|PBR|EV|EBITDA|EPS|순이익|세전이익|자산|시가총액|감가상각|성장률|이익률|차입금|현금|주식수/;
/** 검증기 검사 이름이 작업 지표 검사인가 */
export const isFocusCheck = (name: string) => FOCUS_RE.test(name) && !OTHER_RE.test(name);
/** 외부 대조 항목("SYM 기간 지표")의 지표가 작업 지표인가 */
export const isFocusExternal = (item: string) => (FOCUS_METRICS as readonly string[]).includes(item.split(" ").slice(2).join(" "));
export const isFocusMetric = (metric: string) => (FOCUS_METRICS as readonly string[]).includes(metric);
