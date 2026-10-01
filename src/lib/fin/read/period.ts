/**
 * 1층 — 기간 규칙(architecture.md §1). 사업연도 키·52/53주·분기 달력·LTM 창을 **이 파일 한 곳**에서 정한다.
 * `markets/us/edgar-series.ts` 의 fiscalYearOf·days·shiftYear·isStaleAnnual 을 옮겼다(규칙 동일).
 */

export const DAY = 864e5;
export function days(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / DAY);
}
export function addDays(d: string, n: number): string {
  return new Date(Date.parse(`${d.slice(0, 10)}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}
export function shiftYear(iso: string, n: number): string {
  const [y, m, d] = iso.split("-");
  return `${Number(y) + n}-${m}-${d}`;
}

/**
 * 결산일 → 사업연도. 결산일이 1월 1~7일이면 전년도(52/53주 결산 — WEN "fiscal 2022" = 2023-01-01 결산).
 */
export function fiscalYearOf(end: string): number {
  const y = Number(end.slice(0, 4));
  return end.slice(5, 7) === "01" && Number(end.slice(8, 10)) <= 7 ? y - 1 : y;
}

/** 기간 길이 분류 */
export function durKind(start: string | null, end: string): "FY" | "Q" | "6M" | "9M" | null {
  if (!start) return null;
  const d = days(start, end);
  if (d >= 300 && d <= 400) return "FY";
  if (d >= 55 && d <= 100) return "Q";
  if (d >= 160 && d <= 200) return "6M";
  if (d >= 250 && d <= 290) return "9M";
  return null;
}

/** 날짜가 ±tol 일 안에서 같은가(52/53주 결산·주말 보정) */
export const near = (a: string | null | undefined, b: string | null | undefined, tol = 3) =>
  a != null && b != null && Math.abs(days(a, b)) <= tol;

/** 최근 사업연도 종료가 이만큼(일) 넘게 지났으면 태그를 중단한 것으로 본다(edgar-series.ts 와 같은 값) */
export const STALE_ANNUAL_DAYS = 550;
export function isStaleAnnual(fyEnd: string, now = Date.now()): boolean {
  return (now - Date.parse(fyEnd)) / DAY > STALE_ANNUAL_DAYS;
}

/** 사업연도 하나와 그 안의 분기 경계 */
export interface FiscalYear {
  fy: number;
  start: string;
  end: string | null; // 10-K 가 아직 없으면 null(진행 중인 해)
  /** 1·2·3분기 말(모르면 null) */
  qEnds: [string | null, string | null, string | null];
}

/**
 * 분기 달력 — 연간 기간(start·end) 목록과 중간 기간(start·end) 목록으로 사업연도별 분기 말을 정한다.
 *  - 1분기 말 = 사업연도 시작과 같은 시작(±3일)의 3개월 기간 끝
 *  - 2·3분기 말 = 같은 시작의 6·9개월 누적 끝(없으면 직전 분기 말 다음날 시작하는 3개월 기간 끝)
 * 진행 중인 해(10-K 전)는 직전 사업연도 끝 다음날을 시작으로 본다.
 */
export function buildCalendar(
  annual: { start: string; end: string }[],
  interim: { start: string; end: string }[],
): FiscalYear[] {
  const byFy = new Map<number, { start: string; end: string }>();
  for (const a of annual) {
    const fy = fiscalYearOf(a.end);
    const p = byFy.get(fy);
    // 같은 해 기간이 둘이면(결산기 변경) 더 긴 것
    if (!p || days(a.start, a.end) > days(p.start, p.end)) byFy.set(fy, a);
  }
  const years: FiscalYear[] = [...byFy.entries()].sort((a, b) => a[0] - b[0]).map(([fy, p]) => ({ fy, start: p.start, end: p.end, qEnds: [null, null, null] }));
  // 진행 중인 해
  const last = years[years.length - 1];
  if (last?.end) {
    const s = addDays(last.end, 1);
    if (interim.some((i) => near(i.start, s) || i.start > s)) years.push({ fy: last.fy + 1, start: s, end: null, qEnds: [null, null, null] });
  }
  for (const y of years) {
    const from = interim.filter((i) => near(i.start, y.start));
    const endOf = (k: "Q" | "6M" | "9M") =>
      from.filter((i) => durKind(i.start, i.end) === k).map((i) => i.end).sort().pop() ?? null;
    let q1 = endOf("Q"), q2 = endOf("6M"), q3 = endOf("9M");
    const nextQ = (prevEnd: string | null) =>
      prevEnd ? interim.filter((i) => near(i.start, addDays(prevEnd, 1)) && durKind(i.start, i.end) === "Q").map((i) => i.end).sort().pop() ?? null : null;
    if (!q2) q2 = nextQ(q1);
    if (!q3) q3 = nextQ(q2);
    // 3개월 분기가 연간 끝을 넘으면 버린다(달력 오염 방지)
    const cap = (d: string | null) => (d && y.end && d >= y.end ? null : d);
    q1 = cap(q1); q2 = cap(q2); q3 = cap(q3);
    y.qEnds = [q1, q2, q3];
  }
  return years;
}
