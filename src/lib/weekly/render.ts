import "server-only";
import type { SnapshotRow } from "@/lib/db/weekly-reports";
import { fetchGoogleNewsRss, googleNewsUrl } from "@/lib/news/googleNews";
import { snapshotToMarkdownTable } from "./snapshot";
import { CALENDAR_QUERIES, POLICY_QUERIES } from "./topics";
import type { WeeklyComments } from "./comment";
import type { WeeklyIssue } from "./issues";
import type { ReportWeek } from "./week";

/**
 * 주간 리포트 본문 조립 — 구조·표·숫자는 **코드로** 만든다(오너 지시 2026-09
 * "LLM 사용 없이 가자"). 문장을 지어내지 않고, 집계한 숫자와 실제 기사·리포트
 * 제목만 배치한다.
 *
 * 코멘트 칸(스냅샷 표 마지막 열, 이슈별 "- 코멘트:")만 `comments` 로 채운다
 * (오너 지시 2026-09 "llm을 부활한다" — `comment.ts`가 Gemini로 생성 후 검증한
 * 결과). 호출부가 `comments` 를 안 주거나(LLM 미설정·예산 초과·실패) 특정
 * 항목이 검증에서 걸러지면 해당 칸은 그대로 빈 문자열 — 오너가 편집기에서
 * 직접 채울 수 있다.
 *
 * 구성: 스냅샷 표 / 주간 핵심 이슈 3개 / 금리정책 / 다음 주 일정.
 */

function pctText(r: SnapshotRow): string {
  if (r.diff != null && r.unit.startsWith("%")) {
    const bp = r.diff * 100;
    return `${bp >= 0 ? "+" : ""}${bp.toFixed(0)}bp`;
  }
  if (r.pct != null) return `${r.pct >= 0 ? "+" : ""}${r.pct.toFixed(2)}%`;
  return "-";
}

/**
 * 스냅샷에서 그 주 움직임이 가장 컸던 자산을 한 줄로 짚는다. 해석이 아니라
 * 크기 비교라 코드로 낼 수 있다. 비교 가능한 지표(주간 변동률이 있는 것)만 본다.
 */
function movers(rows: SnapshotRow[]): string {
  const withPct = rows.filter((r) => r.pct != null && Number.isFinite(r.pct));
  if (withPct.length === 0) return "이번 주 비교 가능한 시세 데이터가 없습니다.";
  const sorted = [...withPct].sort((a, b) => (b.pct as number) - (a.pct as number));
  const up = sorted[0];
  const down = sorted[sorted.length - 1];
  if (up === down) return `${up.name} ${pctText(up)}.`;
  return `상승폭 최대 ${up.name} ${pctText(up)}, 하락폭 최대 ${down.name} ${pctText(down)}.`;
}

function issueBlock(issue: WeeklyIssue, rank: number, comment: string): string {
  const lines: string[] = [];
  const metrics = [
    `증권사 리포트 ${issue.researchCount}건`,
    `뉴스 ${issue.newsCount}건`,
    issue.searchInterest != null ? `검색 관심도 ${issue.searchInterest.toFixed(0)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  lines.push(`### ${rank}. ${issue.label}`);
  lines.push(`- 집계: ${metrics}`);

  if (issue.reports.length > 0) {
    lines.push("- 증권사 리포트");
    for (const r of issue.reports) {
      const name = r.stockName && r.stockName !== r.title ? `${r.stockName} — ` : "";
      lines.push(`  - ${r.date} ${r.source}: ${name}${r.title}`);
    }
  }
  if (issue.news.length > 0) {
    lines.push("- 뉴스");
    for (const n of issue.news) {
      lines.push(`  - [${n.title}](${n.url}) — ${n.source} ${n.publishedAt.slice(0, 10)}`);
    }
  }
  if (issue.metrics && issue.metrics.length > 0) {
    lines.push("- 공식 지표(FRED)");
    for (const m of issue.metrics) {
      const chg = `${m.change >= 0 ? "+" : ""}${m.change}`;
      lines.push(`  - ${m.label} ${m.current}${m.unit} (전기 대비 ${chg}${m.unit}, ${m.date})`);
    }
  }
  if (issue.earnings && issue.earnings.length > 0) {
    lines.push("- 최근 실적 서프라이즈");
    for (const e of issue.earnings) {
      const s = e.surprisePct != null ? `${e.surprisePct >= 0 ? "+" : ""}${e.surprisePct}%` : "-";
      lines.push(
        `  - ${e.ticker} EPS 서프라이즈 ${s} (실제 ${e.epsActual ?? "-"} / 추정 ${e.epsEstimate ?? "-"}, ${e.period})`,
      );
    }
  }
  lines.push(`- 코멘트: ${comment}`);
  return lines.join("\n");
}

/**
 * 고정 검색어의 그 주 기사를 표로 건다 — 추론 없음, 코드가 표만 조립한다
 * (오너 지시 2026-09-18 — "일정을 안 건든다는 건 임의 해석하지 말라는
 * 거지 표로 만들지 말라는 게 아니다"). 하한(주 시작)뿐 아니라 상한(주
 * 종료+3일)도 건다 — `issues.ts`의 `countFromNews()`와 같은 이유(실측
 * — 지난 주 리포트를 나중에 재생성하면 그사이 최신 기사가 섞여 들어옴).
 */
async function queryBlock(
  queries: { label: string; query: string }[],
  sinceMs: number,
  untilMs: number,
  perQuery: number,
): Promise<string> {
  const results = await Promise.all(
    queries.map(async ({ label, query }) => {
      const url = googleNewsUrl(
        `search?q=${encodeURIComponent(query)}+when:7d`,
        "hl=ko&gl=KR&ceid=KR:ko",
      );
      const items = await fetchGoogleNewsRss(url).catch(() => []);
      const fresh = items.filter((i) => {
        const ms = Date.parse(i.publishedAt);
        return !Number.isFinite(ms) || (ms >= sinceMs && ms <= untilMs);
      });
      return { label, items: fresh.slice(0, perQuery) };
    }),
  );
  const lines = ["| 구분 | 날짜 | 제목 | 출처 |", "|---|---|---|---|"];
  for (const { label, items } of results) {
    if (items.length === 0) {
      lines.push(`| ${label} | - | 이번 주 관련 기사 없음 | - |`);
      continue;
    }
    for (const i of items) {
      lines.push(`| ${label} | ${i.publishedAt.slice(0, 10)} | [${i.title}](${i.link}) | ${i.source} |`);
    }
  }
  return lines.join("\n");
}

export async function renderWeeklyReport(opts: {
  week: ReportWeek;
  snapshot: SnapshotRow[];
  issues: WeeklyIssue[];
  comments?: WeeklyComments;
}): Promise<string> {
  const { week, snapshot, issues, comments } = opts;
  const snapshotComments = comments?.snapshot ?? new Map<string, string>();
  const issueComments = comments?.issues ?? new Map<string, string>();
  const sinceMs = Date.parse(`${week.weekStart}T00:00:00+09:00`);
  const untilMs = Date.parse(`${week.weekEnd}T00:00:00Z`) + 3 * 86_400_000;
  const [policy, calendar] = await Promise.all([
    queryBlock(POLICY_QUERIES, sinceMs, untilMs, 2),
    queryBlock(CALENDAR_QUERIES, sinceMs, untilMs, 3),
  ]);

  const parts: string[] = [];
  parts.push(`# 주간 거시·시황 요약 (${week.weekStart} ~ ${week.weekEnd})`);
  parts.push("");
  parts.push("## 1. 한 줄 결론");
  parts.push("");
  parts.push(movers(snapshot));
  parts.push("");
  parts.push("## 2. 시장 스냅샷");
  parts.push("");
  parts.push(snapshotToMarkdownTable(snapshot, snapshotComments));
  parts.push("");
  parts.push("## 3. 주간 핵심 이슈 3개");
  parts.push("");
  parts.push(
    "_증권사 산업·전략 리포트 빈도와 그 주 뉴스 건수로 뽑았습니다. 해석은 코멘트 줄에 직접 적으세요._",
  );
  parts.push("");
  if (issues.length === 0) {
    parts.push("이번 주 집계된 이슈가 없습니다.");
  } else {
    issues.forEach((it, i) => {
      parts.push(issueBlock(it, i + 1, issueComments.get(it.label) ?? ""));
      parts.push("");
    });
  }
  parts.push("## 4. 금리정책");
  parts.push("");
  parts.push(policy || "이번 주 관련 기사 없음");
  parts.push("");
  parts.push("## 5. 다음 주 주시 일정");
  parts.push("");
  parts.push(calendar || "이번 주 관련 기사 없음");
  parts.push("");

  return parts.join("\n");
}
