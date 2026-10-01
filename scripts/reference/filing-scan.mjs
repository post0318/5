#!/usr/bin/env node
/**
 * 원인 미확인 칸 공시 원문 전수 검색(오너 지시 2026-09-30 — "10q 8k 20f 등도 같이 보라").
 *
 * 검증 결과(reports/verify/verify-us-*.json)에서 외부 소스(Yahoo·블룸버그·StockAnalysis) 칸 중
 *   (가) 원인 미확인(원인 없음·"추정"), (나) 외부 단독 이탈(outliers)
 * 을 모아, 칸마다 그 기간 관련 공시에서 외부 값과 차이 금액(외부 − 앱)을 찾는다.
 *   · XBRL(companyfacts): 모든 개념·모든 판본(원 공시 ~ 최신) 중 같은 기간(결산일 ±7일, 같은 기간 길이) 값
 *   · 원문 HTML: 그 사업연도 10-K(원 공시)·다음 해 10-K(비교 열)·결산 후 실적발표 8-K(항목 2.02)·그 해 10-Q,
 *     외국 기업은 20-F·6-K. LTM 은 기준일 10-Q/10-K 와 그 실적발표 8-K
 * 숫자 표기: 금액은 백만(정수·소수 1~2자리)·천 단위 콤마 표기, 주당 값은 소수 2자리. 앞뒤가 숫자인 부분 일치는 제외.
 * 결과는 발견 위치(공시 유형·제출일·파일·앞뒤 문맥)만 — 식 확정은 사람이 한다(발견 = 원인 아님).
 *
 * 사용: node scripts/reference/filing-scan.mjs [--report=경로] [--symbols=A,B] [--sources=Yahoo,블룸버그,StockAnalysis]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, "").split("="); return [k, v.join("=") || true]; }));
const REPORT = args.report ?? readdirSync("reports/verify").filter((f) => /^verify-us-\d+-\d+\.json$/.test(f))
  .map((f) => join("reports/verify", f)).filter((f) => JSON.parse(readFileSync(f, "utf8")).symbols?.length > 40)
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
const SOURCES = (args.sources ?? "Yahoo,블룸버그,StockAnalysis").split(",");
const ONLY = args.symbols ? new Set(String(args.symbols).split(",")) : null;
const UA = process.env.SEC_USER_AGENT || "post0318 research post0318@gmail.com";
const DISK = resolve("reports/.sec-cache");
const API_DISK = resolve("reports/.sec-cache/api");

// ── SEC 조회(초당 5건 이하, 원문은 디스크 영구 캐시 — 검증기와 같은 파일 이름) ──
let chain = Promise.resolve(), last = 0;
async function sec(url) {
  const ARCH = "https://www.sec.gov/Archives/edgar/data/";
  const disk = url.startsWith(ARCH) ? join(DISK, url.slice(ARCH.length).replace(/[^A-Za-z0-9._-]/g, "_")) : null;
  if (disk && existsSync(disk)) return readFileSync(disk, "utf8");
  const api = !disk ? join(API_DISK, url.replace(/^https:\/\//, "").replace(/[^A-Za-z0-9._-]/g, "_")) : null;
  if (api && existsSync(api) && Date.now() - statSync(api).mtimeMs < 12 * 3600e3) return readFileSync(api, "utf8");
  for (let i = 0; ; i++) {
    await (chain = chain.then(async () => { const w = last + 210 - Date.now(); if (w > 0) await new Promise((r) => setTimeout(r, w)); last = Date.now(); }));
    const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(90_000) }).catch((e) => ({ ok: false, status: String(e) }));
    if (r.status === 429 && i < 3) { await new Promise((res) => setTimeout(res, 65_000)); continue; }
    if (!r.ok) throw new Error(`${url} → ${r.status}`);
    const t = await r.text();
    if (disk) { mkdirSync(DISK, { recursive: true }); writeFileSync(disk, t); }
    if (api) { mkdirSync(API_DISK, { recursive: true }); writeFileSync(api, t); }
    return t;
  }
}
const secJson = async (u) => JSON.parse(await sec(u));
const dd = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;
const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const fyOf = (end) => { const d = new Date(end); return d.getUTCMonth() === 0 && d.getUTCDate() <= 7 ? d.getUTCFullYear() - 1 : d.getUTCFullYear(); };

// ── 대상 칸 ──
const rep = JSON.parse(readFileSync(REPORT, "utf8"));
const cells = [];
for (const s of rep.results) {
  if (ONLY && !ONLY.has(s.sym)) continue;
  const seen = new Set();
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    if (o.item && o.sources && typeof o.ours === "number") {
      if (seen.has(o.item)) return;
      seen.add(o.item);
      for (const n of SOURCES) {
        const v = o.sources[n];
        if (v == null || (o.matched ?? []).includes(n) || o.precisionNa?.[n]) continue;
        const c = o.causes?.[n];
        const outlier = (o.outliers ?? []).includes(n);
        if (c && !/^추정/.test(c) && !outlier) continue;
        cells.push({ sym: s.sym, col: o.item.split(" ")[0], metric: o.item.split(" ").slice(1).join(" "), ours: o.ours, v, src: n, kind: outlier ? "외부 단독 이탈" : "미해결", cause: c ?? null });
      }
      return;
    }
    Object.values(o).forEach(walk);
  };
  walk(s);
}
console.log(`보고서 ${REPORT} — 대상 ${cells.length}칸(${SOURCES.join("·")})`);

// ── 숫자 표기 후보 ──
const comma = (n) => n.toLocaleString("en-US", { maximumFractionDigits: 20 });
function forms(x, perShare) {
  const out = new Set();
  const a = Math.abs(x);
  if (perShare) { if (Math.abs(a * 100 - Math.round(a * 100)) < 1e-6 && a >= 0.01) out.add(a.toFixed(2)); return [...out]; }
  if (a < 1e5) return [];
  for (const [div, digs] of [[1e6, [0, 1, 2]], [1e3, [0]], [1e9, [1, 2, 3]]]) {
    const q = a / div;
    for (const dg of digs) { const p = 10 ** dg; if (Math.abs(q * p - Math.round(q * p)) < 1e-6) { const s0 = comma(Math.round(q * p) / p); if (s0.replace(/\D/g, "").length >= 3) out.add(dg ? (Math.round(q * p) / p).toLocaleString("en-US", { minimumFractionDigits: dg, maximumFractionDigits: dg }) : s0); } }
  }
  return [...out];
}
const strip = (t) => t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<ix:header>[\s\S]*?<\/ix:header>/gi, " ").replace(/<[^>]+>/g, " ")
  .replace(/&#160;|&nbsp;|&#8203;/gi, " ").replace(/&#36;|&#x24;/gi, "$").replace(/&#8217;|&#x2019;/gi, "'").replace(/&amp;/g, "&").replace(/&#59;/g, ";").replace(/&#\d+;/g, " ").replace(/\s+/g, " ");
function findAll(txt, s) {
  const hits = [];
  let k = -1;
  while ((k = txt.indexOf(s, k + 1)) >= 0 && hits.length < 3) {
    const pre = txt[k - 1] ?? "", post = txt.slice(k + s.length, k + s.length + 2);
    if (/[\d.,]/.test(pre) && !/[\s$(]/.test(pre)) continue;
    if (/^\d/.test(post) || /^[.,]\d/.test(post)) continue;
    hits.push(txt.slice(Math.max(0, k - 140), k + s.length + 20));
  }
  return hits;
}

// ── 종목별 준비 ──
const tickers = JSON.parse(await sec("https://www.sec.gov/files/company_tickers.json"));
const cikOf = (sym) => { const r = Object.values(tickers).find((x) => x.ticker.toUpperCase() === sym.replace("-", ".") || x.ticker.toUpperCase() === sym); return r ? String(r.cik_str).padStart(10, "0") : null; };
const CIK_OVERRIDE = { XOM: "0000034088" };
const out = [];
const bySym = new Map();
for (const c of cells) (bySym.get(c.sym) ?? bySym.set(c.sym, []).get(c.sym)).push(c);

const docCache = new Map();
async function docsOf(cik, accn) {
  const key = `${cik}|${accn}`;
  if (docCache.has(key)) return docCache.get(key);
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accn.replace(/-/g, "")}`;
  const p = (async () => {
    const idx = await secJson(`${base}/index.json`);
    const items = idx.directory.item.filter((x) => /\.htm$/i.test(x.name) && !/^R\d+\.htm$/i.test(x.name) && !/presentation|exhibit(3|4|10|21|23|31|32)|ex-?(3|4|10|21|23|31|32)[._]/i.test(x.name));
    const res = [];
    for (const it of items) { try { res.push({ name: it.name, txt: strip(await sec(`${base}/${it.name}`)) }); } catch { /* 문서 하나 실패 — 건너뜀 */ } }
    return res;
  })();
  docCache.set(key, p);
  return p;
}

for (const [sym, cs] of bySym) {
  const cik = CIK_OVERRIDE[sym] ?? cikOf(sym);
  if (!cik) { for (const c of cs) out.push({ ...c, err: "CIK 없음" }); continue; }
  let sub, facts;
  try { sub = await secJson(`https://data.sec.gov/submissions/CIK${cik}.json`); facts = await secJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`); }
  catch (e) { for (const c of cs) out.push({ ...c, err: String(e).slice(0, 80) }); continue; }
  const pages = [sub.filings.recent];
  for (const f of sub.filings.files ?? []) if ((f.filingTo ?? "") >= "2020-06-01") { try { pages.push(await secJson(`https://data.sec.gov/submissions/${f.name}`)); } catch { /* 과거 목록 실패 */ } }
  const fl = pages.flatMap((pg) => (pg.form ?? []).map((fm, i) => ({ form: fm, accn: pg.accessionNumber[i], filed: pg.filingDate[i], report: pg.reportDate[i], items: pg.items?.[i] ?? "" })));
  const annualForm = fl.some((f) => f.form === "20-F") ? "20-F" : "10-K";
  const annuals = fl.filter((f) => f.form === annualForm && f.report).sort((a, b) => a.report.localeCompare(b.report));
  const periodEnd = (col) => {
    if (col === "LTM") return fl.filter((f) => /^(10-Q|10-K|20-F|6-K)$/.test(f.form) && f.report).sort((a, b) => b.report.localeCompare(a.report))[0]?.report ?? null;
    const y = Number(col.slice(0, 4));
    return annuals.find((f) => fyOf(f.report) === y)?.report ?? null;
  };
  const allFacts = [];
  for (const [ns, o] of Object.entries(facts.facts ?? {})) for (const [cn, d] of Object.entries(o)) for (const [u, l] of Object.entries(d.units ?? {})) for (const e of l) allFacts.push({ c: `${ns}:${cn}`, u, ...e });

  for (const c of cs) {
    const E = periodEnd(c.col);
    const perShare = /EPS/.test(c.metric);
    const rec = { ...c, end: E, xbrl: [], text: [], checked: [] };
    if (!E) { rec.err = "기간 결산일 없음"; out.push(rec); continue; }
    const diff = c.v - c.ours;
    const targets = [["외부 값", c.v], ...(Math.abs(diff) > (perShare ? 0.005 : 5e5) ? [["차이", diff]] : [])];
    // XBRL — 같은 결산일(±7일)·기간 12개월(연간) 또는 흐름 LTM 은 제외(분기 값만 있어서), 주당은 USD/shares
    const want = (e) => (perShare ? /\/shares$/.test(e.u) : e.u === "USD") && e.end && dd(e.end, E) <= 7 && (c.col === "LTM" ? true : !e.start || dd(e.start, addDays(E, -364)) <= 12);
    for (const [lab, x] of targets) {
      for (const e of allFacts) if (want(e) && (perShare ? Math.abs(Math.abs(e.val) - Math.abs(x)) < 0.005 : Math.abs(Math.abs(e.val) - Math.abs(x)) < 0.5)) rec.xbrl.push(`${lab} ${x} = ${e.c} ${e.start ?? ""}~${e.end} ${e.val} (${e.form} ${e.filed})`);
    }
    rec.xbrl = [...new Set(rec.xbrl)].slice(0, 12);
    // 원문 — 연간: 그 해 연차보고서(원)·다음 해 연차보고서·결산 후 8-K(2.02)·그 해 10-Q. LTM: 기준일 분기·연차 보고서 + 그 실적발표
    const pick = [];
    if (c.col === "LTM") {
      pick.push(...fl.filter((f) => /^(10-Q|10-K|20-F|6-K)$/.test(f.form) && f.report && dd(f.report, E) <= 7).slice(0, 2));
      pick.push(...fl.filter((f) => f.form === "8-K" && /2\.02/.test(f.items) && f.filed > E && dd(f.filed, E) <= 80).slice(-1));
      const yb = addDays(E, -365);
      pick.push(...fl.filter((f) => /^(10-Q|10-K)$/.test(f.form) && f.report && dd(f.report, yb) <= 7).slice(0, 1));
    } else {
      const own = annuals.filter((f) => dd(f.report, E) <= 7);
      pick.push(...own.slice(0, 1));
      const nxt = annuals.find((f) => f.report > addDays(E, 300) && f.report < addDays(E, 430));
      if (nxt) pick.push(nxt);
      pick.push(...fl.filter((f) => (f.form === "8-K" || f.form === "6-K") && (f.form === "6-K" || /2\.02/.test(f.items)) && f.filed > E && dd(f.filed, E) <= 80).slice(-1));
      pick.push(...fl.filter((f) => f.form === "10-Q" && f.report && f.report < E && dd(f.report, E) <= 300));
    }
    const uniq = [...new Map(pick.map((f) => [f.accn, f])).values()];
    for (const f of uniq) {
      rec.checked.push(`${f.form} ${f.filed}`);
      let docs;
      try { docs = await docsOf(cik, f.accn); } catch (e) { rec.checked.push(`  (조회 실패 ${String(e).slice(0, 50)})`); continue; }
      for (const [lab, x] of targets) for (const s0 of forms(x, perShare)) for (const d of docs) for (const h of findAll(d.txt, s0)) rec.text.push({ lab, needle: s0, filing: `${f.form} ${f.filed}`, file: d.name, ctx: h });
    }
    rec.text = rec.text.slice(0, 15);
    out.push(rec);
    process.stdout.write(`  ${sym} ${c.col} ${c.metric} [${c.src}] XBRL ${rec.xbrl.length} · 원문 ${rec.text.length}\n`);
  }
}
const stamp = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace(/[-:T]/g, "");
const fn = `reports/verify/filing-scan-${stamp}.json`;
writeFileSync(fn, JSON.stringify({ report: REPORT, at: new Date().toISOString(), cells: out }, null, 1));
const found = out.filter((r) => r.xbrl?.length || r.text?.length);
console.log(`\n완료 — ${out.length}칸 중 공시에서 값 발견 ${found.length}칸 · 결과 ${fn}`);
