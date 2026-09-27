import "server-only";

/**
 * 신한투자증권 「이슈 및 섹터 스케줄」(오너 지시 2026-09-27 — "주간리포트에서 차주일정할때 참조하라").
 * 공개 화면(`/siw/insights/global/issueSector/view.do`)이 부르는 JSON(`data.do`)을 그대로 읽는다 — 로그인 불필요.
 * 거시·시장 일정만 남긴다(해외/국내 지표·이슈). 종목 상장·보호예수·공시·스포츠·휴장은 캘린더 대상이 아니라 제외.
 * 실패하면 빈 배열 — 참조 자료일 뿐이라 리포트 생성을 막지 않는다.
 */
export interface ScheduleItem {
  date: string; // YYYY-MM-DD
  category: string;
  title: string;
}

const KEEP_CATEGORIES = new Set(["해외지표", "국내지표", "해외이슈", "국내이슈"]);
const ymd = (iso: string) => iso.replace(/-/g, "");
const dash = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

export async function fetchShinhanSchedule(startIso: string, endIso: string): Promise<ScheduleItem[]> {
  try {
    const diff = Math.round((Date.parse(`${endIso}T00:00:00Z`) - Date.parse(`${startIso}T00:00:00Z`)) / 86_400_000);
    const res = await fetch("https://www.shinhansec.com/siw/insights/global/issueSector/data.do", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": "Mozilla/5.0",
      },
      body: JSON.stringify({ startDate: ymd(startIso), endDate: ymd(endIso), diffDate: diff }),
      signal: AbortSignal.timeout(15_000),
      next: { revalidate: 3600 },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { body?: { list?: { date: string; ["반복데이타0"]?: string[][] }[] } };
    const out: ScheduleItem[] = [];
    for (const day of json.body?.list ?? []) {
      const date = dash(day.date);
      if (date < startIso || date > endIso) continue;
      for (const r of day["반복데이타0"] ?? []) {
        const category = String(r[4] ?? "").trim();
        if (!KEEP_CATEGORIES.has(category)) continue;
        out.push({ date, category, title: String(r[3] ?? "").trim() });
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}
