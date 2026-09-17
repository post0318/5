import "server-only";
import { shinhanResearchCol } from "@/lib/db/shinhan-research";
import { fetchGoogleNewsRss, googleNewsUrl } from "@/lib/news/googleNews";
import { fetchNaverNewsSearch } from "@/lib/news/naverNews";
import { WEEKLY_TOPICS, type WeeklyTopic } from "./topics";
import type { ReportWeek } from "./week";

/**
 * 주간 핵심 이슈 선정 — **LLM 없이 빈도 집계로만** (오너 지시 2026-09).
 *
 * 세 가지 신호를 합쳐 상위 3개를 고른다.
 *  1) 증권사 리포트 빈도 — 한 주 동안 여러 증권사가 반복해 다룬 주제일수록
 *     그 주의 시장 관심사다. 이미 수집 중인 자료라 근거(제목·출처)를 그대로
 *     붙일 수 있다. **주 신호**.
 *  2) 그 주 뉴스 기사 수 — 대중 매체가 얼마나 다뤘는지. 피드가 주제당 100건
 *     에서 포화하므로 보조 가중치로만 쓴다.
 *  3) 네이버 검색어 트렌드(API 허브) — 실제 대중 검색 관심도.
 *     애플리케이션에 활성화되기 전에는 조용히 건너뛴다(`datalab.ts`).
 *
 * 점수는 각 신호를 그 주 최댓값으로 나눠 0~1 로 맞춘 뒤 가중 합산한다.
 * 신호마다 단위가 달라(건수 vs 상대지수) 그대로 더하면 큰 쪽이 결과를 삼킨다.
 */

const WEIGHT = { research: 0.5, news: 0.3, search: 0.2 } as const;

export interface IssueEvidenceReport {
  date: string;
  source: string;
  stockName: string;
  title: string;
}

export interface IssueEvidenceNews {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  /** 네이버 뉴스 검색 API 의 요약문(있을 때만) — 구글 뉴스 RSS 항목은 없음 */
  excerpt?: string;
}

export interface WeeklyIssue {
  label: string;
  /** 0~1 가중 합산 점수 */
  score: number;
  researchCount: number;
  newsCount: number;
  /** 네이버 검색어 트렌드 상대 관심도(0~100). 활성화 전에는 null */
  searchInterest: number | null;
  reports: IssueEvidenceReport[];
  news: IssueEvidenceNews[];
}

/** 리포트 제목·업종명·발췌에서 주제별 등장 건수와 근거를 모은다. */
async function countFromResearch(
  week: ReportWeek,
): Promise<Map<string, { count: number; reports: IssueEvidenceReport[] }>> {
  const col = await shinhanResearchCol();
  // 대상 주 월요일부터 그 주 금요일 다음 월요일까지. 위쪽을 막지 않으면 주중에
  // 수동 실행할 때 이번 주 리포트까지 딸려 들어와 "지난주" 집계가 아니게 된다
  // (실측 — 9/7~9/11 리포트에 9/16 자 항목이 섞였다). 월요일 오전 발간분은
  // 지난주 정리 성격이라 하루치 여유를 둔다.
  const until = new Date(Date.parse(`${week.weekEnd}T00:00:00Z`) + 3 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const docs = await col
    .find({ category: "산업", date: { $gte: week.weekStart, $lte: until } })
    .sort({ date: -1 })
    .limit(800)
    .toArray();

  const out = new Map<string, { count: number; reports: IssueEvidenceReport[] }>();
  for (const t of WEEKLY_TOPICS) out.set(t.label, { count: 0, reports: [] });

  for (const d of docs) {
    // 발췌까지 보는 이유: 제목만으로는 "Weekly Monitor" 처럼 주제가 안 드러나는
    // 정기 리포트가 많다. 다만 발췌는 길어 오탐이 늘므로 앞부분만 본다.
    const hay = `${d.stockName ?? ""} ${d.title ?? ""} ${(d.summary ?? "").slice(0, 300)}`;
    for (const t of WEEKLY_TOPICS) {
      if (!t.match.test(hay)) continue;
      const slot = out.get(t.label)!;
      slot.count += 1;
      // 근거는 제목에 주제가 드러난 것부터 — 발췌에만 걸린 건 뒤로 민다.
      const strong = t.match.test(`${d.stockName ?? ""} ${d.title ?? ""}`);
      if (slot.reports.length < 12) {
        const ev: IssueEvidenceReport = {
          date: d.date,
          source: d.source,
          stockName: d.stockName ?? "",
          title: d.title ?? "",
        };
        if (strong) slot.reports.unshift(ev);
        else slot.reports.push(ev);
      }
    }
  }
  return out;
}

/**
 * 주제별 그 주 뉴스 — 국내 주제는 네이버 뉴스 검색만, 해외 주제는 네이버+
 * 구글 뉴스 RSS 를 합친다(`WeeklyTopic.domestic`, 오너 지시 2026-09 —
 * "해외는 구글과 네이버를 같이쓰고 국내는 대체"). 네이버는 요약문
 * (`excerpt`)이 있어 제목만 주는 구글보다 Gemini 코멘트 근거가 구체적이다.
 *
 * 네이버 뉴스 검색(API 허브)은 날짜 범위를 못 걸어 전체 누적 건수만 주므로
 * (실측 — "FOMC 금리" 38만 건) `display` 로 받은 최신순 결과를 날짜로 직접
 * 걸러야 주간 신호가 된다. 구글은 `when:7d` 로 서버가 이미 걸러 준다.
 * 두 소스가 같은 기사를 각자 다른 매체로 다시 걸어주는 경우가 있어 제목
 * 기준으로 가볍게 중복 제거한다(네이버를 먼저 둬 요약문이 있는 쪽을 우선).
 */
async function countFromNews(
  week: ReportWeek,
): Promise<Map<string, { count: number; news: IssueEvidenceNews[] }>> {
  const sinceMs = Date.parse(`${week.weekStart}T00:00:00+09:00`);
  const out = new Map<string, { count: number; news: IssueEvidenceNews[] }>();

  const results = await Promise.all(
    WEEKLY_TOPICS.map(async (t) => {
      const naverP = fetchNaverNewsSearch(t.newsQuery, { display: 20 }).catch(() => []);
      const googleP = t.domestic
        ? Promise.resolve([])
        : fetchGoogleNewsRss(
            googleNewsUrl(`search?q=${encodeURIComponent(t.newsQuery)}+when:7d`, "hl=ko&gl=KR&ceid=KR:ko"),
          ).catch(() => []);
      const [naver, google] = await Promise.all([naverP, googleP]);
      const items: IssueEvidenceNews[] = [
        ...naver.map((n) => ({
          title: n.title,
          source: n.source,
          url: n.url,
          publishedAt: n.publishedAt,
          excerpt: n.excerpt ?? undefined,
        })),
        ...google.map((g) => ({
          title: g.title,
          source: g.source,
          url: g.link,
          publishedAt: g.publishedAt,
        })),
      ];
      return { topic: t, items };
    }),
  );

  for (const { topic, items } of results) {
    const seen = new Set<string>();
    const fresh: IssueEvidenceNews[] = [];
    for (const i of items) {
      const ms = Date.parse(i.publishedAt);
      if (Number.isFinite(ms) && ms < sinceMs) continue;
      const key = i.title.replace(/\s+/g, "").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(i);
    }
    out.set(topic.label, { count: fresh.length, news: fresh.slice(0, 5) });
  }
  return out;
}

function normalize(values: number[]): number[] {
  const max = Math.max(...values, 0);
  if (max <= 0) return values.map(() => 0);
  return values.map((v) => v / max);
}

export async function buildWeeklyIssues(
  week: ReportWeek,
  opts: { top?: number } = {},
): Promise<WeeklyIssue[]> {
  const { fetchSearchInterest } = await import("./datalab");
  const [research, news, interest] = await Promise.all([
    countFromResearch(week),
    countFromNews(week),
    fetchSearchInterest(week, WEEKLY_TOPICS).catch(() => new Map<string, number>()),
  ]);

  const rows = WEEKLY_TOPICS.map((t: WeeklyTopic) => ({
    topic: t,
    researchCount: research.get(t.label)?.count ?? 0,
    newsCount: news.get(t.label)?.count ?? 0,
    searchInterest: interest.get(t.label) ?? null,
    reports: research.get(t.label)?.reports ?? [],
    newsItems: news.get(t.label)?.news ?? [],
  }));

  const nRes = normalize(rows.map((r) => r.researchCount));
  const nNews = normalize(rows.map((r) => r.newsCount));
  const nSearch = normalize(rows.map((r) => r.searchInterest ?? 0));
  const hasSearch = rows.some((r) => r.searchInterest != null);

  // 검색어 트렌드가 아직 활성화되지 않았으면 그 몫을 리포트·뉴스로 비례
  // 배분한다 — 0 으로 두면 총점만 낮아지고 순위는 그대로라 무의미하다.
  const w = hasSearch
    ? WEIGHT
    : {
        research: WEIGHT.research / (WEIGHT.research + WEIGHT.news),
        news: WEIGHT.news / (WEIGHT.research + WEIGHT.news),
        search: 0,
      };

  const scored: WeeklyIssue[] = rows.map((r, i) => ({
    label: r.topic.label,
    score: nRes[i] * w.research + nNews[i] * w.news + nSearch[i] * w.search,
    researchCount: r.researchCount,
    newsCount: r.newsCount,
    searchInterest: r.searchInterest,
    reports: r.reports.slice(0, 3),
    news: r.newsItems.slice(0, 3),
  }));

  return scored
    .filter((s) => s.researchCount > 0 || s.newsCount > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.top ?? 3);
}
