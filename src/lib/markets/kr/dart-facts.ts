import "server-only";
import { fetchJson } from "../http";

/**
 * DART `fnlttSinglAcntAll`(전체 재무제표) 를 미국 `CompanyFacts` 에 대응하는
 * 정규화 구조로 로드한다. IS/BS/CF 상세 재분류·재무분석·재무 하이라이트 빌더의 공통 입력.
 *
 * - account_id(`ifrs-full_Revenue`, `dart_OperatingIncomeLoss` …) 우선, 한글 계정명 폴백.
 * - 연간: 최근 확정 사업연도 + −3 두 번의 `11011` 호출로 6개년(각 호출 당기/전기/전전기 3열).
 * - 분기: 최근 가용 분기·반기·사업보고서를 모아 누적(YTD) 차감으로 단일분기 5개 + LTM.
 * - 연결(CFS) 우선, 없으면 별도(OFS).
 */

const BASE = "https://opendart.fss.or.kr/api";
const CACHE = 60 * 60 * 6;

function key(): string {
  const k = process.env.DART_API_KEY;
  if (!k) throw new Error("DART_API_KEY 미설정");
  return k;
}

interface RawRow {
  sj_div: string;
  account_id?: string;
  account_nm: string;
  thstrm_nm?: string;
  thstrm_amount?: string;
  thstrm_add_amount?: string;
  frmtrm_nm?: string;
  frmtrm_amount?: string;
  frmtrm_q_amount?: string;
  frmtrm_add_amount?: string;
  bfefrmtrm_nm?: string;
  bfefrmtrm_amount?: string;
  ord?: string;
}
interface RawResponse {
  status: string;
  message: string;
  list?: RawRow[];
}

const REPRT = { Q1: "11013", H1: "11012", Q3: "11014", FY: "11011" } as const;

function num(v: string | undefined | null): number | null {
  if (v == null || v === "-" || v === "" || v.trim() === "") return null;
  const n = Number(v.replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}
export const norm = (s: string): string => s.replace(/\s|\(.*?\)/g, "");

async function fetchAll(
  corpCode: string,
  year: number,
  reprt: string,
  fsDiv: "CFS" | "OFS",
): Promise<RawRow[] | null> {
  const url =
    `${BASE}/fnlttSinglAcntAll.json?crtfc_key=${key()}&corp_code=${corpCode}` +
    `&bsns_year=${year}&reprt_code=${reprt}&fs_div=${fsDiv}`;
  try {
    const res = await fetchJson<RawResponse>(url, { revalidate: CACHE });
    if (res.status !== "000" || !res.list?.length) return null;
    return res.list.filter((r) => ["BS", "IS", "CIS", "CF"].includes(r.sj_div));
  } catch {
    return null;
  }
}

// ── 정규화 구조 ─────────────────────────────────────────────────────

export interface KrPeriod {
  label: string; // "FY2024" | "2025 Q3" | "현재/LTM"
  year: number;
  quarter: number | null;
  endDate: string;
  kind: "fy" | "quarter" | "ltm";
}

export interface KrFactLine {
  accountId: string;
  accountName: string;
  sjDiv: string; // BS | IS | CIS | CF
  ord: number;
  /** period.label -> 값 (흐름은 단일기간, 잔액은 기말) */
  byPeriod: Map<string, number>;
}

export interface KrFacts {
  mode: "annual" | "quarter";
  fsDiv: "CFS" | "OFS";
  periods: KrPeriod[];
  lines: KrFactLine[];
  byId: Map<string, KrFactLine>;
  byName: Map<string, KrFactLine>;
  /** 연간 6개년 전체 시계열(연도→값) — 모드 무관. 재무분석 CAGR·평균잔액용. */
  annual: Map<string, Map<number, number>>;
  annualEndByYear: Map<number, string>;
  source: string;
}

/** 12/31 결산이 아닌 회사도 있으나 대부분 12/31. */
function yearEnd(year: number): string {
  return `${year}-12-31`;
}

// ── 연간 로드 ───────────────────────────────────────────────────────

async function loadAnnual(corpCode: string): Promise<KrFacts | null> {
  const now = new Date();
  const cy = now.getFullYear();

  for (const fsDiv of ["CFS", "OFS"] as const) {
    // 최근 확정 사업연도 탐색
    let latestYear = 0;
    let latestRows: RawRow[] | null = null;
    for (const y of [cy - 1, cy - 2]) {
      const rows = await fetchAll(corpCode, y, REPRT.FY, fsDiv);
      if (rows) {
        latestYear = y;
        latestRows = rows;
        break;
      }
    }
    if (!latestRows) continue;

    // 그 3년 전 호출로 6개년 확보
    const olderRows = await fetchAll(corpCode, latestYear - 3, REPRT.FY, fsDiv);

    // account -> year -> val
    const series = new Map<string, Map<number, number>>();
    const meta = new Map<string, { id: string; name: string; sj: string; ord: number }>();
    const endByYear = new Map<number, string>();

    const ingest = (rows: RawRow[], baseYear: number) => {
      for (const r of rows) {
        const id = r.account_id && r.account_id !== "-표준계정코드 미사용-" ? r.account_id : "";
        const k = id || `${r.sj_div}|${norm(r.account_nm)}`;
        if (!meta.has(k))
          meta.set(k, { id, name: r.account_nm, sj: r.sj_div, ord: Number(r.ord) || 0 });
        const s = series.get(k) ?? new Map<number, number>();
        series.set(k, s);
        const cols: [number, string | undefined][] = [
          [baseYear, r.thstrm_amount],
          [baseYear - 1, r.frmtrm_amount],
          [baseYear - 2, r.bfefrmtrm_amount],
        ];
        for (const [yr, raw] of cols) {
          const v = num(raw);
          if (v == null) continue;
          if (!s.has(yr)) s.set(yr, v);
          if (!endByYear.has(yr)) endByYear.set(yr, yearEnd(yr));
        }
      }
    };
    if (olderRows) ingest(olderRows, latestYear - 3);
    ingest(latestRows, latestYear);

    const years = [...endByYear.keys()].sort((a, b) => b - a).slice(0, 6).sort((a, b) => a - b);
    if (years.length === 0) continue;
    const showYears = years.slice(-5);
    const periods: KrPeriod[] = showYears.map((y) => ({
      label: `FY${y}`,
      year: y,
      quarter: null,
      endDate: endByYear.get(y) ?? yearEnd(y),
      kind: "fy",
    }));

    const lines: KrFactLine[] = [];
    for (const [k, m] of meta) {
      const s = series.get(k)!;
      const byPeriod = new Map<string, number>();
      for (const y of showYears) {
        const v = s.get(y);
        if (v != null) byPeriod.set(`FY${y}`, v);
      }
      lines.push({ accountId: m.id, accountName: m.name, sjDiv: m.sj, ord: m.ord, byPeriod });
    }
    lines.sort((a, b) => a.ord - b.ord);

    const byId = new Map<string, KrFactLine>();
    const byName = new Map<string, KrFactLine>();
    for (const l of lines) {
      if (l.accountId && !byId.has(l.accountId)) byId.set(l.accountId, l);
      const nk = `${l.sjDiv}|${norm(l.accountName)}`;
      if (!byName.has(nk)) byName.set(nk, l);
    }

    return {
      mode: "annual",
      fsDiv,
      periods,
      lines,
      byId,
      byName,
      annual: series,
      annualEndByYear: endByYear,
      source: `OpenDART 전체 재무제표 (${fsDiv === "CFS" ? "연결" : "별도"})`,
    };
  }
  return null;
}

// ── 분기 로드 (단일분기 5개 + LTM) ─────────────────────────────────

const Q_ORDER: (keyof typeof REPRT)[] = ["Q1", "H1", "Q3", "FY"];
const Q_NUM: Record<string, number> = { Q1: 1, H1: 2, Q3: 3, FY: 4 };

/** YTD 값: 손익은 thstrm_add_amount, 현금흐름은 thstrm_amount 자체가 누적. */
function ytdVal(r: RawRow): number | null {
  return num(r.thstrm_add_amount) ?? num(r.thstrm_amount);
}

async function loadQuarter(corpCode: string): Promise<KrFacts | null> {
  const cy = new Date().getFullYear();

  for (const fsDiv of ["CFS", "OFS"] as const) {
    // 데이터가 있는 최근 연도
    let baseYear = 0;
    for (const y of [cy, cy - 1]) {
      const probe = await fetchAll(corpCode, y, REPRT.Q1, fsDiv);
      const probe2 = probe ?? (await fetchAll(corpCode, y, REPRT.H1, fsDiv));
      if (probe2) {
        baseYear = y;
        break;
      }
    }
    if (!baseYear) continue;

    // baseYear-1 .. baseYear 의 모든 보고서
    const reportYears = [baseYear - 1, baseYear];
    const fetched = new Map<string, RawRow[]>(); // "YYYY:Q1" -> rows
    await Promise.all(
      reportYears.flatMap((yr) =>
        Q_ORDER.map(async (q) => {
          const rows = await fetchAll(corpCode, yr, REPRT[q], fsDiv);
          if (rows) fetched.set(`${yr}:${q}`, rows);
        }),
      ),
    );
    if (fetched.size === 0) continue;

    // 각 (연도, 분기)의 YTD 맵 만들기
    type QT = { year: number; qi: number; end: string; ytd: Map<string, number>; snap: Map<string, number> };
    const quarters: QT[] = [];
    for (const yr of reportYears) {
      for (const q of Q_ORDER) {
        const rows = fetched.get(`${yr}:${q}`);
        if (!rows) continue;
        const ytd = new Map<string, number>();
        const snap = new Map<string, number>(); // BS 기말
        for (const r of rows) {
          const id = r.account_id && r.account_id !== "-표준계정코드 미사용-" ? r.account_id : "";
          const k = id || `${r.sj_div}|${norm(r.account_nm)}`;
          if (r.sj_div === "BS") {
            const v = num(r.thstrm_amount);
            if (v != null && !snap.has(k)) snap.set(k, v);
          } else {
            const v = ytdVal(r);
            if (v != null && !ytd.has(k)) ytd.set(k, v);
          }
        }
        const qi = Q_NUM[q];
        const end =
          qi === 4 ? yearEnd(yr) : `${yr}-${String(qi * 3).padStart(2, "0")}-${qi === 1 ? "31" : qi === 2 ? "30" : "30"}`;
        quarters.push({ year: yr, qi, end, ytd, snap });
      }
    }
    quarters.sort((a, b) => a.year - b.year || a.qi - b.qi);
    if (quarters.length === 0) continue;

    // 단일분기 = YTD[n] − YTD[n-1] (같은 연도 내에서만; qi=1 은 그대로)
    const metaAll = new Map<string, { id: string; name: string; sj: string; ord: number }>();
    for (const rows of fetched.values())
      for (const r of rows) {
        const id = r.account_id && r.account_id !== "-표준계정코드 미사용-" ? r.account_id : "";
        const k = id || `${r.sj_div}|${norm(r.account_nm)}`;
        if (!metaAll.has(k))
          metaAll.set(k, { id, name: r.account_nm, sj: r.sj_div, ord: Number(r.ord) || 0 });
      }

    const single: { year: number; qi: number; end: string; vals: Map<string, number> }[] = [];
    for (const qt of quarters) {
      const prev = quarters.find((x) => x.year === qt.year && x.qi === qt.qi - 1);
      const vals = new Map<string, number>();
      for (const [k, meta] of metaAll) {
        if (meta.sj === "BS") {
          const v = qt.snap.get(k);
          if (v != null) vals.set(k, v);
          continue;
        }
        const cur = qt.ytd.get(k);
        if (cur == null) continue;
        if (qt.qi === 1) vals.set(k, cur);
        else {
          const p = prev?.ytd.get(k);
          if (p != null) vals.set(k, cur - p);
        }
      }
      single.push({ year: qt.year, qi: qt.qi, end: qt.end, vals });
    }

    const show = single.slice(-5);
    if (show.length === 0) continue;
    const periods: KrPeriod[] = show.map((s) => ({
      label: `${s.year} Q${s.qi}`,
      year: s.year,
      quarter: s.qi,
      endDate: s.end,
      kind: "quarter",
    }));

    const lines: KrFactLine[] = [];
    for (const [k, meta] of metaAll) {
      const byPeriod = new Map<string, number>();
      for (const s of show) {
        const v = s.vals.get(k);
        if (v != null) byPeriod.set(`${s.year} Q${s.qi}`, v);
      }
      if (byPeriod.size) lines.push({ accountId: meta.id, accountName: meta.name, sjDiv: meta.sj, ord: meta.ord, byPeriod });
    }
    lines.sort((a, b) => a.ord - b.ord);

    const byId = new Map<string, KrFactLine>();
    const byName = new Map<string, KrFactLine>();
    for (const l of lines) {
      if (l.accountId && !byId.has(l.accountId)) byId.set(l.accountId, l);
      const nk = `${l.sjDiv}|${norm(l.accountName)}`;
      if (!byName.has(nk)) byName.set(nk, l);
    }

    return {
      mode: "quarter",
      fsDiv,
      periods,
      lines,
      byId,
      byName,
      annual: new Map(),
      annualEndByYear: new Map(),
      source: `OpenDART 전체 재무제표 (${fsDiv === "CFS" ? "연결" : "별도"}) · 분기`,
    };
  }
  return null;
}

export async function fetchKrFacts(
  corpCode: string,
  mode: "annual" | "quarter",
): Promise<KrFacts | null> {
  return mode === "quarter" ? loadQuarter(corpCode) : loadAnnual(corpCode);
}

// ── 조회 헬퍼 ───────────────────────────────────────────────────────

/** account_id 우선, 없으면 한글 계정명(정규화) 폴백으로 라인 찾기. */
export function pick(
  facts: KrFacts,
  ids: string[],
  names: string[] = [],
  sj?: string,
): KrFactLine | null {
  for (const id of ids) {
    const l = facts.byId.get(id);
    if (l && (!sj || l.sjDiv === sj)) return l;
  }
  for (const nm of names) {
    for (const div of sj ? [sj] : ["IS", "CIS", "BS", "CF"]) {
      const l = facts.byName.get(`${div}|${norm(nm)}`);
      if (l) return l;
    }
  }
  return null;
}

/** 여러 개념 중 기간별로 처음 값이 있는 것을 병합 (태그 편차 대응). */
export function seriesOf(
  facts: KrFacts,
  ids: string[],
  names: string[] = [],
  sj?: string,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const p of facts.periods) out[p.label] = null;
  const candidates: KrFactLine[] = [];
  for (const id of ids) {
    const l = facts.byId.get(id);
    if (l && (!sj || l.sjDiv === sj)) candidates.push(l);
  }
  for (const nm of names)
    for (const div of sj ? [sj] : ["IS", "CIS", "BS", "CF"]) {
      const l = facts.byName.get(`${div}|${norm(nm)}`);
      if (l && !candidates.includes(l)) candidates.push(l);
    }
  for (const l of candidates)
    for (const p of facts.periods)
      if (out[p.label] == null && l.byPeriod.has(p.label)) out[p.label] = l.byPeriod.get(p.label)!;
  return out;
}

/** 여러 개념 그룹을 기간별 합산 (그룹별 부호 반전 가능). */
export function sumOf(
  facts: KrFacts,
  groups: { ids: string[]; names?: string[]; negate?: boolean }[],
  sj?: string,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const p of facts.periods) out[p.label] = null;
  for (const g of groups) {
    const s = seriesOf(facts, g.ids, g.names ?? [], sj);
    for (const p of facts.periods) {
      const v = s[p.label];
      if (v == null) continue;
      out[p.label] = (out[p.label] ?? 0) + (g.negate ? -v : v);
    }
  }
  return out;
}

/** 연간 전체 시계열(연도→값) — account_id 우선 병합. 재무분석 CAGR·평균잔액용. */
export function annualSeries(
  facts: KrFacts,
  ids: string[],
  names: string[] = [],
): Map<number, number> {
  const out = new Map<number, number>();
  const keys: string[] = [...ids];
  for (const nm of names) {
    // byName 은 모드별 5기만 → annual 맵은 원본 키(id 또는 "SJ|정규화명")로 접근
    for (const [k] of facts.annual) if (k.endsWith(`|${norm(nm)}`)) keys.push(k);
  }
  for (const k of keys) {
    const s = facts.annual.get(k);
    if (!s) continue;
    for (const [y, v] of s) if (!out.has(y)) out.set(y, v);
  }
  return out;
}
