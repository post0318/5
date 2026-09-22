import "server-only";
import type { SnapshotRow } from "@/lib/db/weekly-reports";
import { snapshotToMarkdownTable } from "./snapshot";
import type { IssueComment, WeeklyComments } from "./comment";
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
 * 이슈 블록 = **분석 요약**이 전부다(오너 지시 2026-09-21 — "보고서라는 것을
 * 감안하면 불필요하다. 이슈는 분석 요약이 핵심이다. 근거 보여주기는 뺀다").
 *
 * 증권사 리포트 목록·뉴스 목록·집계 건수는 화면에서 뺀다. 수집·선정에는
 * 여전히 쓰이고 LLM 입력으로도 들어가지만(분석의 재료), 발행되는 보고서에
 * 원자료를 나열할 이유가 없다. 검수용으로는 `candidates`(후보 목록)와
 * 화면 접힘 영역이 따로 있다.
 *
 * **남기는 것 둘**(오너 지시 2026-09-21):
 *  - 최근 실적 서프라이즈 — 이슈의 핵심 숫자
 *  - 공식 지표(FRED) — 출처가 확정된 수치
 * 둘 다 "근거 목록"이 아니라 그 자체가 읽을 값이라 본문에 남긴다.
 */
function issueBlock(issue: WeeklyIssue, rank: number, comment: IssueComment | undefined): string {
  const lines: string[] = [];

  lines.push(`### ${rank}. ${issue.label}`);
  lines.push("");

  // 사실과 해석을 눈으로 구분되게 나눠 놓는다(오너 지시 2026-09-22 — 타사
  // 시황처럼 "사실 → 해석" 2단). 한 문단에 섞여 있으면 어디까지가 확인된
  // 사실인지 읽는 사람이 가려낼 수 없다.
  const facts = comment?.facts ?? [];
  const reading = comment?.reading ?? "";
  if (facts.length === 0 && !reading) {
    lines.push("_(코멘트가 생성되지 않았습니다 — 재생성하거나 편집기에서 직접 작성하세요)_");
    lines.push("");
  } else {
    if (facts.length > 0) {
      lines.push("**사실**");
      lines.push("");
      for (const f of facts) lines.push(`- ${f}`);
      lines.push("");
    }
    if (reading) {
      lines.push(`**해석** → ${reading}`);
      lines.push("");
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

/**
 * 섹터는 **문장 서술**로 낸다(오너 지시 2026-09-21 — "표로 머리아프고
 * 싶지않다. 예를 들면 헬스케어 섹터가 주간 00%상승했다. 주 요인은
 * 00때문이다 이런식으로"). 표(구분·섹터·등락률·코멘트)에 있던 내용을
 * 그대로 문장으로 풀어 쓴다 — 열 너비 문제도 구조적으로 사라진다.
 */
function sectorSentence(s: SectorHighlight, week: ReportWeek, comment: string): string {
  const verb = s.direction === "up" ? "상승" : "하락";
  const pct = sectorPctCell(s, week);
  const reason = comment.trim() || "주요 요인은 확인되지 않았습니다";
  return `- **${tableCell(s.label)}**: 주간 ${pct} ${verb}. ${reason}`;
}

function sectorGroupSentences(
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
  for (const s of up) lines.push(sectorSentence(s, week, comments.get(s.id) ?? ""));
  for (const s of down) lines.push(sectorSentence(s, week, comments.get(s.id) ?? ""));
  return lines.join("\n");
}

function sectorSection(sectors: WeeklySectors, week: ReportWeek, comments: Map<string, string>): string {
  const parts = [
    "_전주 금요일 종가 대비 당주 금요일 종가 기준, 시장별 상승·하락 상위 섹터입니다._",
    "",
    sectorGroupSentences("코스피", sectors.kospi.up, sectors.kospi.down, week, comments),
    "",
    sectorGroupSentences("코스닥", sectors.kosdaq.up, sectors.kosdaq.down, week, comments),
    "",
    sectorGroupSentences("미국", sectors.us.up, sectors.us.down, week, comments),
    "",
    sectorGroupSentences("일본", sectors.jp.up, sectors.jp.down, week, comments),
    "",
    sectorGroupSentences("유럽", sectors.eu.up, sectors.eu.down, week, comments),
  ];
  return parts.join("\n");
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
  const issueComments = comments?.issues ?? new Map<string, IssueComment>();
  const sectorComments = comments?.sectors ?? new Map<string, string>();

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
      parts.push(issueBlock(it, i + 1, issueComments.get(it.label)));
      parts.push("");
    });
  }
  parts.push("## 4. 주요 섹터 이슈");
  parts.push("");
  parts.push(sectorSection(sectors, week, sectorComments));
  parts.push("");
  // "5. 경제"(오너 지시 2026-09-21 — "금리정책처럼 경제를 하나 추가하고
  // 경기와 관련된 내용은 여기서 요약하도록 하자. 위치는 금리정책보다
  // 앞에"). 관세·중국 경기·고용·금·구리 등 "경기" 계열 주제는 핵심 이슈
  // 3개 경쟁에서 제외됐다(issues.ts selectTopIssues 참고) — 여기서만
  // 다룬다.
  parts.push("## 5. 경제");
  parts.push("");
  parts.push(comments?.economySummary || "이번 주 특별한 경기 관련 동향을 확인하지 못했습니다.");
  parts.push("");
  parts.push("## 6. 금리정책");
  parts.push("");
  // Gemini 가 그라운딩으로 종합한 정책 요약만 보여준다 — 기사 표는 더 이상
  // 안 쓴다(오너 지시 2026-09-18 — "표 필요없다구!!"). 그라운딩 실패 시
  // 표로 폴백하지 않고 짧은 안내만 남긴다.
  parts.push(comments?.policySummary || "이번 주 통화정책 요약을 확인하지 못했습니다.");
  parts.push("");
  parts.push("## 7. 다음 주 주시 일정");
  parts.push("");
  // 날짜별 확정 이벤트 캘린더(오너 지시 2026-09-18 — "관련 기사 목록이
  // 아니라 일자별 캘린더를 원한 거다"). 예전엔 비었을 때 키워드 뉴스검색
  // 표로 폴백했는데, 검색어와 우연히 겹치기만 한 무관한 기사가 섞여
  // "보고서로 가치가 없다"(오너 지적 2026-09-19)는 게 확인돼 그 폴백을
  // 없앴다 — 확인 안 되면 정직하게 안내만 남긴다(금리정책 섹션과 동일
  // 원칙).
  if (comments?.calendar && comments.calendar.length > 0) {
    const lines = ["| 날짜 | 일정 |", "|---|---|"];
    for (const c of comments.calendar) lines.push(`| ${c.date} | ${c.event} |`);
    parts.push(lines.join("\n"));
  } else {
    parts.push("이번 주 통화정책·경제지표 일정을 확인하지 못했습니다.");
  }
  parts.push("");

  return parts.join("\n");
}
