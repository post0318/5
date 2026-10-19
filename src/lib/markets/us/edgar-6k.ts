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
/** q3 = 흐름 표의 당기 3개월 열 값(표에 3개월·누적 열이 같이 있을 때 — 당기 누적 열 자리 확인용, verifyPrior) */
export interface SixKRow { label: string; vals: number[]; parent?: string; q3?: number }
/** 흐름 표 열 구성 — q1: 1분기(누적 = 3개월 열), q3: 3개월 열과 누적 열이 같이 있음(q3 값 있음), ytd: 누적 열만 */
export type FlowMode = "q1" | "q3" | "ytd";
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
  /** 손익계산서 누적 열(isDates 순서 — 당기·전기 누적 종료일). 못 읽으면 없음(손익 LTM 은 그 6-K 로 만들지 않음 — 2026-10-17 ASML 6-K 반영) */
  is?: SixKRow[];
  isDates?: string[];
  isMode?: FlowMode;
  cfMode?: FlowMode;
  /** 손익계산서를 못 쓰거나 일부 줄을 뺀 사유(열 기간 판정 불가·전기 누적 확인 실패 — verifyIs) */
  isWhy?: string;
  /** 현금흐름표 줄을 뺀 사유(전기 누적 확인 실패 — verifyPrior) */
  cfWhy?: string;
  /** 흐름 표 전기 누적 열을 확인한 1년 전 같은 분기 보고서(출처) */
  priorChecked?: string;
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
/** 라벨에서 지우는 괄호 약어 — 줄 이름의 일부가 아니라 덧붙인 표기만(이름이 같은 다른 줄을 합치지 않게 목록으로 한정) */
const KNOWN_ABBR_RE = /\s*\((?:R&D|SG&A|G&A|S&M)\)/g;
/** 라벨 정규화 — 소문자, 주석 번호 "(Note 19)" 제거, 구두점·공백 정리 */
export const normLabel = (s: string) =>
  // 괄호 영문 약어 중 알려진 비용 줄 약어("(R&D)"·"(SG&A)" 등)만 표기일 뿐이라 뺀다 — ASML 20-F 「Research and development (R&D) costs」 ↔ 6-K
  // 「Research and development costs」. 예전엔 괄호 대문자 약어를 모두 지워 「(A)」「(USD)」처럼 줄을 가르는 표기까지 사라졌다(독립 감사 2026-10-20 ③)
  s.replace(KNOWN_ABBR_RE, "").toLowerCase().replace(/\((?:notes?|note)[^)]*\)/g, "")
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

/**
 * 표 한 줄의 칸 글자 — 빈 칸·"$" 칸 제외. 괄호 음수가 칸 둘로 나뉜 보고서("(50,051,310" | ")" — TSM 2025 2분기 재무보고서)는 한 칸으로 합친다.
 * 예전엔 닫는 괄호 칸이 따로 버려져 "(50,051,310" 이 양수로 읽혔다(1년 전 같은 분기 6-K 전기 누적 대조로 발견, 2026-10-20)
 */
function rowCells(tr: string): string[] {
  const raw = (tr.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) ?? []).map(decode).filter((c) => c !== "" && c !== "$");
  const out: string[] = [];
  for (let k = 0; k < raw.length; k++) {
    const c = raw[k];
    if (c === "(" && /^\$?\s*[\d,]+(?:\.\d+)?$/.test(raw[k + 1] ?? "") && /^\)/.test(raw[k + 2] ?? "")) { out.push(`(${raw[k + 1]})`); k += 2; continue; }
    if (/^\(\s*\$?\s*[\d,]+(?:\.\d+)?$/.test(c) && /^\)/.test(raw[k + 1] ?? "")) { out.push(`${c})`); k += 1; continue; }
    out.push(c);
  }
  return out;
}

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
    // 숫자 문자 참조(둥근 따옴표 &#8217; 등)도 푼다 — 예전엔 "&#8217;" 가 "8217" 로 남아 "Total shareholders’ equity" 줄이 6-K 와 대응되지 않았다(2026-10-17)
    const txt = m[3].replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
    (/^negated/.test(m[2]) ? s.neg : s.pos).add(normLabel(txt));
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
function sectionRows(html: string, head: RegExp, mustHave: RegExp, end: RegExp): { rows: SixKRow[]; text: string; noteCol: boolean; head: string[][] } | null {
  for (let m: RegExpExecArray | null, re = new RegExp(head.source, "gi"); (m = re.exec(html)); ) {
    const rest = html.slice(m.index);
    const e = rest.slice(200).search(end);
    const sec = e < 0 ? rest.slice(0, 400_000) : rest.slice(0, e + 200);
    const plain = decode(sec);
    if (!mustHave.test(plain)) continue; // 목차의 같은 제목은 건너뜀(서식 코드가 길어 구간 전체를 해독해 본다)
    const rows: SixKRow[] = [];
    // 표 머리 줄(첫 금액 줄 전 — 기간·연도 머리, 주석 번호 "Note" 줄 포함). 손익계산서 열 기간을 머리에서 직접 읽는다(isColumns)
    const headRows: string[][] = [];
    let parent: string | undefined;
    for (const tr of sec.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
      const cells = rowCells(tr);
      const label = cells.find((c) => /[A-Za-z]/.test(c));
      const firstValue = !!label && normLabel(label) !== "note" && cells.slice(cells.indexOf(label) + 1).some((c) => parseNum(c) != null);
      if (!rows.length && !firstValue && cells.length) headRows.push(cells);
      if (!label) continue;
      const vals = cells.slice(cells.indexOf(label) + 1).map(parseNum).filter((v): v is number => v != null);
      if (vals.length) rows.push({ label: normLabel(label), vals, parent });
      else parent = normLabel(label);
    }
    // 금액 앞 주석 번호 열(SPOT "Note" — 줄마다 "11" 같은 번호, 여러 개면 "7, 8" 이라 숫자로 안 읽힘): 머리에 note 칸이 있으면 표시해 둔다
    return { rows, text: plain.slice(0, 3_000).toLowerCase(), noteCol: rows.some((r) => r.label === "note") || /\bnote\b/i.test(plain.slice(0, 1_500)), head: headRows };
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
    // 값 없이 끝난 줄 이름 조각은 다음 조각과 잇는다("Total liabilities and shareholders’" + "equity" — 두 칸 띄움으로 끊긴 줄, ASML 2026 3분기)
    else if (/[A-Za-z]/.test(tok) && cur && !cur.vals.length) cur.label = normLabel(`${cur.label} ${tok}`);
    else if (/[A-Za-z]/.test(tok)) rows.push((cur = { label: normLabel(tok), vals: [] }));
    else cur = null;
  }
  return rows.filter((r) => r.vals.length === n);
}
/** 슬라이드 열 4개(3개월 2 + 누적 2)면 당기 3개월 열 = 앞 두 열 중 날짜가 분기말인 것. 1분기(열 2개)는 없음 */
function slideQ3(d: string[], cols: number[], periodEnd: string): number | null {
  if (d.length !== 4 || cols.join() !== "2,3") return null;
  const k = [0, 1].filter((x) => d[x] === periodEnd);
  return k.length === 1 ? k[0] : null;
}
function slideStatements(html: string, periodEnd: string, fyEnd: string, priorEnd: string, withIs: boolean): Omit<SixKStatements, "source" | "labels" | "parents"> | null {
  const texts = [...html.matchAll(/<FONT[^>]*color:\s*white[^>]*>([\s\S]*?)<\/FONT>/gi)].map((m) =>
    m[1].replace(/<[^>]+>/g, " ").replace(/&#8212;|&mdash;/g, "—").replace(/&#8364;|&euro;/g, "€").replace(/&#8217;|&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/&nbsp;|&#160;/g, " ").replace(/[\r\n\t]/g, " "));
  if (texts.length < 3) return null;
  const unitOf = (t: string) => (/in millions/i.test(t) ? 1e6 : /in thousands/i.test(t) ? 1e3 : null);
  // 재무상태표 — 기준일·연말·1년 전이 다 있는 슬라이드 중 열이 가장 많은 것(분기별 요약)
  const bsCands = texts.filter((t) => /US GAAP/.test(t) && /total assets/i.test(t) && unitOf(t)).map((t) => ({ t, d: slideDates(t) }))
    .filter((x) => x.d.includes(periodEnd) && x.d.includes(fyEnd)).sort((a, b) => b.d.length - a.d.length);
  // 현금흐름표 — 누적 열
  let cf: { t: string; d: string[]; cols: number[]; q3: number | null } | null = null;
  for (const t of texts) {
    if (!/US GAAP/.test(t) || !/operating activities/i.test(t) || !/months ended/i.test(t) || !unitOf(t)) continue;
    const d = slideDates(t);
    const cols = d.length === 4 && /(six|nine) months ended/i.test(t) ? [2, 3] : d.length === 2 && !/(six|nine) months ended/i.test(t) ? [0, 1] : null;
    if (!cols || !cols.every((k) => d[k] === periodEnd || d[k] === priorEnd) || d[cols[0]] === d[cols[1]]) continue;
    cf = { t, d, cols, q3: slideQ3(d, cols, periodEnd) };
    break;
  }
  // 손익계산서 — 현금흐름표와 같은 누적 열 규칙(재무상태표·현금흐름표 슬라이드 제외)
  let is: { t: string; d: string[]; cols: number[]; q3: number | null } | null = null;
  for (const t of texts) {
    if (!/US GAAP/.test(t) || !/net income/i.test(t) || !/gross profit|total net sales/i.test(t) || /operating activities|total assets/i.test(t) || !/months ended/i.test(t) || !unitOf(t)) continue;
    const d = slideDates(t);
    const cols = d.length === 4 && /(six|nine) months ended/i.test(t) ? [2, 3] : d.length === 2 && !/(six|nine) months ended/i.test(t) ? [0, 1] : null;
    if (!cols || !cols.every((k) => d[k] === periodEnd || d[k] === priorEnd) || d[cols[0]] === d[cols[1]]) continue;
    is = { t, d, cols, q3: slideQ3(d, cols, periodEnd) };
    break;
  }
  const bs = bsCands[0];
  if (!bs || !cf || unitOf(bs.t) !== unitOf(cf.t)) return null;
  const unit = unitOf(bs.t)!;
  const cfRows = slideRows(cf.t, cf.d.length).map((r) => ({ ...r, vals: cf!.cols.map((k) => r.vals[k]), ...(cf!.q3 != null ? { q3: r.vals[cf!.q3] } : {}) }));
  const isPart = withIs && is && unitOf(is.t) === unit
    ? { is: slideRows(is.t, is.d.length).map((r) => ({ ...r, vals: is!.cols.map((k) => r.vals[k]), ...(is!.q3 != null ? { q3: r.vals[is!.q3] } : {}) })), isDates: is.cols.map((k) => is!.d[k]), isMode: (is.q3 != null ? "q3" : "q1") as FlowMode }
    : {};
  // 재무상태표가 자산·부채와 자본 두 덩어리 글자로 나뉜 슬라이드 — 날짜 머리가 똑같은 덩어리(같은 단위)를 이어 읽는다(ASML 자본 총계·부채와 자본 총계)
  const sameHead = texts.filter((t) => t !== bs.t && /US GAAP/.test(t) && unitOf(t) === unit && /shareholders|equity|liabilities/i.test(t) && !/operating activities|months ended/i.test(t) && slideDates(t).join("|") === bs.d.join("|"));
  const bsRows = [bs.t, ...sameHead].flatMap((t) => slideRows(t, bs.d.length));
  return { unit, bsDates: bs.d, cfDates: cf.cols.map((k) => cf!.d[k]), bs: bsRows, cf: cfRows, cfMode: cf.q3 != null ? "q3" : "q1", ...isPart, loose: true };
}

/**
 * 손익계산서 표 머리에서 열 기간을 직접 읽는다(독립 감사 2026-10-20 ② — 예전엔 "구간 앞 1,500자의 연도 4개"와 누적 열 [2,3] 자리를 가정했다).
 * 기간 칸("Three/Six/Nine Months Ended …")을 순서대로, 연도 줄(4자리 연도 칸)을 순서대로 읽어 기간 칸 하나가 연도 열 몇 개를 덮는지 정한다
 * (연도 수 ÷ 기간 수 — 나누어떨어지지 않으면 판정 불가). 당기 누적 = 개월 수가 (사업연도말 → 분기말)이고 연도가 분기말 연도인 열 하나,
 * 전기 누적 = 같은 개월 수·1년 전 연도인 열 하나. 못 정하면 사유(빈칸 — 자리를 추측하지 않는다).
 */
function isColumns(head: string[][], title: string, periodEnd: string, priorEnd: string, fyEnd: string): { cols: [number, number]; n: number; q3: number | null; mode: FlowMode } | { why: string } {
  const months = Math.round((Date.parse(periodEnd) - Date.parse(fyEnd)) / (30.44 * 864e5));
  if (![3, 6, 9].includes(months)) return { why: `분기말 ${periodEnd} 이 사업연도말 ${fyEnd} 뒤 3·6·9개월이 아님` };
  const MW: Record<string, number> = { three: 3, six: 6, nine: 9, twelve: 12, "3": 3, "6": 6, "9": 9, "12": 12 };
  const periodOf = (c: string): number | null => {
    const m = /\b(three|six|nine|twelve|3|6|9|12)[\s-]+months?\b/i.exec(c);
    if (m) return MW[m[1].toLowerCase()];
    if (/\bquarter ended\b/i.test(c)) return 3;
    if (/\b(?:fiscal )?year ended\b/i.test(c)) return 12;
    return null;
  };
  const yearsIn = (c: string) => [...c.matchAll(/\b((?:19|20)\d{2})\b/g)].map((m) => m[1]);
  const pCells = head.flat().filter((c) => periodOf(c) != null);
  const periods = pCells.map((c) => periodOf(c)!);
  // 연도 줄 = 칸이 모두 연도(주석 번호 머리 "Note" 칸은 무시)인 줄 중 연도가 가장 많은 줄. 없으면 기간 칸마다 연도가 하나씩 든 형식
  const yRows = head.map((r) => r.filter((c) => !/^note$/i.test(c))).filter((r) => r.length && r.every((c) => /^(?:19|20)\d{2}$/.test(c)));
  let years = yRows.sort((a, b) => b.length - a.length)[0] ?? [];
  let span: number;
  if (years.length) {
    if (!periods.length) {
      // 기간 칸이 없는 표 — 1분기 보고서(3개월 열 둘)이고 제목·머리에 "three months" 가 있을 때만
      if (!(months === 3 && years.length === 2 && /three months/i.test(`${title} ${head.flat().join(" ")}`))) return { why: "손익계산서 머리에 기간(3·6·9개월) 칸 없음" };
      periods.push(3);
    }
    if (years.length % periods.length) return { why: `손익계산서 머리 연도 ${years.length}개가 기간 칸 ${periods.length}개로 나뉘지 않음` };
    span = years.length / periods.length;
  } else {
    years = pCells.map((c) => yearsIn(c)).filter((y) => y.length === 1).map((y) => y[0]);
    if (!years.length || years.length !== pCells.length) return { why: "손익계산서 머리에 연도 줄 없음" };
    span = 1;
  }
  const colMonths = years.map((_, k) => periods[Math.floor(k / span)]);
  const pick = (y: string) => { const ks = years.map((yy, k) => (yy === y && colMonths[k] === months ? k : -1)).filter((k) => k >= 0); return ks.length === 1 ? ks[0] : -1; };
  const iC = pick(periodEnd.slice(0, 4)), iP = pick(priorEnd.slice(0, 4));
  if (iC < 0 || iP < 0) return { why: `손익계산서 머리에서 ${months}개월 누적 당기·전기 열을 하나씩 못 찾음(머리: ${head.flat().join(" | ").slice(0, 120)})` };
  // 당기 3개월 열(누적 열 자리 확인용) — 1분기는 누적 = 3개월, 3개월 열이 아예 없으면 누적 열만인 표
  if (months === 3) return { cols: [iC, iP], n: years.length, q3: null, mode: "q1" };
  const k3 = years.map((yy, k) => (yy === periodEnd.slice(0, 4) && colMonths[k] === 3 ? k : -1)).filter((k) => k >= 0);
  if (k3.length === 1) return { cols: [iC, iP], n: years.length, q3: k3[0], mode: "q3" };
  if (!colMonths.includes(3)) return { cols: [iC, iP], n: years.length, q3: null, mode: "ytd" };
  return { why: `손익·현금흐름 머리에서 당기 3개월 열을 하나로 못 정함(머리: ${head.flat().join(" | ").slice(0, 120)})` };
}

/** 구간 머리말에 나온 날짜(ISO) — 등장 순서(열 순서) */
function headerDates(text: string, candidates: string[]): string[] {
  return candidates.map((d) => ({ d, i: text.indexOf(longDate(d)) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i).map((x) => x.d);
}

/**
 * 분기말 periodEnd 의 6-K 연결재무보고서. fyEnd = 최근 사업연도말, priorEnd = 1년 전 같은 분기말(재무상태표 3번째 열·현금흐름 전년 누적).
 * 없거나(보고서 미제출) 재무제표를 읽을 수 없으면(그림 — ASML) null
 */
export async function sixKStatements(
  cik: string, recent: RecentFilings | null, periodEnd: string, fyEnd: string, priorEnd: string,
  /** withIs — 손익계산서도 읽는다(야후보다 앞선 분기 LTM 용) */
  opts: { withIs?: boolean } = {},
): Promise<SixKStatements | null> {
  const st = await findSixK(cik, recent, periodEnd, fyEnd, priorEnd, !!opts.withIs);
  return st ? verifyPrior(st, cik, recent, periodEnd, fyEnd, priorEnd) : null;
}

/** 한 달 말에서 12개월 전 달 말 */
const back12 = (d: string) => { const x = new Date(`${d}T00:00:00Z`); return new Date(Date.UTC(x.getUTCFullYear() - 1, x.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); };

/** 비교할 줄 수 문턱 — 비교 가능 줄의 과반이면서 최소 3줄, 비교 가능 줄이 5줄 미만이면 전부 일치(적은 줄 표의 우연 통과 방지, 재감사 2026-10-20) */
const tableOk = (matched: number, compared: number) => matched >= 3 && (compared < 5 ? matched === compared : matched * 2 > compared);
/** 한 달 말에서 3개월 전 달 말 */
const back3 = (d: string) => { const x = new Date(`${d}T00:00:00Z`); return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() - 2, 0)).toISOString().slice(0, 10); };

/**
 * 흐름 표(손익계산서·현금흐름표) 열 확인 — 1년 전 같은 분기 6-K·직전 분기 6-K(SEC 제출 보고서)로 표 단위 확인(독립 감사
 * 2026-10-20 ②: 흐름 표엔 재무상태표의 "연말 열 = SEC" 같은 자리 확인이 없었다). 20-F 회사는 분기 XBRL 이 없어 전년 같은 분기 누적의 SEC 원천은
 * 그 6-K 뿐이다. 열을 잘못 읽었으면(당기·전기 뒤바뀜·3개월 열) 값이 대부분 어긋나 표가 걸러진다. 확인된 표는 줄마다 이번 보고서의 두 열을 쓴다.
 * 1년 전 보고서를 못 찾거나 그 표를 못 읽으면 그 표 전체를 쓰지 않는다(isWhy·cfWhy). 조회 실패는 그대로 던진다(호출자가 경고로)
 */
async function verifyPrior(st: SixKStatements, cik: string, recent: RecentFilings | null, periodEnd: string, fyEnd: string, priorEnd: string): Promise<SixKStatements> {
  const withIs = !!st.isDates;
  const prev = await findSixK(cik, recent, priorEnd, back12(fyEnd), back12(priorEnd), withIs);
  // 직전 분기 보고서(같은 사업연도) — 당기 누적 열 자리 확인용. 3개월 열이 있는 표(q3)가 있을 때만 받는다
  const prevQEnd = back3(periodEnd);
  const needQ = st.cfMode === "q3" || (withIs && st.isMode === "q3");
  const prevQ = needQ && prevQEnd > fyEnd ? await findSixK(cik, recent, prevQEnd, fyEnd, back12(prevQEnd), withIs) : null;
  // 슬라이드 글자 형식은 구간 첫 줄 이름 앞에 열 머리(날짜·연도)가 붙는다 — 마지막 연도 뒤만 비교(해마다 날짜가 달라 같은 줄이 갈리지 않게)
  // 부호 표기만 다른 이름("operating income (loss)" ↔ "operating income", "net (loss)/income" ↔ "net income", "(increase)/decrease" ↔ "increase",
  // "income tax (expense)/benefit")은 같은 줄로 — 손익 부호에 따라 해마다 붙었다 빠진다
  const pair = (t: string) => t.replace(/\bcost\b/g, "costs").replace(/\b(?:costs income|income costs)\b/g, "income costs")
    .replace(/\b(?:income loss|loss income)\b/g, "income").replace(/\b(?:gain loss|loss gain)\b/g, "gain")
    .replace(/\b(?:benefit expense|expense benefit)\b/g, "expense").replace(/\b(?:increase decrease|decrease increase)\b/g, "increase")
    .replace(/^net cash flows (?:(?:from|used in|provided by|generated by) )+/, "net cash flows ");
  // 표 머리 줄(기간·날짜 — "three months ended june 30")이 부모로 잡힌 줄은 부모를 비교하지 않는다(분기마다 날짜가 달라 같은 줄이 갈린다)
  const headLike = (p: string) => /\bmonths? ended\b|\b(?:year|quarter|weeks?) ended\b|\b(?:19|20)\d{2}\b|\bunaudited\b/.test(p);
  const key = (r: SixKRow, loose?: boolean) => `${pair(loose ? r.label.replace(/^.*\b(?:19|20)\d{2} /, "") : r.label)}|${r.parent && !headLike(r.parent) ? pair(r.parent) : ""}`;
  const counterpart = (r: SixKRow, other: SixKStatements, rows: SixKRow[]) => { const m = rows.filter((x) => key(x, other.loose) === key(r, st.loose)); return m.length === 1 ? m[0] : null; };
  /**
   * 표 단위 확인 두 가지(조정자 지시·재감사 2026-10-20) — 둘 다 통과해야 그 표 모든 줄에 이번 보고서의 당기·전기 열을 쓴다(전기 누적 = 회사가 이번
   * 보고서 기준으로 다시 나눈 값, 한국 LTM 정정본 원칙). 이름·묶음이 바뀐 줄도 남는다. 하나라도 안 되면 그 표 전체를 쓰지 않는다(빈칸 + 사유).
   *  (가) 전기 열 = 1년 전 같은 분기 6-K 의 당기 누적
   *  (나) 당기 열: 3개월·누적 열이 같이 있는 표는 「당기 누적 − 직전 분기 6-K 당기 누적 = 당기 3개월」(반올림 범위 판정 — 칸 ± 표시 단위 절반끼리 겹치면 일치, 정확 일치가 0 줄이면 보류). 1분기 표는 누적 = 3개월 열이라 확인 없음,
   *       누적 열만 있는 표(3개월 열 없음 — TSM 현금흐름표)는 열이 둘뿐이라 당기 열이 틀리면 (가)에서 걸린다.
   *  (가)만으로는 두 보고서가 같은 종류로 틀린 경우(둘 다 3개월 열을 누적으로 읽음)와 당기 열만 틀린 경우를 못 잡는다
   */
  const check = (rows: SixKRow[], dates: string[], mode: FlowMode | undefined, sec: "is" | "cf", what: string) => {
    const iC = dates.indexOf(periodEnd), iP = dates.indexOf(priorEnd);
    const prows = prev?.[sec], pdates = sec === "is" ? prev?.isDates : prev?.cfDates, jC = pdates?.indexOf(priorEnd) ?? -1;
    if (!prev) return { rows: [] as SixKRow[], why: `1년 전 같은 분기(${priorEnd}) 6-K 재무제표 없음 — ${what} 전기 누적 열 확인 불가` };
    if (!prows || jC < 0 || iP < 0 || iC < 0) return { rows: [] as SixKRow[], why: `1년 전 같은 분기 6-K(${prev.source}) ${what}를 못 읽음 — 전기 누적 열 확인 불가` };
    let compared = 0, matched = 0;
    const diff: string[] = [];
    for (const r of rows) {
      const m = counterpart(r, prev, prows);
      if (!m) continue;
      compared++;
      if (Math.round(m.vals[jC] * prev.unit) === Math.round(r.vals[iP] * st.unit)) matched++;
      else diff.push(r.label);
    }
    if (!tableOk(matched, compared))
      return { rows: [] as SixKRow[], why: `${what} 전기 누적 열 확인 실패 — 1년 전 6-K(${prev.source}) 당기 누적과 같은 줄 ${matched}/${compared}${diff.length ? `, 다른 줄: ${diff.slice(0, 6).join(", ")}` : ""}` };
    if (mode !== "q3") return { rows, why: undefined };
    // (나) 당기 누적 열 자리
    const qrows = prevQ?.[sec], qdates = sec === "is" ? prevQ?.isDates : prevQ?.cfDates, kC = qdates?.indexOf(prevQEnd) ?? -1;
    if (!prevQ || !qrows || kC < 0) return { rows: [] as SixKRow[], why: `직전 분기(${prevQEnd}) 6-K ${what}를 못 찾음 — 당기 누적 열 확인 불가` };
    let c2 = 0, m2 = 0, exact = 0;
    const diff2: string[] = [];
    for (const r of rows) {
      const m = counterpart(r, prevQ, qrows);
      if (!m || r.q3 == null) continue;
      c2++;
      // 반올림 범위 판정(검증기와 같은 원칙 — 허용치 아님): 각 칸은 표시 단위 u 로 반올림해 실린 값이라 참값은 칸 ± u/2. 「누적 − 직전 누적」의
      // 범위(± u)와 「3개월」 칸 범위(± u/2)가 겹치면 범위 일치, 차가 정확히 0 이면 정확 일치(ASML 769.1 − 506.3 = 262.8 vs 262.9 는 범위 일치).
      // 이 등식은 열 자리를 가르는 데만 쓴다. 값은 칸 그대로
      const dec = Math.max(...[r.vals[iC], m.vals[kC], r.q3].map((v) => (String(v).split(".")[1] ?? "").length));
      const d = Math.round((r.vals[iC] - m.vals[kC] - r.q3) * 10 ** dec);
      if (st.unit === prevQ.unit && d === 0) { m2++; exact++; }
      else if (st.unit === prevQ.unit && Math.abs(d) <= 1.5) m2++;      else diff2.push(r.label);
    }
    if (!tableOk(m2, c2))
      return { rows: [] as SixKRow[], why: `${what} 당기 누적 열 확인 실패 — 당기 누적 − 직전 분기 6-K(${prevQ.source}) 누적 = 당기 3개월인 줄 ${m2}/${c2}(정확 ${exact})${diff2.length ? `, 다른 줄: ${diff2.slice(0, 6).join(", ")}` : ""}` };
    // 전부 반올림 범위로만 맞으면(정확 일치 0) 판정 보류 — 열 자리를 확정할 근거가 약하다
    if (!exact) return { rows: [] as SixKRow[], why: `${what} 당기 누적 열 판정 보류 — 직전 분기 6-K(${prevQ.source})와 반올림 범위로만 맞음(${m2}/${c2}, 정확 일치 0)` };
    return { rows, why: undefined };
  };
  const cf = check(st.cf, st.cfDates, st.cfMode, "cf", "현금흐름표");
  const out: SixKStatements = { ...st, cf: cf.rows, ...(cf.why ? { cfWhy: cf.why } : {}), ...(prev ? { priorChecked: prev.source } : {}) };
  if (st.is && st.isDates) {
    const is = check(st.is, st.isDates, st.isMode, "is", "손익계산서");
    if (!is.rows.length) return { ...out, is: undefined, isDates: undefined, isWhy: is.why };
    return { ...out, is: is.rows, ...(is.why ? { isWhy: is.why } : {}) };
  }
  return out;
}

async function findSixK(cik: string, recent: RecentFilings | null, periodEnd: string, fyEnd: string, priorEnd: string, withIs: boolean): Promise<SixKStatements | null> {
  if (!recent) return null;
  const cikN = Number(cik);
  const lo = periodEnd, hi = new Date(Date.parse(periodEnd) + 120 * 864e5).toISOString().slice(0, 10);
  const cands: number[] = [];
  // 조회 실패 기록 — 값을 못 찾고 끝났는데 실패가 있었으면 던진다(재감사 12차 ③: null 로 삼키면 "6-K 없음"과 구분되지 않아 LTM 값이 조용히 사라졌다)
  const errs: string[] = [];
  const failed = (what: string) => (e: unknown) => { errs.push(`${what}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160)); return null; };
  for (let i = 0; i < recent.form.length; i++) if (recent.form[i] === "6-K" && recent.filingDate[i] > lo && recent.filingDate[i] <= hi) cands.push(i);
  // 분기말에 가까운(먼저 낸) 보고서부터 24건 — 제출 목록은 최신순이라 예전엔 창 끝쪽 8건만 봐서, 6-K 를 자주 내는 회사(TSM 월 매출·이사회·
  // 월말 공시)는 분기 재무보고서가 창 안에 있어도 밀려나면 못 찾았다(TSM 2025 2분기 재무보고서 = 창 안 6-K 중 먼저 낸 순 9번째). 공시 원본은
  // 디스크 캐시(http.ts)라 이미 본 보고서는 다시 받지 않는다
  cands.sort((a, b) => recent.filingDate[a].localeCompare(recent.filingDate[b]) || a - b).splice(24);
  for (const i of cands) {
    const base = `https://www.sec.gov/Archives/edgar/data/${cikN}/${recent.accessionNumber[i].replace(/-/g, "")}`;
    const idx = await fetchJson<{ directory: { item: { name: string; size: string | number }[] } }>(`${base}/index.json`, OPT).catch(failed(`${recent.accessionNumber[i]} index`));
    const docs = (idx?.directory.item ?? []).filter((x) => /\.htm$/i.test(x.name) && !/-index/i.test(x.name) && Number(x.size) > 15_000).sort((a, b) => Number(b.size) - Number(a.size)).slice(0, 6);
    for (const d of docs) {
      const html = await fetchText(`${base}/${d.name}`, { ...OPT, timeoutMs: 60_000 }).catch(failed(`${recent.accessionNumber[i]} ${d.name}`));
      if (!html) continue;
      // 형식 2 — 슬라이드 그림 + 숨은 글자(Workiva, ASML "Financial Statements US GAAP")
      const sl = slideStatements(html, periodEnd, fyEnd, priorEnd, withIs);
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
      // 현금흐름 열 = 당기·전기 누적 — 표 머리의 기간·연도 칸에서 직접(isColumns, 손익계산서와 같은 규칙). 예전엔 구간 앞 글에서 두 연도가 나온
      // 순서로 정해 제목 연도가 섞이면 뒤바뀔 수 있었다(독립 감사 2026-10-20 ② — 같은 종류)
      const cfc = isColumns(cf.head, cf.text.slice(0, 600), periodEnd, priorEnd, fyEnd);
      if (bsDates.length < 2 || "why" in cfc) continue;
      const cfDates = [periodEnd, priorEnd];
      // 재무상태표 줄 값: 열마다 [금액, 비율%] 쌍인 보고서(TSM) — 값 개수가 열 수의 2배면 짝수 자리만
      // 주석 번호 열이 있는 표는 값이 하나 많은 줄의 첫 값(번호)을 뺀다
      const fix = (rows: SixKRow[], n: number, noteCol: boolean) =>
        rows.map((r) => ({ ...r, vals: r.vals.length === 2 * n ? r.vals.filter((_, k) => k % 2 === 0) : noteCol && r.vals.length === n + 1 ? r.vals.slice(1) : r.vals })).filter((r) => r.vals.length === n);
      const { labels, parents } = await filingLabels(cikN, recent); // 라벨 파일 조회 실패는 그대로 던진다(호출자가 경고로)
      if (!labels.size) return null;
      // 손익계산서(withIs 일 때만) — 열 기간은 표 머리에서 직접 읽는다(isColumns). 못 정하면 손익계산서 없음 + 사유(isWhy)
      let isPart: { is?: SixKRow[]; isDates?: string[]; isWhy?: string; isMode?: FlowMode } = {};
      const isSec = withIs ? sectionRows(html, /CONSOLIDATED STATEMENTS? OF (?:OPERATIONS|INCOME|PROFIT OR LOSS|COMPREHENSIVE INCOME)/, /(?:revenue|net sales)[\s\S]*(?:net (?:\(loss\)\/|loss\/)?income|net (?:\(loss\)|loss)|net profit|profit for the period)/i, /CONSOLIDATED (?:STATEMENTS? OF (?:COMPREHENSIVE|FINANCIAL POSITION|CHANGES IN|CASH FLOWS?)|BALANCE SHEETS?)/i) : null;
      if (withIs && !isSec) isPart = { isWhy: "6-K 에서 손익계산서 표를 못 찾음" };
      if (isSec) {
        const ic = isColumns(isSec.head, isSec.text.slice(0, 600), periodEnd, priorEnd, fyEnd);
        const isUnit = /in (?:\S+ )?thousands/.test(isSec.text) ? 1e3 : /in (?:\S+ )?millions/.test(isSec.text) ? 1e6 : 1;
        if ("why" in ic) isPart = { isWhy: ic.why };
        else if (isUnit !== unit) isPart = { isWhy: "손익계산서 금액 단위가 재무상태표와 다름" };
        else isPart = { is: fix(isSec.rows, ic.n, isSec.noteCol).map((r) => ({ ...r, vals: ic.cols.map((k) => r.vals[k]), ...(ic.q3 != null ? { q3: r.vals[ic.q3] } : {}) })), isDates: [periodEnd, priorEnd], isMode: ic.mode };
      }
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
          const cells = rowCells(tr);
          const label = cells.find((c) => /[A-Za-z]/.test(c));
          if (!label) continue;
          const vals = cells.slice(cells.indexOf(label) + 1).map(parseNum).filter((v): v is number => v != null);
          if (vals.length) rows.push({ label: normLabel(label), vals });
        }
        (single ? bsNotes1 : bsNotes).push({ dates: ds, rows: fix(rows, ds.length, /\bnote\b/i.test(plain.slice(0, 1_500))) });
      }
      return { source: `6-K ${recent.accessionNumber[i]} ${d.name}`, unit, bsDates, cfDates, bs: fix(bs.rows, bsDates.length, bs.noteCol), cf: fix(cf.rows, cfc.n, cf.noteCol).map((r) => ({ ...r, vals: cfc.cols.map((k) => r.vals[k]), ...(cfc.q3 != null ? { q3: r.vals[cfc.q3] } : {}) })), cfMode: cfc.mode, ...isPart, labels, parents, loose: false, bsNotes, bsNotes1 };
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
export function sixKHasRow(st: SixKStatements, concept: string, sec: "bs" | "cf" | "is"): boolean | null {
  const ls = st.labels.get(concept);
  if (!ls) return null;
  const all = [...ls.pos, ...ls.neg];
  const rows = (st[sec] ?? []).filter((r) => all.includes(r.label) || (!!st.loose && all.some((l) => l.length > 3 && r.label.endsWith(` ${l}`))));
  // 머리 줄을 아는 표(형식 1)는 개념의 표시 구조 부모 구역에 있는 줄만 — SPOT 비유동 "Exchangeable notes"(연말 0)는 분기 본표에 유동부채 구역에만 있다
  const pl = new Set<string>();
  for (const pc of st.parents.get(concept) ?? []) for (const x of [...(st.labels.get(pc)?.pos ?? []), ...(st.labels.get(pc)?.neg ?? [])]) pl.add(x);
  if (pl.size && rows.length && rows.every((r) => r.parent)) return rows.some((r) => pl.has(r.parent!));
  return rows.length > 0;
}

export function sixKValueOf(st: SixKStatements, concept: string, sec: "bs" | "cf" | "is", check?: (vals: number[]) => boolean): number[] | null {
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
  let rows = (st[sec] ?? []).filter((r) => tail(r, ls.pos) || tail(r, ls.neg));
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
