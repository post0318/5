import "server-only";
import { shinhanResearchCol } from "@/lib/db/shinhan-research";
import { fetchCompanyBlog } from "@/lib/news/companyBlog";
import { fetchGoogleNewsRss, googleNewsUrl } from "@/lib/news/googleNews";
import { fetchNaverNewsInRange } from "@/lib/news/naverNews";
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

/**
 * 이슈 점수 가중치(오너 결정 2026-09-21, 실측 시뮬레이션 근거).
 *
 * 종전 0.5/0.3/0.2 는 증권사 리포트를 주 신호로 뒀는데, 리포트는 상시·후행
 * 성격이라 "그 주의 이슈"를 못 짚었다 — 실측: AI·반도체가 리포트 143건으로
 * 1위였지만 그중 107건이 국내 반도체였고, 그 주 보도량은 물가·유가·미국증시가
 * 훨씬 많았다. 뉴스를 주 신호로 올린다.
 *
 * **검색은 0** — 네이버 데이터랩 지수는 단어의 **일상성**에 지배된다.
 * 실측: "환율"은 그 주 뉴스 0건인데 검색 100, "물가"·"관세"·"고용"은 0.
 * 그 주에 무슨 일이 있었나가 아니라 평소 그 단어를 얼마나 검색하나를 재고
 * 있어 노이즈다. 절대값 대신 **직전 4주 평균 대비 변화율**로 바꾸면 사건성을
 * 재게 되므로, 그때 비중을 다시 넣는다(미착수).
 */
const WEIGHT = { research: 0.4, news: 0.6, search: 0 } as const;

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
  /** 주제에 직접 매핑된 소스(기업 블로그)라 관련성 정규식 검사를 면제한다.
   *  LLM 페이로드(buildPayload)에는 안 실린다 — 집계 단계 표시용. */
  trusted?: boolean;
}

/** 빅테크 실적 서프라이즈 — "핵심 이슈 근거로만"(오너 지시 2026-09-18,
 * `evidence.ts` 참고). 기업분석 자체는 범위 밖이라 최근 실적 1건만 싣는다. */
export interface IssueEvidenceEarnings {
  ticker: string;
  /** 분기 종료일(YYYY-MM-DD) 또는 라벨 */
  period: string;
  epsActual: number | null;
  epsEstimate: number | null;
  surprisePct: number | null;
}

/** FRED 공식 거시지표(전기 대비) — "핵심 이슈 근거로만"(오너 지시 2026-09-18). */
export interface IssueEvidenceMetric {
  label: string;
  date: string;
  current: number;
  previous: number;
  change: number;
  unit: string;
  source: string;
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
  /** 상위 3개로 뽑힌 뒤에만 채워진다(`evidence.ts` enrichTopIssues) */
  earnings?: IssueEvidenceEarnings[];
  metrics?: IssueEvidenceMetric[];
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
  const seenByTopic = new Map<string, Set<string>>();
  for (const t of WEEKLY_TOPICS) {
    out.set(t.label, { count: 0, reports: [] });
    seenByTopic.set(t.label, new Set());
  }

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
      // 같은 리포트가 여러 소스(예: 자체 수집기 + 한경 컨센서스 경유)로
      // 중복 저장돼 있을 수 있어(실측 — DS투자증권 리포트가 그대로 두 번
      // 뽑힘) 소스+제목 기준으로 근거만 중복 제거한다. count(빈도 점수)는
      // 원래 신호대로 그대로 둔다 — 실제로 두 곳에서 다뤄진 만큼 관심도가
      // 높다는 뜻이라 점수를 깎을 이유가 없다.
      const dedupeKey = `${d.source ?? ""}:${(d.title ?? "").replace(/\s+/g, "").toLowerCase()}`;
      const seen = seenByTopic.get(t.label)!;
      if (slot.reports.length < 12 && !seen.has(dedupeKey)) {
        seen.add(dedupeKey);
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
 * 걸러야 주간 신호가 된다. 구글의 `when:7d` 도 "지금부터 7일 전"이라 대상
 * 주가 지난 뒤(재생성 시점)엔 안 맞는 기간을 준다 — 그래서 하한(주 시작)
 * 뿐 아니라 **상한(주 종료+3일)도 직접 건다**(`countFromResearch()`와 동일
 * 패턴, 오너 실측 — 09-07~09-11 리포트를 09-18에 재생성했더니 09-16·09-17
 * 자 기사가 "그 주" 뉴스로 섞여 나왔다). 두 소스가 같은 기사를 각자 다른
 * 매체로 다시 걸어주는 경우가 있어 제목 기준으로 가볍게 중복 제거한다
 * (네이버를 먼저 둬 요약문이 있는 쪽을 우선).
 */
/** 이슈 주제 → 빅테크 공식 블로그(companyBlog.ts) 소스 매핑. 파급력이
 * 커도 3자 뉴스 매체가 받아쓰기 전엔 기존 파이프라인에 안 잡히는 자체
 * 발표를 보강한다(오너 지시 2026-09-18). 필요해지면 다른 주제·기업도
 * 여기 추가. */
const COMPANY_BLOGS_BY_TOPIC: Record<string, string[]> = {
  "AI·반도체 수요(해외)": ["NVIDIA", "Microsoft", "Oracle", "Amazon"],
};

async function countFromNews(
  week: ReportWeek,
  opts: { maxPages?: number } = {},
): Promise<Map<string, { count: number; news: IssueEvidenceNews[]; rejected: string[] }>> {
  const sinceMs = Date.parse(`${week.weekStart}T00:00:00+09:00`);
  const untilMs = Date.parse(`${week.weekEnd}T00:00:00Z`) + 3 * 86_400_000;
  const out = new Map<string, { count: number; news: IssueEvidenceNews[]; rejected: string[] }>();

  const results = await Promise.all(
    WEEKLY_TOPICS.map(async (t) => {
      // 최신 20건만 받으면 조회 시점 직전 몇 시간치만 들어와, 기사가 많은
      // 주제일수록 리포트 주 밖으로 전부 밀려난다(실측 2026-09-21 — "원달러
      // 환율" 0건). 기간이 찰 때까지 페이지를 넘겨 받는다.
      const naverP = fetchNaverNewsInRange(t.newsQuery, sinceMs, untilMs, {
        maxPages: opts.maxPages,
      }).catch(() => []);
      const googleP = t.domestic
        ? Promise.resolve([])
        : fetchGoogleNewsRss(
            googleNewsUrl(`search?q=${encodeURIComponent(t.newsQuery)}+when:7d`, "hl=ko&gl=KR&ceid=KR:ko"),
          ).catch(() => []);
      const blogSources = COMPANY_BLOGS_BY_TOPIC[t.label] ?? [];
      const blogP = Promise.all(blogSources.map((s) => fetchCompanyBlog(s).catch(() => [])));
      const [naver, google, blogLists] = await Promise.all([naverP, googleP, blogP]);
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
        ...blogLists.flat().map((b) => ({
          title: b.title,
          source: b.source,
          url: b.url,
          publishedAt: b.publishedAt,
          excerpt: b.excerpt ?? undefined,
          // 기업 블로그는 주제에 직접 매핑된 소스라 아래 관련성 검사를
          // 면제한다(영문 제목이라 한글 정규식에 안 걸리는 경우가 많다).
          trusted: true,
        })),
      ];
      return { topic: t, items };
    }),
  );

  for (const { topic, items } of results) {
    const seen = new Set<string>();
    const fresh: IssueEvidenceNews[] = [];
    const rejected: string[] = [];
    for (const i of items) {
      const ms = Date.parse(i.publishedAt);
      if (Number.isFinite(ms) && (ms < sinceMs || ms > untilMs)) continue;
      // 관련성 검사(오너 지시 2026-09-21) — 뉴스는 검색어로 받아온 결과를
      // 그대로 세고 있어서 주제와 무관한 기사가 섞였다(실측: "물가·인플레이션"
      // 근거에 "코스피, 미중 정상회담·추석 앞두고 방향성 탐색", "원달러 환율"에
      // "LG에너지솔루션 실적 개선세"). 리포트는 이미 match 정규식으로 판정
      // 하는데 뉴스만 검증이 없었다. 뉴스 가중치를 0.6 으로 올리면서 더
      // 중요해졌다.
      //
      // **제목만 본다** — 본문 발췌까지 넣으면 긴 텍스트 어딘가에 주제어가
      // 한 번 나오는 것만으로 통과한다(기업 블로그 필터에서 겪은 그 문제).
      if (!i.trusted && !topic.match.test(i.title)) {
        rejected.push(i.title); // 정규식 튜닝용 — newsRelevanceReport() 가 읽는다
        continue;
      }
      const key = i.title.replace(/\s+/g, "").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(i);
    }
    out.set(topic.label, { count: fresh.length, news: fresh.slice(0, 5), rejected });
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
    // 가중치가 0 이면 결과를 쓰지 않으므로 호출 자체를 건너뛴다.
    WEIGHT.search > 0
      ? fetchSearchInterest(week, WEEKLY_TOPICS).catch(() => new Map<string, number>())
      : Promise.resolve(new Map<string, number>()),
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

// ── 계열(family) 기반 상위 이슈 선정 ─────────────────────────────────
// 오너 지시 2026-09-21. 종전엔 점수 상위 3개를 그대로 썼는데 두 가지 문제가
// 있었다.
//  (1) 「5. 금리정책」 섹션이 이미 연준·한국은행·일본은행을 전담하는데
//      「3. 핵심 이슈」에서 또 미국 금리·연준이 1위로 뽑혀 같은 내용이 리포트
//      안에서 두 번 다뤄졌다 → 통화정책 계열은 후보에서 뺀다.
//  (2) 물가·유가처럼 사실상 한 이야기인 주제가 3칸 중 2칸을 나눠 가졌다
//      → 계열당 하나만 뽑고, 포함 관계가 뚜렷한 계열은 병합한다.

/** 주제 → 계열. 여기 없는 주제는 자기 자신이 계열이 된다. */
const TOPIC_FAMILY: Record<string, string> = {
  "미국 금리·연준": "통화정책",
  "한국은행·국내 금리": "통화정책",
  "일본은행·엔화": "통화정책",
  "물가·인플레이션": "물가·원자재",
  "국제유가·에너지": "물가·원자재",
  "미국 증시·밸류에이션": "미국증시·기술",
  "AI·반도체 수요(해외)": "미국증시·기술",
  "코스피 수급·외국인": "국내시장",
  "국내 반도체": "국내시장",
  "2차전지·전기차": "국내시장",
  "조선·방산": "국내시장",
  "관세·통상": "경기",
  "중국 경기·부양책": "경기",
  "고용·경기": "경기",
  "브라질 국채": "경기",
  "금·귀금속": "경기",
  "원달러 환율": "경기",
  "구리·산업금속": "경기",
  "BDI·해운운임": "경기",
};

/** 핵심 이슈 후보에서 통째로 빼는 계열 — 전용 섹션이 따로 있다. */
const EXCLUDED_FAMILIES = new Set(["통화정책"]);

/**
 * 병합하는 계열과 그 대표 라벨. 포함 관계가 뚜렷한 계열만 넣는다 —
 * 물가가 유가를 품고(오너 지시: "물가가 유가를 포함해야 한다"), 미국 증시가
 * AI·반도체를 품는다("ai 반도체는 미국증시를 움직인 하나의 요인").
 * 「경기」는 관세·중국·금·구리·BDI 가 서로 포함 관계가 없어(금과 구리는
 * 방향조차 반대) 병합하지 않고 점수 1위만 뽑는다.
 */
const MERGED_FAMILY_LABEL: Record<string, string> = {
  "물가·원자재": "물가·인플레이션",
  "미국증시·기술": "미국 증시·밸류에이션",
};

/** 제목 기준 중복 제거 — 같은 기사가 두 주제에 잡히는 경우가 많다. */
function dedupeByTitle<T extends { title: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const i of items) {
    const key = i.title.replace(/\s+/g, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(i);
  }
  return out;
}

/** 여러 주제의 근거를 번갈아 담는다 — 앞 주제가 자리를 다 차지하지 않게. */
function interleave<T>(lists: T[][], limit: number): T[] {
  const out: T[] = [];
  for (let i = 0; out.length < limit; i++) {
    let added = false;
    for (const l of lists) {
      if (i < l.length) {
        out.push(l[i]);
        added = true;
        if (out.length >= limit) break;
      }
    }
    if (!added) break;
  }
  return out;
}

/**
 * 계열 규칙을 적용해 상위 n개를 고른다. `all` 은 `buildWeeklyIssues()` 가
 * 준 **주제별** 목록(점수 내림차순)이고, 그대로 둬야 한다 — 검수용 후보
 * 목록과 금리정책 근거(policyEvidence)가 개별 주제를 그대로 참조한다.
 *
 * 병합 계열의 점수는 **구성원 중 최댓값**을 쓴다. 건수를 더하면 두 주제에
 * 동시에 잡힌 같은 기사를 두 번 세게 되는데(물가 491건·유가 492건이 대부분
 * 같은 기사일 수 있다), 정규화가 최댓값 기준이라 그 부풀림이 순위를 그대로
 * 뒤집는다. 최댓값은 과소평가일 수는 있어도 없는 근거를 만들지는 않는다.
 */
export function selectTopIssues(all: WeeklyIssue[], n = 3): WeeklyIssue[] {
  const byFamily = new Map<string, WeeklyIssue[]>();
  for (const issue of all) {
    const fam = TOPIC_FAMILY[issue.label] ?? issue.label;
    if (EXCLUDED_FAMILIES.has(fam)) continue;
    const list = byFamily.get(fam) ?? [];
    list.push(issue);
    byFamily.set(fam, list);
  }

  const picked: WeeklyIssue[] = [];
  for (const [fam, members] of byFamily) {
    // all 이 점수 내림차순이므로 members[0] 이 그 계열의 최고 점수다.
    const head = members[0];
    const repLabel = MERGED_FAMILY_LABEL[fam];
    if (!repLabel || members.length === 1) {
      picked.push(head);
      continue;
    }
    picked.push({
      ...head,
      label: repLabel,
      score: head.score,
      researchCount: Math.max(...members.map((m) => m.researchCount)),
      newsCount: Math.max(...members.map((m) => m.newsCount)),
      searchInterest: members.reduce<number | null>(
        (acc, m) => (m.searchInterest == null ? acc : Math.max(acc ?? 0, m.searchInterest)),
        null,
      ),
      reports: dedupeByTitle(interleave(members.map((m) => m.reports), 6)).slice(0, 3),
      news: dedupeByTitle(interleave(members.map((m) => m.news), 10)).slice(0, 5),
    });
  }

  return picked.sort((a, b) => b.score - a.score).slice(0, n);
}

/**
 * 관련성 정규식 튜닝용 진단(오너 지시 2026-09-21) — 주제별로 몇 건이
 * 걸러졌는지와 **탈락한 제목 표본**을 돌려준다. 필터를 켜니 감소율이
 * 주제마다 -5% ~ -100% 로 들쭉날쭉했는데, 그건 기사가 없어서가 아니라
 * 정규식 정밀도가 제각각이기 때문이다. 무엇이 걸러졌는지 봐야 고칠 수 있다.
 * LLM 을 호출하지 않아 비용이 없다.
 */
export async function newsRelevanceReport(week: ReportWeek): Promise<
  { label: string; accepted: number; rejected: number; rejectedSamples: string[] }[]
> {
  const news = await countFromNews(week);
  return WEEKLY_TOPICS.map((t) => {
    const r = news.get(t.label);
    return {
      label: t.label,
      accepted: r?.count ?? 0,
      rejected: r?.rejected.length ?? 0,
      rejectedSamples: (r?.rejected ?? []).slice(0, 12),
    };
  });
}

// ── 정규화 방식 비교 시뮬레이션 ──────────────────────────────────────
/**
 * 오너 지시 2026-09-21 — "정규화 개선을 했을 때 시뮬레이션도 확인해줘".
 *
 * 현재는 주제별 건수를 **전 주제 최댓값**으로 나눈다. 그러면 검색어가
 * 원래 많은 기사를 가져오는 주제가 항상 유리하다 — 실측: 미국 금리 319건 /
 * 고용·경기 4건 이라 고용은 점수가 0.01 수준이라 영구 배제된다. 기사량
 * 차이는 그 주에 무슨 일이 있었나가 아니라 검색어가 주는 양의 차이다.
 *
 * 대안: **그 주제의 평소 건수 대비 배수**로 바꾼다(직전 N주 평균 기준).
 * 평소 4건 나오던 주제가 12건이면 3배 — 평소 300건이 310건인 주제보다
 * 그 주에 실제로 튄 것이다. 검색 트렌드를 변화율로 바꾸자고 한 것과 같은 원리.
 *
 * 과거 주는 기준선 계산용이라 페이지를 2장으로 줄여 호출을 아낀다
 * (그 주의 정확한 총량이 아니라 평소 수준만 알면 된다).
 */
export async function normalizationSim(
  week: ReportWeek,
  lookbackWeeks = 3,
): Promise<{
  label: string;
  current: { research: number; news: number };
  baseline: { research: number; news: number };
  ratio: { research: number; news: number };
}[]> {
  const DAY = 86_400_000;
  const priorWeeks: ReportWeek[] = [];
  for (let i = 1; i <= lookbackWeeks; i++) {
    const shift = i * 7 * DAY;
    const iso = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - shift).toISOString().slice(0, 10);
    priorWeeks.push({
      weekStart: iso(week.weekStart),
      weekEnd: iso(week.weekEnd),
      baseFriday: iso(week.baseFriday),
      today: week.today,
    });
  }

  const [curRes, curNews] = await Promise.all([countFromResearch(week), countFromNews(week)]);
  const priors: { research: Awaited<ReturnType<typeof countFromResearch>>; news: Awaited<ReturnType<typeof countFromNews>> }[] = [];
  for (const w of priorWeeks) {
    // 순차 실행 — 동시에 때리면 네이버 레이트리밋에 걸린다.
    priors.push({
      research: await countFromResearch(w),
      news: await countFromNews(w, { maxPages: 2 }),
    });
  }

  return WEEKLY_TOPICS.map((t) => {
    const cR = curRes.get(t.label)?.count ?? 0;
    const cN = curNews.get(t.label)?.count ?? 0;
    const bR = priors.reduce((s, p) => s + (p.research.get(t.label)?.count ?? 0), 0) / priors.length;
    const bN = priors.reduce((s, p) => s + (p.news.get(t.label)?.count ?? 0), 0) / priors.length;
    return {
      label: t.label,
      current: { research: cR, news: cN },
      baseline: { research: bR, news: bN },
      // 기준선이 0 이면 배수를 못 내므로 1 로 바닥을 깐다(신규 주제 보호).
      ratio: { research: cR / Math.max(bR, 1), news: cN / Math.max(bN, 1) },
    };
  });
}
