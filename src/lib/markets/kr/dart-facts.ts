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
  /** 연도별로 태그가 바뀐 경우 관측된 모든 account_id */
  accountIds: string[];
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

/**
 * 계정 키 결정기. 같은 계정이 연도별로
 *  (a) account_id 는 그대로인데 계정명이 바뀌거나(분기순이익→반기순이익→당기순이익)
 *  (b) 계정명은 그대로인데 account_id 가 바뀌거나 사라지는(단기차입금)
 * 두 경우를 모두 하나로 병합한다.
 *  - real id 가 있고 이미 본 id 면 → 그 id 의 최초 키(sj|정규화명) 재사용
 *  - 아니면 sj|정규화명 을 키로, real id 는 그 키에 등록
 * 키마다 관측된 모든 정규화명을 모아 byName 에 별칭 등록.
 */
function makeKeyer() {
  const idToKey = new Map<string, string>();
  const namesByKey = new Map<string, Set<string>>();
  const idsByKey = new Map<string, Set<string>>();
  return {
    key(r: { sj_div: string; account_id?: string; account_nm: string }): string {
      const id = r.account_id && r.account_id !== "-표준계정코드 미사용-" ? r.account_id : "";
      const nk = `${r.sj_div}|${norm(r.account_nm)}`;
      let k = nk;
      if (id && idToKey.has(id)) k = idToKey.get(id)!;
      else if (id) idToKey.set(id, nk);
      const ns = namesByKey.get(k) ?? new Set<string>();
      ns.add(norm(r.account_nm));
      namesByKey.set(k, ns);
      if (id) {
        const is = idsByKey.get(k) ?? new Set<string>();
        is.add(id);
        idsByKey.set(k, is);
      }
      return k;
    },
    namesByKey,
    idsByKey,
  };
}

function buildIndex(
  meta: Map<string, { name: string; sj: string; ord: number }>,
  keyer: ReturnType<typeof makeKeyer>,
  periodLabels: string[],
  valueFor: (k: string, periodLabel: string) => number | null,
): { lines: KrFactLine[]; byId: Map<string, KrFactLine>; byName: Map<string, KrFactLine> } {
  const lines: KrFactLine[] = [];
  const lineByKey = new Map<string, KrFactLine>();
  for (const [k, m] of meta) {
    const byPeriod = new Map<string, number>();
    for (const pl of periodLabels) {
      const v = valueFor(k, pl);
      if (v != null) byPeriod.set(pl, v);
    }
    const ids = [...(keyer.idsByKey.get(k) ?? [])];
    const line: KrFactLine = { accountId: ids[0] ?? "", accountIds: ids, accountName: m.name, sjDiv: m.sj, ord: m.ord, byPeriod };
    lines.push(line);
    lineByKey.set(k, line);
  }
  lines.sort((a, b) => a.ord - b.ord);

  const byId = new Map<string, KrFactLine>();
  const byName = new Map<string, KrFactLine>();
  for (const [k, m] of meta) {
    const line = lineByKey.get(k)!;
    for (const id of keyer.idsByKey.get(k) ?? []) if (!byId.has(id)) byId.set(id, line);
    for (const nm of keyer.namesByKey.get(k) ?? []) {
      const nk = `${m.sj}|${nm}`;
      if (!byName.has(nk)) byName.set(nk, line);
    }
  }
  return { lines, byId, byName };
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

    const keyer = makeKeyer();
    const series = new Map<string, Map<number, number>>();
    const meta = new Map<string, { name: string; sj: string; ord: number }>();
    const endByYear = new Map<number, string>();

    const ingest = (rows: RawRow[], baseYear: number) => {
      for (const r of rows) {
        const k = keyer.key(r);
        if (!meta.has(k)) meta.set(k, { name: r.account_nm, sj: r.sj_div, ord: Number(r.ord) || 0 });
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
    // 최신 보고서를 먼저 ingest → 계정명 별칭의 대표는 최신 표기(당기순이익 등)
    ingest(latestRows, latestYear);
    if (olderRows) ingest(olderRows, latestYear - 3);

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

    const { lines, byId, byName } = buildIndex(
      meta,
      keyer,
      showYears.map((y) => `FY${y}`),
      (k, pl) => series.get(k)?.get(Number(pl.slice(2))) ?? null,
    );
    // annual: 키 → (연도 → 값) — annualSeries 헬퍼용 (전체 6개년)
    const annual = new Map<string, Map<number, number>>();
    for (const [k, s] of series) annual.set(k, new Map(s));

    return {
      mode: "annual",
      fsDiv,
      periods,
      lines,
      byId,
      byName,
      annual,
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

    // 계정 키 결정기 — 최신 보고서부터 ingest (대표 계정명 = 최신 표기)
    const keyer = makeKeyer();
    const meta = new Map<string, { name: string; sj: string; ord: number }>();
    const orderedReports: [number, keyof typeof REPRT][] = [];
    for (const yr of [baseYear, baseYear - 1]) for (const q of ["FY", "Q3", "H1", "Q1"] as const) orderedReports.push([yr, q]);
    for (const [yr, q] of orderedReports) {
      const rows = fetched.get(`${yr}:${q}`);
      if (!rows) continue;
      for (const r of rows) {
        const k = keyer.key(r);
        if (!meta.has(k)) meta.set(k, { name: r.account_nm, sj: r.sj_div, ord: Number(r.ord) || 0 });
      }
    }

    // 각 (연도, 분기)의 YTD/기말 맵 (키는 keyer 키)
    type QT = { year: number; qi: number; end: string; ytd: Map<string, number>; snap: Map<string, number> };
    const quarters: QT[] = [];
    for (const yr of reportYears) {
      for (const q of Q_ORDER) {
        const rows = fetched.get(`${yr}:${q}`);
        if (!rows) continue;
        const ytd = new Map<string, number>();
        const snap = new Map<string, number>();
        for (const r of rows) {
          const k = keyer.key(r);
          if (r.sj_div === "BS") {
            const v = num(r.thstrm_amount);
            if (v != null && !snap.has(k)) snap.set(k, v);
          } else {
            const v = ytdVal(r);
            if (v != null && !ytd.has(k)) ytd.set(k, v);
          }
        }
        const qi = Q_NUM[q];
        const end = qi === 4 ? yearEnd(yr) : `${yr}-${String(qi * 3).padStart(2, "0")}-${qi === 2 || qi === 3 ? "30" : "31"}`;
        quarters.push({ year: yr, qi, end, ytd, snap });
      }
    }
    quarters.sort((a, b) => a.year - b.year || a.qi - b.qi);
    if (quarters.length === 0) continue;

    // 단일분기 = YTD[n] − YTD[n-1] (같은 연도 내; qi=1 은 그대로). BS 는 기말값.
    const single: { year: number; qi: number; end: string; vals: Map<string, number> }[] = [];
    for (const qt of quarters) {
      const prev = quarters.find((x) => x.year === qt.year && x.qi === qt.qi - 1);
      const vals = new Map<string, number>();
      for (const [k, m] of meta) {
        if (m.sj === "BS") {
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
    const plLabels = show.map((s) => `${s.year} Q${s.qi}`);
    const valAt = new Map<string, number>(); // `${k}@@${label}` -> v
    for (const s of show) for (const [k, v] of s.vals) valAt.set(`${k}@@${s.year} Q${s.qi}`, v);

    const { lines, byId, byName } = buildIndex(
      meta,
      keyer,
      plLabels,
      (k, pl) => valAt.get(`${k}@@${pl}`) ?? null,
    );

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

/** 연간 전체 시계열(연도→값) — 개념 병합. 재무분석 CAGR·평균잔액용. */
export function annualSeries(
  facts: KrFacts,
  ids: string[],
  names: string[] = [],
  sj?: string,
): Map<number, number> {
  const out = new Map<number, number>();
  const seenLines = new Set<KrFactLine>();
  const linesFor: KrFactLine[] = [];
  for (const id of ids) {
    const l = facts.byId.get(id);
    if (l && (!sj || l.sjDiv === sj) && !seenLines.has(l)) {
      seenLines.add(l);
      linesFor.push(l);
    }
  }
  for (const nm of names)
    for (const div of sj ? [sj] : ["IS", "CIS", "BS", "CF"]) {
      const l = facts.byName.get(`${div}|${norm(nm)}`);
      if (l && !seenLines.has(l)) {
        seenLines.add(l);
        linesFor.push(l);
      }
    }
  for (const l of linesFor) {
    const s = facts.annual.get(`${l.sjDiv}|${norm(l.accountName)}`);
    if (!s) continue;
    for (const [y, v] of s) if (!out.has(y)) out.set(y, v);
  }
  return out;
}

/** 여러 개념 그룹의 연간 시계열 합산. */
export function annualSum(
  facts: KrFacts,
  groups: { ids: string[]; names?: string[]; negate?: boolean }[],
  sj?: string,
): Map<number, number> {
  const out = new Map<number, number>();
  const years = new Set<number>();
  const perGroup = groups.map((g) => annualSeries(facts, g.ids, g.names ?? [], sj));
  for (const m of perGroup) for (const y of m.keys()) years.add(y);
  for (const y of years) {
    let acc: number | null = null;
    groups.forEach((g, i) => {
      const v = perGroup[i].get(y);
      if (v == null) return;
      acc = (acc ?? 0) + (g.negate ? -v : v);
    });
    if (acc != null) out.set(y, acc);
  }
  return out;
}
