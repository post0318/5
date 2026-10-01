import "server-only";
import { fetchText } from "@/lib/markets/http";
import { fetchYahooEstimates } from "@/lib/markets/quote/yahoo";
import type { IssueEvidenceEarnings, IssueEvidenceMetric, WeeklyIssue } from "./issues";
import type { ReportWeek } from "./week";

/**
 * 핵심 이슈 3개(선정 끝난 뒤)에 실적·공식 거시지표 근거를 덧붙인다(오너 지시
 * 2026-09-18 — 제안받은 "빅테크 실적 서프라이즈"·"FRED 공식 지표" 아이디어를
 * "핵심 이슈 근거로만 추가"로 좁혀 채택). 이슈 점수 계산에는 관여하지 않고
 * (이미 뽑힌 top 3에만 적용 — API 호출도 줄고, "기업분석은 범위 밖"이라는
 * 기존 규칙(`corpus.ts` 참고)도 지킨다) 종목 수를 고정된 소수(M7 안팎)로
 * 좁혔다. 실적은 Yahoo(이미 이 프로젝트가 컨센서스에 쓰는 `fetchYahooEstimates`
 * 재사용), 거시지표는 FRED 공개 CSV(`snapshot.ts`의 UST3Y 와 동일 패턴 —
 * API 키 불필요)를 쓴다. 둘 다 실패해도 그 근거만 빠지고 리포트 생성은
 * 막지 않는다(이 프로젝트의 "조용히 생략" 원칙).
 */

const EARNINGS_TICKERS_BY_TOPIC: Record<string, string[]> = {
  "AI·반도체 수요(해외)": ["NVDA", "TSM", "AVGO"],
  "미국 증시·밸류에이션": ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA"],
};

/**
 * FRED `release/dates` API 의 release_id(`comment.ts`의 FRED_RELEASES 와
 * 같은 값, `/fred/series/release?series_id=...`로 실측 확인) — 이 시리즈가
 * **그 주에 실제로 새로 발표됐는지** 확인하는 용도(오너 지적 2026-10-01 —
 * "지표를 보여주는것은 해당 이슈에 대한 지표를 확인주는 것인데 8월지표를
 * 보여주고 있고.."). 없으면(FEDFUNDS — 월간 평균치라 CPI/PPI 처럼 정해진
 * "발표일"이 있는 시리즈가 아님) release 여부를 못 가려 기존처럼 최신값을
 * 그대로 쓴다.
 */
const FRED_METRICS_BY_TOPIC: Record<
  string,
  { series: string; label: string; unit: string; releaseId?: number }[]
> = {
  // "전월비"를 라벨에 못 박아 둔다 — 뉴스 헤드라인의 "CPI 3.4%↑"는 보통
  // 전년동월비(YoY)라, 라벨 없이 지수값만 주면 서로 다른 기준의 숫자가
  // 나란히 놓여 헷갈린다(실측 — 오너 지적으로 발견).
  "물가·인플레이션": [
    { series: "CPIAUCSL", label: "미국 CPI(계절조정지수, 전월비)", unit: "지수", releaseId: 10 },
  ],
  "고용·경기": [
    { series: "UNRATE", label: "미국 실업률", unit: "%", releaseId: 50 },
    { series: "PAYEMS", label: "미국 비농업 고용(전월비)", unit: "천명", releaseId: 50 },
  ],
  "미국 금리·연준": [{ series: "FEDFUNDS", label: "실효 연방기금금리", unit: "%" }],
};

/** 최근 2개 관측치(전기 대비 계산용) — 월별 지표라 400일 정도 여유를 둔다. */
async function fetchFredLastTwo(seriesId: string): Promise<{ date: string; value: number }[]> {
  try {
    const cosd = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
    const csv = await fetchText(
      `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}&cosd=${cosd}`,
      { headers: { "user-agent": "Mozilla/5.0", accept: "text/csv" }, revalidate: 60 * 60 * 12 },
    );
    const lines = csv.trim().split(/\r?\n/);
    const rows: { date: string; value: number }[] = [];
    for (let i = 1; i < lines.length; i++) {
      const [date, raw] = lines[i]?.split(",") ?? [];
      if (!raw || raw === ".") continue;
      const value = Number(raw);
      if (Number.isFinite(value)) rows.push({ date, value });
    }
    return rows.slice(-2);
  } catch {
    return [];
  }
}

/** releaseId 가 있는 시리즈가 그 주(week.weekStart~weekEnd)에 실제로 새
 * 발표됐는지 — `comment.ts`의 `fetchFredReleaseEvents()`와 같은 엔드포인트.
 * 월간 지표는 보통 그 달에 한 번만 발표되므로, 발표가 없었던 주에는 지난
 * 발표분을 "최근 지표"로 재활용하지 않는다(그 주 뉴스가 아니므로). */
async function fredReleasedThisWeek(releaseId: number, week: ReportWeek): Promise<boolean> {
  const key = process.env.FRED_API_KEY;
  if (!key) return true; // 키 없으면 발표 여부를 못 가리므로 기존처럼 통과시킨다
  try {
    const res = await fetch(
      `https://api.stlouisfed.org/fred/release/dates?release_id=${releaseId}&api_key=${key}&realtime_start=${week.weekStart}&realtime_end=${week.weekEnd}&include_release_dates_with_no_data=true&file_type=json`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) return true;
    const j = (await res.json()) as { release_dates?: { date: string }[] };
    return (j.release_dates ?? []).some((d) => d.date >= week.weekStart && d.date <= week.weekEnd);
  } catch {
    return true;
  }
}

async function fetchMetricsForTopic(
  specs: { series: string; label: string; unit: string; releaseId?: number }[],
  week: ReportWeek,
): Promise<IssueEvidenceMetric[]> {
  const results = await Promise.all(
    specs.map(async (spec): Promise<IssueEvidenceMetric | null> => {
      if (spec.releaseId != null && !(await fredReleasedThisWeek(spec.releaseId, week))) return null;
      const last2 = await fetchFredLastTwo(spec.series);
      if (last2.length < 2) return null;
      const [prev, cur] = last2;
      return {
        label: spec.label,
        date: cur.date,
        current: cur.value,
        previous: prev.value,
        change: Math.round((cur.value - prev.value) * 1000) / 1000,
        unit: spec.unit,
        source: "FRED",
      };
    }),
  );
  return results.filter((m): m is IssueEvidenceMetric => m !== null);
}

async function fetchEarningsForTickers(tickers: string[]): Promise<Map<string, IssueEvidenceEarnings>> {
  const out = new Map<string, IssueEvidenceEarnings>();
  await Promise.all(
    tickers.map(async (ticker) => {
      try {
        const est = await fetchYahooEstimates("us", ticker);
        const last = est.surprises[est.surprises.length - 1];
        if (!last) return;
        out.set(ticker, {
          ticker,
          period: last.period,
          epsActual: last.epsActual,
          epsEstimate: last.epsEstimate,
          surprisePct: last.surprisePct != null ? Math.round(last.surprisePct * 10) / 10 : null,
        });
      } catch {
        // 이 종목만 근거 없이 남는다 — 리포트 생성 자체는 막지 않음
      }
    }),
  );
  return out;
}

/**
 * 실적 서프라이즈는 **그 리포트 주에 실제로 화제였을 분기만** 붙인다(오너
 * 지적 2026-09-21 — 9월 셋째 주 리포트에 2026-06-30 분기 실적이 달려
 * "먼소리지?"; 2026-10-01 재지적 — "실적 서프라이즈가 왜 계속 엔비디아만
 * 나올까?", "주간이다 주간과 관련되어야 하는데 거의 고정으로 나온다").
 *
 * Yahoo earningsHistory 는 **분기 종료일**만 주고 발표일은 안 준다. 처음엔
 * "종료일이 리포트 주 기준 8주 이내"(상한만 있는 단면 컷오프)로 걸렀는데,
 * NVDA 는 회계연도가 1월 결산이라 분기 종료일(7/31)이 캘린더 분기(6/30)
 * 종료 기업들(AAPL·MSFT·GOOGL·AMZN·META·TSLA)보다 한 달 늦다 — 그래서
 * 9월 내내 "8주 이내"를 만족하는 건 사실상 NVDA 뿐이었고(다른 6곳의 6/30
 * 분기는 9월 둘째 주만 지나도 8주를 넘겨 버림), 몇 주에 걸쳐 똑같은 NVDA
 * 실적만 "최근 실적"으로 계속 재활용됐다(실측).
 *
 * 하한도 둬서 **구간**(3~6주)으로 좁힌다 — 미국 대형주는 보통 분기 종료
 * 3~6주 뒤에 발표하므로, 그 구간을 지나면(실제 발표 후 몇 주가 지나면)
 * 더 이상 "이번 주의 소식"이 아니다. 발표 직전(3주 미만)엔 애초에 그
 * 분기 실적 자체가 아직 없다. 결과적으로 한 종목이 "최근 실적"으로
 * 잡히는 기간이 8주 연속에서 약 3주로 줄어 — 분기마다 실제 발표 시점
 * 근처 2~3주만 반영되고, 발표가 없는 주(대부분)엔 이 근거가 통째로
 * 빠진다(기존 "조용히 생략" 원칙과 동일 — 근거 없으면 그냥 안 보여줌).
 */
const EARNINGS_REPORT_LAG_MIN_DAYS = 3 * 7;
const EARNINGS_REPORT_LAG_MAX_DAYS = 6 * 7;

/** facts 줄 하나의 목표 길이 — 너무 길면 요약문 전체를 그대로 박아 넣은
 * 것처럼 보인다. */
const FACT_LINE_MAX_CHARS = 140;
/** 이슈 하나에 붙일 facts 최대 개수 — comment.ts 프롬프트의 "facts 3~6개"
 * 지시와 맞춘다. */
const FACTS_PER_ISSUE = 6;

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * facts 를 **코드가 reports/news 증거에서 직접 포맷**한다(오너 지시
 * 2026-10-01 — "핵심이슈를 뽑아서 작성할때 깊이가 이정도가 필요하다.
 * LLM아니어도 가능하지않냐?" → "해봐"). 증권사 리포트 제목·뉴스 제목
 * (+네이버 요약문)은 이미 실제 데이터라 LLM 이 웹검색으로 다시 찾아
 * 검증할 필요가 없다 — 그 비용·환각 위험을 통째로 없앤다. LLM 은 이
 * facts 를 입력으로 받아 headline·reading 만 쓴다(comment.ts).
 *
 * 숫자가 든 줄을 우선한다 — "구체적인 수치"가 facts 의 핵심 요건이었고
 * (기존 LLM 프롬프트 규칙과 동일 기준), 뉴스는 제목보다 네이버 요약문
 * (excerpt)에 수치가 더 많이 들어있다(실측). 중복은 정규화한 접두어로
 * 간단히 걸러낸다 — 같은 사건을 다루는 제목·요약이 흔히 겹친다.
 */
/**
 * `usedPrefixes` 는 이미 **다른 issue**에서 쓴 fact 를 걸러내는 공유
 * Set 이다(오너 지적 2026-10-01 — "유가가 반복하네": LLM 이 facts를 직접
 * 쓰던 시절, 서로 다른 issue 가 같은 WTI 유가 급락 수치를 거의 그대로
 * 반복해 썼다). facts 가 이제 코드 생성이라 같은 뉴스/리포트가 여러 주제
 * 정규식에 동시에 걸리면 똑같은 중복이 재발할 수 있어, 호출부(enrichTopIssues)
 * 가 이슈 순서대로 처리하며 이 Set 을 누적해 넘긴다 — 먼저 처리된(점수 높은)
 * 이슈가 우선권을 갖는다.
 */
function buildFactsFromEvidence(
  issue: Pick<WeeklyIssue, "reports" | "news">,
  usedPrefixes: Set<string>,
): string[] {
  const candidates: { text: string; hasNumber: boolean; date: string }[] = [];
  for (const n of issue.news) {
    const body = (n.excerpt?.trim() || n.title.trim()).replace(/\s+/g, " ");
    if (!body) continue;
    const date = n.publishedAt.slice(0, 10);
    candidates.push({
      text: truncate(`${body} (${n.source}, ${date})`, FACT_LINE_MAX_CHARS),
      hasNumber: /\d/.test(body),
      date,
    });
  }
  for (const r of issue.reports) {
    const title = r.title.trim().replace(/\s+/g, " ");
    if (!title) continue;
    candidates.push({
      text: truncate(`${title} (${r.source}, ${r.date})`, FACT_LINE_MAX_CHARS),
      hasNumber: /\d/.test(title),
      date: r.date,
    });
  }

  // 숫자 포함 우선, 그다음 최신순.
  candidates.sort((a, b) => Number(b.hasNumber) - Number(a.hasNumber) || b.date.localeCompare(a.date));

  const out: string[] = [];
  for (const c of candidates) {
    const prefix = c.text.replace(/\s+/g, "").slice(0, 16);
    if (usedPrefixes.has(prefix)) continue;
    usedPrefixes.add(prefix);
    out.push(c.text);
    if (out.length >= FACTS_PER_ISSUE) break;
  }
  return out;
}

export async function enrichTopIssues(
  issues: WeeklyIssue[],
  week: ReportWeek,
): Promise<WeeklyIssue[]> {
  const labels = new Set(issues.map((i) => i.label));

  const tickerSet = new Set<string>();
  for (const [label, tickers] of Object.entries(EARNINGS_TICKERS_BY_TOPIC)) {
    if (labels.has(label)) for (const t of tickers) tickerSet.add(t);
  }

  const [earningsMap, metricsByTopic] = await Promise.all([
    fetchEarningsForTickers([...tickerSet]),
    (async () => {
      const map = new Map<string, IssueEvidenceMetric[]>();
      await Promise.all(
        Object.entries(FRED_METRICS_BY_TOPIC)
          .filter(([label]) => labels.has(label))
          .map(async ([label, specs]) => {
            map.set(label, await fetchMetricsForTopic(specs, week));
          }),
      );
      return map;
    })(),
  ]);

  const usedFactPrefixes = new Set<string>();
  return issues.map((issue) => {
    const tickers = EARNINGS_TICKERS_BY_TOPIC[issue.label];
    const weekEndMs = Date.parse(`${week.weekEnd}T00:00:00Z`);
    const earnings = tickers
      ?.map((t) => earningsMap.get(t))
      .filter((e): e is IssueEvidenceEarnings => e != null)
      .filter((e) => {
        const t = Date.parse(`${e.period}T00:00:00Z`);
        if (!Number.isFinite(t)) return false;
        const ageDays = (weekEndMs - t) / 86_400_000;
        return ageDays >= EARNINGS_REPORT_LAG_MIN_DAYS && ageDays <= EARNINGS_REPORT_LAG_MAX_DAYS;
      });
    const metrics = metricsByTopic.get(issue.label);
    return {
      ...issue,
      facts: buildFactsFromEvidence(issue, usedFactPrefixes),
      ...(earnings && earnings.length > 0 ? { earnings } : {}),
      ...(metrics && metrics.length > 0 ? { metrics } : {}),
    };
  });
}
