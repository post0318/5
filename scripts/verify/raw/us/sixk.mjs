/**
 * 20-F 회사의 분기 재무(설계 10 R-US7) — 6-K 연결재무보고서(HTML 표·Exhibit 99 슬라이드 아래 숨은 글자)를 문서 글자로 읽는다.
 * 옛 검증기 판독(sixKCfYtd·sixKBsHeaders·sixKRows·sixKBsCols — 앱 edgar-6k.ts 와 다른 방식)을 ①로 옮긴 것.
 *  - 줄 대응 = 최근 20-F 라벨 파일의 같은 이름 줄(라벨 → 개념). 숫자 단위 = 그 위치 앞 가장 가까운 「in thousands/millions」.
 *  - 기간 열: 흐름(손익·현금흐름) = 「… months ended <날짜들> … 연도 연도」 머리, 시점(재무상태표) = 날짜 머리.
 *  - 출력 = RawFact(placement.face=false, locator.source="6-K") — 원통화 그대로(환산은 ④). 같은 라벨·기간에 값이 갈리면 RawFact 를 내지 않고 ambiguous 로 기록.
 */
import { checkJson } from "../common/format.mjs";
import { fyKey, monthsBetween, normNum, rawFact, scaleInt } from "../common/rawfact.mjs";
import { parseLabels } from "../common/xbrl.mjs";

const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const snap = (y, mo, d) => (d >= 24 ? new Date(Date.UTC(y, mo + 1, 0)) : d <= 7 ? new Date(Date.UTC(y, mo, 0)) : new Date(Date.UTC(y, mo, d))).toISOString().slice(0, 10);

/** HTML → 소문자 글자(표 칸 ‖, 줄 바꿈 \n, 슬라이드 그림 §§) */
export function docText(html) {
  return html.replace(/<img\b/gi, " §§ <img").replace(/<\/t[dh]>/gi, " ‖ ").replace(/<\/tr>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&#8212;|&mdash;/g, "—").replace(/&#160;|&nbsp;| /g, " ").replace(/&amp;/g, "&").replace(/&#8217;|&rsquo;/g, "'").replace(/&#?[a-z0-9]+;/gi, " ").toLowerCase();
}
function bsHeaders(text) {
  const out = [];
  for (const m of text.matchAll(/((?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}[\s‖]*){2,})/g)) {
    const ds = [...m[1].matchAll(/([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/g)].map((x) => snap(Number(x[3]), MON.indexOf(x[1]), Number(x[2])));
    if (ds.length >= 2 && !ds.some((d) => d.includes("NaN"))) out.push({ i: m.index, dates: ds });
  }
  for (const m of text.matchAll(/((?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},\s*){2,})\s*\([^)]*\)\s*((?:(?:19|20)\d{2}\s+){2,})/g)) {
    const md = [...m[1].matchAll(/([a-z]{3})[a-z]*\.?\s+(\d{1,2}),/g)], ys = m[2].trim().split(/\s+/).map(Number);
    if (md.length === ys.length) out.push({ i: m.index, dates: md.map((x, k) => snap(ys[k], MON.indexOf(x[1]), Number(x[2]))) });
  }
  return out.sort((a, b) => a.i - b.i);
}
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function rowsFor(text, label) {
  const words = label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length < 2 && label.length < 6) return [];
  const re = new RegExp(`(?:^|\\n)[ \\t]*(?:\\(?[a-z]\\)\\s*)?${words.map(esc).join("[^a-z0-9]*(?:\\([^)]{0,30}\\)[^a-z0-9]*)?")}(?:[^a-z0-9(—\\-]*\\(notes?[^)]{0,20}\\))?[^a-z0-9(—\\-]*((?:[\\s‖$]*(?:\\(?[\\d,]+(?:\\.\\d+)?\\)?|—|-)(?![\\d,]))+)`, "g");
  const out = [];
  for (const m of text.matchAll(re)) {
    const body = m[1].replace(/^([\s‖$]*)\d{1,2}(?:,\s?\d{1,2})+(?=[\s‖])/, "$1");
    const toks = [...body.matchAll(/\(?[\d,]+(?:\.\d+)?\)?|—|-/g)].map((x) => x[0]).filter((t) => /\d/.test(t) || t === "—" || t === "-");
    if (!toks.length) continue;
    // 연도 머리 줄(「2026 2025」 — 자본변동표 머리·기간 머리)은 값 줄이 아니다. 표 금액은 천 단위 쉼표를 쓰므로 쉼표 없는 4자리 연도 토큰이 있으면 버린다
    if (toks.some((t) => /^\(?(19|20)\d\d\)?$/.test(t))) continue;
    out.push({ i: m.index, toks, vals: toks.map((t) => (t === "—" || t === "-" ? "0" : `${t.startsWith("(") ? "-" : ""}${t.replace(/[(),]/g, "")}`)) });
  }
  return out;
}
function unitAt(text, i) {
  const head = text.slice(Math.max(0, i - 60_000), i);
  const t = head.lastIndexOf("thousands"), mn = head.lastIndexOf("millions");
  if (t < 0 && mn < 0) return null; // 앞에 단위 표시가 없으면 단위 미확인(문서 다른 곳 단위를 가져오지 않는다 — 감사 10-16 U5)
  return t > mn ? 3 : 6;
}
/**
 * 흐름 열 모형 — 줄 앞 3천 자 안 가장 가까운 「N months ended <날짜>」 묶음(연속한 머리 1~2개)과 그 뒤 연도 줄, 금액·비율 쌍 머리(「amount ‖ % ‖ …」).
 * → { cols: [{ months, md:[월,일], year }], pct } 또는 null. 열 수를 정할 수 없으면 null(값을 내지 않는다 — 감사 10-16 2차 ③-1:
 * TSM 손익 「금액 ‖ % ‖ 금액 ‖ %」 4값 줄을 「3개월 둘 + 6개월 둘」로 읽어 2026 3개월 매출에 2025 값, 2025 에 비율 100 을 냈다)
 */
const BLOCK_RE = /(three|six|nine|twelve|3|6|9|12|fiscal|the)[\s-]*(?:months?|years?) ended[^0-9]{0,200}?([a-z]{3})[a-z]*\.? (\d{1,2})\b/g; // 「years ended」(4분기 연간 보고서) = 12개월
function flowCols(text, i) {
  const lo = Math.max(0, i - 3_000), win = text.slice(lo, i);
  const bs = [...win.matchAll(BLOCK_RE)];
  if (!bs.length) return yearOnlyCols(text, i);
  // 마지막 머리와, 그 앞 300자 안에 이어진 머리(「three months ended … six months ended …」)
  const last = bs.at(-1);
  const blocks = bs.filter((b) => b === last || (b.index < last.index && last.index - b.index <= 300 && bs.indexOf(b) === bs.indexOf(last) - 1));
  const afterHead = win.slice(last.index + last[0].length);
  const ym = /((?:(?:19|20)\d\d\b[\s‖,]*(?:note[s]?[\s‖]*)?){2,})/.exec(afterHead);
  if (!ym || ym.index > 400) return null;
  const years = [...ym[1].matchAll(/(?:19|20)\d\d/g)].map((x) => Number(x[0]));
  const months = (b) => (/years? ended/.test(b[0]) ? 12 : { three: 3, six: 6, nine: 9, twelve: 12 }[b[1]] ?? Number(b[1]));
  const md = (b) => [MON.indexOf(b[2]), Number(b[3])];
  if (blocks.some((b) => md(b)[0] < 0)) return null;
  let cols;
  if (blocks.length === 1 && years.length === 2) cols = years.map((y) => ({ months: months(blocks[0]), md: md(blocks[0]), year: y }));
  else if (blocks.length === 2 && years.length === 4) cols = years.map((y, k) => ({ months: months(blocks[k < 2 ? 0 : 1]), md: md(blocks[k < 2 ? 0 : 1]), year: y }));
  else return null;
  const pct = /amount[\s‖$]+%/.test(win.slice(last.index));
  return { cols, pct };
}

/** 표 머리에 기간 문구 없이 연도만 있는 연간 보고서(TSM 4분기 「‖ 2025 ‖ 2024 ‖ amount ‖ % …」) — 문서 첫머리 제목
 *  「for the years ended <월 일>, YYYY and YYYY」의 두 해와 줄 바로 위(600자 안) 연도 줄이 정확히 같을 때만 12개월 열 */
function yearOnlyCols(text, i) {
  const t = /for\s+the\s+years?\s+ended\s+([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+((?:19|20)\d\d)\s+and\s+((?:19|20)\d\d)/.exec(text.slice(0, 1_500));
  if (!t || MON.indexOf(t[1]) < 0) return null;
  const near = text.slice(Math.max(0, i - 600), i);
  const ym = [...near.matchAll(/((?:(?:19|20)\d\d\b[\s‖]*){2})(?=[\s‖]*(?:amount|[a-z(]))/g)].at(-1);
  if (!ym) return null;
  const years = [...ym[1].matchAll(/(?:19|20)\d\d/g)].map((x) => Number(x[0]));
  if (years[0] !== Number(t[3]) || years[1] !== Number(t[4])) return null;
  return { cols: years.map((y) => ({ months: 12, md: [MON.indexOf(t[1]), Number(t[2])], year: y })), pct: /amount[\s‖$]+%/.test(near.slice(ym.index)) };
}

/** 본표 구역 — 줄 앞에서 가장 가까운 재무제표 제목(「consolidated statement(s) of …」·「balance sheet」·「notes to the …」).
 *  bs = 시점 열만, flow = 기간 열만, equity = 자본변동표(열이 구성요소라 건너뜀), notes = 주석(시점·기간 둘 다 머리로 판정), null = 제목 전 */
const TITLE_RE = /consolidated (?:statements?|balance sheets?)(?: of)? ?(financial position|cash flows?|operations|income|profit or loss|comprehensive income|changes in (?:shareholders'? |stockholders'? )?equity)?|balance sheets?|notes to (?:the )?[a-z ]{0,60}financial statements/g;
// 제목 = 「제목 바로 뒤가 줄 끝·칸·괄호」이고 250자 안에 단위·검토 표시(「(in thousands …」·「(unaudited)」) 또는(주석) 「for the … months」.
// 본문 문장 속 언급(「… statement of financial position, which …」)·목차 줄(「… statement of cash flows ‖ ‖ 6」)은 구역을 바꾸지 않는다(감사 10-16 2차 ③-1 —
// TSM 주석 제목 「notes to consolidated financial statements」(the 없음)를 못 알아봐 현금흐름표 구역이 주석 끝까지 이어졌다)
const HEAD_AFTER = /^[\s‖]*(?:\n|‖|\(|$)/;
const UNIT_NEAR = /\((?:unaudited|in [a-z]|amounts? in|expressed in)|in (?:thousands|millions|billions) of/;
function regions(text) {
  const out = [];
  for (const m of text.matchAll(TITLE_RE)) {
    const w = m[1] ?? (/notes to/.test(m[0]) ? "notes" : /balance sheet/.test(m[0]) ? "financial position" : null);
    if (!w) continue;
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 250);
    if (w === "notes" ? !(UNIT_NEAR.test(after) || /^[\s‖]*for the (?:three|six|nine|twelve|year|period)/.test(after)) : !(HEAD_AFTER.test(after.slice(0, 40)) && UNIT_NEAR.test(after))) continue;
    // 흐름 구역은 종류까지(손익·포괄손익 = is, 현금흐름 = cf) — 같은 이름 줄이 손익과 현금흐름 조정에 함께 있다(SPOT finance income / AdjustmentsForFinanceIncome)
    out.push({ i: m.index, kind: /financial position/.test(w) ? "bs" : /changes in/.test(w) ? "equity" : w === "notes" ? "notes" : "flow", stmt: /cash flow/.test(w) ? "cf" : /financial position/.test(w) ? "bs" : /changes in|notes/.test(w) ? null : "is" });
  }
  return out;
}

/** 재무상태표 줄의 구역(유동·비유동 × 자산·부채) — 구역 안에서 줄 앞 가장 가까운 소제목(「total …」 합계 줄 제외) */
const SEC_RE = /(?<!total\s{0,3})\b(non[- ]?current|long[- ]term|current)\s+(assets|liabilities)\b/g;
function bsSectionAt(text, from, i) {
  let last = null;
  for (const m of text.slice(from, i).matchAll(SEC_RE)) last = m;
  if (!last) return null;
  const nc = /non|long/.test(last[1]);
  return `${nc ? "noncurrent" : "current"}_${last[2]}`;
}

/**
 * 6-K 서류 하나의 문서들 → RawFact[] (20-F 라벨 기준)
 *  - 본표 구역(재무상태표·손익·포괄손익·현금흐름표)의 줄만 읽는다. 주석·자본변동표·제목 전(목차·경영진 설명)은 읽지 않는다(감사 10-16 2차 ③-1).
 *  - 개념의 기간 종류 = 그 20-F 인스턴스에서 그 개념이 쓰인 종류(시점·기간 하나일 때만). 시점 개념은 재무상태표 구역, 기간 개념은 흐름 구역에서만
 *    (현금흐름표 「취득 — 사용권자산 (9,441,034)」 줄이 사용권자산 기간값이 되던 것).
 *  - 별도(모회사 단독) 재무보고서 문서는 읽지 않는다 — 연결과 같은 개념·기간으로 섞였다(감사 10-16 2차 ③-2, TSM a2025q4standalone…).
 *  - 같은 개념·기간의 값이 문서·줄 사이에서 갈리면(서류 전체 기준) 내지 않고 ambiguous. 한 줄을 두 개념이 함께 가져가도 ambiguous.
 * @param {{labelsByConcept: Map<string,string[]>, periodKind: Map<string,"instant"|"duration">, negated: Map<string,boolean|null>, conceptStmts: Map<string,{stmts:Set<string>, sections:Set<string>}>, cik, sym, filing, docs:[{name, text}], currency}} o
 */
export function sixKFacts(o) {
  const out = [], ambiguous = [], excluded = [];
  const found = new Map(); // 개념 → Map(기간 열쇠 → Map(값 → [{doc, pos, reg}]))
  const claims = new Map(); // 「문서|위치|기간 열쇠」 → Set(개념)
  const noKind = [];
  const cover = new Map(); // 문서 → { regions, facts:{bs,flow} } — 본표 구역이 있는데 사실이 0건이면 호출부가 실패로 남긴다(감사 10-16 2차 ③-5 SPOT 손익 0건 무기록)
  const add = (concept, key, val, doc, pos, reg) => {
    if (!found.has(concept)) found.set(concept, new Map());
    const m = found.get(concept);
    if (!m.has(key)) m.set(key, new Map());
    const vm = m.get(key);
    if (!vm.has(val)) vm.set(val, []);
    vm.get(val).push({ doc, pos, reg });
    const c = `${doc}|${pos}|${key}`;
    if (!claims.has(c)) claims.set(c, new Set());
    claims.get(c).add(concept);
  };
  for (const d of o.docs) {
    const t = d.text;
    if (!/(statements?|balance sheets?) of (cash flows?|financial position|comprehensive income|income|profit or loss|operations)|balance sheets?/.test(t)) continue;
    // 별도 판정 = 문서 이름 또는 문서 첫머리 제목(1,500자 — 연결 보고서도 감사인 문단에서 「parent company only」를 언급한다, TSM 2025 4분기)
    const head = t.slice(0, 1_500);
    if (/standalone|parent[- ]?company[- ]?only/.test(d.name.toLowerCase()) || (/parent company only financial statements|standalone financial (?:statements|report)/.test(head) && !/consolidated financial statements/.test(head))) { excluded.push({ doc: d.name, why: "standalone(별도 재무보고서)" }); continue; }
    const hdrs = bsHeaders(t);
    const regs = regions(t);
    cover.set(d.name, { regions: [...new Set(regs.map((g) => g.kind))], facts: { bs: 0, flow: 0 } });
    for (const [concept, labels] of o.labelsByConcept) {
      const pk = o.periodKind?.get(concept) ?? null;
      if (!pk) { noKind.push(concept); continue; }
      const cs = o.conceptStmts?.get(concept) ?? null; // 20-F 에서 그 개념이 놓인 본표 종류·재무상태표 구역
      for (const lab of labels) {
        for (const r of rowsFor(t, lab)) {
          const g = regs.filter((x) => x.i < r.i).at(-1) ?? null;
          const reg = g?.kind ?? null;
          if (reg !== "bs" && reg !== "flow") continue;
          if ((reg === "bs") !== (pk === "instant")) continue;
          // 본표 종류가 20-F 와 같은 구역만(손익 개념을 현금흐름 조정 줄에서 읽지 않는다), 재무상태표는 유동·비유동 구역도(정해지면)
          if (cs && g.stmt && !cs.stmts.has(g.stmt)) continue;
          if (cs && reg === "bs" && cs.sections.size === 1) {
            const sec = bsSectionAt(t, g.i, r.i);
            if (sec && !cs.sections.has(sec)) continue;
          }
          const e = unitAt(t, r.i);
          if (e == null) continue;
          // 주석 번호 열(「13 | 2,588 | 3,366」) — 값이 열 수보다 하나 많고 첫 토큰이 쉼표 없는 1~2자리 정수면 뺀다
          const fit = (n) => (r.vals.length === n ? { v: r.vals, t: r.toks } : r.vals.length === n + 1 && /^\d{1,2}$/.test(r.toks[0]) ? { v: r.vals.slice(1), t: r.toks.slice(1) } : null);
          const pctOk = (toks) => toks.every((x, k) => k % 2 === 0 || /^\(?-?\d{1,3}(?:\.\d+)?\)?$|^[—-]$/.test(x));
          if (reg === "bs") {
            // 날짜 머리는 줄 바로 위(3천 자 안)만
            const hd = hdrs.filter((h) => h.i < r.i && r.i - h.i <= 3_000).at(-1);
            if (!hd) continue;
            const n = hd.dates.length;
            const pct = /amount[\s‖$]+%/.test(t.slice(hd.i, r.i));
            const f = fit(pct ? 2 * n : n);
            if (!f || (pct && !pctOk(f.t))) continue;
            const vals = pct ? f.v.filter((_, k) => k % 2 === 0) : f.v;
            hd.dates.forEach((dt, k) => add(concept, `I|${dt}`, scaleInt(normNum(vals[k]), e), d.name, r.i, reg));
          } else {
            const fc = flowCols(t, r.i);
            if (!fc) continue;
            const f = fit(fc.pct ? 2 * fc.cols.length : fc.cols.length);
            if (!f || (fc.pct && !pctOk(f.t))) continue;
            const vals = fc.pct ? f.v.filter((_, k) => k % 2 === 0) : f.v;
            fc.cols.forEach((c, k) => add(concept, `D|${c.months}|${snap(c.year, c.md[0], c.md[1])}`, scaleInt(normNum(vals[k]), e), d.name, r.i, reg));
          }
        }
      }
    }
  }
  for (const [concept, byKey] of found) {
    for (const [key, vm] of byKey) {
      const vs = [...vm.keys()].filter((v) => v != null);
      const where = [...vm.values()].flat();
      if (vs.length !== 1) { if (vs.length > 1) ambiguous.push({ concept, key, vals: vs, docs: [...new Set(where.map((w) => w.doc))] }); continue; }
      const shared = where.flatMap((w) => [...(claims.get(`${w.doc}|${w.pos}|${key}`) ?? [])]).filter((c) => c !== concept);
      if (shared.length) { ambiguous.push({ concept, key, vals: vs, docs: [...new Set(where.map((w) => w.doc))], sharedRowWith: [...new Set(shared)] }); continue; }
      // 부호 — 6-K 글자는 표시 부호(괄호 = 음수). 20-F 본표 줄이 부호 반전 라벨(negatedLabel)이면 XBRL 부호 = 표시 부호의 반대
      // (감사 10-16 2차 대조: TSM 「헤지수단 취득 (631,620)」 20-F 631,600, SPOT 자기주식 (701) 20-F 701). 줄마다 반전 여부가 갈리면 판정 불가 → 모호
      const neg = o.negated?.get(concept);
      if (neg == null) { ambiguous.push({ concept, key, vals: vs, docs: [...new Set(where.map((w) => w.doc))], why: "부호 판정 불가(20-F 본표 줄의 부호 반전 라벨이 줄마다 다름)" }); continue; }
      const xv = neg && vs[0] !== "0" ? (vs[0].startsWith("-") ? vs[0].slice(1) : `-${vs[0]}`) : vs[0];
      const [kind, a, b] = key.split("|");
      const end = kind === "I" ? a : b;
      const months = kind === "D" ? Number(a) : null;
      const start = kind === "D" ? new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)) - months, 1)).toISOString().slice(0, 10) : null;
      for (const w of where) { const c = cover.get(w.doc); if (c) c.facts[w.reg]++; }
      out.push(rawFact({
        market: "us", entity: { sym: o.sym, cik: o.cik },
        filing: { id: o.filing.id, form: "6-K", filed_at: o.filing.filed_at, period_end: null, amends: null },
        concept: { id: concept, label: o.labelsByConcept.get(concept)?.[0] ?? null, standard: !/^[a-z]+:/.test(concept) || /^(us-gaap|ifrs-full):/.test(concept) },
        placement: { face: false, source: "6-K" },
        period: { kind: kind === "I" ? "instant" : "duration", start, end, months: start ? monthsBetween(start, end) : null, fy_key: fyKey("us", end), fp: kind === "D" ? `${months}M` : null, column: key },
        scope: { consolidation: "consolidated", attribution: "none", ops: "none", dims: [] },
        value: { raw: vs[0], num: xv, unit: o.currency ?? null, decimals: null, sign: neg ? "display_negated(20-F negatedLabel)" : "display", nil: false },
        locator: { source: "6-K", accn: o.filing.id, doc: [...new Set(where.map((w) => w.doc))].join(","), region: [...new Set(where.map((w) => w.reg))].join(",") },
        fetch: null,
      }));
    }
  }
  const coverage = [...cover].map(([doc, c]) => ({ doc, ...c, empty: c.regions.filter((k) => (k === "bs" || k === "flow") && !c.facts[k]) }));
  return { facts: out, ambiguous, excluded, coverage, noPeriodKind: [...new Set(noKind)].length };
}

/** 20-F 라벨 파일 → 개념 → 라벨 목록(표준·간략 라벨, 영어) */
export async function labelsFrom20F(sec, cik, accn, labFile) {
  const buf = (await sec.archive(cik, accn.replace(/-/g, ""), labFile)).buf.toString("utf8");
  const m = parseLabels(buf);
  const out = new Map();
  for (const [id, ls] of m) {
    const q = id.includes("_") ? `${id.slice(0, id.lastIndexOf("_"))}:${id.slice(id.lastIndexOf("_") + 1)}` : id;
    const texts = [...new Set(ls.filter((l) => !/documentation|period(Start|End)/i.test(l.role)).map((l) => l.text).filter((x) => x && x.length > 3 && x.length < 120))];
    if (texts.length) out.set(q, texts);
  }
  return out;
}

/** 6-K 서류의 큰 HTML 문서들(15KB 넘는 .htm) */
export async function sixKDocs(sec, cik, accn) {
  const a18 = accn.replace(/-/g, "");
  const idx = await sec.archive(cik, a18, "index.json");
  const v = checkJson(idx.buf);
  if (!v.ok) throw new Error(`6-K index.json 형식 ${v.why}`);
  const items = JSON.parse(idx.buf.toString("utf8")).directory?.item ?? [];
  const out = [];
  for (const it of items.filter((x) => /\.htm$/i.test(x.name) && !/-index/i.test(x.name) && Number(x.size) > 15_000)) {
    const html = (await sec.archive(cik, a18, it.name)).buf.toString("utf8");
    out.push({ name: it.name, text: docText(html) });
  }
  return out;
}
