import "server-only";
import { fetchJson, fetchText } from "../http";
import type { RecentFilings } from "./edgar-gapfill";

/**
 * 20-F 발행사 분기 재무제표 — 6-K 로 낸 연결재무보고서(HTML) 판독(2026-10-02, 오너 지적 "TSM 빈칸 — 해결책을 못 찾은 건가").
 *
 * 20-F 회사는 분기 XBRL 이 없어 LTM 을 야후 분기로 만드는데(edgar-yahoo-quarters.ts), 야후는 항목을 자기 기준으로 재분류해 SEC 정의와 다른
 * 줄이 있다(TSM 매입채무 = 매입채무 + 설비 미지급금, 유동성 장기부채에서 사채 유동분 누락 등). 회사가 직접 낸 분기 보고서의 같은 줄을 읽으면
 * 정의가 SEC 연간과 같다. 줄 대응은 추측하지 않는다 — 같은 회사 최근 20-F 의 XBRL 라벨 파일(개념 ↔ 회사가 쓰는 줄 이름)로 이름이 정확히
 * 같은 줄만. 재무상태표는 보고서의 전년 연말 열이 SEC 연간 값과 정확히 같은 후보만 쓴다(호출부 edgar-yahoo-quarters.ts 가 확인).
 * 재무제표가 그림인 보고서(ASML)는 읽지 못한다 — null.
 */

const UA = "post0318 research post0318@gmail.com";
const H = { "user-agent": UA, "accept-encoding": "gzip, deflate" };
const OPT = { headers: H, revalidate: 60 * 60 * 24, timeoutMs: 45_000 };

/** parent = 바로 위 값 없는 머리 줄(예 "current assets"·"acquisitions of") — 같은 이름 줄(유동·비유동, 취득·처분) 구분용 */
export interface SixKRow { label: string; vals: number[]; parent?: string }
export interface SixKStatements {
  /** 보고서 출처(접수번호/파일) */
  source: string;
  /** 금액 단위(천 = 1e3) */
  unit: number;
  /** 재무상태표 열 순서(날짜) — vals 와 같은 순서 */
  bsDates: string[];
  /** 현금흐름표 열 순서(누적 기간 종료일) */
  cfDates: string[];
  bs: SixKRow[];
  cf: SixKRow[];
  /** 개념(접두어 없는 이름, 예 "TradeAndOtherCurrentPayablesToTradeSuppliers") → 정규화 라벨 집합. neg = 부호 반전 라벨(negatedLabel 계열 —
   *  보고서에 음수로 보이는 지급액 등. XBRL 값 = −표시값) */
  labels: Map<string, { pos: Set<string>; neg: Set<string> }>;
  /** 개념 → 표시 구조(_pre.xml)상 부모 개념 */
  parents: Map<string, Set<string>>;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const longDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };
const decode = (s: string) =>
  s.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;|&#xa0;/gi, " ").replace(/&amp;/g, "&").replace(/&#8217;|&rsquo;/g, "'").replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, "-")
    .replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
/** 라벨 정규화 — 소문자, 주석 번호 "(Note 19)" 제거, 구두점·공백 정리 */
export const normLabel = (s: string) => s.toLowerCase().replace(/\((?:notes?|note)[^)]*\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();

const NUM_RE = /^\(?-?\$?\s*[\d,]+(?:\.\d+)?\)?$/;
const parseNum = (s: string): number | null => {
  const t = s.replace(/\$/g, "").trim();
  if (/^[-–—]$/.test(t)) return 0;
  if (!NUM_RE.test(t)) return null;
  const neg = /^\(.*\)$/.test(t) || t.startsWith("-");
  const v = Number(t.replace(/[(),\s-]/g, ""));
  return Number.isFinite(v) ? (neg ? -v : v) : null;
};

/** 20-F 라벨 파일 → 개념 이름 → 라벨 집합(label·terse·verbose·negated) */
type Lb = Map<string, { pos: Set<string>; neg: Set<string> }>;
async function filingLabels(cik: number, recent: RecentFilings): Promise<{ labels: Lb; parents: Map<string, Set<string>> }> {
  const none = { labels: new Map(), parents: new Map() };
  const i = recent.form.findIndex((f) => /^20-F/.test(f));
  if (i < 0) return none;
  const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${recent.accessionNumber[i].replace(/-/g, "")}`;
  const idx = await fetchJson<{ directory: { item: { name: string }[] } }>(`${base}/index.json`, OPT);
  const names = idx.directory.item.map((x) => x.name);
  const lab = names.find((n) => /_lab\.xml$/i.test(n)), pre = names.find((n) => /_pre\.xml$/i.test(n));
  if (!lab || !pre) return none;
  const [xml, pxml] = await Promise.all([fetchText(`${base}/${lab}`, OPT), fetchText(`${base}/${pre}`, OPT)]);
  const out: Lb = new Map();
  const re = /<link:label\b[^>]*xlink:label="lab_[^_"]+_([A-Za-z0-9]+)"[^>]*xlink:role="[^"]*\/(label|terseLabel|verboseLabel|negatedLabel|negatedTerseLabel|totalLabel)"[^>]*>([^<]*)<\/link:label>/g;
  for (let m: RegExpExecArray | null; (m = re.exec(xml)); ) {
    const s = out.get(m[1]) ?? { pos: new Set<string>(), neg: new Set<string>() };
    (/^negated/.test(m[2]) ? s.neg : s.pos).add(normLabel(m[3]));
    out.set(m[1], s);
  }
  // 표시 구조 — loc(이름표 → 개념)·parent-child 연결
  const loc = new Map<string, string>();
  for (const m of pxml.matchAll(/<link:loc\b[^>]*xlink:label="([^"]+)"[^>]*xlink:href="[^"]*#[^_"]+_([A-Za-z0-9]+)"/g)) loc.set(m[1], m[2]);
  const parents = new Map<string, Set<string>>();
  for (const m of pxml.matchAll(/<link:presentationArc\b[^>]*xlink:from="([^"]+)"[^>]*xlink:to="([^"]+)"/g)) {
    const f = loc.get(m[1]), t = loc.get(m[2]);
    if (f && t) parents.set(t, (parents.get(t) ?? new Set<string>()).add(f));
  }
  return { labels: out, parents };
}

/** 보고서 HTML 안의 한 재무제표 구간(제목 ~ 다음 제목)에서 표의 줄 */
function sectionRows(html: string, head: RegExp, mustHave: RegExp, end: RegExp): { rows: SixKRow[]; text: string } | null {
  for (let m: RegExpExecArray | null, re = new RegExp(head.source, "gi"); (m = re.exec(html)); ) {
    const rest = html.slice(m.index);
    const e = rest.slice(200).search(end);
    const sec = e < 0 ? rest.slice(0, 400_000) : rest.slice(0, e + 200);
    const plain = decode(sec);
    if (!mustHave.test(plain)) continue; // 목차의 같은 제목은 건너뜀(서식 코드가 길어 구간 전체를 해독해 본다)
    const rows: SixKRow[] = [];
    let parent: string | undefined;
    for (const tr of sec.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
      const cells = (tr.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) ?? []).map(decode).filter((c) => c !== "" && c !== "$");
      const label = cells.find((c) => /[A-Za-z]/.test(c));
      if (!label) continue;
      const vals = cells.slice(cells.indexOf(label) + 1).map(parseNum).filter((v): v is number => v != null);
      if (vals.length) rows.push({ label: normLabel(label), vals, parent });
      else parent = normLabel(label);
    }
    return { rows, text: plain.slice(0, 3_000).toLowerCase() };
  }
  return null;
}

/** 구간 머리말에 나온 날짜(ISO) — 등장 순서(열 순서) */
function headerDates(text: string, candidates: string[]): string[] {
  return candidates.map((d) => ({ d, i: text.indexOf(longDate(d)) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i).map((x) => x.d);
}

/**
 * 분기말 periodEnd 의 6-K 연결재무보고서. fyEnd = 최근 사업연도말, priorEnd = 1년 전 같은 분기말(재무상태표 3번째 열·현금흐름 전년 누적).
 * 없거나(보고서 미제출) 재무제표를 읽을 수 없으면(그림 — ASML) null
 */
export async function sixKStatements(cik: string, recent: RecentFilings | null, periodEnd: string, fyEnd: string, priorEnd: string): Promise<SixKStatements | null> {
  if (!recent) return null;
  const cikN = Number(cik);
  const lo = periodEnd, hi = new Date(Date.parse(periodEnd) + 120 * 864e5).toISOString().slice(0, 10);
  const cands: number[] = [];
  for (let i = 0; i < recent.form.length && cands.length < 8; i++) if (recent.form[i] === "6-K" && recent.filingDate[i] > lo && recent.filingDate[i] <= hi) cands.push(i);
  for (const i of cands) {
    const base = `https://www.sec.gov/Archives/edgar/data/${cikN}/${recent.accessionNumber[i].replace(/-/g, "")}`;
    const idx = await fetchJson<{ directory: { item: { name: string; size: string | number }[] } }>(`${base}/index.json`, OPT).catch(() => null);
    const docs = (idx?.directory.item ?? []).filter((x) => /\.htm$/i.test(x.name) && Number(x.size) > 150_000).sort((a, b) => Number(b.size) - Number(a.size)).slice(0, 2);
    for (const d of docs) {
      const html = await fetchText(`${base}/${d.name}`, { ...OPT, timeoutMs: 60_000 }).catch(() => null);
      if (!html) continue;
      const head = decode(html.slice(0, 200_000)).toLowerCase();
      if (!head.includes(longDate(periodEnd))) continue;
      const bs = sectionRows(html, /CONSOLIDATED (?:BALANCE SHEETS?|STATEMENTS? OF FINANCIAL POSITION)/, /total (?:current )?assets/i, /CONSOLIDATED STATEMENTS? OF (?:COMPREHENSIVE|PROFIT|INCOME|OPERATIONS)/i);
      const cf = sectionRows(html, /CONSOLIDATED STATEMENTS? OF CASH FLOWS?/, /operating activities/i, /NOTES TO (?:THE )?(?:CONDENSED )?CONSOLIDATED/i);
      if (!bs || !cf) continue;
      const unit = /in thousands/.test(bs.text) ? 1e3 : /in millions/.test(bs.text) ? 1e6 : 1;
      const bsDates = headerDates(bs.text, [periodEnd, fyEnd, priorEnd]);
      // 현금흐름 열 = 당기·전기 누적(종료일 표기는 "june 30" + 연도 열 머리) — 당기 → 전기 순서가 관행. 머리말에 두 연도가 그 순서로 나올 때만
      const yC = periodEnd.slice(0, 4), yP = priorEnd.slice(0, 4);
      const iC = cf.text.indexOf(yC), iP = cf.text.indexOf(yP);
      const cfDates = iC >= 0 && iP >= 0 ? (iC < iP ? [periodEnd, priorEnd] : [priorEnd, periodEnd]) : [];
      if (bsDates.length < 2 || cfDates.length !== 2) continue;
      // 재무상태표 줄 값: 열마다 [금액, 비율%] 쌍인 보고서(TSM) — 값 개수가 열 수의 2배면 짝수 자리만
      const fix = (rows: SixKRow[], n: number) => rows.map((r) => ({ ...r, vals: r.vals.length === 2 * n ? r.vals.filter((_, k) => k % 2 === 0) : r.vals })).filter((r) => r.vals.length === n);
      const { labels, parents } = await filingLabels(cikN, recent).catch(() => ({ labels: new Map(), parents: new Map() }));
      if (!labels.size) return null;
      return { source: `6-K ${recent.accessionNumber[i]} ${d.name}`, unit, bsDates, cfDates, bs: fix(bs.rows, bsDates.length), cf: fix(cf.rows, 2), labels, parents };
    }
  }
  return null;
}

/**
 * 개념의 6-K 값(XBRL 부호, 원통화 = 표시값 × 단위) — 라벨이 정확히 같은 줄이 하나일 때만. 같은 라벨이 일반·부호 반전 양쪽에 있으면
 * 부호를 정할 수 없어 null(추측 금지)
 */
export function sixKValueOf(st: SixKStatements, concept: string, sec: "bs" | "cf", check?: (vals: number[]) => boolean): number[] | null {
  const ls = st.labels.get(concept);
  if (!ls) return null;
  const val = (r: SixKRow) => {
    const p = ls.pos.has(r.label), n = ls.neg.has(r.label);
    return p && n ? null : r.vals.map((v) => (n ? -v : v) * st.unit);
  };
  let rows = st[sec].filter((r) => ls.pos.has(r.label) || ls.neg.has(r.label));
  if (rows.length > 1) {
    // 같은 이름 줄이 여럿 — 머리 줄이 개념의 표시 구조 부모 라벨과 같은 줄만(유동 vs 비유동, 취득 vs 처분)
    const pl = new Set<string>();
    for (const pc of st.parents.get(concept) ?? []) for (const x of [...(st.labels.get(pc)?.pos ?? []), ...(st.labels.get(pc)?.neg ?? [])]) pl.add(x);
    const byParent = rows.filter((r) => r.parent && pl.has(r.parent));
    // 그래도 못 가르면 호출부 확인(재무상태표 — 전년 연말 열 = SEC 연말 값)으로 정확히 하나만
    rows = byParent.length === 1 ? byParent : check ? rows.filter((r) => { const v = val(r); return v != null && check(v); }) : [];
  }
  if (rows.length !== 1) return null;
  return val(rows[0]);
}
