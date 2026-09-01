/**
 * 날짜 처리 (prd.md §8) — 버그 방지 필수 규칙
 * - 입력 중간값 파싱 금지: 연도 4자리 완성 시에만 유효
 * - 연도 범위 가드
 * - 무한 루프 방지: 날짜 계산 루프에 상한 카운터
 * - Date 객체 대신 정규화된 문자열/숫자 사용
 */

import {
  addMonths,
  format,
  isValid,
  parseISO,
  startOfMonth,
} from "date-fns";

/** 조회 가능한 연도 범위. 이 밖의 값은 파싱/조회하지 않는다. */
export const MIN_YEAR = 1990;
export const MAX_YEAR = 2100;

/** 날짜 계산 루프의 절대 상한 (무한 루프 방지). */
export const MAX_DATE_LOOP_ITERATIONS = 1200;

export function isYearInRange(year: number): boolean {
  return Number.isInteger(year) && year >= MIN_YEAR && year <= MAX_YEAR;
}

/**
 * 연도 입력값이 "조회해도 되는" 완성 상태인지 판정.
 * "2027" 타이핑 중 "0002", "020" 같은 중간값을 걸러낸다.
 */
export function isCompleteYearInput(raw: string): boolean {
  const s = raw.trim();
  if (!/^\d{4}$/.test(s)) return false;
  return isYearInRange(Number(s));
}

/** 완성된 연도 문자열 → number. 미완성이면 null. */
export function parseYear(raw: string): number | null {
  return isCompleteYearInput(raw) ? Number(raw.trim()) : null;
}

/**
 * YYYY-MM-DD 문자열이 완성·유효한지 판정.
 * 부분 입력("2027-0", "2027-13-01")은 false.
 */
export function isCompleteISODate(raw: string): boolean {
  const s = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parseISO(s);
  if (!isValid(d)) return false;
  const year = Number(s.slice(0, 4));
  if (!isYearInRange(year)) return false;
  // parseISO는 2027-02-30을 3월로 굴리므로 round-trip으로 검증
  return format(d, "yyyy-MM-dd") === s;
}

/** 완성된 ISO 날짜 문자열만 통과시키고 나머지는 null. */
export function sanitizeISODate(raw: string): string | null {
  return isCompleteISODate(raw) ? raw.trim() : null;
}

/**
 * 오늘 기준 안전한 기본 조회 기간 (최근 N년).
 * Date 객체를 노출하지 않고 ISO 문자열로만 반환한다.
 */
export function defaultDateRange(years = 5): { from: string; to: string } {
  const now = new Date();
  const toYear = now.getFullYear();
  const fromYear = Math.max(MIN_YEAR, toYear - years);
  return {
    from: `${fromYear}-01-01`,
    to: format(now, "yyyy-MM-dd"),
  };
}

/**
 * from~to 사이 월초 날짜 목록. 상한 카운터로 무한 루프를 방지한다.
 * 입력이 미완성/역전이면 빈 배열.
 */
export function monthStartsBetween(fromISO: string, toISO: string): string[] {
  const from = sanitizeISODate(fromISO);
  const to = sanitizeISODate(toISO);
  if (!from || !to) return [];

  let cursor = startOfMonth(parseISO(from));
  const end = startOfMonth(parseISO(to));
  if (cursor.getTime() > end.getTime()) return [];

  const out: string[] = [];
  let guard = 0;
  while (cursor.getTime() <= end.getTime()) {
    if (++guard > MAX_DATE_LOOP_ITERATIONS) break;
    out.push(format(cursor, "yyyy-MM-dd"));
    cursor = addMonths(cursor, 1);
  }
  return out;
}

/** OpenDART 등에서 쓰는 YYYYMMDD 포맷. */
export function toCompactDate(iso: string): string | null {
  const s = sanitizeISODate(iso);
  return s ? s.replace(/-/g, "") : null;
}

/** YYYYMMDD → YYYY-MM-DD. 유효하지 않으면 원본 반환. */
export function fromCompactDate(compact: string): string {
  const s = compact.trim();
  if (!/^\d{8}$/.test(s)) return compact;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}
