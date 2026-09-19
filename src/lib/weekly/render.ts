import "server-only";
import type { SnapshotRow } from "@/lib/db/weekly-reports";
import { fetchGoogleNewsRss, googleNewsUrl } from "@/lib/news/googleNews";
import { fetchNaverNewsSearch } from "@/lib/news/naverNews";
import { snapshotToMarkdownTable } from "./snapshot";
import { CALENDAR_QUERIES } from "./topics";
import type { WeeklyComments } from "./comment";
import type { WeeklyIssue } from "./issues";
import type { SectorHighlight, WeeklySectors } from "./sectors";
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
 * 구성: 스냅샷 표 / 주간 핵심 이슈 3개 / 주요 섹터 이슈 / 금리정책 / 다음 주 일정.
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

/**
 * 오너 지시 2026-09-18 — "리서치자료와 뉴스는 근거일 뿐이다. 핵심은
 * 코멘트다." 분석(코멘트)을 제목 바로 아래 맨 앞에 문단으로 두고, 리포트·
 * 뉴스·지표·실적 목록은 그 아래 "근거"로 내린다 — 목록 나열이 먼저 보이고
 * 코멘트가 맨 끝에 한 줄 딸려오던 이전 구조를 뒤집었다.
 */
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
  lines.push("");
  lines.push(`**분석**: ${comment || "_(해석 근거 부족으로 비어 있음 — 편집기에서 직접 작성하세요)_"}`);
  lines.push("");
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
    // 오너 지시(2026-09-18) — 이 블록만 굵게. 다른 근거(뉴스·FRED)와 달리
    // 실적 서프라이즈는 이슈의 핵심 숫자라 한눈에 띄어야 한다.
    lines.push("- **최근 실적 서프라이즈**");
    for (const e of issue.earnings) {
      const s = e.surprisePct != null ? `${e.surprisePct >= 0 ? "+" : ""}${e.surprisePct}%` : "-";
      lines.push(
        `  - **${e.ticker} EPS 서프라이즈 ${s} (실제 ${e.epsActual ?? "-"} / 추정 ${e.epsEstimate ?? "-"}, ${e.period})**`,
      );
    }
  }
  return lines.join("\n");
}

function tableCell(s: string): string {
  return s.replace(/\|/g, "/").replace(/\s+/g, " ").trim();
}

/** 실제 기준·비교일이 그 주의 일반적인 구간(baseFriday~weekEnd)과 다르면
 * (연휴로 기준점이 앞으로, 비교점이 뒤로 밀린 경우) 등락률 옆에 실제 날짜를
 * 밝힌다 — 평소엔 안 붙어 표가 깔끔하다. */
function sectorPctCell(s: SectorHighlight, week: ReportWeek): string {
  const pct = `${s.pct >= 0 ? "+" : ""}${s.pct.toFixed(2)}%`;
  if (s.startDate === week.baseFriday && s.endDate === week.weekEnd) return pct;
  return `${pct} (${s.startDate.slice(5)}→${s.endDate.slice(5)})`;
}

/** 섹터 한 그룹(상승/하락 최대 2개씩)을 표로. 데이터가 없으면 안내 문구만. */
function sectorGroupTable(
  title: string,
  up: SectorHighlight[],
  down: SectorHighlight[],
  week: ReportWeek,
  comments: Map<string, string>,
): string {
  const lines: string[] = [`### ${title}`, ""];
  if (up.length === 0 && down.length === 0) {
    lines.push("_이번 주 집계된 섹터 데이터가 없습니다._");
    return lines.join("\n");
  }
  lines.push("| 구분 | 섹터 | 등락률 | 코멘트 |", "|---|---|---:|---|");
  for (const s of up) {
    lines.push(`| 상승 | ${tableCell(s.label)} | ${sectorPctCell(s, week)} | ${tableCell(comments.get(s.id) ?? "")} |`);
  }
  for (const s of down) {
    lines.push(`| 하락 | ${tableCell(s.label)} | ${sectorPctCell(s, week)} | ${tableCell(comments.get(s.id) ?? "")} |`);
  }
  return lines.join("\n");
}

function sectorSection(sectors: WeeklySectors, week: ReportWeek, comments: Map<string, string>): string {
  const parts = [
    "_전주 금요일 종가 대비 당주 금요일 종가 기준, 시장별 상승·하락 상위 섹터입니다(연휴로 기준일이 밀리면 실제 날짜를 괄호로 표기)._",
    "",
    sectorGroupTable("코스피", sectors.kospi.up, sectors.kospi.down, week, comments),
    "",
    sectorGroupTable("코스닥", sectors.kosdaq.up, sectors.kosdaq.down, week, comments),
    "",
    sectorGroupTable("미국", sectors.us.up, sectors.us.down, week, comments),
    "",
    sectorGroupTable("일본", sectors.jp.up, sectors.jp.down, week, comments),
    "",
    sectorGroupTable("유럽", sectors.eu.up, sectors.eu.down, week, comments),
  ];
  return parts.join("\n");
}

/**
 * 고정 검색어의 그 주 기사를 표로 건다 — 추론 없음, 코드가 표만 조립한다
 * (오너 지시 2026-09-18 — "일정을 안 건든다는 건 임의 해석하지 말라는
 * 거지 표로 만들지 말라는 게 아니다"). 하한(주 시작)뿐 아니라 상한(주
 * 종료+3일)도 건다 — `issues.ts`의 `countFromNews()`와 같은 이유(실측
 * — 지난 주 리포트를 나중에 재생성하면 그사이 최신 기사가 섞여 들어옴).
 *
 * **제목만 링크로 나열하던 걸 요약문 있는 표로(오너 지적 2026-09-18 —
 * "표만들라니깐 그냥 링크 넣는 표를 만든거냐... 발언·수치 같은 걸 넣는
 * 것이 정책이지")**: `issues.ts`와 같은 방식으로 네이버 뉴스 검색(요약문
 * 포함)을 구글 뉴스 RSS와 합쳐서, 최소한 각 행에 실제 스니펫(발언·수치가
 * 언급된 문장)이 보이게 한다. 여전히 추론 없음 — 검색된 기사의 요약문을
 * 그대로 옮길 뿐 해석하지 않는다.
 */
async function queryBlock(
  queries: { label: string; query: string }[],
  sinceMs: number,
  untilMs: number,
  perQuery: number,
): Promise<string> {
  const results = await Promise.all(
    queries.map(async ({ label, query }) => {
      const naverP = fetchNaverNewsSearch(query, { display: 20 }).catch(() => []);
      const googleP = fetchGoogleNewsRss(
        googleNewsUrl(`search?q=${encodeURIComponent(query)}+when:7d`, "hl=ko&gl=KR&ceid=KR:ko"),
      ).catch(() => []);
      const [naver, google] = await Promise.all([naverP, googleP]);
      const merged = [
        ...naver.map((n) => ({ title: n.title, excerpt: n.excerpt, url: n.url, source: n.source, publishedAt: n.publishedAt })),
        ...google.map((g) => ({ title: g.title, excerpt: null as string | null, url: g.link, source: g.source, publishedAt: g.publishedAt })),
      ];
      const seen = new Set<string>();
      const fresh: typeof merged = [];
      for (const i of merged) {
        const ms = Date.parse(i.publishedAt);
        if (Number.isFinite(ms) && (ms < sinceMs || ms > untilMs)) continue;
        const key = i.title.replace(/\s+/g, "").toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push(i);
        if (fresh.length >= perQuery) break;
      }
      return { label, items: fresh };
    }),
  );
  const lines = ["| 구분 | 날짜 | 제목 | 요약 | 출처 |", "|---|---|---|---|---|"];
  for (const { label, items } of results) {
    if (items.length === 0) {
      lines.push(`| ${label} | - | 이번 주 관련 기사 없음 | - | - |`);
      continue;
    }
    for (const i of items) {
      const excerpt = i.excerpt ? tableCell(i.excerpt).slice(0, 80) : "-";
      lines.push(
        `| ${label} | ${i.publishedAt.slice(0, 10)} | [${tableCell(i.title)}](${i.url}) | ${excerpt} | ${i.source} |`,
      );
    }
  }
  return lines.join("\n");
}

export async function renderWeeklyReport(opts: {
  week: ReportWeek;
  snapshot: SnapshotRow[];
  issues: WeeklyIssue[];
  sectors: WeeklySectors;
  comments?: WeeklyComments;
}): Promise<string> {
  const { week, snapshot, issues, sectors, comments } = opts;
  const snapshotComments = comments?.snapshot ?? new Map<string, string>();
  const issueComments = comments?.issues ?? new Map<string, string>();
  const sectorComments = comments?.sectors ?? new Map<string, string>();
  const sinceMs = Date.parse(`${week.weekStart}T00:00:00+09:00`);
  const untilMs = Date.parse(`${week.weekEnd}T00:00:00Z`) + 3 * 86_400_000;
  // 금리정책은 더 이상 기사 표를 안 쓴다(오너 지시 2026-09-18 — "표
  // 필요없다구!!") — policySummary(종합 요약 문단)만 보여주고, 없으면
  // 짧은 안내만 남긴다. 다음 주 일정만 캘린더가 비었을 때 기사 표로 폴백.
  const calendar = await queryBlock(CALENDAR_QUERIES, sinceMs, untilMs, 3);

  const parts: string[] = [];
  parts.push(`# 주간 거시·시황 요약 (${week.weekStart} ~ ${week.weekEnd})`);
  parts.push("");
  parts.push("## 1. 한 줄 결론");
  parts.push("");
  // Gemini 가 이슈 근거와 엮어 인과관계로 쓴 한 줄(오너 지시 2026-09-18 —
  // "상승·하락 2개만 적고 끝이냐, 인과가 있어야"). 미설정/검증 실패 시
  // 기존처럼 순수 사실 비교(movers)로 폴백.
  parts.push(comments?.headline || movers(snapshot));
  parts.push("");
  parts.push("## 2. 시장 스냅샷");
  parts.push("");
  parts.push(snapshotToMarkdownTable(snapshot, snapshotComments));
  parts.push("");
  parts.push("## 3. 주간 핵심 이슈 3개");
  parts.push("");
  parts.push(
    "_증권사 산업·전략 리포트 빈도와 그 주 뉴스 건수로 뽑았습니다._",
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
  parts.push("## 4. 주요 섹터 이슈");
  parts.push("");
  parts.push(sectorSection(sectors, week, sectorComments));
  parts.push("");
  parts.push("## 5. 금리정책");
  parts.push("");
  // Gemini 가 그라운딩으로 종합한 정책 요약만 보여준다 — 기사 표는 더 이상
  // 안 쓴다(오너 지시 2026-09-18 — "표 필요없다구!!"). 그라운딩 실패 시
  // 표로 폴백하지 않고 짧은 안내만 남긴다.
  parts.push(comments?.policySummary || "이번 주 통화정책 요약을 확인하지 못했습니다.");
  parts.push("");
  parts.push("## 6. 다음 주 주시 일정");
  parts.push("");
  // 날짜별 확정 이벤트 캘린더(오너 지시 2026-09-18 — "관련 기사 목록이
  // 아니라 일자별 캘린더를 원한 거다"). 없으면(그라운딩 실패 등) 기존
  // 기사 표로 폴백.
  if (comments?.calendar && comments.calendar.length > 0) {
    const lines = ["| 날짜 | 일정 |", "|---|---|"];
    for (const c of comments.calendar) lines.push(`| ${c.date} | ${c.event} |`);
    parts.push(lines.join("\n"));
  } else {
    parts.push(calendar || "이번 주 관련 기사 없음");
  }
  parts.push("");

  return parts.join("\n");
}
