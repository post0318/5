import "server-only";
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
 * 재사용), 거시지표는 FRED API(키 필요 — 그 주 발표 여부를 빈티지로 확인,
 * 아래 fetchOfficialMetrics)를 쓴다. 둘 다 실패해도 그 근거만 빠지고 리포트 생성은
 * 막지 않는다(이 프로젝트의 "조용히 생략" 원칙).
 */

const EARNINGS_TICKERS_BY_TOPIC: Record<string, string[]> = {
  "AI·반도체 수요(해외)": ["NVDA", "TSM", "AVGO"],
  "미국 증시·밸류에이션": ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA"],
};

/**
 * 미국 공식 거시지표(FRED) — **리포트 주에 실제로 새로 발표된 값만** 싣는다.
 *
 * 2026-10-05 오너 지적("미국 CPI(계절조정지수, 전월비) 334.131지수 (전기 대비
 * +1.318지수, 2026-08-01) — 너무 과거 것을 쓰고 있다"): 원인은 둘이었다.
 *  ① 발표 여부 확인(`release/dates`)이 FRED_API_KEY 가 없거나 호출이 실패하면
 *     `true`(통과)를 돌려줘, 9/11 에 나온 8월 CPI 가 9/28 주 리포트에 "그 주
 *     지표"처럼 붙었다(그림자 채우기). → 확인 못 하면 싣지 않는다.
 *  ② 지수 수준(334.131)과 지수 차(+1.318)를 "전월비"라는 이름으로 보여줬다.
 *     → 시장이 읽는 단위(전월비·전년비 %, 고용 증감 만 명, 실업률 %)로 코드가
 *     계산해 `text` 로 확정한다.
 *
 * 발표 여부는 관측치의 `realtime_start`(그 값이 공표된 날)로 판정한다 — 리포트
 * 주 금요일 시점의 빈티지(realtime_start=realtime_end=weekEnd)로 조회해, 가장
 * 최근 관측치가 그 주(월~금) 안에 공표됐을 때만 쓴다. 나중에 재생성해도 그
 * 주 기준으로 같은 결과가 나온다.
 */
type MetricKind = "mom" | "yoy" | "diffMan" | "level" | "levelMan";

interface OfficialMetricSpec {
  series: string;
  label: string;
  kind: MetricKind;
  unit: string;
  quarterly?: boolean;
}

const OFFICIAL_METRICS: Record<string, OfficialMetricSpec> = {
  cpiMom: { series: "CPIAUCSL", label: "미국 CPI(전월비)", kind: "mom", unit: "%" },
  cpiYoy: { series: "CPIAUCSL", label: "미국 CPI(전년비)", kind: "yoy", unit: "%" },
  coreCpiYoy: { series: "CPILFESL", label: "미국 근원 CPI(전년비)", kind: "yoy", unit: "%" },
  pceYoy: { series: "PCEPI", label: "미국 PCE 물가(전년비)", kind: "yoy", unit: "%" },
  corePceYoy: { series: "PCEPILFE", label: "미국 근원 PCE 물가(전년비)", kind: "yoy", unit: "%" },
  ppiMom: { series: "PPIFIS", label: "미국 PPI 최종수요(전월비)", kind: "mom", unit: "%" },
  payrolls: { series: "PAYEMS", label: "미국 비농업 고용(전월 대비 증감)", kind: "diffMan", unit: "만 명" },
  unrate: { series: "UNRATE", label: "미국 실업률", kind: "level", unit: "%" },
  jolts: { series: "JTSJOL", label: "미국 JOLTS 구인건수", kind: "levelMan", unit: "만 건" },
  retailMom: { series: "RSAFS", label: "미국 소매판매(전월비)", kind: "mom", unit: "%" },
  gdp: { series: "A191RL1Q225SBEA", label: "미국 실질 GDP(전기비 연율)", kind: "level", unit: "%", quarterly: true },
};

/** 핵심 이슈에 붙일 지표(주제 → 지표 id). FEDFUNDS(월평균 실효금리)는 정해진
 * 발표일이 없어 "그 주 발표"를 증명할 수 없으므로 뺐다. */
const METRICS_BY_TOPIC: Record<string, string[]> = {
  "물가·인플레이션": ["cpiMom", "cpiYoy", "coreCpiYoy", "pceYoy", "corePceYoy", "ppiMom"],
  "고용·경기": ["payrolls", "unrate", "jolts", "retailMom", "gdp"],
};

export interface OfficialMetric extends IssueEvidenceMetric {
  id: string;
}

export interface OfficialMetricsResult {
  metrics: OfficialMetric[];
  /** 못 실은 이유(키 없음·조회 실패) — 검수 화면 dropReasons 로 간다 */
  note: string | null;
}

async function fetchFredVintage(
  series: string,
  asOf: string,
  key: string,
): Promise<{ date: string; value: number; realtimeStart: string }[]> {
  const url =
    `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&api_key=${key}` +
    `&file_type=json&sort_order=desc&limit=14&realtime_start=${asOf}&realtime_end=${asOf}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`FRED ${series} HTTP ${res.status}`);
  const j = (await res.json()) as { observations?: { date: string; value: string; realtime_start: string }[] };
  return (j.observations ?? [])
    .filter((o) => o.value !== "." && Number.isFinite(Number(o.value)))
    .map((o) => ({ date: o.date, value: Number(o.value), realtimeStart: o.realtime_start }));
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function periodLabel(date: string, quarterly: boolean): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return quarterly ? `${y}년 ${Math.floor((m - 1) / 3) + 1}분기분` : `${m}월분`;
}

function computeMetric(
  id: string,
  spec: OfficialMetricSpec,
  obs: { date: string; value: number }[],
  releaseDate: string,
): OfficialMetric | null {
  // obs 는 최신순
  const v = (i: number) => obs[i]?.value;
  let value: number | undefined;
  let previous: number | undefined;
  switch (spec.kind) {
    case "mom":
      if (v(2) == null) return null;
      value = round((v(0)! / v(1)! - 1) * 100, 1);
      previous = round((v(1)! / v(2)! - 1) * 100, 1);
      break;
    case "yoy":
      if (v(13) == null) return null;
      value = round((v(0)! / v(12)! - 1) * 100, 1);
      previous = round((v(1)! / v(13)! - 1) * 100, 1);
      break;
    case "diffMan":
      if (v(2) == null) return null;
      value = round((v(0)! - v(1)!) / 10, 1);
      previous = round((v(1)! - v(2)!) / 10, 1);
      break;
    case "level":
      if (v(1) == null) return null;
      value = v(0)!;
      previous = v(1)!;
      break;
    case "levelMan":
      if (v(1) == null) return null;
      value = round(v(0)! / 10, 1);
      previous = round(v(1)! / 10, 1);
      break;
  }
  const signed = spec.kind === "mom" || spec.kind === "yoy" || spec.kind === "diffMan";
  const digits = spec.kind === "level" ? null : 1;
  const f = (n: number) => `${signed && n > 0 ? "+" : ""}${digits == null ? n : n.toFixed(digits)}${spec.unit}`;
  const rel = releaseDate;
  const text =
    `${spec.label} ${f(value)} (${periodLabel(obs[0].date, Boolean(spec.quarterly))}, ` +
    `${Number(rel.slice(5, 7))}/${Number(rel.slice(8, 10))} 발표, 직전 ${f(previous)})`;
  return {
    id,
    label: spec.label,
    date: obs[0].date,
    releaseDate: rel,
    value,
    previous,
    unit: spec.unit,
    text,
    source: "FRED",
  };
}

/** 그 관측치가 처음 공표된 날 — [from, to] 실시간 구간의 빈티지 중 가장 이른 realtime_start. */
async function fetchFirstPublished(
  series: string,
  obsDate: string,
  from: string,
  to: string,
  key: string,
): Promise<string | null> {
  const url =
    `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&api_key=${key}` +
    `&file_type=json&observation_start=${obsDate}&observation_end=${obsDate}&realtime_start=${from}&realtime_end=${to}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`FRED ${series} HTTP ${res.status}`);
  const j = (await res.json()) as { observations?: { realtime_start: string; value: string }[] };
  const starts = (j.observations ?? []).filter((o) => o.value !== ".").map((o) => o.realtime_start).sort();
  return starts[0] ?? null;
}

/**
 * 리포트 주(월~금)에 **새 기간 값이 처음 나왔는지**로 판정한다 — 그 주 월요일
 * 직전(일요일) 시점에 알려진 최신 관측월과, 금요일 시점의 최신 관측월을 비교해
 * 새 달(분기)이 생겼을 때만 "이번 주 발표"다. 과거 값 수정(revision)만 있었던
 * 주는 해당하지 않는다. (realtime_start=realtime_end 로 조회하면 realtime_start 가
 * 그 날짜로 잘려 와서 발표일 판정에 못 쓴다 — 2026-10-05 실측.)
 */
async function fetchSeriesNewInWeek(
  series: string,
  week: ReportWeek,
  key: string,
): Promise<{ obs: { date: string; value: number }[]; releaseDate: string } | null> {
  const dayBefore = new Date(Date.parse(`${week.weekStart}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const [before, at] = await Promise.all([
    fetchFredVintage(series, dayBefore, key),
    fetchFredVintage(series, week.weekEnd, key),
  ]);
  if (at.length === 0) return null;
  if (before.length > 0 && at[0].date <= before[0].date) return null; // 그 주에 새 기간 값 없음
  const releaseDate = (await fetchFirstPublished(series, at[0].date, week.weekStart, week.weekEnd, key)) ?? week.weekEnd;
  return { obs: at, releaseDate };
}

/** 리포트 주(월~금)에 새로 공표된 미국 공식 지표 전부. */
export async function fetchOfficialMetrics(week: ReportWeek): Promise<OfficialMetricsResult> {
  const key = process.env.FRED_API_KEY;
  if (!key) {
    return { metrics: [], note: "FRED_API_KEY 미설정 — 그 주 발표 여부를 확인할 수 없어 공식 지표를 싣지 않음" };
  }
  const bySeries = new Map<string, Promise<{ obs: { date: string; value: number }[]; releaseDate: string } | null>>();
  for (const spec of Object.values(OFFICIAL_METRICS)) {
    if (!bySeries.has(spec.series)) bySeries.set(spec.series, fetchSeriesNewInWeek(spec.series, week, key));
  }
  const failures: string[] = [];
  const out: OfficialMetric[] = [];
  for (const [id, spec] of Object.entries(OFFICIAL_METRICS)) {
    try {
      const hit = await bySeries.get(spec.series)!;
      if (!hit) continue;
      const m = computeMetric(id, spec, hit.obs, hit.releaseDate);
      if (m) out.push(m);
    } catch {
      if (!failures.includes(spec.series)) failures.push(spec.series);
    }
  }
  return {
    metrics: out,
    note: failures.length > 0 ? `FRED 조회 실패(${failures.join(", ")}) — 해당 지표는 싣지 않음` : null,
  };
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
  /** fetchOfficialMetrics() 결과 — 그 주 발표분만 들어 있다(주제별로 나눠 붙인다) */
  official: OfficialMetric[] = [],
): Promise<WeeklyIssue[]> {
  const labels = new Set(issues.map((i) => i.label));

  const tickerSet = new Set<string>();
  for (const [label, tickers] of Object.entries(EARNINGS_TICKERS_BY_TOPIC)) {
    if (labels.has(label)) for (const t of tickers) tickerSet.add(t);
  }

  const earningsMap = await fetchEarningsForTickers([...tickerSet]);

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
    const ids = METRICS_BY_TOPIC[issue.label] ?? [];
    const metrics: IssueEvidenceMetric[] = official.filter((m) => ids.includes(m.id));
    return {
      ...issue,
      facts: buildFactsFromEvidence(issue, usedFactPrefixes),
      ...(earnings && earnings.length > 0 ? { earnings } : {}),
      ...(metrics && metrics.length > 0 ? { metrics } : {}),
    };
  });
}
