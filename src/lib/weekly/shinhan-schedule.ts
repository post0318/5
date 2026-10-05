import "server-only";

/**
 * 신한투자증권 「이슈 및 섹터 스케줄」(오너 지시 2026-09-27 — "주간리포트에서 차주일정할때 참조하라").
 * 공개 화면(`/siw/insights/global/issueSector/view.do`)이 부르는 JSON(`data.do`)을 그대로 읽는다 — 로그인 불필요.
 * 거시·시장 일정만 남긴다(해외/국내 지표·이슈). 종목 상장·보호예수·공시·스포츠·휴장은 캘린더 대상이 아니라 제외.
 * 실패하면 빈 배열 — 리포트 생성을 막지 않는다.
 *
 * **요청 형식 주의(실측 2026-10-05)**: 이 API 는 `endDate`·`diffDate` 를 무시하고
 * **`startDate` 부터 거꾸로 약 7일치**를 준다(startDate=20260928 → 9/28~9/22).
 * 예전엔 startDate 에 다음 주 월요일을 넣어 **월요일 하루치만** 받고 있었다
 * (2026-09-28 주 초안의 "다음 주 일정"이 비거나 월요일 지표만 남은 원인 중 하나).
 * 그래서 startDate 에 구간 끝날을 넣고, 구간보다 길면 끝에서부터 7일씩 나눠 받는다.
 */
export interface ScheduleItem {
  date: string; // YYYY-MM-DD
  category: string;
  title: string;
}

const KEEP_CATEGORIES = new Set(["해외지표", "국내지표", "해외이슈", "국내이슈"]);
const ymd = (iso: string) => iso.replace(/-/g, "");
const dash = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const DAY = 86_400_000;

async function fetchWindowEndingAt(endIso: string): Promise<{ date: string; rows: string[][] }[]> {
  const res = await fetch("https://www.shinhansec.com/siw/insights/global/issueSector/data.do", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": "Mozilla/5.0",
    },
    // startDate 가 실제로는 "끝날"로 쓰인다(위 주석). endDate·diffDate 는 화면이 보내는 형식대로만 채운다.
    body: JSON.stringify({ startDate: ymd(endIso), endDate: ymd(endIso), diffDate: 0 }),
    signal: AbortSignal.timeout(15_000),
    next: { revalidate: 3600 },
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { body?: { list?: { date: string; ["반복데이타0"]?: string[][] }[] } };
  return (json.body?.list ?? []).map((d) => ({ date: dash(d.date), rows: d["반복데이타0"] ?? [] }));
}

export async function fetchShinhanSchedule(startIso: string, endIso: string): Promise<ScheduleItem[]> {
  try {
    const ends: string[] = [];
    for (let t = Date.parse(`${endIso}T00:00:00Z`), i = 0; t >= Date.parse(`${startIso}T00:00:00Z`) && i < 10; t -= 7 * DAY, i++) {
      ends.push(new Date(t).toISOString().slice(0, 10));
    }
    const windows = (await Promise.all(ends.map((e) => fetchWindowEndingAt(e).catch(() => [])))).flat();
    const seen = new Set<string>();
    const out: ScheduleItem[] = [];
    for (const day of windows) {
      if (day.date < startIso || day.date > endIso) continue;
      for (const r of day.rows) {
        const category = String(r[4] ?? "").trim();
        if (!KEEP_CATEGORIES.has(category)) continue;
        const title = String(r[3] ?? "").trim();
        const key = `${day.date}|${title}`;
        if (!title || seen.has(key)) continue;
        seen.add(key);
        out.push({ date: day.date, category, title });
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

/**
 * "다음 주 주시 일정" 표에 **코드로 바로 싣는** 주요 일정만 고른다(2026-10-05).
 * 예전엔 이 스케줄을 Gemini 입력으로만 넘기고, 표는 웹검색(그라운딩)이 성공했을
 * 때만 채웠다 — 그라운딩이 실패한 주(10-04 21:00 UTC 실행, 검색 0건)엔 고정
 * 일정(FOMC·고용 등)도 그 주에 없어 표가 통째로 비었다. 증권사가 공개한 확정
 * 일정이라 모델 확인 없이 그대로 싣는다.
 *
 * 시장 영향이 큰 것만 남긴다(PMI 확정치·주간 원유재고·채굴장비 수 같은 저영향
 * 정기 항목은 표가 길어지기만 해서 뺀다).
 */
const MAJOR_RE =
  /FOMC|의사록|금리\s*결정|통화정책|금통위|금융통화|BOJ|일본은행|ECB|유럽중앙은행|BOE|영란은행|인민은행|LPR|CPI|소비자물가|PPI|생산자물가|PCE|개인소비지출|고용|비농업|실업률|ISM|소매판매|GDP|국내총생산|미시건|미시간|소비심리|JOLT|무역수지|수출입|수출|산업생산|10년\s*만기\s*국채\s*입찰|30년\s*만기\s*국채\s*입찰|옵션\s*만기|선물.?옵션|동시\s*만기|국제수지|OPEC|정상회담|의장.{0,12}연설|잭슨홀|대선|총선|인플레이션\s*기대/i;
const MINOR_RE = /확정치|주간\s*(원유|신규|MBA|ADP)|채굴장비|모기지|도매재고|건설지출|주택가격|공장주문|소비자신용|외환보유액|경기동향|경기현황/;

export function isMajorScheduleItem(item: ScheduleItem): boolean {
  return MAJOR_RE.test(item.title) && !MINOR_RE.test(item.title);
}

/** "美) 9월 ISM 비제조업지수(현지시간)" → "미국 9월 ISM 비제조업지수(현지시간)" */
export function formatScheduleTitle(title: string): string {
  return title
    .replace(/^美\)\s*/, "미국 ")
    .replace(/^中\)\s*/, "중국 ")
    .replace(/^日\)\s*/, "일본 ")
    .replace(/^(영국|독일|유로존|프랑스|호주|캐나다|인도|브라질)\)\s*/, "$1 ")
    .trim();
}
