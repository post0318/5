import "server-only";
import { getYahooFinance } from "@/lib/macro/yf-client";
import { fetchRateSeries } from "@/lib/macro/kr/ecos";
import { fetchText } from "@/lib/markets/http";
import type { SnapshotRow } from "@/lib/db/weekly-reports";
import type { ReportWeek } from "./week";

/**
 * 주간 시세 스냅샷 — "지난주 금요일 종가 vs 전전주 금요일 종가"로 전 지표를
 * 같은 구간에 맞춘다(데모 때 자산별 조회 구간이 제각각이라 표가 뒤섞였던
 * 문제 방지). 소스: Yahoo(지수·원자재·환율·미국채 10년), FRED(미국채 3년 —
 * CBOE 가 3년물 지수 자체를 안 내서 Yahoo 티커가 없음, `^`류 대신 FRED
 * DGS3 공개 CSV 사용), ECOS(국고채, 키 있을 때), 브라질 장기 국채(NTN-F
 * ~10년 롤링)는 오너의 4번 프로젝트(github.com/post0318/4)가 재무부
 * CSV(14MB)를 매주 일요일 12:00 UTC 에 갱신해 커밋하는 JSON 을 GitHub raw
 * 로 읽는다(오너 안내, 2026-09 — Tesouro Direto 공개 JSON 은 410 Gone 으로
 * 폐기돼 못 씀). 갱신이 밀리면 asOf 를 그대로 표기하고 전주 대비는 그
 * 시점 기준 7일 전과 비교한다. 브라질 Selic(기준금리) 행은 표를 줄이라는
 * 오너 지시로 제거 — NTN-F 10년 수익률 하나만 남긴다(2026-09).
 */

interface YahooSpec {
  sym: string;
  key: string;
  group: string;
  name: string;
  unit: string;
  /** 금리류: 변동률 대신 %p 차이를 저장 */
  rate?: boolean;
}

const YAHOO_SPECS: YahooSpec[] = [
  { sym: "^KS11", key: "KOSPI", group: "국내주식", name: "코스피", unit: "pt" },
  { sym: "^KQ11", key: "KOSDAQ", group: "국내주식", name: "코스닥", unit: "pt" },
  { sym: "^GSPC", key: "SPX", group: "해외주식", name: "S&P 500", unit: "pt" },
  { sym: "^IXIC", key: "IXIC", group: "해외주식", name: "나스닥", unit: "pt" },
  // MSCI World 지수 자체는 라이선스 데이터라 무료로 직접 못 받아, 이를
  // 추종하는 ETF(iShares MSCI World, URTH) 가격으로 근사한다(오너 지시
  // 2026-09-19 — 운용보수·추적오차만큼의 미세한 괴리는 감안).
  { sym: "URTH", key: "MSCIWORLD", group: "해외주식", name: "MSCI World(URTH)", unit: "$" },
  { sym: "000001.SS", key: "SSEC", group: "해외주식", name: "상해종합지수", unit: "pt" },
  { sym: "^STOXX50E", key: "SX5E", group: "해외주식", name: "유로스톡스50", unit: "pt" },
  { sym: "^TNX", key: "UST10Y", group: "채권", name: "미국채 10년", unit: "%", rate: true },
  { sym: "GC=F", key: "GOLD", group: "원자재", name: "금", unit: "$/oz" },
  { sym: "CL=F", key: "WTI", group: "원자재", name: "WTI", unit: "$/bbl" },
  { sym: "HG=F", key: "COPPER", group: "원자재", name: "구리", unit: "$/lb" },
  { sym: "KRW=X", key: "USDKRW", group: "환율·변동성", name: "원/달러", unit: "원" },
  { sym: "JPY=X", key: "USDJPY", group: "환율·변동성", name: "엔/달러", unit: "엔" },
  { sym: "BRL=X", key: "USDBRL", group: "환율·변동성", name: "헤알/달러", unit: "헤알" },
  { sym: "DX-Y.NYB", key: "DXY", group: "환율·변동성", name: "달러인덱스", unit: "pt" },
  { sym: "^VIX", key: "VIX", group: "환율·변동성", name: "VIX", unit: "pt" },
];

interface Bar {
  date: string;
  close: number;
}

/** Yahoo 일봉 타임스탬프 → 거래일. 환율·일부 지수는 봉이 전일 23:00Z 로 찍혀
 * 그대로 UTC 날짜를 쓰면 하루 앞으로 밀린다(실측: KRW=X 금요일 봉이 목요일로
 * 표기). 20시(UTC) 이후 봉은 다음 날로 본다 — 미국 주식(13:30Z)·한국(00:00Z)·
 * 원자재(새벽)는 영향 없음. */
function barDate(d: Date | string | number): string {
  const t = new Date(d);
  const shifted = t.getUTCHours() >= 20 ? new Date(t.getTime() + 24 * 3600_000) : t;
  return shifted.toISOString().slice(0, 10);
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function lastOnOrBefore(bars: Bar[], ymd: string): Bar | null {
  let found: Bar | null = null;
  for (const b of bars) {
    if (b.date <= ymd) found = b;
    else break;
  }
  return found;
}

interface RowSpec {
  key: string;
  group: string;
  name: string;
  unit: string;
  rate?: boolean;
  source: string;
}

function rowFromBars(spec: RowSpec, bars: Bar[], week: ReportWeek): SnapshotRow {
  const last = lastOnOrBefore(bars, week.weekEnd);
  const base = lastOnOrBefore(bars, week.baseFriday);
  const value = last?.close ?? null;
  const baseVal = base?.close ?? null;
  const pct =
    value != null && baseVal != null && baseVal !== 0 ? ((value - baseVal) / baseVal) * 100 : null;
  const diff = value != null && baseVal != null ? value - baseVal : null;
  return {
    key: spec.key,
    group: spec.group,
    name: spec.name,
    value,
    asOf: last?.date ?? null,
    pct: spec.rate ? null : pct,
    diff: spec.rate ? diff : null,
    baseAsOf: base?.date ?? null,
    unit: spec.unit,
    source: spec.source,
  };
}

function emptyRow(spec: RowSpec): SnapshotRow {
  return {
    key: spec.key,
    group: spec.group,
    name: spec.name,
    value: null,
    asOf: null,
    pct: null,
    diff: null,
    baseAsOf: null,
    unit: spec.unit,
    source: spec.source,
  };
}

async function yahooRows(week: ReportWeek): Promise<SnapshotRow[]> {
  const yf = getYahooFinance();
  const period1 = new Date(Date.parse(week.baseFriday) - 12 * 86_400_000);
  const out: SnapshotRow[] = [];
  for (const spec of YAHOO_SPECS) {
    const rowSpec: RowSpec = { ...spec, source: "Yahoo Finance" };
    try {
      const r = await yf.chart(spec.sym, { period1, interval: "1d" });
      const bars: Bar[] = r.quotes
        .filter((q) => q.close != null)
        .map((q) => ({ date: barDate(q.date), close: round4(Number(q.close)) }))
        .sort((a, b) => a.date.localeCompare(b.date));
      out.push(rowFromBars(rowSpec, bars, week));
    } catch {
      out.push(emptyRow(rowSpec));
    }
  }
  return out;
}

async function ecosRows(week: ReportWeek): Promise<SnapshotRow[]> {
  if (!process.env.ECOS_API_KEY) return [];
  const start = week.baseFriday.replace(/-/g, "");
  const end = week.weekEnd.replace(/-/g, "");
  const items = [
    { item: "gov10y" as const, key: "KTB10Y", name: "국고채 10년" },
    { item: "gov3y" as const, key: "KTB3Y", name: "국고채 3년" },
  ];
  const rows: SnapshotRow[] = [];
  for (const it of items) {
    const series = await fetchRateSeries(it.item, start, end).catch(() => []);
    const bars: Bar[] = series.map((p) => ({ date: p.date, close: p.value }));
    rows.push(
      rowFromBars(
        { key: it.key, group: "채권", name: it.name, unit: "%", rate: true, source: "한국은행 ECOS" },
        bars,
        week,
      ),
    );
  }
  return rows;
}

/** 미국채 3년 — CBOE 가 3년물 지수(^FVX 류)를 안 내서 Yahoo 티커가 없다.
 * FRED DGS3(공개 CSV, 키 불필요)로 대체(오너 지시 — 미국채 5년 대신 3년). */
async function ust3yRow(week: ReportWeek): Promise<SnapshotRow> {
  const spec: RowSpec = { key: "UST3Y", group: "채권", name: "미국채 3년", unit: "%", rate: true, source: "FRED (DGS3)" };
  try {
    // baseFriday 자체가 휴장일일 수 있어(요일이 항상 거래일은 아님) 그
    // 이전 값도 찾을 수 있게 며칠 여유를 두고 요청한다(yahooRows와 동일 방식).
    const cosd = new Date(Date.parse(week.baseFriday) - 12 * 86_400_000).toISOString().slice(0, 10);
    const csv = await fetchText(
      `https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS3&cosd=${cosd}`,
      { headers: { "user-agent": "Mozilla/5.0", accept: "text/csv" }, revalidate: 60 * 60 * 12 },
    );
    const lines = csv.trim().split(/\r?\n/);
    const bars: Bar[] = [];
    for (let i = 1; i < lines.length; i++) {
      const [date, raw] = lines[i].split(",");
      if (!raw || raw === ".") continue;
      const value = Number(raw);
      if (Number.isFinite(value)) bars.push({ date, close: value });
    }
    return rowFromBars(spec, bars, week);
  } catch {
    return emptyRow(spec);
  }
}

const NTNF_JSON_URL =
  "https://raw.githubusercontent.com/post0318/4/main/src/lib/server/ntnf-yield-history.json";

/** 브라질 NTN-F ~10년 수익률 — 4번 프로젝트가 주간 커밋하는 JSON */
async function ntnfRow(week: ReportWeek): Promise<SnapshotRow | null> {
  try {
    const res = await fetch(NTNF_JSON_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      asOfDate?: string;
      points?: { date: string; ytm: number; maturityYear?: number }[];
    };
    const bars: Bar[] = (j.points ?? [])
      .filter((p) => Number.isFinite(p.ytm))
      .map((p) => ({ date: p.date, close: p.ytm }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const last = lastOnOrBefore(bars, week.weekEnd);
    if (!last) return null;
    // 시계열이 지난주 금요일까지 못 미치면(갱신 지연) 그 시점 기준 7일 전과 비교
    const baseYmd =
      last.date === week.weekEnd
        ? week.baseFriday
        : new Date(Date.parse(last.date) - 7 * 86_400_000).toISOString().slice(0, 10);
    const base = lastOnOrBefore(bars, baseYmd);
    const maturity = j.points?.at(-1)?.maturityYear;
    return {
      key: "BR_NTNF10Y",
      group: "채권",
      name: `브라질 국채 NTN-F 10년${maturity ? ` (만기 ${maturity})` : ""}`,
      value: last.close,
      asOf: last.date,
      pct: null,
      diff: base ? last.close - base.close : null,
      baseAsOf: base?.date ?? null,
      unit: "%",
      source: "Tesouro Nacional (post0318/4 주간 갱신)",
    };
  } catch {
    return null;
  }
}

export async function buildSnapshot(week: ReportWeek): Promise<SnapshotRow[]> {
  const [yahoo, ust3y, ecos, ntnf] = await Promise.all([
    yahooRows(week),
    ust3yRow(week),
    ecosRows(week),
    ntnfRow(week),
  ]);
  const rows = [...yahoo, ust3y, ...ecos, ...(ntnf ? [ntnf] : [])];
  const order = ["국내주식", "해외주식", "채권", "원자재", "환율·변동성"];
  return rows.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}

/** 이력이 없는 지표(NTN-F 등)에 직전 리포트 값을 기준값으로 채움 */
export function fillFromPrevious(rows: SnapshotRow[], prev: SnapshotRow[] | null): SnapshotRow[] {
  if (!prev) return rows;
  const byKey = new Map(prev.map((r) => [r.key, r]));
  return rows.map((r) => {
    if (r.value == null || r.baseAsOf != null) return r;
    const p = byKey.get(r.key);
    if (!p || p.value == null) return r;
    return { ...r, diff: r.value - p.value, baseAsOf: p.asOf };
  });
}

function fmt(n: number, unit: string): string {
  if (unit.startsWith("%")) return n.toFixed(2);
  return n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n.toFixed(2);
}

/** 프롬프트용 텍스트 표 */
export function snapshotToText(rows: SnapshotRow[], week: ReportWeek): string {
  const lines = rows.map((r) => {
    if (r.value == null) return `- ${r.group} | ${r.name}: 자료 없음`;
    let change: string;
    if (r.diff != null && r.unit.startsWith("%")) {
      const bp = r.diff * 100;
      change = `${bp >= 0 ? "+" : ""}${bp.toFixed(0)}bp`;
    } else if (r.pct != null) {
      change = `${r.pct >= 0 ? "+" : ""}${r.pct.toFixed(2)}%`;
    } else {
      change = "전주 대비 자료 없음";
    }
    const base = r.baseAsOf ? ` (기준일 ${r.baseAsOf})` : "";
    return `- ${r.group} | ${r.name}: ${fmt(r.value, r.unit)} ${r.unit} (${r.asOf}) 전주 대비 ${change}${base} [${r.source}]`;
  });
  return `기준: 지난주 마지막 거래일(${week.weekEnd}) vs 전전주 마지막 거래일(${week.baseFriday})\n${lines.join("\n")}`;
}

/** 마크다운 표 — 값·변동은 스냅샷에서, 코멘트는 모델이 쓴 "- 지표명: 코멘트" 줄에서.
 * 모델이 수치를 옮겨 적게 두면 반올림·오기 위험이 있어(오너가 Gemini 앱 샘플에서
 * 목/금 종가가 뒤섞인 표를 실측) 표는 반드시 코드가 만든다. 첫 초안(2026-09-15)
 * 에선 모델이 값을 정확히 옮겼지만 구조적으로 막아두는 편이 안전. */
export function snapshotToMarkdownTable(rows: SnapshotRow[], comments: Map<string, string>): string {
  const lines = ["| 자산 | 종가 | 주간 변동 | 코멘트 |", "|---|---:|---:|---|"];
  for (const r of rows) {
    if (r.value == null) continue;
    let change: string;
    if (r.diff != null && r.unit.startsWith("%")) {
      const bp = r.diff * 100;
      change = `${bp >= 0 ? "+" : ""}${bp.toFixed(0)}bp`;
    } else if (r.pct != null) {
      change = `${r.pct >= 0 ? "+" : ""}${r.pct.toFixed(2)}%`;
    } else {
      change = "-";
    }
    const value = r.unit.startsWith("%") ? `${fmt(r.value, r.unit)}%` : fmt(r.value, r.unit);
    const comment = comments.get(r.name) ?? "";
    lines.push(`| ${r.name} | ${value} | ${change} | ${comment} |`);
  }
  return lines.join("\n");
}
