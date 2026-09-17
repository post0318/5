import "server-only";
import { fetchText } from "@/lib/markets/http";
import { fetchYahooEstimates } from "@/lib/markets/quote/yahoo";
import type { IssueEvidenceEarnings, IssueEvidenceMetric, WeeklyIssue } from "./issues";

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
  "AI·반도체 수요": ["NVDA", "TSM", "AVGO"],
  "미국 증시·밸류에이션": ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA"],
};

const FRED_METRICS_BY_TOPIC: Record<
  string,
  { series: string; label: string; unit: string }[]
> = {
  // "전월비"를 라벨에 못 박아 둔다 — 뉴스 헤드라인의 "CPI 3.4%↑"는 보통
  // 전년동월비(YoY)라, 라벨 없이 지수값만 주면 서로 다른 기준의 숫자가
  // 나란히 놓여 헷갈린다(실측 — 오너 지적으로 발견).
  "물가·인플레이션": [
    { series: "CPIAUCSL", label: "미국 CPI(계절조정지수, 전월비)", unit: "지수" },
  ],
  "고용·경기": [
    { series: "UNRATE", label: "미국 실업률", unit: "%" },
    { series: "PAYEMS", label: "미국 비농업 고용(전월비)", unit: "천명" },
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

async function fetchMetricsForTopic(
  specs: { series: string; label: string; unit: string }[],
): Promise<IssueEvidenceMetric[]> {
  const results = await Promise.all(
    specs.map(async (spec): Promise<IssueEvidenceMetric | null> => {
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

export async function enrichTopIssues(issues: WeeklyIssue[]): Promise<WeeklyIssue[]> {
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
            map.set(label, await fetchMetricsForTopic(specs));
          }),
      );
      return map;
    })(),
  ]);

  return issues.map((issue) => {
    const tickers = EARNINGS_TICKERS_BY_TOPIC[issue.label];
    const earnings = tickers
      ?.map((t) => earningsMap.get(t))
      .filter((e): e is IssueEvidenceEarnings => e != null);
    const metrics = metricsByTopic.get(issue.label);
    return {
      ...issue,
      ...(earnings && earnings.length > 0 ? { earnings } : {}),
      ...(metrics && metrics.length > 0 ? { metrics } : {}),
    };
  });
}
