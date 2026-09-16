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
 * **키가 뉴스 검색과 다르다**(실측 2026-09): 허브 애플리케이션이 검색용
 * (`news`)과 트렌드용(`trend`)으로 나뉘어 있고, 검색어 트렌드는 `trend` 앱에만
 * 활성화돼 있다. `news` 키로 부르면 `"요청한 API는 이 Application 에서
 * 활성화되어 있지 않습니다"` 가 온다. 그래서 `NAVER_TREND_KEY_ID` /
 * `NAVER_TREND_KEY_SECRET` 를 따로 읽고, 없으면 검색용 키로 폴백한다
 * (두 API 를 한 앱에 몰아 둔 환경도 그대로 동작하도록).
 *
 * 키가 없거나 활성화 전이면 조용히 빈 결과를 돌려준다. 주간 리포트는 이 신호
 * 없이도 리포트·뉴스 빈도만으로 이슈를 뽑는다(`issues.ts`).
 *
 * **요청마다 100 이 다시 매겨진다 — 기준점(anchor) 필수.** 데이터랩은 한
 * 요청 안에서 가장 큰 그룹을 100 으로 놓고 나머지를 상대화한다. 그래서 주제를
 * 5개씩 나눠 보내면 묶음마다 1등이 100 이 돼 서로 비교할 수 없다(실측 —
 * 뉴스 3건짜리 "중국 경기"가 100, 뉴스 100건짜리 "원달러 환율"도 100).
 * 모든 요청에 같은 기준 키워드를 한 그룹 끼워 넣고, 그 값으로 각 묶음을
 * 나눠 같은 자로 재는 효과를 낸다. 그룹은 요청당 5개까지라 주제는 4개씩.
 */

const ENDPOINT = "https://naverapihub.apigw.ntruss.com/search-trend/v1/search";
/** 기준 그룹 1개를 빼고 주제는 4개씩 */
const GROUPS_PER_CALL = 4;
/** 모든 요청에 함께 보내는 기준 키워드 — 주제 목록과 겹치지 않는 흔한 말 */
const ANCHOR_LABEL = "__기준__";
const ANCHOR_KEYWORDS = ["주식"];

interface DatalabResponse {
  results?: { title: string; data: { period: string; ratio: number }[] }[];
}

function keys(): { id: string; secret: string } | null {
  const id = process.env.NAVER_TREND_KEY_ID || process.env.NAVER_APIHUB_KEY_ID;
  const secret =
    process.env.NAVER_TREND_KEY_SECRET || process.env.NAVER_APIHUB_KEY_SECRET;
  if (!id || !secret) return null;
  return { id, secret };
}

/** 한 묶음 조회 → 기준 그룹으로 나눈 "묶음 간 비교 가능한" 값 */
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
      keywordGroups: [
        ...groups.map((g) => ({
          groupName: g.label,
          // 데이터랩은 그룹당 키워드 5개까지
          keywords: g.trendKeywords.slice(0, 5),
        })),
        { groupName: ANCHOR_LABEL, keywords: ANCHOR_KEYWORDS },
      ],
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    // 미활성화(401)·일시 오류 모두 여기로 — 신호만 빠지고 리포트는 나간다
    throw new Error(`검색어 트렌드 HTTP ${res.status}`);
  }
  const body = (await res.json()) as DatalabResponse;
  const peaks = new Map<string, number>();
  for (const r of body.results ?? []) {
    peaks.set(r.title, Math.max(0, ...r.data.map((d) => d.ratio)));
  }
  const anchor = peaks.get(ANCHOR_LABEL) ?? 0;
  const out = new Map<string, number>();
  for (const [title, peak] of peaks) {
    if (title === ANCHOR_LABEL) continue;
    // 기준이 0 이면(그 주에 기준어 검색이 거의 없던 극단적 경우) 나눌 수 없어
    // 원값을 그대로 둔다 — 그 묶음만 비교가 거칠어지고 나머지는 멀쩡하다.
    out.set(title, anchor > 0 ? peak / anchor : peak);
  }
  return out;
}

/**
 * 주제별 그 주 검색 관심도. 기준 그룹으로 묶음 간 비교를 맞춘 뒤, 읽기 좋게
 * 전체 최댓값을 100 으로 다시 맞춰 돌려준다. 키가 없거나 실패하면 빈 Map.
 */
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
  const max = Math.max(0, ...merged.values());
  if (max <= 0) return merged;
  const scaled = new Map<string, number>();
  for (const [k, v] of merged) scaled.set(k, (v / max) * 100);
  return scaled;
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
        ? "이 애플리케이션에 검색어 트렌드가 없음 — NAVER_TREND_KEY_ID/SECRET 확인"
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
