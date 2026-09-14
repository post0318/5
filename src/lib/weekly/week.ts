import "server-only";

/**
 * 리포트 대상 주(週) 계산 — KST 기준. 월요일 오후 발행이므로 "지난주"
 * (직전 월~금)가 대상. 월요일이 아닌 날에 수동 실행해도 같은 규칙:
 * 오늘보다 앞선 가장 최근 금요일을 weekEnd 로 잡는다.
 */
export interface ReportWeek {
  /** 지난주 월요일 */
  weekStart: string;
  /** 지난주 금요일 */
  weekEnd: string;
  /** 전전주 금요일(스냅샷 기준값 날짜) */
  baseFriday: string;
  /** 실행일(KST) */
  today: string;
}

const DAY = 86_400_000;

function kstDateString(ms: number): string {
  return new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
}

export function resolveReportWeek(now = new Date()): ReportWeek {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  const dow = kst.getUTCDay(); // KST 요일: 0=일 … 5=금, 6=토
  // 오늘 이전의 가장 최근 금요일까지 며칠 전인가: 토=1, 일=2, 월=3, …, 금=7
  const back = dow === 6 ? 1 : dow === 0 ? 2 : dow + 2;
  const fridayMs = now.getTime() - back * DAY;
  const weekEnd = kstDateString(fridayMs);
  const weekStart = kstDateString(fridayMs - 4 * DAY);
  const baseFriday = kstDateString(fridayMs - 7 * DAY);
  return { weekStart, weekEnd, baseFriday, today: kstDateString(now.getTime()) };
}
