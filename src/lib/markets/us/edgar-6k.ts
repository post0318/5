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
 * 재무제표가 슬라이드 그림인 보고서(ASML)는 그림 아래 숨은 글자(같은 내용)를 읽는다(slideStatements, 오너 지적 2026-10-02 — ASML IR 공시 목록).
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
  /** 본표 밖 표(주석 — 날짜 머리에 기준일·연말이 있는 표). 본표에 따로 없는 줄(SPOT 리스부채 유동분 — 미지급비용 주석 안)용 */
  bsNotes?: { dates: string[]; rows: SixKRow[] }[];
  /** 기준일 열 하나뿐인 본표 밖 표(연말 열이 없어 SEC 연말 확인 불가 — SPOT 1년 전 분기 리스부채 주석 "Current 68 Non-current 453").
   *  같은 표의 다른 줄이 이미 확인된 값과 같을 때만 쓴다(edgar-yahoo-quarters 기준 줄 확인) */
  bsNotes1?: { dates: string[]; rows: SixKRow[] }[];
  /** 슬라이드 글자 형식 — 줄 이름 앞에 구역 머리말이 붙어 나온다("cash flows from investing activities purchase of …"). 끝이 라벨과 같으면 대응 */
  loose?: boolean;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const longDate = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };
const decode = (s: string) =>
  s.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;|&#xa0;/gi, " ").replace(/&amp;/g, "&").replace(/&#8217;|&rsquo;/g, "'").replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, "-")
    .replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
/** 라벨 정규화 — 소문자, 주석 번호 "(Note 19)" 제거, 구두점·공백 정리 */
export const normLabel = (s: string) =>
  s.toLowerCase().replace(/\((?:notes?|note)[^)]*\)/g, "")
    // 현금흐름 합계 줄 — 20-F "Net cash used in investing activities" ↔ 분기 "Net cash provided by (used in) investing activities"(같은 개념, 부호만 다른 표현)
    .replace(/^net cash (?:provided by |used in |\(used in\) |provided by \(used in\) )+/, "net cash ")
    .replace(/[^a-z0-9]+/g, " ").trim();

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
  const re = /<link:label\b[^>]*xlink:label="lab_[^_"]+_([A-Za-z0-9]+)"[^>]*xlink:role="[^"]*\/(label|terseLabel|verboseLabel|negatedLabel|negatedTerseLabel|negatedTotalLabel|totalLabel|netLabel)"[^>]*>([^<]*)<\/link:label>/g;
  for (let m: RegExpExecArray | null; (m = re.exec(xml)); ) {
    const s = out.get(m[1]) ?? { pos: new Set<string>(), neg: new Set<string>() };
    (/^negated/.test(m[2]) ? s.neg : s.pos).add(normLabel(m[3].replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'")));
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
function sectionRows(html: string, head: RegExp, mustHave: RegExp, end: RegExp): { rows: SixKRow[]; text: string; noteCol: boolean } | null {
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
    // 금액 앞 주석 번호 열(SPOT "Note" — 줄마다 "11" 같은 번호, 여러 개면 "7, 8" 이라 숫자로 안 읽힘): 머리에 note 칸이 있으면 표시해 둔다
    return { rows, text: plain.slice(0, 3_000).toLowerCase(), noteCol: rows.some((r) => r.label === "note") || /\bnote\b/i.test(plain.slice(0, 1_500)) };
  }
  return null;
}

/**
 * 형식 2 — 재무제표가 슬라이드 그림이고 같은 내용이 그림 아래 숨은 글자(흰색 1pt)로 들어 있는 보고서(Workiva — ASML "Financial Statements
 * US GAAP"). 글자는 "줄 이름  값  값 …"(두 칸 띄움)이고, 열 머리는 "Jun 29, Jun 28, (Unaudited, €, in millions) 2025 2026".
 * 분기말이 달 말이 아닌 회사(ASML 6월 28일)는 같은 달 말로 맞춘다(야후 분기말·LTM 기준일이 달 말). 미국 기준(US GAAP) 슬라이드만.
 * 현금흐름표는 누적 열(반기·3분기 보고서의 "Six/Nine months ended", 1분기는 3개월)
 */
const MON3 = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function snapMonthEnd(y: number, m: number, d: number): string {
  // 24일 이후면 그달 말, 7일 이전이면 전달 말(52·53주 결산), 그 밖은 그대로
  const end = (yy: number, mm: number) => new Date(Date.UTC(yy, mm + 1, 0)).toISOString().slice(0, 10);
  if (d >= 24) return end(y, m);
  if (d <= 7) return end(y, m - 1);
  return new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
}
function slideDates(text: string): string[] {
  const h = /((?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2},\s*)+)\s*\([^)]*\)\s*((?:(?:19|20)\d{2}\s+)+)/.exec(text);
  if (!h) return [];
  const md = [...h[1].matchAll(/([A-Za-z]{3})[a-z]*\.? (\d{1,2}),/g)].map((m) => [MON3.indexOf(m[1].toLowerCase()), Number(m[2])]);
  const ys = h[2].trim().split(/\s+/).map(Number);
  if (md.length !== ys.length || md.some(([m]) => m < 0)) return [];
  return md.map(([m, d], k) => snapMonthEnd(ys[k], m, d));
}
function slideRows(text: string, n: number): SixKRow[] {
  const rows: SixKRow[] = [];
  let cur: SixKRow | null = null;
  for (const tok of text.split(/\s{2,}/).map((t) => t.trim()).filter(Boolean)) {
    const v = parseNum(tok);
    if (v != null && cur) cur.vals.push(v);
    else if (/[A-Za-z]/.test(tok)) rows.push((cur = { label: normLabel(tok), vals: [] }));
    else cur = null;
  }
  return rows.filter((r) => r.vals.length === n);
}
function slideStatements(html: string, periodEnd: string, fyEnd: string, priorEnd: string): Omit<SixKStatements, "source" | "labels" | "parents"> | null {
  const texts = [...html.matchAll(/<FONT[^>]*color:\s*white[^>]*>([\s\S]*?)<\/FONT>/gi)].map((m) =>
    m[1].replace(/<[^>]+>/g, " ").replace(/&#8212;|&mdash;/g, "—").replace(/&#8364;|&euro;/g, "€").replace(/&#8217;|&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/&nbsp;|&#160;/g, " ").replace(/[\r\n\t]/g, " "));
  if (texts.length < 3) return null;
  const unitOf = (t: string) => (/in millions/i.test(t) ? 1e6 : /in thousands/i.test(t) ? 1e3 : null);
  // 재무상태표 — 기준일·연말·1년 전이 다 있는 슬라이드 중 열이 가장 많은 것(분기별 요약)
  const bsCands = texts.filter((t) => /US GAAP/.test(t) && /total assets/i.test(t) && unitOf(t)).map((t) => ({ t, d: slideDates(t) }))
    .filter((x) => x.d.includes(periodEnd) && x.d.includes(fyEnd)).sort((a, b) => b.d.length - a.d.length);
  // 현금흐름표 — 누적 열
  let cf: { t: string; d: string[]; cols: number[] } | null = null;
  for (const t of texts) {
    if (!/US GAAP/.test(t) || !/operating activities/i.test(t) || !/months ended/i.test(t) || !unitOf(t)) continue;
    const d = slideDates(t);
    const cols = d.length === 4 && /(six|nine) months ended/i.test(t) ? [2, 3] : d.length === 2 && !/(six|nine) months ended/i.test(t) ? [0, 1] : null;
    if (!cols || !cols.every((k) => d[k] === periodEnd || d[k] === priorEnd) || d[cols[0]] === d[cols[1]]) continue;
    cf = { t, d, cols };
    break;
  }
  const bs = bsCands[0];
  if (!bs || !cf || unitOf(bs.t) !== unitOf(cf.t)) return null;
  const unit = unitOf(bs.t)!;
  const cfRows = slideRows(cf.t, cf.d.length).map((r) => ({ ...r, vals: cf!.cols.map((k) => r.vals[k]) }));
  return { unit, bsDates: bs.d, cfDates: cf.cols.map((k) => cf!.d[k]), bs: slideRows(bs.t, bs.d.length), cf: cfRows, loose: true };
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
  // 조회 실패 기록 — 값을 못 찾고 끝났는데 실패가 있었으면 던진다(재감사 12차 ③: null 로 삼키면 "6-K 없음"과 구분되지 않아 LTM 값이 조용히 사라졌다)
  const errs: string[] = [];
  const failed = (what: string) => (e: unknown) => { errs.push(`${what}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160)); return null; };
  for (let i = 0; i < recent.form.length && cands.length < 8; i++) if (recent.form[i] === "6-K" && recent.filingDate[i] > lo && recent.filingDate[i] <= hi) cands.push(i);
  for (const i of cands) {
    const base = `https://www.sec.gov/Archives/edgar/data/${cikN}/${recent.accessionNumber[i].replace(/-/g, "")}`;
    const idx = await fetchJson<{ directory: { item: { name: string; size: string | number }[] } }>(`${base}/index.json`, OPT).catch(failed(`${recent.accessionNumber[i]} index`));
    const docs = (idx?.directory.item ?? []).filter((x) => /\.htm$/i.test(x.name) && !/-index/i.test(x.name) && Number(x.size) > 15_000).sort((a, b) => Number(b.size) - Number(a.size)).slice(0, 6);
    for (const d of docs) {
      const html = await fetchText(`${base}/${d.name}`, { ...OPT, timeoutMs: 60_000 }).catch(failed(`${recent.accessionNumber[i]} ${d.name}`));
      if (!html) continue;
      // 형식 2 — 슬라이드 그림 + 숨은 글자(Workiva, ASML "Financial Statements US GAAP")
      const sl = slideStatements(html, periodEnd, fyEnd, priorEnd);
      if (sl) {
        const { labels, parents } = await filingLabels(cikN, recent); // 라벨 파일 조회 실패는 그대로 던진다(호출자가 경고로)
        if (!labels.size) return null;
        return { source: `6-K ${recent.accessionNumber[i]} ${d.name}`, ...sl, labels, parents, loose: true };
      }
      if (Number(d.size) < 150_000) continue;
      const head = decode(html.slice(0, 200_000)).toLowerCase();
      if (!head.includes(longDate(periodEnd))) continue;
      const bs = sectionRows(html, /CONSOLIDATED (?:BALANCE SHEETS?|STATEMENTS? OF FINANCIAL POSITION)/, /total (?:current )?assets/i, /CONSOLIDATED STATEMENTS? OF (?:COMPREHENSIVE|PROFIT|INCOME|OPERATIONS|CHANGES IN|CASH FLOWS?)/i); // 다음 재무제표 제목까지(SPOT 은 재무상태표 다음이 자본변동표)
      const cf = sectionRows(html, /CONSOLIDATED STATEMENTS? OF CASH FLOWS?/, /operating activities/i, /NOTES TO (?:THE )?(?:INTERIM )?(?:CONDENSED )?CONSOLIDATED/i); // SPOT "Notes to the interim condensed consolidated …"
      if (!bs || !cf) continue;
      const unit = /in (?:\S+ )?thousands/.test(bs.text) ? 1e3 : /in (?:\S+ )?millions/.test(bs.text) ? 1e6 : 1; // "in € millions"(SPOT)
      const bsDates = headerDates(bs.text, [periodEnd, fyEnd, priorEnd]);
      // 현금흐름 열 = 당기·전기 누적(종료일 표기는 "june 30" + 연도 열 머리) — 당기 → 전기 순서가 관행. 머리말에 두 연도가 그 순서로 나올 때만
      const yC = periodEnd.slice(0, 4), yP = priorEnd.slice(0, 4);
      const iC = cf.text.indexOf(yC), iP = cf.text.indexOf(yP);
      const cfDates = iC >= 0 && iP >= 0 ? (iC < iP ? [periodEnd, priorEnd] : [priorEnd, periodEnd]) : [];
      if (bsDates.length < 2 || cfDates.length !== 2) continue;
      // 재무상태표 줄 값: 열마다 [금액, 비율%] 쌍인 보고서(TSM) — 값 개수가 열 수의 2배면 짝수 자리만
      // 주석 번호 열이 있는 표는 값이 하나 많은 줄의 첫 값(번호)을 뺀다
      const fix = (rows: SixKRow[], n: number, noteCol: boolean) =>
        rows.map((r) => ({ ...r, vals: r.vals.length === 2 * n ? r.vals.filter((_, k) => k % 2 === 0) : noteCol && r.vals.length === n + 1 ? r.vals.slice(1) : r.vals })).filter((r) => r.vals.length === n);
      const { labels, parents } = await filingLabels(cikN, recent); // 라벨 파일 조회 실패는 그대로 던진다(호출자가 경고로)
      if (!labels.size) return null;
      // 본표 밖 표 — 머리(앞 2천 자)에 기준일·연말이 둘 다 있는 표의 줄
      const bsNotes: { dates: string[]; rows: SixKRow[] }[] = [];
      const bsNotes1: { dates: string[]; rows: SixKRow[] }[] = [];
      for (const t of html.match(/<table\b[\s\S]*?<\/table>/gi) ?? []) {
        const plain = decode(t).toLowerCase();
        const ds = headerDates(plain.slice(0, 2_000), [periodEnd, fyEnd, priorEnd]);
        // 기준일 열 하나뿐인 표(연말 열 없음)는 따로 — 연말 확인을 못 하므로 기준 줄 확인을 거쳐서만 쓴다(bsNotes1)
        const single = ds.length === 1 && ds[0] === periodEnd;
        if (!single && (!ds.includes(periodEnd) || !ds.includes(fyEnd))) continue;
        const rows: SixKRow[] = [];
        for (const tr of t.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
          const cells = (tr.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) ?? []).map(decode).filter((c) => c !== "" && c !== "$");
          const label = cells.find((c) => /[A-Za-z]/.test(c));
          if (!label) continue;
          const vals = cells.slice(cells.indexOf(label) + 1).map(parseNum).filter((v): v is number => v != null);
          if (vals.length) rows.push({ label: normLabel(label), vals });
        }
        (single ? bsNotes1 : bsNotes).push({ dates: ds, rows: fix(rows, ds.length, /\bnote\b/i.test(plain.slice(0, 1_500))) });
      }
      return { source: `6-K ${recent.accessionNumber[i]} ${d.name}`, unit, bsDates, cfDates, bs: fix(bs.rows, bsDates.length, bs.noteCol), cf: fix(cf.rows, 2, cf.noteCol), labels, parents, loose: false, bsNotes, bsNotes1 };
    }
  }
  if (errs.length) throw new Error(`6-K 분기 재무제표 조회 실패 — ${errs.join(" · ")}`);
  return null;
}

/**
 * 개념의 6-K 값(XBRL 부호, 원통화 = 표시값 × 단위) — 라벨이 정확히 같은 줄이 하나일 때만. 같은 라벨이 일반·부호 반전 양쪽에 있으면
 * 부호를 정할 수 없어 null(추측 금지)
 */
/**
 * 본표에 없는 줄을 본표 밖 표(주석)에서 — 라벨이 같고 그 표의 연말 열이 check(연말 값) 를 통과하는 줄이 표 전체에서 값 하나로 모일 때만.
 * 결과는 본표 열 순서(bsDates)에 맞춘 값(그 표에 없는 날짜는 NaN). 부호 반전 라벨은 반전
 */
export function sixKNoteValueOf(st: SixKStatements, concept: string, fyEnd: string, check: (fyV: number) => boolean): number[] | null {
  const ls = st.labels.get(concept);
  if (!ls || !st.bsNotes?.length) return null;
  const found = new Map<string, number[]>();
  for (const t of st.bsNotes) {
    const iF = t.dates.indexOf(fyEnd);
    if (iF < 0) continue;
    for (const r of t.rows) {
      const p = ls.pos.has(r.label), n = ls.neg.has(r.label);
      if (!p && !n) continue;
      for (const sg of p && n ? [1, -1] : [n ? -1 : 1]) {
        const v = r.vals.map((x) => Math.round(sg * x * st.unit));
        if (!check(v[iF])) continue;
        const aligned = st.bsDates.map((d) => { const k = t.dates.indexOf(d); return k >= 0 ? v[k] : NaN; });
        found.set(aligned.map(String).join("|"), aligned);
      }
    }
  }
  return found.size === 1 ? [...found.values()][0] : null;
}

/** 20-F 재무상태표 본표 줄인가 — 표시 구조 부모가 자산·부채·자본 구역 머리(유동자산·비유동부채·자본 등)일 때 */
export function sixKOnBsFace(st: SixKStatements, concept: string): boolean {
  const heads = new Set(["assets", "current assets", "non current assets", "noncurrent assets", "liabilities", "current liabilities", "non current liabilities", "noncurrent liabilities", "equity", "stockholders equity", "shareholders equity", "liabilities and equity", "equity and liabilities"]);
  for (const pc of st.parents.get(concept) ?? []) for (const l of [...(st.labels.get(pc)?.pos ?? [])]) if (heads.has(l)) return true;
  return false;
}

/** 그 개념의 라벨과 이름이 같은 줄이 보고서 표에 하나라도 있는가(없음 판정용 — 개념이 20-F 라벨 파일에 없으면 판정 불가로 null) */
export function sixKHasRow(st: SixKStatements, concept: string, sec: "bs" | "cf"): boolean | null {
  const ls = st.labels.get(concept);
  if (!ls) return null;
  const all = [...ls.pos, ...ls.neg];
  const rows = st[sec].filter((r) => all.includes(r.label) || (!!st.loose && all.some((l) => l.length > 3 && r.label.endsWith(` ${l}`))));
  // 머리 줄을 아는 표(형식 1)는 개념의 표시 구조 부모 구역에 있는 줄만 — SPOT 비유동 "Exchangeable notes"(연말 0)는 분기 본표에 유동부채 구역에만 있다
  const pl = new Set<string>();
  for (const pc of st.parents.get(concept) ?? []) for (const x of [...(st.labels.get(pc)?.pos ?? []), ...(st.labels.get(pc)?.neg ?? [])]) pl.add(x);
  if (pl.size && rows.length && rows.every((r) => r.parent)) return rows.some((r) => pl.has(r.parent!));
  return rows.length > 0;
}

export function sixKValueOf(st: SixKStatements, concept: string, sec: "bs" | "cf", check?: (vals: number[]) => boolean): number[] | null {
  const ls = st.labels.get(concept);
  if (!ls) return null;
  // 슬라이드 형식은 줄 이름 앞에 머리말이 붙을 수 있어 끝부분이 라벨과 같은 줄도(단어 경계)
  const tail = (r: SixKRow, set: Set<string>) => set.has(r.label) || (!!st.loose && [...set].some((l) => l.length > 3 && r.label.endsWith(` ${l}`)));
  const val = (r: SixKRow) => {
    const p = tail(r, ls.pos), n = tail(r, ls.neg);
    if (!(p && n)) return r.vals.map((v) => Math.round((n ? -v : v) * st.unit));
    // 같은 이름이 일반·부호 반전 라벨 양쪽에 있으면(SPOT "Treasury shares") 부호를 라벨로 못 정한다 — 재무상태표는 연말 열이 SEC 값과 정확히
    // 맞는 부호가 하나일 때만(호출부 확인 함수), 그 밖은 null(추측 금지)
    if (!check) return null;
    const cands = [1, -1].map((sg) => r.vals.map((v) => Math.round(sg * v * st.unit))).filter((v) => check(v));
    return cands.length === 1 ? cands[0] : null;
  };
  let rows = st[sec].filter((r) => tail(r, ls.pos) || tail(r, ls.neg));
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
