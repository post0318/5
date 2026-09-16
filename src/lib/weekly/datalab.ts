import "server-only";
import type { WeeklyTopic } from "./topics";
import type { ReportWeek } from "./week";

/**
 * 네이버 검색어 트렌드 (NAVER API HUB).
 *
 * **경로 주의**(실측 2026-09, 오너 확인 — "네이버는 API HUB 이고 바라봐야 하는
 * 곳이 달라졌다"): 예전 개발자센터(`openapi.naver.com/v1/datalab/search`)와
 * 옛 게이트웨이(`naveropenapi.apigw.ntruss.com/datalab/v1/search`)는 이 키로
 * 안 된다. 뉴스 검색과 **같은 허브 호스트**에 경로만 다르다 —
 * `naverapihub.apigw.ntruss.com/search-trend/v1/search`. 인증 헤더도 같은
 * `X-NCP-APIGW-API-KEY-ID` / `X-NCP-APIGW-API-KEY`.
 *
 * 실측: 이 프로젝트의 검색용 키를 넣으면 인증은 통과하고 `"요청한 API는 이
 * Application 에서 활성화되어 있지 않습니다"` 가 온다 — 즉 **콘솔에서 그
 * 애플리케이션에 검색어 트렌드만 활성화하면 새 키 없이 바로 열린다**.
 *
 * 활성화 전에는 조용히 빈 결과를 돌려준다. 주간 리포트는 이 신호 없이도
 * 리포트·뉴스 빈도만으로 이슈를 뽑는다(`issues.ts`).
 *
 * 한 요청에 키워드 그룹은 5개까지라 나눠 보내고, 그룹당 최대 검색 비율을
 * 0~100 상대지수로 돌려준다.
 */

const ENDPOINT = "https://naverapihub.apigw.ntruss.com/search-trend/v1/search";
const GROUPS_PER_CALL = 5;

interface DatalabResponse {
  results?: { title: string; data: { period: string; ratio: number }[] }[];
}

function keys(): { id: string; secret: string } | null {
  const id = process.env.NAVER_APIHUB_KEY_ID;
  const secret = process.env.NAVER_APIHUB_KEY_SECRET;
  if (!id || !secret) return null;
  return { id, secret };
}

async function callOnce(
  auth: { id: string; secret: string },
  week: ReportWeek,
  groups: WeeklyTopic[],
): Promise<Map<string, number>> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "X-NCP-APIGW-API-KEY-ID": auth.id,
      "X-NCP-APIGW-API-KEY": auth.secret,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      startDate: week.weekStart,
      endDate: week.weekEnd,
      timeUnit: "date",
      keywordGroups: groups.map((g) => ({
        groupName: g.label,
        // 데이터랩은 그룹당 키워드 5개까지
        keywords: g.trendKeywords.slice(0, 5),
      })),
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    // 미활성화(401)·일시 오류 모두 여기로 — 신호만 빠지고 리포트는 나간다
    throw new Error(`검색어 트렌드 HTTP ${res.status}`);
  }
  const body = (await res.json()) as DatalabResponse;
  const out = new Map<string, number>();
  for (const r of body.results ?? []) {
    const peak = Math.max(0, ...r.data.map((d) => d.ratio));
    out.set(r.title, peak);
  }
  return out;
}

/** 주제별 그 주 최고 검색 관심도(0~100). 구독 전에는 빈 Map. */
export async function fetchSearchInterest(
  week: ReportWeek,
  topics: WeeklyTopic[],
): Promise<Map<string, number>> {
  const auth = keys();
  if (!auth) return new Map();

  const chunks: WeeklyTopic[][] = [];
  for (let i = 0; i < topics.length; i += GROUPS_PER_CALL) {
    chunks.push(topics.slice(i, i + GROUPS_PER_CALL));
  }

  const merged = new Map<string, number>();
  for (const chunk of chunks) {
    try {
      const part = await callOnce(auth, week, chunk);
      for (const [k, v] of part) merged.set(k, v);
    } catch {
      // 한 묶음이 실패해도 나머지는 살린다. 전부 실패하면 빈 Map.
      continue;
    }
  }
  return merged;
}

/** 점검용 — 애플리케이션에 검색어 트렌드가 활성화됐는지 한 번에 확인 */
export async function datalabStatus(): Promise<{
  configured: boolean;
  ok: boolean;
  message: string;
}> {
  const auth = keys();
  if (!auth) return { configured: false, ok: false, message: "NAVER 키 미설정" };
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "X-NCP-APIGW-API-KEY-ID": auth.id,
        "X-NCP-APIGW-API-KEY": auth.secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        startDate: "2026-01-01",
        endDate: "2026-01-07",
        timeUnit: "week",
        keywordGroups: [{ groupName: "금리", keywords: ["금리"] }],
      }),
      cache: "no-store",
    });
    if (res.ok) return { configured: true, ok: true, message: "정상" };
    const text = await res.text();
    return {
      configured: true,
      ok: false,
      message: text.includes("활성화")
        ? "콘솔에서 이 애플리케이션에 검색어 트렌드를 활성화해야 함 (키는 그대로 사용)"
        : `HTTP ${res.status} ${text.slice(0, 120)}`,
    };
  } catch (e) {
    return {
      configured: true,
      ok: false,
      message: e instanceof Error ? e.message : "확인 실패",
    };
  }
}
