import "server-only";

/**
 * 중앙은행 회의 일정 — **공식 소스에서 가져온다**(오너 지적 2026-09-20 —
 * "이건 주고 안주고가 아니라 찾아야하지 않겠니?").
 *
 * 원래는 연도별 일정을 배열에 손으로 박아뒀는데, 그러면 해가 바뀔 때마다
 * 갱신해야 하고 잊으면 조용히 빈 목록이 된다. 실제로 LLM 코멘트가 "11월
 * 추가 인상 여부"라고 썼는데 2026년 FOMC 는 10/28 다음이 12/09 라 11월
 * 회의가 없었다(FOMC 는 연 8회라 없는 달이 생긴다).
 *
 * 소스별 사정이 달라 셋을 따로 처리한다:
 *  - **FOMC**: Kalshi KXFED 시리즈(무인증, 이미 `macro/fedwatch.ts` 가 쓰는
 *    API). 회의별 이벤트의 strike_date 가 곧 결정일이고 2028년분까지 있다.
 *    실측(2026-09-20) 2026년 8개가 손으로 박아둔 값과 완전히 일치했다.
 *  - **BOJ**: boj.or.jp 영문 일정표(공개 HTML). 회의는 이틀이고 **둘째 날이
 *    결정일**이다("Jan. 22 (Thurs.), 23 (Fri.)" → 1/23). 한 페이지에 올해와
 *    내년 표가 같이 있어 표 캡션("Table : 2026")에서 연도를 읽어야 한다 —
 *    안 그러면 내년 날짜를 올해로 찍는다(실측 오류).
 *  - **한국은행**: bok.or.kr 통화정책방향 결정회의 목록(공개 HTML). 기본
 *    페이지가 당해 연도를 보여준다. 실측(2026-09-20) 2026년 8개 일치.
 *
 * 모두 실패하면 아래 FALLBACK(2026년 실측 확인값)을 쓴다. 긁어오기가 깨져도
 * 최소한 그해까지는 정확한 값이 나가고, 그마저 없으면 빈 목록이 되는데
 * 그때는 "목록에 없는 달을 지어내지 마라"는 프롬프트 규칙이 대신 작동한다.
 */

export interface CbMeeting {
  /** 결정일 YYYY-MM-DD */
  date: string;
  bank: string;
}

export const BANK_FOMC = "미국 FOMC";
export const BANK_BOJ = "일본은행(BOJ)";
export const BANK_BOK = "한국은행 금통위";

/** 2026년 실측 확인값 — 긁어오기 실패 시에만 쓴다. */
const FALLBACK: Record<string, string[]> = {
  [BANK_FOMC]: [
    "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17",
    "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
  ],
  [BANK_BOJ]: [
    "2026-01-23", "2026-03-19", "2026-04-28", "2026-06-16",
    "2026-07-31", "2026-09-18", "2026-10-30", "2026-12-18",
  ],
  [BANK_BOK]: [
    "2026-01-15", "2026-02-26", "2026-04-10", "2026-05-28",
    "2026-07-16", "2026-08-27", "2026-10-22", "2026-11-26",
  ],
};

const UA = "Mozilla/5.0 (compatible; stock-research/1.0)";
/** 일정은 몇 달에 한 번 바뀐다 — 하루 캐시면 충분하다. */
const REVALIDATE = 24 * 60 * 60;

async function getText(url: string, accept: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept },
    signal: AbortSignal.timeout(12_000),
    next: { revalidate: REVALIDATE },
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Kalshi KXFED 이벤트의 strike_date = FOMC 결정일. */
async function fetchFomc(): Promise<string[]> {
  const raw = await getText(
    "https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=KXFED&limit=200",
    "application/json",
  );
  const { events } = JSON.parse(raw) as { events?: { strike_date?: string }[] };
  const dates = (events ?? [])
    .map((e) => e.strike_date?.slice(0, 10))
    .filter((d): d is string => Boolean(d));
  return [...new Set(dates)].sort();
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/**
 * BOJ 영문 일정표. 한 페이지에 연도별 표가 여러 개 있고 각 표 앞에
 * "Table : 2026" 캡션이 붙는다 — 캡션을 기준으로 잘라 각 표에 그 연도를
 * 적용한다. 각 행의 **첫 셀**만 회의일이고(나머지는 성명문·의사록 공개일),
 * "Apr. 27 (Mon.), 28 (Tues.)" 처럼 이틀이 적히며 둘째 날이 결정일이다.
 */
async function fetchBoj(): Promise<string[]> {
  const html = await getText("https://www.boj.or.jp/en/mopo/mpmsche_minu/index.htm", "text/html");
  const out: string[] = [];
  // 캡션 위치로 표 구간을 나눈다. 캡션이 없으면(구조 변경) 아무것도 안 나온다.
  const captions = [...html.matchAll(/Table\s*[:：]\s*(20\d{2})/g)];
  for (let i = 0; i < captions.length; i++) {
    const year = Number(captions[i][1]);
    const start = captions[i].index ?? 0;
    const end = i + 1 < captions.length ? (captions[i + 1].index ?? html.length) : html.length;
    const section = html.slice(start, end);
    for (const row of section.match(/<tr[\s\S]*?<\/tr>/g) ?? []) {
      const firstCell = row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/);
      if (!firstCell) continue;
      const m = stripTags(firstCell[1]).match(
        /^([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2})\s*\([^)]*\)\s*,\s*(\d{1,2})\s*\(/,
      );
      if (!m) continue;
      const month = MONTHS[m[1].toLowerCase()];
      if (!month) continue;
      const day1 = Number(m[2]);
      const day2 = Number(m[3]);
      // 4/30~5/1 처럼 월을 넘기는 회의 — 둘째 날이 더 작으면 다음 달이다.
      const rolled = day2 < day1;
      const month2 = rolled ? month + 1 : month;
      const y = month2 > 12 ? year + 1 : year;
      out.push(`${y}-${pad(month2 > 12 ? 1 : month2)}-${pad(day2)}`);
    }
  }
  return [...new Set(out)].sort();
}

/**
 * 한국은행 통화정책방향 결정회의 목록. 기본 페이지가 당해 연도를 보여주고
 * 본문에 "01월 15일" 형식으로 날짜가 박혀 있다. 연도는 페이지 제목의
 * "2026년" 에서 읽는다(목록이 그 해 것만 나오므로).
 */
async function fetchBok(): Promise<string[]> {
  const html = await getText(
    "https://www.bok.or.kr/portal/singl/crncyPolicyDrcMtg/listYear.do?mtgSe=A&menuNo=200755",
    "text/html",
  );
  const yearMatch = html.match(/결정회의\s*(20\d{2})\s*년/) ?? html.match(/(20\d{2})\s*년/);
  if (!yearMatch) return [];
  const year = yearMatch[1];
  const out: string[] = [];
  for (const m of stripTags(html).matchAll(/(\d{2})월\s*(\d{2})일/g)) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    out.push(`${year}-${pad(month)}-${pad(day)}`);
  }
  return [...new Set(out)].sort();
}

/** 긁어온 값이 너무 적으면(구조 변경·차단) 신뢰하지 않고 FALLBACK 을 쓴다.
 *  연 8회가 정상이라 4개 미만이면 파싱이 깨진 것으로 본다. */
function pick(bank: string, fetched: string[]): CbMeeting[] {
  const dates = fetched.length >= 4 ? fetched : (FALLBACK[bank] ?? []);
  return dates.map((date) => ({ date, bank }));
}

/**
 * 가져올 수 있는 중앙은행 회의를 **전부** 날짜순으로 돌려준다(과거분 포함).
 * 한 소스가 실패해도 나머지는 그대로 나간다.
 *
 * 과거분까지 주는 이유: 프롬프트에는 앞으로 남은 것만 넘기면 되지만,
 * 검증(`verifyMeetingMonths`)은 "9월 FOMC에서 인상했다" 같은 **지난 회의
 * 언급**도 참이라고 판정할 수 있어야 한다. 앞으로 남은 것만 갖고 검증하면
 * 맞는 문장을 틀렸다고 버린다.
 */
export async function getCentralBankMeetings(): Promise<CbMeeting[]> {
  const [fomc, boj, bok] = await Promise.all([
    fetchFomc().catch(() => []),
    fetchBoj().catch(() => []),
    fetchBok().catch(() => []),
  ]);
  return [
    ...pick(BANK_FOMC, fomc),
    ...pick(BANK_BOJ, boj),
    ...pick(BANK_BOK, bok),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.bank.localeCompare(b.bank));
}

/** 텍스트에서 그 중앙은행을 가리키는지 판정하는 키워드 — 검증에서 쓴다. */
export const BANK_MENTION_RE: Record<string, RegExp> = {
  [BANK_FOMC]: /FOMC|연준|연방준비|\bFed\b/i,
  [BANK_BOJ]: /BOJ|일본은행|일은\b/i,
  [BANK_BOK]: /한국은행|금통위|한은\b/,
};
