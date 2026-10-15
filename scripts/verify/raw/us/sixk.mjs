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
/** 흐름 열 머리(가장 가까운 「months ended … YYYY YYYY」) → { months, years:[y1,y2], ends } */
function flowHeader(text, i) {
  // 줄 앞 3천 자 안의 머리만(뒤쪽·멀리 있는 머리를 쓰지 않는다 — 감사 10-16 ③-1)
  const lo = Math.max(0, i - 3_000), win = text.slice(lo, i);
  const hs = [...win.matchAll(/(three|six|nine|twelve|3|6|9|12)[\s-]*months? ended[^0-9]{0,200}?((?:[a-z]{3,9}\.? \d{1,2},?[\s‖]*)+)[^0-9]{0,80}?(20\d\d)[\s‖]+(20\d\d)/g)]
    .sort((a, b) => Math.abs(lo + a.index - i) - Math.abs(lo + b.index - i));
  const h = hs[0];
  if (!h) return null;
  const w = { three: 3, six: 6, nine: 9, twelve: 12 }[h[1]] ?? Number(h[1]);
  const md = /([a-z]{3})[a-z]*\.? (\d{1,2})/.exec(h[2]);
  return { months: w, md: md ? [MON.indexOf(md[1]), Number(md[2])] : null, years: [Number(h[3]), Number(h[4])] };
}

/** 본표 구역 — 줄 앞에서 가장 가까운 재무제표 제목(「consolidated statement(s) of …」·「balance sheet」·「notes to the …」).
 *  bs = 시점 열만, flow = 기간 열만, equity = 자본변동표(열이 구성요소라 건너뜀), notes = 주석(시점·기간 둘 다 머리로 판정), null = 제목 전 */
const TITLE_RE = /consolidated (?:statements?|balance sheets?)(?: of)? ?(financial position|cash flows?|operations|income|profit or loss|comprehensive income|changes in (?:shareholders'? |stockholders'? )?equity)?|balance sheets?|notes to the [a-z ]{0,60}financial statements/g;
function regions(text) {
  const out = [];
  for (const m of text.matchAll(TITLE_RE)) {
    const w = m[1] ?? (/notes to/.test(m[0]) ? "notes" : /balance sheet/.test(m[0]) ? "financial position" : null);
    if (!w) continue;
    out.push({ i: m.index, kind: /financial position/.test(w) ? "bs" : /changes in/.test(w) ? "equity" : w === "notes" ? "notes" : "flow" });
  }
  return out;
}

/**
 * 6-K 서류 하나의 문서들 → RawFact[] (20-F 라벨 기준)
 * @param {{labelsByConcept: Map<string,string[]>, cik, sym, filing, docs:[{name, text}], currency}} o
 */
export function sixKFacts(o) {
  const out = [], ambiguous = [];
  for (const d of o.docs) {
    const t = d.text;
    if (!/(statements?|balance sheets?) of (cash flows?|financial position|comprehensive income|income|profit or loss)|balance sheets?/.test(t)) continue;
    const hdrs = bsHeaders(t);
    const regs = regions(t);
    const claims = new Map(); // 「문서 위치|기간 열쇠」 → Set(개념) — 한 줄을 두 개념이 함께 가져가면(20-F 라벨이 같은 유동·비유동 줄) 둘 다 내지 않는다
    const pending = [];
    for (const [concept, labels] of o.labelsByConcept) {
      const found = new Map(); // 기간 열쇠 → Set(값)
      const at = new Map(); // 기간 열쇠 → Set(문서 위치)
      const claim = (key, pos) => { if (!at.has(key)) at.set(key, new Set()); at.get(key).add(pos); const c = `${pos}|${key}`; if (!claims.has(c)) claims.set(c, new Set()); claims.get(c).add(concept); };
      for (const lab of labels) {
        for (const r of rowsFor(t, lab)) {
          const e = unitAt(t, r.i);
          if (e == null) continue;
          // 구역(감사 10-16 ③-1 — 현금흐름표 줄이 재무상태표 날짜 머리로 시점값이 됐다): 재무상태표 = 시점만, 손익·현금흐름 = 기간만, 자본변동표 = 건너뜀
          const reg = regs.filter((g) => g.i < r.i).at(-1)?.kind ?? null;
          if (reg === "equity") continue;
          // 시점 — 앞에서 가장 가까운 날짜 머리, 값 개수 = 열 수(또는 2배 금액·비율 쌍)
          // 날짜 머리는 줄 바로 위(3천 자 안)만 — 멀리 떨어진 재무상태표 머리를 주석·경영진 설명 표 줄에 붙이지 않는다(감사 10-16 ③-1)
          const hd = hdrs.filter((h) => h.i < r.i && r.i - h.i <= 3_000).at(-1);
          let added = false;
          // 주석 번호 열(「13 | 2,588 | 3,366」) — 값이 열 수보다 하나 많고 첫 토큰이 쉼표 없는 1~2자리 정수면 뺀다
          const vals0 = (n) => (r.vals.length === n + 1 && /^\d{1,2}$/.test(r.toks[0]) ? r.vals.slice(1) : r.vals);
          if (reg !== "flow" && hd && (vals0(hd.dates.length).length === hd.dates.length || r.vals.length === 2 * hd.dates.length)) {
            const v0 = vals0(hd.dates.length);
            const vals = v0.length === hd.dates.length ? v0 : r.vals.filter((_, k) => k % 2 === 0);
            hd.dates.forEach((dt, k) => { const key = `I|${dt}`; if (!found.has(key)) found.set(key, new Set()); found.get(key).add(scaleInt(normNum(vals[k]), e)); claim(key, r.i); });
            added = true;
          }
          if (!added && reg !== "bs") {
            const fh = flowHeader(t, r.i);
            const fv = r.vals.length === 3 || r.vals.length === 5 ? vals0(r.vals.length - 1) : r.vals;
            if (!fh || !fh.md || !(fv.length === 2 || fv.length === 4)) continue;
            const pair = fv.length === 4 ? fv.slice(2) : fv;
            fh.years.forEach((y, k) => {
              const end = snap(y, fh.md[0], fh.md[1]);
              const key = `D|${fh.months}|${end}`;
              if (!found.has(key)) found.set(key, new Set());
              found.get(key).add(scaleInt(normNum(pair[k]), e));
              claim(key, r.i);
            });
          }
        }
      }
      pending.push({ concept, found, at });
    }
    for (const { concept, found, at } of pending) {
      for (const [key, vals] of found) {
        const vs = [...vals].filter((v) => v != null);
        if (vs.length !== 1) { if (vs.length > 1) ambiguous.push({ concept, key, vals: vs, doc: d.name }); continue; }
        const shared = [...(at.get(key) ?? [])].flatMap((pos) => [...(claims.get(`${pos}|${key}`) ?? [])]).filter((c) => c !== concept);
        if (shared.length) { ambiguous.push({ concept, key, vals: vs, doc: d.name, sharedRowWith: [...new Set(shared)] }); continue; }
        const [kind, a, b] = key.split("|");
        const end = kind === "I" ? a : b;
        const months = kind === "D" ? Number(a) : null;
        const start = kind === "D" ? new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)) - months, 1)).toISOString().slice(0, 10) : null;
        out.push(rawFact({
          market: "us", entity: { sym: o.sym, cik: o.cik },
          filing: { id: o.filing.id, form: "6-K", filed_at: o.filing.filed_at, period_end: null, amends: null },
          concept: { id: concept, label: o.labelsByConcept.get(concept)?.[0] ?? null, standard: !/^[a-z]+:/.test(concept) || /^(us-gaap|ifrs-full):/.test(concept) },
          placement: { face: false, source: "6-K" },
          period: { kind: kind === "I" ? "instant" : "duration", start, end, months: start ? monthsBetween(start, end) : null, fy_key: fyKey("us", end), fp: kind === "D" ? `${months}M` : null, column: key },
          scope: { consolidation: "consolidated", attribution: "none", ops: "none", dims: [] },
          value: { raw: vs[0], num: vs[0], unit: o.currency ?? null, decimals: null, sign: null, nil: false },
          locator: { source: "6-K", accn: o.filing.id, doc: d.name },
          fetch: null,
        }));
      }
    }
  }
  return { facts: out, ambiguous };
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
