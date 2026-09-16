import "server-only";
import type { SnapshotRow } from "@/lib/db/weekly-reports";
import { fetchGoogleNewsRss, googleNewsUrl } from "@/lib/news/googleNews";
import { snapshotToMarkdownTable } from "./snapshot";
import { CALENDAR_QUERIES, POLICY_QUERIES } from "./topics";
import type { WeeklyIssue } from "./issues";
import type { ReportWeek } from "./week";

/**
 * 주간 리포트 본문을 **코드로** 조립한다 (오너 지시 2026-09 — "LLM 사용 없이
 * 가자"). 문장을 지어내지 않고, 집계한 숫자와 실제 기사·리포트 제목만 배치한다.
 * 해석은 오너가 편집기에서 직접 쓴다.
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

function issueBlock(issue: WeeklyIssue, rank: number): string {
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
  lines.push("- 코멘트: ");
  return lines.join("\n");
}

/** 고정 검색어의 그 주 기사를 그대로 건다 — 추론 없음. */
async function queryBlock(
  queries: { label: string; query: string }[],
  sinceMs: number,
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
        return !Number.isFinite(ms) || ms >= sinceMs;
      });
      return { label, items: fresh.slice(0, perQuery) };
    }),
  );
  const lines: string[] = [];
  for (const { label, items } of results) {
    lines.push(`- **${label}**`);
    if (items.length === 0) {
      lines.push("  - 이번 주 관련 기사 없음");
      continue;
    }
    for (const i of items) {
      lines.push(`  - [${i.title}](${i.link}) — ${i.source} ${i.publishedAt.slice(0, 10)}`);
    }
  }
  return lines.join("\n");
}

export async function renderWeeklyReport(opts: {
  week: ReportWeek;
  snapshot: SnapshotRow[];
  issues: WeeklyIssue[];
}): Promise<string> {
  const { week, snapshot, issues } = opts;
  const sinceMs = Date.parse(`${week.weekStart}T00:00:00+09:00`);
  const [policy, calendar] = await Promise.all([
    queryBlock(POLICY_QUERIES, sinceMs, 2),
    queryBlock(CALENDAR_QUERIES, sinceMs, 3),
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
  // 코멘트 칸은 비워 둔다 — 오너가 편집기에서 채운다(자동 서술 안 함).
  parts.push(snapshotToMarkdownTable(snapshot, new Map()));
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
      parts.push(issueBlock(it, i + 1));
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
