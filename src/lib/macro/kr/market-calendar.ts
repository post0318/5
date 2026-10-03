import "server-only";

/**
 * 한국 증시 휴장일 달력 — 휴장 판정을 "KRX 가 빈 응답을 줬다"는 데이터만으로 하지 않기 위한 근거(오너 지시 2026-10-03).
 * 예전엔 빈 응답 = 휴장으로 찍어, KRX OPEN API 가 아직 데이터를 안 낸 실제 거래일 11일(09-14~10-01)을 휴장으로 오기록했다.
 *
 * 소스: Nager.Date 공개 API(무료·인증 불필요, `lib/weekly/comment.ts` 가 이미 다른 나라 휴장일에 쓰는 것과 같은 소스).
 * 한국 공휴일(대체공휴일·선거일 포함, 실측 2026 — 예: 10-05 개천절 대체, 06-03 지방선거)에 KRX 고유 휴장일을 더한다:
 *   - 12-31 연말 휴장(공휴일 목록에 없음)
 *   - 05-01 근로자의 날(Nager 에 "노동절"로 이미 있음 — 없을 때를 대비해 고정 추가)
 * 달력을 못 받으면 null(모름)을 돌려주고 호출자가 판단한다 — 모르는 걸 휴장으로 단정하지 않는다.
 */

const cache = new Map<number, { at: number; days: Set<string> | null }>();
const TTL_MS = 12 * 60 * 60 * 1000;

async function holidaysOf(year: number): Promise<Set<string> | null> {
  const hit = cache.get(year);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.days;
  let days: Set<string> | null = null;
  try {
    const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/KR`, {
      signal: AbortSignal.timeout(8_000),
      next: { revalidate: TTL_MS / 1000 },
    });
    if (res.ok) {
      const rows = (await res.json()) as { date: string }[];
      days = new Set(rows.map((r) => r.date));
      days.add(`${year}-05-01`);
      days.add(`${year}-12-31`);
    }
  } catch {
    days = null;
  }
  cache.set(year, { at: Date.now(), days });
  return days;
}

/** 한국 증시 휴장일인가(YYYY-MM-DD). 주말·공휴일·KRX 고유 휴장이면 true, 거래일이면 false, 달력을 못 받으면 null. */
export async function isKrxHoliday(date: string): Promise<boolean | null> {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return true;
  const days = await holidaysOf(Number(date.slice(0, 4)));
  if (!days) return null;
  return days.has(date);
}
