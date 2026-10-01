/**
 * 주석 판독(분해용) — 오너 원칙 2026-09-29(memory feedback_decompose-with-notes): 차이를 "공시 없음"으로 판정하기 전에 반드시
 *   ① 본표 줄(계산 구조 _cal.xml) → ② 상세 XBRL 사실 전부(차원 포함 — 손익 위치·부문·자산 종류) → ③ 주석 TextBlock 의 HTML 표
 *   → ④ 주석·MD&A 문장의 금액
 * 순서로 찾고, 무엇을 봤는지 근거로 남긴다. 앱·검증기 코드를 가져오지 않는 독립 모듈(ESM). SEC 요청은 초당 2건 이하, 공시 원본은
 * 디스크 캐시(.cache/sec-archives — 앱 http.ts 와 같은 sha1(URL) 키), submissions·company_tickers 는 .cache/sec-api(12시간).
 *
 *   node scripts/reference/notes.mjs <TICKER> <form>:<결산일> <목표 금액(달러)> [--pairs] [--tol=500000]
 *   예) node scripts/reference/notes.mjs ISRG 10-K:2025-12-31 600000000
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const UA = process.env.SEC_USER_AGENT ?? "global-market-research (personal use) contact@example.com";
const ROOT = process.env.SEC_CACHE_DIR ?? path.join(process.cwd(), ".cache");
const ARCH_DIR = process.env.SEC_ARCHIVE_CACHE_DIR ?? path.join(ROOT, "sec-archives");
const API_DIR = path.join(ROOT, "sec-api");
const API_TTL = Number(process.env.SEC_API_CACHE_TTL_H ?? 12) * 3_600_000;
const sha = (s) => createHash("sha1").update(s).digest("hex");

let lastNet = 0;
async function net(url) {
  const wait = lastNet + 550 - Date.now(); // 초당 2건 이하
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNet = Date.now();
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, { headers: { "user-agent": UA, "accept-encoding": "gzip, deflate" } });
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 65_000)); continue; }
    if (!r.ok) throw new Error(`SEC ${r.status} ${url}`);
    return r.text();
  }
  throw new Error(`SEC 429 계속 ${url}`);
}
/** SEC 텍스트 — 공시 원본(접수번호 폴더)은 영구 캐시, 갱신형(submissions·company_tickers)은 12시간 */
export async function secText(url) {
  const archive = /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d{18}\//.test(url);
  const f = path.join(archive ? ARCH_DIR : API_DIR, sha(url));
  try {
    const st = fs.statSync(f);
    if (archive || Date.now() - st.mtimeMs < API_TTL) return fs.readFileSync(f, "utf8");
  } catch { /* 캐시 없음 */ }
  const body = await net(url);
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body, "utf8"); } catch { /* 캐시 실패 무시 */ }
  return body;
}

const accnDir = (cik, accn) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accn.replace(/-/g, "")}`;

// ── 공시 찾기 ──
export async function cikOf(ticker) {
  const j = JSON.parse(await secText("https://www.sec.gov/files/company_tickers.json"));
  const hit = Object.values(j).find((t) => t.ticker.toUpperCase() === ticker.toUpperCase());
  if (!hit) throw new Error(`티커 없음 ${ticker}`);
  return String(hit.cik_str);
}
/** 정기공시 목록 [{ accn, form, filed, report, doc }] (최근 목록만) */
export async function filings(cik) {
  const s = JSON.parse(await secText(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`));
  const r = s.filings.recent;
  return r.form.map((form, i) => ({ accn: r.accessionNumber[i], form, filed: r.filingDate[i], report: r.reportDate[i], doc: r.primaryDocument[i] }))
    .filter((f) => /^(10-K|10-Q|20-F|40-F)(\/A)?$/.test(f.form));
}
export async function filingIndex(cik, accn) {
  return JSON.parse(await secText(`${accnDir(cik, accn)}/index.json`)).directory.item.map((x) => x.name);
}

// ── XML·HTML 도구 ──
const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#160;|&nbsp;/g, " ").replace(/&#8217;/g, "'").replace(/&#8212;|&#8211;|&mdash;|&ndash;/g, "—").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");
const stripTags = (s) => decode(s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** 공시 인스턴스의 수치 사실 전부 [{ concept, ns, start?, end?, instant?, dims: {axis: member}, unit, decimals, val }] + TextBlock 원문 */
const instMemo = new Map();
export async function instanceFacts(cik, accn) {
  const key = `${cik}|${accn}`;
  if (instMemo.has(key)) return instMemo.get(key);
  const names = await filingIndex(cik, accn);
  const instN = names.find((x) => /_htm\.xml$/i.test(x)) ?? names.find((x) => /\.xml$/i.test(x) && !/_(pre|cal|def|lab)\.xml$|FilingSummary|^R\d+\.xml$/i.test(x));
  if (!instN) throw new Error(`인스턴스 없음 ${accn}`);
  const xml = await secText(`${accnDir(cik, accn)}/${instN}`);
  const ctx = new Map();
  for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
    const dims = {};
    for (const d of m[2].matchAll(/<xbrldi:explicitMember[^>]*dimension="([^"]+)"[^>]*>([^<]+)</g)) dims[d[1].replace(/^[^:]+:/, "")] = d[2].trim().replace(/^[^:]+:/, "");
    for (const d of m[2].matchAll(/<xbrldi:typedMember[^>]*dimension="([^"]+)"[^>]*>([\s\S]*?)<\/xbrldi:typedMember>/g)) dims[d[1].replace(/^[^:]+:/, "")] = stripTags(d[2]);
    ctx.set(m[1], {
      start: /<(?:xbrli:)?startDate>\s*([^<\s]+)/.exec(m[2])?.[1], end: /<(?:xbrli:)?endDate>\s*([^<\s]+)/.exec(m[2])?.[1],
      instant: /<(?:xbrli:)?instant>\s*([^<\s]+)/.exec(m[2])?.[1], dims,
    });
  }
  const facts = [], blocks = [];
  for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1:\2>)/g)) {
    const attrs = m[3], body = m[4];
    const cref = /contextRef="([^"]+)"/.exec(attrs)?.[1];
    if (!cref || body == null) continue;
    const c = ctx.get(cref) ?? {};
    const base = { ns: m[1], concept: m[2], start: c.start, end: c.end, instant: c.instant, dims: c.dims ?? {} };
    if (/TextBlock$/.test(m[2])) { blocks.push({ ...base, html: decode(body) }); continue; }
    const t = body.trim();
    if (!/^-?[\d.]+(?:[eE][-+]?\d+)?$/.test(t)) continue;
    const d = /decimals="([^"]+)"/.exec(attrs)?.[1];
    facts.push({ ...base, unit: /unitRef="([^"]+)"/.exec(attrs)?.[1] ?? null, decimals: d == null ? null : d === "INF" ? Infinity : Number(d), val: Number(t) });
  }
  const out = { facts, blocks, instN };
  instMemo.set(key, out);
  return out;
}

/** 본표(손익·현금흐름·재무상태) 계산 구조에 있는 개념 id 집합 */
export async function faceConcepts(cik, accn) {
  const names = await filingIndex(cik, accn);
  const calN = names.find((x) => /_cal\.xml$/i.test(x)) ?? names.find((x) => /\.xsd$/i.test(x));
  const out = new Set();
  if (!calN) return out;
  const cal = await secText(`${accnDir(cik, accn)}/${calN}`);
  for (const m of cal.matchAll(/<(?:link:)?calculationLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/(?:link:)?calculationLink>/g)) {
    const role = m[1].split("/").pop() ?? "";
    if (!/INCOME|OPERATIONS|EARNINGS|CASHFLOW|BALANCESHEET|FINANCIALPOSITION|CONDITION/i.test(role) || /Detail|Table|Parenth|Polic|Narrative|Schedule/i.test(role)) continue;
    for (const l of m[2].matchAll(/xlink:href="[^"#]*#([^"]+)"/g)) out.add(l[1].replace(/^([a-z0-9-]+)_/i, "$1:"));
  }
  return out;
}

// ── ③ 주석 표 ──
/** 셀 문자열 → 숫자(괄호·마이너스 음수, "—"/"-" = 0) | null */
function cellNumber(s) {
  const t = s.replace(/[$€£¥]/g, "").replace(/\s+/g, "").trim();
  if (/^[—–-]+$/.test(t)) return 0;
  const m = /^(\()?(-)?([\d,]*\.?\d+)(\))?%?$/.exec(t);
  if (!m || /%$/.test(t)) return null;
  const v = Number(m[3].replace(/,/g, ""));
  return m[1] || m[2] ? -v : v;
}
const scaleOf = (text) => (/in billions/i.test(text) ? 1e9 : /in millions/i.test(text) ? 1e6 : /in thousands/i.test(text) ? 1e3 : 1);
/** HTML 한 덩어리의 표들 → [{ title, scale, rows: [{ label, cells: [{ colHeader, value, raw }] }] }] */
export function parseTables(html, title = "") {
  const tables = [];
  const around = stripTags(html.slice(0, 4000));
  for (const t of html.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const scale = scaleOf(stripTags(t[0]).slice(0, 600)) !== 1 ? scaleOf(stripTags(t[0]).slice(0, 600)) : scaleOf(around);
    const rows = [...t[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((r) => [...r[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => stripTags(c[1])).filter((c) => c !== "" && c !== "$"));
    const header = [];
    const out = [];
    for (const cells of rows) {
      if (!cells.length) continue;
      const nums = cells.slice(1).map(cellNumber);
      if (nums.every((v) => v == null)) { header.push(cells); continue; }
      const label = cellNumber(cells[0]) == null ? cells[0] : "";
      const vals = (label ? cells.slice(1) : cells).map((raw) => ({ raw, v: cellNumber(raw) })).filter((x) => x.v != null);
      const hdr = header.at(-1) ?? [];
      const hdrCols = hdr.length > vals.length ? hdr.slice(hdr.length - vals.length) : hdr;
      out.push({ label, cells: vals.map((x, i) => ({ colHeader: hdrCols[i] ?? `열${i + 1}`, value: x.v * scale, raw: x.raw })) });
    }
    if (out.length) tables.push({ title, scale, rows: out });
  }
  return tables;
}
/** 공시의 모든 TextBlock 주석 표 */
export async function noteTables(cik, accn) {
  const { blocks } = await instanceFacts(cik, accn);
  const seen = new Set(), out = [];
  for (const b of blocks) {
    if (seen.has(b.concept) || !/<table/i.test(b.html)) continue;
    seen.add(b.concept);
    for (const t of parseTables(b.html, `${b.ns}:${b.concept}`)) out.push({ note: t.title, scale: t.scale, rows: t.rows });
  }
  return out;
}

// ── ④ 문장 ──
const AMT_RE = /\$\s?([\d,]*\.?\d+)\s*(billion|million|thousand)?/gi;
const docMemo = new Map();
async function primaryText(cik, accn) {
  if (docMemo.has(accn)) return docMemo.get(accn);
  const f = (await filings(cik)).find((x) => x.accn === accn);
  const names = await filingIndex(cik, accn);
  const doc = f?.doc ?? names.find((x) => /\.htm$/i.test(x) && !/^R\d+\.htm$/i.test(x));
  const text = stripTags((await secText(`${accnDir(cik, accn)}/${doc}`)).replace(/<ix:header>[\s\S]*?<\/ix:header>/i, ""));
  docMemo.set(accn, text);
  return text;
}
/** 본문(주석·MD&A 포함) 문장 중 keyword 에 맞고 금액이 있는 것 → [{ text, amounts: [{ raw, value, unit }] }] */
export async function noteSentences(cik, accn, keyword = /./) {
  const text = await primaryText(cik, accn);
  const out = [];
  for (const s of text.split(/(?<=[.;])\s+(?=[A-Z(])/)) {
    if (!keyword.test(s)) continue;
    const amounts = [...s.matchAll(AMT_RE)].map((m) => {
      const unit = (m[2] ?? "").toLowerCase(), k = unit === "billion" ? 1e9 : unit === "million" ? 1e6 : unit === "thousand" ? 1e3 : 1;
      const dec = (m[1].split(".")[1] ?? "").length;
      // 근거 문맥 — 금액 앞 220자·뒤 80자(긴 문단이 한 문장으로 묶여도 해당 부분이 보이게)
      const ctx = s.slice(Math.max(0, m.index - 220), m.index + m[0].length + 80);
      return { raw: m[0], value: Number(m[1].replace(/,/g, "")) * k, unit: k * 10 ** -dec, ctx };
    });
    if (amounts.length) out.push({ text: s.slice(0, 400), amounts });
  }
  return out;
}

/** 본문에서 keyword 가 나오는 곳의 문맥(금액 유무 무관 — 재분류·재작성 명시문 등) → [string] */
export async function noteMentions(cik, accn, keyword, span = 300) {
  const text = await primaryText(cik, accn);
  const out = [], re = new RegExp(keyword.source, keyword.flags.includes("g") ? keyword.flags : keyword.flags + "g");
  for (const m of text.matchAll(re)) {
    const s = text.slice(Math.max(0, m.index - 80), m.index + span);
    if (!out.some((o) => o.includes(s.slice(80, 160)))) out.push(s);
  }
  return out;
}

// ── 4단계 탐색 ──
/**
 * target(달러, 부호 무관 — 절댓값 비교)을 공시들(accns)의 네 층에서 찾는다. tolerance: 사실·표 값의 추가 허용(기본 0 — 각 값의 자기 표기
 * 단위 반올림만 인정: XBRL decimals, 표의 소수 자릿수 × 표 단위, 문장의 표기 단위). pairs: 같은 표의 두 셀 a ± b 도 찾는다(같은 열).
 * scopes: ["face","facts","tables","sentences"] 부분만. period: { end, days } 로 사실(①②) 기간 제한.
 * → { checked: [{ layer, filing, n }], hits: [{ layer, filing, where, label, value, period? }] }
 */
export async function findAmount(cik, accns, target, { tolerance = 0, scopes = ["face", "facts", "tables", "sentences"], pairs = false, period = null, sentenceKeyword = /./ } = {}) {
  const T = Math.abs(target), checked = [], hits = [];
  const near = (v, unit) => Math.abs(Math.abs(v) - T) <= Math.max(tolerance, unit / 2) + 1e-6;
  const inPeriod = (f) => !period || (f.end && Math.abs(Date.parse(f.end) - Date.parse(period.end)) / 864e5 <= (period.days ?? 7)) || (f.instant && Math.abs(Date.parse(f.instant) - Date.parse(period.end)) / 864e5 <= (period.days ?? 7));
  for (const accn of accns) {
    const { facts } = await instanceFacts(cik, accn);
    const usd = facts.filter((f) => /usd/i.test(f.unit ?? "") && !/shares/i.test(f.unit ?? ""));
    const unitOf = (f) => (Number.isFinite(f.decimals) ? 10 ** -f.decimals : 0);
    if (scopes.includes("face") || scopes.includes("facts")) {
      const face = await faceConcepts(cik, accn);
      const faceF = usd.filter((f) => !Object.keys(f.dims).length && face.has(`${f.ns}:${f.concept}`) && inPeriod(f));
      if (scopes.includes("face")) {
        checked.push({ layer: "① 본표 줄", filing: accn, n: faceF.length });
        for (const f of faceF) if (near(f.val, unitOf(f))) hits.push({ layer: "① 본표 줄", filing: accn, where: `${f.ns}:${f.concept}`, label: "", value: f.val, period: f.start ? `${f.start}~${f.end}` : f.instant });
      }
      if (scopes.includes("facts")) {
        const rest = usd.filter((f) => !faceF.includes(f) && inPeriod(f));
        checked.push({ layer: "② 상세 사실(차원 포함)", filing: accn, n: rest.length });
        for (const f of rest) if (near(f.val, unitOf(f))) hits.push({ layer: "② 상세 사실(차원 포함)", filing: accn, where: `${f.ns}:${f.concept}`, label: Object.entries(f.dims).map(([a, m]) => `${a}=${m}`).join(", "), value: f.val, period: f.start ? `${f.start}~${f.end}` : f.instant });
      }
    }
    if (scopes.includes("tables")) {
      const tabs = await noteTables(cik, accn);
      checked.push({ layer: "③ 주석 표", filing: accn, n: tabs.reduce((s, t) => s + t.rows.length, 0) });
      for (const t of tabs) {
        const cellUnit = (c) => t.scale * 10 ** -((c.raw.replace(/[^\d.]/g, "").split(".")[1] ?? "").length);
        for (const r of t.rows) for (const c of r.cells) if (near(c.value, cellUnit(c))) hits.push({ layer: "③ 주석 표", filing: accn, where: t.note, label: `${r.label} [${c.colHeader}]`, value: c.value });
        if (pairs) {
          for (let i = 0; i < t.rows.length; i++) for (let j = i + 1; j < t.rows.length; j++) {
            const a = t.rows[i], b = t.rows[j];
            for (let k = 0; k < Math.min(a.cells.length, b.cells.length); k++) {
              const u = cellUnit(a.cells[k]) + cellUnit(b.cells[k]);
              for (const [sg, v] of [["+", a.cells[k].value + b.cells[k].value], ["−", a.cells[k].value - b.cells[k].value]])
                if (near(v, u)) hits.push({ layer: "③ 주석 표(두 줄)", filing: accn, where: t.note, label: `${a.label} ${sg} ${b.label} [${a.cells[k].colHeader}]`, value: v });
            }
          }
        }
      }
    }
    if (scopes.includes("sentences")) {
      const ss = await noteSentences(cik, accn, sentenceKeyword);
      checked.push({ layer: "④ 주석·MD&A 문장", filing: accn, n: ss.length });
      for (const s of ss) for (const a of s.amounts) if (near(a.value, a.unit)) hits.push({ layer: "④ 주석·MD&A 문장", filing: accn, where: a.raw, label: a.ctx, value: a.value });
    }
  }
  return { checked, hits };
}

// ── CLI ──
if (process.argv[1]?.endsWith("notes.mjs")) {
  const [ticker, fp, tgt] = process.argv.slice(2);
  if (!ticker || !fp || !tgt) { console.error("사용법: node scripts/reference/notes.mjs <TICKER> <form>:<결산일> <목표 금액(달러)> [--pairs] [--tol=N]"); process.exit(1); }
  const [form, end] = fp.split(":");
  const cik = await cikOf(ticker);
  const f = (await filings(cik)).find((x) => x.form === form && x.report === end);
  if (!f) { console.error(`${ticker} ${form} ${end} 공시 없음(최근 목록)`); process.exit(1); }
  const tol = Number(process.argv.find((a) => a.startsWith("--tol="))?.slice(6) ?? 0);
  const r = await findAmount(cik, [f.accn], Number(tgt), { pairs: process.argv.includes("--pairs"), tolerance: tol });
  console.log(`${ticker} ${form} ${end} (${f.accn}) 목표 ${Number(tgt).toLocaleString("en-US")}`);
  for (const c of r.checked) console.log(`  확인: ${c.layer} ${c.n}건`);
  for (const h of r.hits) console.log(`  [${h.layer}] ${h.value.toLocaleString("en-US")} · ${h.where}${h.period ? ` · ${h.period}` : ""}${h.label ? ` · ${h.label.slice(-300)}` : ""}`);
  if (!r.hits.length) console.log("  네 층 모두 확인 — 일치 없음");
}
