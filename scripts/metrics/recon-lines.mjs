#!/usr/bin/env node
/**
 * 외부 소스 줄 단위 구성 대조(오너 지시 2026-09-27 — "정의 차이를 인정하려면 어떻게 구성하고 있는지, 난 이건데 쟨 다르게 했지만
 * 본데이타는 다 맞다 — 이게 감사고 검증").
 *
 * 외부 값(Yahoo·StockAnalysis·인포맥스)이 앱(= SEC 본표)과 다른 칸을 **외부 소스 자신의 손익 줄**로 분해한다.
 *  1. 줄 대조표: 매출·매출원가·매출총이익·판관비·연구개발비·무형상각·기타 영업비용 줄마다 외부 값 vs SEC 본표 값.
 *  2. 항등식: 외부 영업이익 − 앱 영업이익 = Σ 줄 차이(외부가 영업이익에서 뺀 본표 줄 포함) — 안 맞으면 외부 자료 자체가 안 맞는 것.
 *  3. 다른 줄의 잔차를 SEC 10-K 원본 전체 항목(본표·주석, 차원 1개까지)에서 찾는다 — 한 항목 또는 두 항목 합(부호 포함)이
 *     **대조 가능한 모든 해에서** 외부 표기 단위 안으로 정확히 같을 때만 설명된 것으로 본다.
 *  판정: 모든 줄 차이가 설명되면 "②구성분해", 하나라도 남으면 "미결"(구성표를 남긴다). 추정으로 채우지 않는다.
 *
 * 입력: 최신 검증 결과(reports/verify/*.json — 앱 값 ours·대상 칸), SEC 10-K 원본(reports/.sec-cache 디스크 캐시), 외부 3곳 손익 줄.
 * 앱 코드(src/lib/fin)는 import 하지 않는다. 개발 서버 불필요.
 *
 *   node scripts/metrics/recon-lines.mjs [--symbols=MDLZ,IBM] [--from=verify-us-20260927-1733]
 * 결과: reports/recon/recon-{KST}.json + 콘솔 요약
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve as pathResolve, join as pathJoin } from "node:path";
import { createRequire } from "node:module";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const env = Object.fromEntries((existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "").split(/\r?\n/).map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^"|"$/g, "")]));

// ── SEC(검증기와 같은 디스크 캐시·요청 간격) ─────────────────────────────
const SEC_UA = env.SEC_USER_AGENT || "global-market-research (personal use) contact@example.com";
const SEC_DISK = pathResolve("reports/.sec-cache");
let secChain = Promise.resolve(), secLast = 0;
async function secRaw(url) {
  const ARCH = "https://www.sec.gov/Archives/edgar/data/";
  const disk = url.startsWith(ARCH) ? pathJoin(SEC_DISK, url.slice(ARCH.length).replace(/[^A-Za-z0-9._-]/g, "_")) : null;
  if (disk && existsSync(disk)) return readFileSync(disk, "utf8");
  for (let attempt = 0; ; attempt++) {
    await (secChain = secChain.then(async () => { const w = secLast + 334 - Date.now(); if (w > 0) await new Promise((r) => setTimeout(r, w)); secLast = Date.now(); }));
    const r = await fetch(url, { headers: { "user-agent": SEC_UA }, signal: AbortSignal.timeout(60_000) });
    if (r.status === 429 && attempt < 3) { await new Promise((res) => setTimeout(res, 65_000)); continue; }
    if (!r.ok) throw new Error(`SEC ${url} → HTTP ${r.status}`);
    const t = await r.text();
    if (disk) { mkdirSync(SEC_DISK, { recursive: true }); writeFileSync(disk, t); }
    return t;
  }
}
const CIK_OVERRIDE = { XOM: "0000034088" };
let cikMap = null;
async function cikOf(sym) {
  if (!cikMap) cikMap = new Map(Object.values(JSON.parse(await secRaw("https://www.sec.gov/files/company_tickers.json"))).map((r) => [r.ticker.toUpperCase().replace(".", "-"), String(r.cik_str).padStart(10, "0")]));
  return CIK_OVERRIDE[sym] ?? cikMap.get(sym) ?? null;
}
function contexts(xml) {
  const ctx = new Map();
  for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
    const b = m[2];
    ctx.set(m[1], {
      start: /<(?:xbrli:)?startDate>\s*([^<\s]+)/.exec(b)?.[1], end: /<(?:xbrli:)?endDate>\s*([^<\s]+)/.exec(b)?.[1],
      dims: [...b.matchAll(/dimension="([^"]+)"[^>]*>\s*(?:<[^>/]+>\s*([^<]*?)\s*<\/[^>]+>|([^<]*?))\s*</g)].map((d) => `${d[1].split(":").pop()}=${(d[2] ?? d[3] ?? "").split(":").pop()}`),
    });
  }
  return ctx;
}
function calcRoles(xml) {
  const out = [];
  xml = xml.replace(/<(?:link:)?calculationLink\b[^>]*\/>/g, "");
  for (const m of xml.matchAll(/<(?:link:)?calculationLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/(?:link:)?calculationLink>/g)) {
    const loc = new Map();
    for (const l of m[2].matchAll(/<(?:link:)?loc\b([^>]*)\/?>/g)) { const id = /xlink:label="([^"]+)"/.exec(l[1])?.[1], h = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1]; if (id && h) loc.set(id, h); }
    const arcs = [];
    for (const a of m[2].matchAll(/<(?:link:)?calculationArc\b([^>]*)\/?>/g)) {
      const fr = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? ""), to = loc.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
      if (fr && to) arcs.push({ fr, to, w: Number(/\bweight="([^"]+)"/.exec(a[1])?.[1] ?? 1) });
    }
    out.push({ role: m[1].split("/").pop() ?? "", arcs });
  }
  return out;
}
function labelsOf(lab) {
  const loc = new Map(), text = new Map(), labels = new Map();
  for (const l of lab.matchAll(/<(?:link:)?loc\b([^>]*)\/?>/g)) { const id = /xlink:label="([^"]+)"/.exec(l[1])?.[1], h = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1]; if (id && h) loc.set(id, h); }
  for (const m of lab.matchAll(/<(?:link:)?label\b([^>]*)>([^<]*)<\/(?:link:)?label>/g)) { const id = /xlink:label="([^"]+)"/.exec(m[1])?.[1]; if (!id || /documentation|verbose/i.test(m[1])) continue; const t = m[2].trim().replace(/&#160;/g, " ").replace(/&amp;/g, "&"); text.set(id, /role\/label"/.test(m[1]) ? [t, ...(text.get(id) ?? [])] : [...(text.get(id) ?? []), t]); }
  for (const a of lab.matchAll(/<(?:link:)?labelArc\b([^>]*)\/?>/g)) { const f = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? ""), t = text.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? ""); if (f && t && !labels.has(f)) labels.set(f, t[0]); }
  return labels;
}
const OPINC = /^(us-gaap_OperatingIncomeLoss|ifrs-full_ProfitLossFromOperatingActivities)$/;
const PRETAX = /^us-gaap_IncomeLossFromContinuingOperationsBeforeIncomeTaxes/;
/**
 * 10-K 한 건 → { accn, report, facts: Map(개념[차원] → Map(연도 → 값)), face: [{ id, label, w }] 손익계산서 본표에서 영업이익(없으면
 * 세전이익)을 이루는 말단 줄(매출·원가·비용 — 가중치 부호 포함), labels }
 */
async function readTenK(cik, p) {
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${p.accn.replace(/-/g, "")}`;
  const names = JSON.parse(await secRaw(`${base}/index.json`)).directory.item.map((x) => x.name);
  const xsd = names.find((x) => /\.xsd$/i.test(x));
  const calN = names.find((x) => /_cal\.xml$/i.test(x)) ?? xsd, labN = names.find((x) => /_lab\.xml$/i.test(x)) ?? xsd;
  const instN = names.find((x) => /_htm\.xml$/i.test(x)) ?? names.find((x) => /\.xml$/i.test(x) && !/_(pre|cal|def|lab)\.xml$|FilingSummary|^R\d+\.xml$/i.test(x));
  if (!instN || !calN) return null;
  const xml = await secRaw(`${base}/${instN}`);
  const ctx = contexts(xml);
  const facts = new Map();
  for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*?)contextRef="([^"]+)"([^>]*)>\s*(-?[\d.]+)\s*</g)) {
    const c = ctx.get(m[4]);
    if (!c?.start || c.dims.length > 1) continue;
    const days = (Date.parse(c.end) - Date.parse(c.start)) / 864e5;
    if (days < 350 || days > 380) continue;
    const u = /unitRef="([^"]*)"/.exec(`${m[3]} ${m[5]}`)?.[1] ?? "";
    if (/shares|pure|per/i.test(u)) continue;
    const k = `${m[1]}_${m[2]}${c.dims.length ? `[${c.dims[0]}]` : ""}`;
    const y = c.end;
    if (!facts.has(k)) facts.set(k, new Map());
    if (!facts.get(k).has(y)) facts.get(k).set(y, Number(m[6]));
  }
  const labels = labN ? labelsOf(await secRaw(`${base}/${labN}`)) : new Map();
  // 손익계산서 역할 — 영업이익(없으면 세전이익) 식이 있는 역할 중 상세·괄호 아닌 것
  const roles = calcRoles(await secRaw(`${base}/${calN}`)).filter((r) => !/Detail|Parenth|Segment|Table|Policies/i.test(r.role));
  let face = [], root = null, facePre = null, preRoot = null, faceNi = null, niRoot = null;
  for (const r of roles) {
    const rt = r.arcs.find((a) => OPINC.test(a.fr))?.fr ?? r.arcs.find((a) => PRETAX.test(a.fr))?.fr;
    if (!rt) continue;
    const kids = new Map();
    for (const a of r.arcs) kids.set(a.fr, [...(kids.get(a.fr) ?? []), a]);
    const leaves = [];
    const walk = (id, w, depth) => {
      const ch = kids.get(id);
      if (!ch || depth > 5) { leaves.push({ id, w }); return; }
      for (const a of ch) walk(a.to, w * a.w, depth + 1);
    };
    walk(rt, 1, 0);
    face = leaves; root = rt;
    // 세전이익 식 전체의 말단 줄(영업이익 아래 이자·영업외·비경상 포함) — 인포맥스 세부 줄 배분용(인포맥스 세전이익 = SEC 세전이익이 기준)
    const pt = r.arcs.find((a) => PRETAX.test(a.fr))?.fr;
    const nr = r.arcs.find((a) => /^us-gaap_ProfitLoss$/.test(a.fr))?.fr ?? r.arcs.find((a) => /^(us-gaap_NetIncomeLoss|ifrs-full_ProfitLoss)$/.test(a.fr))?.fr;
    if (nr) { const lv = []; const w3 = (id, w, depth) => { const ch = kids.get(id); if (!ch || depth > 8) { lv.push({ id, w }); return; } for (const a of ch) w3(a.to, w * a.w, depth + 1); }; w3(nr, 1, 0); faceNi = lv; niRoot = nr; }
    if (pt) { const lv = []; const w2 = (id, w, depth) => { const ch = kids.get(id); if (!ch || depth > 6) { lv.push({ id, w }); return; } for (const a of ch) w2(a.to, w * a.w, depth + 1); }; w2(pt, 1, 0); facePre = lv; preRoot = pt; }
    break;
  }
  return { ...p, facts, face, root, labels, facePre, preRoot, faceNi, niRoot };
}

/** 10-Q 한 건 → Map(개념[차원] → Map("시작|끝" → 값)) — 기간(누적) 사실 전부 */
async function readYtd(cik, p) {
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${p.accn.replace(/-/g, "")}`;
  const names = JSON.parse(await secRaw(`${base}/index.json`)).directory.item.map((x) => x.name);
  const instN = names.find((x) => /_htm\.xml$/i.test(x)) ?? names.find((x) => /\.xml$/i.test(x) && !/_(pre|cal|def|lab)\.xml$|FilingSummary|^R\d+\.xml$/i.test(x));
  if (!instN) throw new Error("10-Q 인스턴스 없음");
  const xml = await secRaw(`${base}/${instN}`);
  const ctx = contexts(xml);
  const out = new Map();
  for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*?)contextRef="([^"]+)"([^>]*)>\s*(-?[\d.]+)\s*</g)) {
    const c = ctx.get(m[4]);
    if (!c?.start || c.dims.length > 1) continue;
    const u = /unitRef="([^"]*)"/.exec(`${m[3]} ${m[5]}`)?.[1] ?? "";
    if (/shares|pure|per/i.test(u)) continue;
    const k = `${m[1]}_${m[2]}${c.dims.length ? `[${c.dims[0]}]` : ""}`;
    if (!out.has(k)) out.set(k, new Map());
    const se = `${c.start}|${c.end}`;
    if (!out.get(k).has(se)) out.get(k).set(se, Number(m[6]));
  }
  return out;
}
// ── 외부 소스 ───────────────────────────────────────────────────────────
const SA_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
function saUnflatten(arr) {
  const memo = new Map();
  const h = (i) => {
    if (i === -1) return undefined;
    if (memo.has(i)) return memo.get(i);
    const v = arr[i];
    if (v === null || typeof v !== "object") { memo.set(i, v); return v; }
    if (Array.isArray(v)) { const o = []; memo.set(i, o); for (const x of v) o.push(h(x)); return o; }
    const o = {}; memo.set(i, o);
    for (const [k, x] of Object.entries(v)) o[k] = h(x);
    return o;
  };
  return h(0);
}
// 인포맥스 배분에서 허용하는 주석 이동 수(기본 2, 실험 RECON_MOVES=3)
const MAX_MOVES = Number(process.env.RECON_MOVES ?? 2);
const SA_UNUSUAL = ["mergerRestructureCharges", "assetWritedown", "otherUnusualItems", "gainAssets", "legalSettlements", "impairmentGoodwill", "gainInvestments", "currencyGains"];
async function saLines(sym) {
  const get = async (path, q = false) => {
    const t = await (await fetch(`https://stockanalysis.com/stocks/${sym.toLowerCase()}/financials/${path}/__data.json?${q ? "p=quarterly&" : ""}x-sveltekit-invalidated=001`, { headers: { "user-agent": SA_UA, accept: "application/json" }, signal: AbortSignal.timeout(20_000) })).text();
    const node = JSON.parse(t).nodes.find((n) => n?.type === "data" && JSON.stringify(n.data).includes("financialData"));
    return saUnflatten(node.data).financialData;
  };
  const f = await get("income-statement");
  const out = new Map();
  let ltm = null;
  f.datekey.forEach((d, i) => {
    const v = (k) => f[k]?.[i] ?? null;
    if (d === "TTM") {
      const sga = v("sgna"), rnd = v("rnd"), amort = v("goodwillIntangibleAmortization"), opex = v("opex");
      ltm = { rev: v("revenue"), cogs: v("cor"), gp: v("gp"), sga, rnd, amort, other: opex != null ? opex - (sga ?? 0) - (rnd ?? 0) - (amort ?? 0) : null, op: v("opinc"), da: v("depAmorEbitda"),
        unusual: Object.fromEntries(SA_UNUSUAL.map((k) => [k, v(k)]).filter(([, x]) => x != null && x !== 0).map(([k, x]) => [k, -x])) };
      return;
    }
    const sga = v("sgna"), rnd = v("rnd"), amort = v("goodwillIntangibleAmortization"), opex = v("opex");
    out.set(d, {
      rev: v("revenue"), cogs: v("cor"), gp: v("gp"), sga, rnd, amort,
      other: opex != null ? opex - (sga ?? 0) - (rnd ?? 0) - (amort ?? 0) : null, op: v("opinc"), da: v("depAmorEbitda"),
      // 비경상 줄(영업이익 아래) — 비용 양수로(SA 는 비용을 음수로 적는다). 본표 한 줄이 SA 영업 분류와 비경상 줄로 쪼개진 경우 배분에 쓴다
      unusual: Object.fromEntries(SA_UNUSUAL.map((k) => [k, v(k)]).filter(([, x]) => x != null && x !== 0).map(([k, x]) => [k, -x])),
    });
  });
  // SA TTM 기준일 = 분기 손익의 최신 분기말(TTM 이 몇 분기 늦을 수 있다 — 앱 LTM 기준일과 20일 안일 때만 쓴다)
  let ltmEnd = null;
  // silent-ok: SA 분기 화면이 없으면 LTM 대조를 하지 않는다 — 결과에 ltmEnd null 로 남고 LTM 행이 생기지 않는다
  try { ltmEnd = (await get("income-statement", true)).datekey?.find((d) => d !== "TTM") ?? null; } catch { /* 분기 없음 */ }
  return { rows: out, ltm, ltmEnd, unit: unitOf([...out.values(), ltm].filter(Boolean)), lines: { sga: "sgna", rnd: "rnd", amort: "goodwillIntangibleAmortization", other: "opex − sgna − rnd − 상각" } };
}
let yf = null;
async function yahooLines(sym) {
  if (!yf) {
    const req = createRequire(new URL("../../package.json", import.meta.url));
    const mod = await import(new URL(`file:///${req.resolve("yahoo-finance2").replace(/\\/g, "/")}`).href);
    const YF = mod.default?.default ?? mod.default ?? mod;
    yf = new YF({ suppressNotices: ["yahooSurvey", "ripHistorical"], validation: { logErrors: false } });
  }
  const ya = await yf.fundamentalsTimeSeries(sym, { period1: "2018-01-01", type: "annual", module: "all" }, { validateResult: false });
  const row = (r) => {
    const sga = r.sellingGeneralAndAdministration ?? null, rnd = r.researchAndDevelopment ?? null, opex = r.operatingExpense ?? null;
    return { rev: r.totalRevenue ?? null, cogs: r.costOfRevenue ?? null, gp: r.grossProfit ?? null, sga, rnd, amort: null,
      other: opex != null ? opex - (sga ?? 0) - (rnd ?? 0) : null, op: r.totalOperatingIncomeAsReported ?? r.operatingIncome ?? null, da: r.reconciledDepreciation ?? null };
  };
  const out = new Map();
  for (const r of ya) out.set(new Date(r.date).toISOString().slice(0, 10), row(r));
  // LTM = 최근 분기 4개 합(Yahoo 는 52/53주 결산 분기말을 월말로 적는다 — 기준일 비교는 20일 허용)
  const yq = (await yf.fundamentalsTimeSeries(sym, { period1: new Date(Date.now() - 500 * 864e5), type: "quarterly", module: "all" }, { validateResult: false })).filter((r) => r.totalRevenue != null).sort((a, b) => new Date(a.date) - new Date(b.date)).slice(-4);
  const { ltm, ltmEnd } = sum4(yq.map((r) => ({ end: new Date(r.date).toISOString().slice(0, 10), ...row(r) })));
  return { rows: out, ltm, ltmEnd, unit: 1, lines: { sga: "sellingGeneralAndAdministration", rnd: "researchAndDevelopment", other: "operatingExpense − 판관비 − 연구개발비" } };
}
/** 외부 표기 정밀도(감사 HIGH-1) — 값 전부가 나누어떨어지는 가장 큰 10의 거듭제곱(1e3~1e6). SA 는 종목마다 천·백만 단위가 섞인다 */
function unitOf(rows) {
  const vals = rows.flatMap((r) => ["rev", "cogs", "gp", "sga", "rnd", "amort", "op", "da"].map((k) => r[k])).filter((v) => typeof v === "number" && v !== 0);
  for (const u of [1e6, 1e5, 1e4, 1e3]) if (vals.every((v) => Math.abs(Math.round(v / u) * u - v) < 0.5)) return u;
  return 1;
}
const annualCount = (yrs) => yrs.filter((y) => y.year !== "LTM").length;
/** 분기 4개 → LTM 줄(한 분기라도 값이 없으면 그 줄은 null) */
function sum4(qs) {
  if (qs.length !== 4) return { ltm: null, ltmEnd: null };
  const keys = ["rev", "cogs", "gp", "sga", "rnd", "amort", "other", "op", "da"];
  const ltm = Object.fromEntries(keys.map((k) => [k, qs.every((q) => q[k] != null) ? qs.reduce((t, q) => t + q[k], 0) : k === "amort" || k === "rnd" ? null : null]));
  return { ltm, ltmEnd: qs[3].end };
}
const IM = "https://globalmonitor.einfomax.co.kr";
async function infomaxLines(sym) {
  const post = (p, b) => fetch(IM + p, { method: "POST", headers: { "content-type": "application/json", referer: IM + "/sss.html" }, body: JSON.stringify(b), signal: AbortSignal.timeout(20_000) }).then((r) => r.json());
  const t = await post("/facset/tickerlist/usa", { ticker: sym });
  const code = t?._source?.["인포맥스코드"];
  if (!code || t._source["티커"]?.toUpperCase() !== sym) return null;
  // FactSet 손익계산서 세부 줄(오너 지시 2026-09-27 — sss.html 종목분석 > 재무제표, /facset/getStatementData). 금액 백만 달러 정수
  const F = { frequency: "A", frequency2: "0", infocode: code, pagetype: "", type: "", curr: "" };
  const pre = await post("/facset/getPreStatementData", { param: F });
  const stmt = async (freq) => {
    const d = await post("/facset/getStatementData", { param: { ...F, frequency: freq, frequency2: freq === "A" ? "0" : "", type: pre.step1["업종"], curr: "USD", pagetype: "손익계산서" }, type: { key: "IO", name: "손익계산서" } });
    return Array.isArray(d) ? d : d?.data ?? [];
  };
  const M = (v) => (v != null ? Math.round(v * 1e6) : null);
  const row = (r) => ({
    rev: M(r["매출액"]), cogs: M(r["상각비포함매출원가"]), gp: M(r["매출총이익"]), sga: M(r["판매비와관리비"]), rnd: null, amort: null,
    other: M(r["기타영업비용"]) ?? 0, op: M(r["영업이익"]), da: M(r["감가및감모상각비"]),
    // 영업이익 아래(비용 양수): 비경상비용, 영업외손익(수익이면 음수 비용), 이자비용, 관계기업이익(세전이익 밖 — 음수 비용)
    below: { unusual: M(r["비경상비용"]) ?? 0, nonop: -(M(r["영업외손익"]) ?? 0), interest: M(r["이자비용"]) ?? 0, tax: M(r["법인세"]) ?? 0, equity: -(M(r["관계기업투자이익"]) ?? 0),
      afterTax: -(M(r["기타세후조정"]) ?? 0), disc: -(M(r["중단사업이익"]) ?? 0), minority: M(r["비지배주주귀속분"]) ?? 0 },
    pretax: M(r["세전이익"]), niCons: M(r["연결순이익"]), niParent: M(r["당기순이익"]),
  });
  const out = new Map();
  for (const r of await stmt("A")) out.set(String(r["결산년월"]).slice(0, 10), row(r));
  const qs = (await stmt("Q")).map((r) => ({ end: String(r["결산년월"]).slice(0, 10), ...row(r) })).sort((a, b) => a.end.localeCompare(b.end)).slice(-4);
  let { ltm, ltmEnd } = sum4(qs);
  if (ltm && qs.length === 4) {
    ltm.below = Object.fromEntries(["unusual", "nonop", "interest", "tax", "equity", "afterTax", "disc", "minority"].map((k) => [k, qs.reduce((t, q) => t + (q.below[k] ?? 0), 0)]));
    for (const k of ["pretax", "niCons", "niParent"]) ltm[k] = qs.every((q) => q[k] != null) ? qs.reduce((t, q) => t + q[k], 0) : null;
  }
  // 인포맥스(FactSet) 판관비 = 판관비 + 연구개발비, 원가 = 감가·무형상각 포함 원가
  return { rows: out, ltm, ltmEnd, unit: unitOf([...out.values(), ltm].filter(Boolean)), sgaIncludesRnd: true, full: true, lines: { cogs: "상각비포함매출원가", sga: "판매비와관리비(연구개발비 포함)", other: "기타영업비용" } };
}

// ── 본표 줄 분류 ─────────────────────────────────────────────────────────
const NM = (id) => id.replace(/^[a-z0-9-]+_/i, "");
const catOf = (id, label = "") => {
  const s = `${NM(id)} ${label}`;
  if (/^(Revenues?|RevenueFromContract|SalesRevenue|Revenue\b)/.test(NM(id))) return "rev";
  if (/^CostOf|CostsOf|CostOfRevenue|CostOfGoods/.test(NM(id)) || /^cost of (sales|revenue|goods|products|services)/i.test(label)) return "cogs";
  if (/SellingGeneral|GeneralAndAdministrative|SellingAndMarketing|SellingExpense|MarketingAndAdvertising/i.test(s)) return "sga";
  if (/ResearchAndDevelopment|research and development|technology and development/i.test(s)) return "rnd";
  if (/AmortizationOfIntangible|amortization of (acquired |purchased )?intangible/i.test(s)) return "amort";
  return "other";
};

/** 정의 가설 분석용 표준 항목(회사 고유 태그 제외, 차원은 손익 위치 축만) */
const STD_RE = /^us-gaap_(DepreciationDepletionAndAmortization|DepreciationAndAmortization|Depreciation|DepreciationAmortizationAndAccretionNet|AmortizationOfIntangibleAssets|CostOfGoodsAndServicesSoldDepreciationAndAmortization|RestructuringCharges|RestructuringSettlementAndImpairmentProvisions|RestructuringCosts|SeveranceCosts1|AssetImpairmentCharges|GoodwillImpairmentLoss|ImpairmentOfIntangibleAssets\w*|ShareBasedCompensation|AllocatedShareBasedCompensationExpense|BusinessCombinationAcquisitionRelatedCosts|BusinessCombinationIntegrationRelatedCosts|OtherCostAndExpenseOperating|OtherOperatingIncomeExpenseNet|GainLossOnDispositionOfAssets1?|GainLossOnSaleOfPropertyPlantEquipment|LitigationSettlementExpense|LossContingencyLossInPeriod|UnrealizedGainLossOnDerivatives\w*|ExciseAndSalesTaxes|OperatingLeaseCost|OperatingLeaseRightOfUseAssetAmortizationExpense|FinanceLeaseRightOfUseAssetAmortization|CapitalizedComputerSoftwareAmortization1|InventoryWriteDown|ResearchAndDevelopmentExpense|SellingGeneralAndAdministrativeExpense|GeneralAndAdministrativeExpense|SellingAndMarketingExpense|OtherNonoperatingIncomeExpense)(\[(IncomeStatementLocationAxis|ConsolidationItemsAxis)=[^\]]+\])?$/;
// ── 잔차 검색 ────────────────────────────────────────────────────────────
/** d: Map(연도끝 → 잔차), pool: [{ k, vals: Map(연도끝 → 값) }] → 설명 문자열 | null. 모든 연도에서 |s·f − d| ≤ tol */
// 우연 일치 방지(2026-09-27 — 한 해짜리 무작위 조합이 "기타포괄손익"·"이자비용"으로 맞던 문제): 손익·현금흐름 성격 항목만,
// 차이가 0 이 아닌 해가 단일 항목 2개·두 항목 조합 3개 이상일 때만 인정
const POOL_OK = /Restructur|Impair|Amortiz|Depreci|Depletion|Acquisition|Integration|Divest|Litigation|Settlement|Derivative|Hedg|Unrealized|MarkToMarket|Gain|Loss|Cost|Expense|Charge|Severance|Write(down|off)|Inventor|Revenue|Sales|Excise|Royalt|Pension|Benefit|Compensation|Warrant|Contingen|Separation|Spin|Merger|Transaction|Remediation|Insurance|Recover/i;
const POOL_NO = /Oci|Comprehensive|IncomeTax|TaxBenefit|TaxExpense|Deferred|UnrecognizedTax|InterestExpense|InterestIncome|InterestPaid|Dividend|Share|Stock(?!Based)|Payable|Receivable|Liabilit|Assets?(?:Current|Noncurrent)?$|Accumulated|Proceeds|Payments|Purchase|Borrow|Debt|Cash(?!Flow)|PerShare|Weighted|Number/i;
function searchPool(d, pool, tol) {
  const ys = [...d.keys()];
  if (ys.every((y) => Math.abs(d.get(y)) <= tol)) return { how: "차이 0(표기 단위 안)", terms: [] };
  const nz = ys.filter((y) => Math.abs(d.get(y)) > tol).length;
  const has = (f) => ys.every((y) => f.vals.has(y)) && POOL_OK.test(f.k) && !POOL_NO.test(f.k.replace(/\[.*$/, ""));
  const cand = pool.filter(has);
  const fit1 = [];
  if (nz >= 2) for (const f of cand) for (const s of [1, -1]) if (ys.every((y) => Math.abs(s * f.vals.get(y) - d.get(y)) <= tol)) fit1.push([{ k: f.k, s }]);
  if (fit1.length) return { terms: fit1[0], alt: fit1.length - 1 };
  if (nz < 3) return null;
  let hit2 = null;
  // 두 항목 — 크기로 가지치기(첫 해 기준)
  const y0 = ys[0], t0 = d.get(y0);
  const byV = cand.map((f) => ({ f, v: f.vals.get(y0) })).filter((x) => x.v !== 0 && Math.abs(x.v) <= Math.abs(t0) * 20 + 1e9);
  for (let i = 0; i < byV.length; i++) for (let j = i + 1; j < byV.length; j++) for (const a of [1, -1]) for (const b of [1, -1]) {
    if (Math.abs(a * byV[i].v + b * byV[j].v - t0) > tol) continue;
    if (ys.every((y) => Math.abs(a * byV[i].f.vals.get(y) + b * byV[j].f.vals.get(y) - d.get(y)) <= tol)) {
      // 해 유일성(재감사 LOW-2) — 다른 두 항목 조합이 또 맞으면 확정 불가
      if (hit2) return null;
      hit2 = { terms: [{ k: byV[i].f.k, s: a }, { k: byV[j].f.k, s: b }] };
    }
  }
  if (hit2) return hit2;
  return null;
}

// ── 대상 칸(최신 검증 결과) ──────────────────────────────────────────────
const FROM = args.from ?? "verify-us-20260927-1733";
const files = readdirSync("reports/verify").filter((x) => x >= FROM && x.startsWith("verify-us-") && x.endsWith(".json")).sort();
const latest = new Map();
for (const x of files) for (const r of JSON.parse(readFileSync(`reports/verify/${x}`, "utf8")).results) latest.set(r.sym, r);
const METRICS = ["매출", "매출원가", "매출총이익", "영업이익", "감가상각비"];
const WEAK = new Set(["외부정의분해불가", "외부단독이탈", "구성미분해", "③"]);
const want = args.symbols ? new Set(String(args.symbols).split(",").map((s) => s.trim().toUpperCase())) : null;
const SRC = { Yahoo: yahooLines, StockAnalysis: saLines, 인포맥스: infomaxLines };

const results = [];
for (const [sym, r] of latest) {
  if (want && !want.has(sym)) continue;
  // 대상: 연간 열 외부 대조 중 약한 분류(구성 분해 없이 넘긴 칸)
  const cells = [];
  for (const x of r.review ?? []) {
    const m = /^(\d{4}Y|LTM) (.+)$/.exec(x.item);
    if (!m || !METRICS.includes(m[2])) continue;
    const cls = x.metricClass ?? x.revenueClass;
    if (!cls) continue;
    for (const [n, c] of Object.entries(cls)) if (WEAK.has(c) || (c === "②" && /^구성 분해/.test(x.causes?.[n] ?? ""))) cells.push({ year: m[1] === "LTM" ? "LTM" : m[1].slice(0, 4), metric: m[2], src: n, cls: c, ours: x.ours, ext: x.sources[n] });
  }
  if (!cells.length) continue;
  const cik = await cikOf(sym);
  if (!cik) { results.push({ sym, err: "CIK 없음" }); continue; }
  const sub = JSON.parse(await secRaw(`https://data.sec.gov/submissions/CIK${cik}.json`));
  const rc = sub.filings.recent;
  const ks = [];
  for (let i = 0; i < rc.form.length && ks.length < 3; i++) if (/^(10-K|20-F)$/.test(rc.form[i])) ks.push({ accn: rc.accessionNumber[i], report: rc.reportDate[i], form: rc.form[i] });
  const tenK = [];
  for (const p of ks) { try { const t = await readTenK(cik, p); if (t) tenK.push(t); } catch (e) { results.push({ sym, err: `10-K ${p.report} 판독 실패: ${String(e).slice(0, 80)}` }); } }
  if (!tenK.length) continue;
  // 항목 풀 — 최신 10-K 우선(재작성), 없으면 이전 10-K
  const pool = new Map();
  // 판본(감사 2026-09-28 HIGH-3): 나중 공시가 앞선 정밀값의 반올림으로 다시 태깅한 값(MCD 2023)이면 앞선 정밀값 — 앱 dropRoundedRetags 와 같은 원칙
  const isRoundOf = (late, early) => late !== early && [1e5, 1e6, 1e7, 1e8, 1e9].some((u) => late % u === 0 && early % u !== 0 && Math.round(early / u) * u === late);
  for (const t of tenK) for (const [k, vs] of t.facts) {
    if (!pool.has(k)) pool.set(k, new Map());
    for (const [y, v] of vs) { const cur = pool.get(k).get(y); if (cur == null) pool.get(k).set(y, v); else if (isRoundOf(cur, v)) pool.get(k).set(y, v); }
  }
  // 옛 10-K 의 본표 줄 개념 이름이 다르면(MDLZ 이자·기타 영업외 줄) 최신 본표 줄에 이어 붙인다 — 같은 식의 말단 줄 목록이 같은 길이면 같은 위치,
  // 아니면 같은 라벨. 최신 개념에 그 해 값이 없을 때만 채운다
  const aliased = new Set();
  for (const key of ["face", "facePre", "faceNi"]) {
    const cur = tenK[0][key];
    if (!cur) continue;
    for (const old of tenK.slice(1)) {
      const o = old[key];
      if (!o) continue;
      for (let j = 0; j < cur.length; j++) {
        const lab = tenK[0].labels.get(cur[j].id);
        const m = o.length === cur.length && o[j].w === cur[j].w ? o[j] : o.find((x) => old.labels.get(x.id) && old.labels.get(x.id) === lab);
        if (!m || m.id === cur[j].id) continue;
        aliased.add(m.id);
        const src = old.facts.get(m.id);
        if (!src) continue;
        if (!pool.has(cur[j].id)) pool.set(cur[j].id, new Map());
        for (const [y, v] of src) if (!pool.get(cur[j].id).has(y)) pool.get(cur[j].id).set(y, v);
      }
    }
  }
  // 본표 줄 목록 = 최신 10-K + 옛 10-K 에만 있는 줄(감사 HIGH-3 — VRT 2021 자산손상·AMAT 2021 구조조정이 0 으로 사라지던 문제). 개념 이름만 바뀐 줄(aliased)은 제외
  for (const key of ["face", "facePre", "faceNi"]) {
    const cur = tenK[0][key];
    if (!cur) continue;
    const have = new Set(cur.map((f) => f.id));
    for (const old of tenK.slice(1)) for (const f of old[key] ?? []) if (!have.has(f.id) && !aliased.has(f.id)) { cur.push(f); have.add(f.id); if (!tenK[0].labels.has(f.id) && old.labels.has(f.id)) tenK[0].labels.set(f.id, old.labels.get(f.id)); }
  }
  // LTM — 최신 10-K 뒤 10-Q 가 있으면 줄마다 사업연도 + 당기 누적 − 전년 동기(10-Q 원본), 없으면 사업연도 값
  const fyEnd = tenK[0].report;
  let ltmEnd = fyEnd;
  const kIdx = rc.form.findIndex((f) => /^(10-K|20-F)$/.test(f));
  const qIdx = rc.form.findIndex((f, i) => f === "10-Q" && (kIdx < 0 || i < kIdx));
  if (qIdx >= 0) {
    try {
      const q = await readYtd(cik, { accn: rc.accessionNumber[qIdx], report: rc.reportDate[qIdx] });
      ltmEnd = rc.reportDate[qIdx];
      const day = 864e5, near = (a, b, n) => Math.abs(Date.parse(a) - Date.parse(b)) <= n * day;
      const s0 = new Date(Date.parse(fyEnd) + day).toISOString().slice(0, 10);
      for (const [k, vals] of pool) {
        const fy = vals.get(fyEnd);
        const per = q.get(k);
        if (fy == null || !per) continue;
        let cur = null, prior = null, curDays = 0;
        for (const [se, v] of per) { const [a, b] = se.split("|"); if (near(a, s0, 5) && near(b, ltmEnd, 3)) { cur = v; curDays = (Date.parse(b) - Date.parse(a)) / day; } }
        if (cur == null) continue;
        for (const [se, v] of per) { const [a, b] = se.split("|"); const dd = (Date.parse(b) - Date.parse(a)) / day; if (near(a, new Date(Date.parse(s0) - 365 * day).toISOString(), 8) && near(b, new Date(Date.parse(ltmEnd) - 365 * day).toISOString(), 8) && Math.abs(dd - curDays) <= 10) prior = v; }
        if (prior == null) continue;
        vals.set("LTM", fy + cur - prior);
      }
    } catch (e) { results.push({ sym, err: `10-Q LTM 판독 실패: ${String(e).slice(0, 80)}` }); }
  } else for (const vals of pool.values()) if (vals.has(fyEnd)) vals.set("LTM", vals.get(fyEnd));
  const poolArr = [...pool].map(([k, vals]) => ({ k, vals }));
  const face = tenK[0].face, labels = tenK[0].labels;
  const faceVal = (id, y) => pool.get(id)?.get(y) ?? null;
  const yEnd = (yr) => yr === "LTM" ? "LTM" : [...(pool.get("us-gaap_Revenues") ?? pool.get(face.find((f) => catOf(f.id) === "rev")?.id ?? "") ?? new Map()).keys()].find((e) => e.startsWith(yr)) ?? [...new Set(poolArr.flatMap((p) => [...p.vals.keys()]))].find((e) => e.slice(0, 4) === yr);

  const srcData = {};
  for (const n of new Set(cells.map((c) => c.src))) { try { srcData[n] = await SRC[n](sym); } catch (e) { srcData[n] = { err: String(e).slice(0, 80) }; } }

  // 칸을 (소스, 지표)로 묶어 여러 해를 함께 분해한다(모든 해 성립이 조건)
  const groups = new Map();
  for (const c of cells) { const k = `${c.src}|${c.metric}`; groups.set(k, [...(groups.get(k) ?? []), c]); }
  for (const [k, cs] of groups) {
    const [src, metric] = k.split("|");
    const S = srcData[src];
    if (!S?.rows) { results.push({ sym, src, metric, verdict: "미결", why: `외부 줄 조회 실패 ${S?.err ?? ""}` }); continue; }
    const tol = S.unit / 2;
    const rowOf = (end) => end === "LTM" ? (S.ltm && S.ltmEnd && Math.abs(Date.parse(S.ltmEnd) - Date.parse(ltmEnd)) <= 20 * 864e5 ? S.ltm : null) : [...S.rows].find(([d]) => Math.abs(Date.parse(d) - Date.parse(end)) <= 10 * 864e5)?.[1] ?? null;
    // 앱(= SEC) 연도별 값 — 본표 줄 합으로 분해할 때 쓰는 SEC 줄 값
    // 앱 값(= SEC 본표, A층 통과) — 같은 해 매출·매출원가·영업이익
    // 앱 값은 그 칸 A층(앱 = SEC 본표)이 통과했을 때만 SEC 값으로 쓴다(감사 HIGH-3)
    const aPass = (yr, m) => (r.checks ?? []).some((c) => c.layer === "A" && c.col === (yr === "LTM" ? "LTM" : `${yr}Y`) && c.status === "pass" && c.name.includes(`${m} 앱 = SEC`));
    const appOf = (yr, m) => aPass(yr, m) ? (r.review ?? []).find((x) => x.item === (yr === "LTM" ? `LTM ${m}` : `${yr}Y ${m}`))?.ours ?? null : null;
    const yrs = [];
    for (const c of cs) {
      const end = yEnd(c.year);
      const row = end ? rowOf(end) : null;
      if (!end || !row) continue;
      const sec = { rev: 0, cogs: 0, sga: 0, rnd: 0, amort: 0, other: 0 }, secLines = { rev: [], cogs: [], sga: [], rnd: [], amort: [], other: [] };
      let miss = false;
      for (const f of face) {
        const v = faceVal(f.id, end);
        if (v == null) continue;
        const cat = catOf(f.id, labels.get(f.id));
        // 영업이익 식에서 매출은 +, 비용은 − 가중치 — 비용 줄은 양수로 적는다
        const amt = cat === "rev" ? f.w * v : -f.w * v;
        sec[cat] += amt; secLines[cat].push({ id: f.id, label: labels.get(f.id) ?? NM(f.id), v: amt });
      }
      if (miss) continue;
      // SEC 원가·매출 = 앱 값(본표 판독이 원가 경계를 가른 결과 — 개념 이름 분류보다 정확), 기타 = 매출 − 원가 − 판관비 − 연구개발비 − 상각 − 영업이익
      const aRev = appOf(c.year, "매출"), aCogs = appOf(c.year, "매출원가"), aOp = appOf(c.year, "영업이익");
      if (aRev != null) sec.rev = aRev;
      if (aCogs != null) {
        const moved = secLines.cogs.reduce((t, x) => t + x.v, 0) - aCogs;
        sec.cogs = aCogs;
        if (Math.abs(moved) > 0.5) secLines.other.push({ id: "(앱 매출원가 경계)", label: `원가 줄 분류 차 ${moved / 1e6}백만`, v: moved });
      }
      // 본표 줄 완전성(감사 HIGH-3): 본표 줄 합(매출 − 비용 줄) = 앱 영업이익(A층 통과)이어야 줄 배분을 믿는다. 기타는 역산하지 않는다(항등식이 무의미해짐)
      const complete = aRev != null && aOp != null && Math.abs(sec.rev - sec.cogs - sec.sga - sec.rnd - sec.amort - sec.other - aOp) <= 1;
      if (S.sgaIncludesRnd) { sec.sga += sec.rnd; secLines.sga.push(...secLines.rnd); sec.rnd = 0; secLines.rnd = []; }
      yrs.push({ ...c, end, row, sec, secLines, complete });
    }
    if (!yrs.length) { results.push({ sym, src, metric, verdict: "미결", why: "연도 대응 없음(SEC 결산일 ↔ 외부 기간)", cells: cs.length }); continue; }
    // 연간 열로 구성을 찾고, LTM 은 연간 + LTM 을 함께 다시 판정(같은 구성이 LTM 에서도 성립할 때만 LTM ②) — LTM 하나가 연간 판정을 깨지 않게
    const analyze = (yrs) => {
      // 줄 대조표 — 지표별로 관련 줄만
      const lineSet = metric === "매출" ? ["rev"] : metric === "매출원가" || metric === "매출총이익" ? ["rev", "cogs"] : metric === "영업이익" ? ["rev", "cogs", "sga", "rnd", "amort", "other"] : ["da"];
      const table = yrs.map((y) => {
        const t = { year: y.year, ext: y.ext, app: y.ours, diff: y.ext - y.ours, lines: {} };
        for (const l of lineSet) {
          if (l === "da") { t.lines.da = { ext: y.row.da, sec: y.ours }; continue; }
          let e = y.row[l];
          // 외부에 줄이 없으면(0 또는 null) 외부는 그 본표 줄을 영업이익에서 뺀 것
          if (e == null && ["rnd", "amort", "other"].includes(l)) e = 0;
          t.lines[l] = { ext: e, sec: y.sec[l], secLines: y.secLines[l] };
        }
        return t;
      });
      // 항등식 — 외부 지표 − 앱 = Σ 줄 차이(지표 방향 부호)
      const sign = { rev: 1, cogs: -1, sga: -1, rnd: -1, amort: -1, other: -1 };
      const idOk = table.every((t) => {
        if (metric === "매출" || metric === "감가상각비") return true;
        if (metric === "매출원가") return Math.abs((t.lines.cogs.ext - t.lines.cogs.sec) - t.diff) <= tol * 2;
        if (metric === "매출총이익") return Math.abs((t.lines.rev.ext - t.lines.rev.sec) - (t.lines.cogs.ext - t.lines.cogs.sec) - t.diff) <= tol * 3;
        const s = lineSet.reduce((a, l) => a + sign[l] * ((t.lines[l].ext ?? 0) - t.lines[l].sec), 0);
        return Math.abs(s - t.diff) <= tol * 7;
      });
      // 줄별 잔차 설명
      const explain = {};
      const lineTargets = metric === "매출" ? ["rev"] : metric === "감가상각비" ? ["da"] : metric === "영업이익" ? lineSet : ["rev", "cogs"];
      for (const l of lineTargets) {
        const d = new Map();
        for (const t of table) {
          const ln = t.lines[l];
          if (!ln) continue;
          if (ln.ext == null) { d.clear(); break; }
          d.set(t.lines && yrs.find((y) => y.year === t.year).end, ln.ext - ln.sec);
        }
        if (!d.size) { explain[l] = { ok: false, why: "외부 줄 값 없음" }; continue; }
        if ([...d.values()].every((v) => Math.abs(v) <= tol)) { explain[l] = { ok: true, how: "외부 = SEC(표기 단위 안)" }; continue; }
        // 외부가 이 분류 줄을 통째로 0 으로 둔 경우 — 본표 줄 이름으로 설명(외부가 영업이익에서 뺀 본표 줄)
        const zeroed = table.every((t) => (t.lines[l]?.ext ?? 0) === 0);
        if (zeroed && table.every((t) => (t.lines[l]?.secLines ?? []).length)) {
          explain[l] = { ok: true, how: `외부는 본표 줄을 영업이익에서 제외: ${[...new Set(table.flatMap((t) => t.lines[l].secLines.map((x) => x.label)))].join(" · ")}` };
          continue;
        }
        const hit = searchPool(d, poolArr, tol);
        explain[l] = hit ? { ok: true, how: hit.how ?? `SEC ${hit.terms.map((x) => `${x.s > 0 ? "+" : "−"}${x.k}`).join(" ")}${hit.alt ? ` (같은 값 후보 ${hit.alt}개 더)` : ""}` }
          : { ok: false, why: `잔차 ${[...d].map(([y, v]) => `${y.slice(0, 4)} ${Math.round(v / 1e6)}`).join(" / ")}백만 — SEC 손익 성격 항목 1~2개 조합 없음(또는 근거 연도 부족: 단일 2년·조합 3년 필요)` };
      }
      // 정의 가설 분석용 — 줄별 잔차(연도별)와 자주 쓰는 SEC 표준 항목 값
      const resid = {};
      for (const l of lineTargets) resid[l] = Object.fromEntries(table.map((t) => [t.year, t.lines[l]?.ext == null ? null : t.lines[l].ext - t.lines[l].sec]));
      const std = {};
      for (const [k, vals] of pool) {
        if (!STD_RE.test(k)) continue;
        std[k] = Object.fromEntries(yrs.map((y) => [y.year, vals.get(y.end) ?? null]));
      }
      // 본표 줄 배분(2026-09-27) — 외부는 SEC 본표 비용 줄을 자기 분류(원가·판관비·연구개발비·상각·영업이익 밖)로 다시 묶는다(인포맥스 V·XOM·UBER:
      // 원가 +차 = 기타 −차). 외부 분류마다 본표 줄 부분집합의 합이 **모든 해에서** 외부 값과 같은 배분을 찾는다 — 찾으면 그 배분이 구성 설명
      let partition = null, fsDiag = null, partitionWhy = null;
      if (!Object.values(explain).every((x) => x.ok) && idOk && ["영업이익", "매출원가", "매출총이익"].includes(metric) && explain.rev?.ok) {
        // 매출 줄 제외 — 개념 이름 분류가 놓치는 매출 줄(MCD "Sales by Company-operated restaurants" 회사 고유 개념)은 가산(+) 줄 중 이름·라벨이 매출
        const isRev = (f) => catOf(f.id, labels.get(f.id)) === "rev" || (f.w > 0 && /Revenue|Sales|Fees|Rent/i.test(`${NM(f.id)} ${labels.get(f.id) ?? ""}`) && !/Gain|Loss|Cost|Expense/i.test(NM(f.id)));
        const lines = face.filter((f) => !isRev(f)).map((f) => ({ id: f.id, label: labels.get(f.id) ?? NM(f.id), amt: Object.fromEntries(yrs.map((y) => [y.year, -f.w * (faceVal(f.id, y.end) ?? 0)])) }))
          .filter((l) => yrs.some((y) => Math.abs(l.amt[y.year]) > 0.5));
        const targets = (metric === "영업이익" ? ["cogs", "sga", "rnd", "amort", "other"] : ["cogs"]).filter((c) => yrs.every((y) => y.row[c] != null) && !(c === "rnd" && S.sgaIncludesRnd));
        if (!yrs.every((y) => y.complete)) partitionWhy = "본표 줄 합 ≠ 매출 − 영업이익(줄 누락·판본 차) — 배분 불가";
        else if (annualCount(yrs) < 2) partitionWhy = "근거 연도 1개 — 배분은 2개 연도 이상 필요";
        else if (lines.length <= 16 && targets.length) {
          // 외부 비경상 줄(SA — 영업이익 아래로 옮긴 금액): 외부 분류 + 비경상 줄 일부 = 본표 줄 부분집합이면 "본표 한 줄을 외부가 쪼갬"(TSLA "Restructuring
          // and other" 176 = SA 기타 영업비용 140 + SA 구조조정 36). 비경상 줄은 모든 해 같은 이름 집합으로만 쓴다
          const uNames = [...new Set(yrs.flatMap((y) => Object.keys(y.row.unusual ?? {})))].slice(0, 8);
          const uAmt = (i, y) => y.row.unusual?.[uNames[i]] ?? 0;
          const tolOf = (n) => tol * Math.max(1, n);
          const N = lines.length, full = (1 << N) - 1;
          // 첫해 부분집합 합 색인(백만 단위 버킷) — 이후 해는 후보만 확인
          const y0 = yrs[0], sums0 = new Float64Array(1 << N);
          for (let m = 1; m < 1 << N; m++) { const b = 31 - Math.clz32(m & -m); sums0[m] = sums0[m & (m - 1)] + lines[b].amt[y0.year]; }
          const bucket = new Map();
          for (let m = 0; m < 1 << N; m++) { const k = Math.round(sums0[m] / 1e6); if (!bucket.has(k)) bucket.set(k, []); bucket.get(k).push(m); }
          const sumAt = (mask, y) => { let t = 0; for (let i = 0; i < N; i++) if (mask & (1 << i)) t += lines[i].amt[y.year]; return t; };
          const uSum = (um, y) => { let t = 0; for (let i = 0; i < uNames.length; i++) if (um & (1 << i)) t += uAmt(i, y); return t; };
          // 주석 항목 조정(오너 지시 2026-09-27 "주석도 봐야지") — 본표 밖 사실(비용 위치별 구조조정·퇴직급여, 원가 속 감가상각 등)을 외부 분류에
          // ± 1~2개 더해 본표 줄 부분집합과 맞춘다. 우연 일치 방지: 주석 조정 배분은 3개 연도 이상, 조정 항목은 2개 연도 이상 0 아님, 손익 성격 항목만
          const faceIds = new Set(face.map((f) => f.id));
          const notes = yrs.length >= 3 ? poolArr.filter((f) => !faceIds.has(f.k) && POOL_OK.test(f.k) && !POOL_NO.test(f.k.replace(/\[.*$/, ""))
            && yrs.every((y) => f.vals.has(y.end)) && yrs.filter((y) => Math.abs(f.vals.get(y.end)) > tol).length >= 2) : [];
          const adjs = [{ t: [], v: (y) => 0 }];
          for (const f of notes) for (const sg of [1, -1]) adjs.push({ t: [[sg, f.k]], v: (y) => sg * f.vals.get(y.end) });
          const singles = adjs.length;
          if (notes.length <= 300) for (let i = 0; i < notes.length; i++) for (let j = i + 1; j < notes.length; j++) for (const a of [1, -1]) for (const b of [1, -1]) {
            const A = notes[i], B = notes[j];
            adjs.push({ t: [[a, A.k], [b, B.k]], v: (y) => a * A.vals.get(y.end) + b * B.vals.get(y.end) });
          }
          const popc = (x) => { let n = 0; while (x) { x &= x - 1; n++; } return n; };
          // 해를 2개까지 모은다(감사 MEDIUM-2 — 해가 여럿이면 어느 구성인지 확정 못 함 → 미결)
          const solveAll = (ti, used, uUsed, withNotes) => {
            if (ti === targets.length) return [[]];
            const found = [];
            const c = targets[ti];
            const adjList = withNotes ? adjs : adjs.slice(0, 1);
            for (let ai = 0; ai < adjList.length; ai++) {
              const ad = adjList[ai];
              for (let um = 0; um < 1 << uNames.length; um++) {
                if (um & uUsed) continue;
                if (ai >= singles && um) break; // 주석 두 항목 조정은 비경상 줄과 섞지 않는다
                const want0 = y0.row[c] + uSum(um, y0) + ad.v(y0);
                const k0 = Math.round(want0 / 1e6);
                for (let k = k0 - 1; k <= k0 + 1; k++) for (const mask of bucket.get(k) ?? []) {
                  if (mask & used) continue;
                  if (!yrs.every((y) => Math.abs(sumAt(mask, y) - (y.row[c] + uSum(um, y) + ad.v(y))) <= tolOf(1 + popc(um)))) continue;
                  // 우연 일치 기대 건수 = 이 분류에서 시도한 조합 수 × Π해(허용 폭 ÷ 가능한 합 범위) — 0.01 이상이면 인정하지 않는다
                  const trials = adjList.length * (1 << uNames.length) * (1 << N);
                  let pr = trials;
                  for (const y of yrs) {
                    const span = lines.reduce((t, l) => t + Math.abs(l.amt[y.year]), 0) + uNames.reduce((t, _, i) => t + Math.abs(uAmt(i, y)), 0) + Math.abs(ad.v(y)) + Math.abs(y.row[c]);
                    pr *= Math.min(1, (2 * tolOf(1 + popc(um))) / Math.max(span, 1));
                  }
                  if (pr >= 0.01) continue;
                  for (const rest of solveAll(ti + 1, used | mask, uUsed | um, withNotes)) { found.push([{ c, mask, um, adj: ad.t }, ...rest]); if (found.length >= 2) return found; }
                }
              }
            }
            return found;
          };
          let sols = solveAll(0, 0, 0, false);
          if (!sols.length && notes.length) sols = solveAll(0, 0, 0, true);
          const sol = sols.length === 1 ? sols[0] : null;
          if (sols.length > 1) partitionWhy = "본표 줄 배분 해가 여러 개 — 구성 확정 불가";
          if (sol) {
            const used = sol.reduce((m, x) => m | x.mask, 0);
            const nm = { cogs: "원가", sga: S.sgaIncludesRnd ? "판관비(연구개발비 포함)" : "판관비", rnd: "연구개발비", amort: "무형상각", other: "기타 영업비용" };
            const names = (mask) => lines.filter((_, i) => mask & (1 << i)).map((l) => l.label);
            const uTxt = (um) => uNames.filter((_, i) => um & (1 << i));
            partition = [...sol.map((x) => `외부 ${nm[x.c]}${x.um ? ` + 외부 비경상 줄[${uTxt(x.um).join(" + ")}]` : ""}${x.adj?.length ? ` ${x.adj.map(([sg, k]) => `${sg > 0 ? "+" : "−"} 주석[${k.replace(/^us-gaap_/, "")}]`).join(" ")}` : ""} = SEC 본표 [${names(x.mask).join(" + ") || "없음"}]`), `외부 영업이익에서 제외 = [${names(full & ~used).join(" + ") || "없음"}]`];
            if (metric !== "영업이익") partition.pop();
            for (const l of lineTargets) if (l !== "rev") explain[l] = { ok: true, how: `본표 줄 배분(모든 해 정확): ${partition.join(" · ")}` };
          }
        }
      }
      // 인포맥스(FactSet) 세부 줄 배분 — SEC 세전이익 식의 비매출 말단 줄 전부를 FactSet 칸(원가·판관비·기타영업비용·비경상·영업외·이자·관계기업)에
      // 빠짐없이 나눈다(세전이익이 같으면 남는 줄이 없어야 한다). 필요하면 주석 항목 1개로 한 줄을 두 칸에 쪼갠다. 우연 일치 기대 건수 0.01 미만
      if (!partition && S.full && tenK[0].faceNi && ["영업이익", "매출원가", "매출총이익"].includes(metric) && explain.rev?.ok && yrs.every((y) => y.row.below)) {
        const isRev = (f) => catOf(f.id, labels.get(f.id)) === "rev" || (f.w > 0 && /Revenue|Sales|Fees|Rent/i.test(`${NM(f.id)} ${labels.get(f.id) ?? ""}`) && !/Gain|Loss|Cost|Expense/i.test(NM(f.id)));
        // 기준을 순이익으로 — SEC 는 일부 항목(MDLZ 지분법 투자 처분이익)을 세전이익 아래에 두고 FactSet 은 세전이익 안에 둔다
        const preLeaves = tenK[0].faceNi;
        const niIsCons = /ProfitLoss$/.test(tenK[0].niRoot);
        const lines = preLeaves.filter((f) => !isRev(f)).map((f) => ({ id: f.id, label: labels.get(f.id) ?? NM(f.id), amt: Object.fromEntries(yrs.map((y) => [y.year, -f.w * (faceVal(f.id, y.end) ?? 0)])) }))
          .filter((l) => yrs.some((y) => Math.abs(l.amt[y.year]) > 0.5));
        const tg = [["cogs", (y) => y.row.cogs], ["sga", (y) => y.row.sga], ["other", (y) => y.row.other ?? 0], ["unusual", (y) => y.row.below.unusual], ["nonop", (y) => y.row.below.nonop],
          ["interest", (y) => y.row.below.interest], ["tax", (y) => y.row.below.tax], ["equity", (y) => y.row.below.equity], ["afterTax", (y) => y.row.below.afterTax], ["disc", (y) => y.row.below.disc],
          ...(niIsCons ? [] : [["minority", (y) => y.row.below.minority]])].filter(([, v]) => yrs.some((y) => Math.abs(v(y)) > tol) || true);
        // 기준(원데이터 일치): SEC 순이익(식의 뿌리 — ProfitLoss 면 연결, NetIncomeLoss 면 지배주주) = FactSet 연결순이익/당기순이익
        const secPre = (y) => faceVal(tenK[0].niRoot, y.end);
        // FactSet 순이익은 중단사업이익을 뺀 값(AMD 2025 — SEC 4,335 = FactSet 4,269 + 중단사업 66)
        const anchor = yrs.every((y) => { const f = (niIsCons ? y.row.niCons : y.row.niParent); return f != null && secPre(y) != null && Math.abs(secPre(y) - (f - y.row.below.disc)) <= tol * 3; });
        const N = lines.length;
        // SEC 쪽 완전성 — 순이익 식 비매출 줄 합 = 매출 − SEC 순이익
        const niComplete = yrs.every((y) => secPre(y) != null && Math.abs(y.sec.rev - lines.reduce((t, l) => t + l.amt[y.year], 0) - secPre(y)) <= 1);
        fsDiag = { anchor, lines: N, niComplete };
        if (anchor && !niComplete) partitionWhy = "SEC 순이익 식 줄 합 ≠ 매출 − 순이익(줄 누락·판본 차) — 배분 불가";
        if (anchor && niComplete && annualCount(yrs) < 2) partitionWhy = "근거 연도 1개 — 배분은 2개 연도 이상 필요";
        if (anchor && niComplete && annualCount(yrs) >= 2 && N <= 22) {
          const full = (1 << N) - 1, y0 = yrs[0];
          const sums0 = new Float64Array(1 << N);
          for (let m = 1; m < 1 << N; m++) { const b = 31 - Math.clz32(m & -m); sums0[m] = sums0[m & (m - 1)] + lines[b].amt[y0.year]; }
          const bucket = new Map();
          for (let m = 0; m < 1 << N; m++) { const k = Math.round(sums0[m] / 1e6); if (!bucket.has(k)) bucket.set(k, []); bucket.get(k).push(m); }
          const sumAt = (mask, y) => { let t = 0; for (let i = 0; i < N; i++) if (mask & (1 << i)) t += lines[i].amt[y.year]; return t; };
          const popc = (x) => { let n = 0; while (x) { x &= x - 1; n++; } return n; };
          const faceIds = new Set(preLeaves.map((f) => f.id));
          const notes = yrs.length >= 3 ? poolArr.filter((f) => !faceIds.has(f.k) && POOL_OK.test(f.k) && !POOL_NO.test(f.k.replace(/\[.*$/, "")) && yrs.every((y) => f.vals.has(y.end)) && yrs.filter((y) => Math.abs(f.vals.get(y.end)) > tol).length >= 2) : [];
          const adjs = [{ t: [], v: () => 0 }];
          for (const f of notes) for (const sg of [1, -1]) adjs.push({ t: [[sg, f.k]], v: (y) => sg * f.vals.get(y.end) });
          // 칸별 후보 → 조합(2026-09-27, 이동 2개까지). 칸마다 "본표 줄 부분집합 = 인포맥스 칸 값 ± 주석 항목 0~1개"가 모든 해에서 맞는 후보를 모은 뒤,
          // 줄이 겹치지 않고 전부 쓰이며 주석이 한 칸 +·다른 칸 − 로 짝지어지는(이동) 조합을 찾는다. 이동은 2개까지. 칸별 우연 일치 기대 건수 0.01 미만
          const adjOpts = [{ k: null, sg: 0, v: () => 0 }];
          if (notes.length <= 400) for (const f of notes) for (const sg of [1, -1]) adjOpts.push({ k: f.k, sg, v: (y) => sg * f.vals.get(y.end) });
          const opts = tg.map(([c, val]) => {
            const out = [];
            for (const ad of adjOpts) {
              const want0 = val(y0) + ad.v(y0), k0 = Math.round(want0 / 1e6);
              for (let k = k0 - 1; k <= k0 + 1; k++) for (const mask of bucket.get(k) ?? []) {
                if (!yrs.every((y) => Math.abs(sumAt(mask, y) - (val(y) + ad.v(y))) <= tol)) continue;
                let pr = adjOpts.length * (1 << N);
                for (const y of yrs) { const span = lines.reduce((t2, l) => t2 + Math.abs(l.amt[y.year]), 0) + Math.abs(val(y)) + Math.abs(ad.v(y)); pr *= Math.min(1, (2 * tol) / Math.max(span, 1)); }
                if (ad.k && pr >= 0.01) continue;
                if (!ad.k && pr * (adjOpts.length > 1 ? 1 : 1) >= 0.01 * adjOpts.length) continue;
                out.push({ c, mask, ad });
                if (out.length > 200) break;
              }
            }
            return out.sort((a, b) => (a.ad.k ? 1 : 0) - (b.ad.k ? 1 : 0));
          });
          const sols2 = [];
          const go = (ti, used, bal, pick) => {
            if (sols2.length >= 2) return;
            if (ti === tg.length) {
              if (used === full && [...bal.values()].every((v) => v === 0) && bal.size <= MAX_MOVES) sols2.push(pick.slice());
              return;
            }
            for (const o of opts[ti]) {
              if (o.mask & used) continue;
              const nb = new Map(bal);
              if (o.ad.k) { nb.set(o.ad.k, (nb.get(o.ad.k) ?? 0) + o.ad.sg); if (nb.get(o.ad.k) === 0) nb.set(o.ad.k, 0); }
              const open = [...nb.entries()].filter(([, v]) => v !== 0).length;
              if (nb.size > MAX_MOVES || open > tg.length - ti - 1) continue;
              pick.push(o); go(ti + 1, used | o.mask, nb, pick); pick.pop();
              if (sols2.length >= 2) return;
            }
          };
          if (opts.every((o) => o.length)) go(0, 0, new Map(), []);
          const sol = sols2.length === 1 ? sols2[0] : null;
          if (sols2.length > 1) partitionWhy = "인포맥스 줄 배분 해가 여러 개 — 구성 확정 불가";
          const moves = sol ? [...new Set(sol.filter((o) => o.ad.k).map((o) => o.ad.k))].map((k) => ({ k, from: sol.find((o) => o.ad.k === k && o.ad.sg > 0).c, to: sol.find((o) => o.ad.k === k && o.ad.sg < 0).c })) : [];
          if (sol) {
            const nm = { cogs: "상각비포함 원가", sga: "판관비(연구개발비 포함)", other: "기타영업비용", unusual: "비경상비용", nonop: "영업외손익(비용 부호)", interest: "이자비용", tax: "법인세", equity: "관계기업이익(비용 부호)", afterTax: "기타세후조정(비용 부호)", disc: "중단사업이익(비용 부호)", minority: "비지배주주귀속분" };
            const names = (mask) => lines.filter((_, i) => mask & (1 << i)).map((l) => l.label);
            // 주석 부호: 칸 값 + 주석 = 본표 줄 합 → +칸(from)은 본표 줄에 주석 금액이 더 있고(인포맥스는 그 금액을 뺌), −칸(to)은 인포맥스가 그 금액을 더 담음
            partition = [`원데이터 일치: 매출·${niIsCons ? "연결" : "지배주주"} 순이익 = SEC(모든 해)`, ...moves.map((m) => `주석[${m.k.replace(/^us-gaap_/, "")}] 금액을 SEC 쪽 ${nm[m.from]} 줄에서 인포맥스 ${nm[m.to]}(으)로 옮김`),
              ...sol.map((x) => `인포맥스 ${nm[x.c]}${x.ad.k ? ` ${x.ad.sg > 0 ? "+" : "−"} 주석[${x.ad.k.replace(/^us-gaap_/, "")}]` : ""} = SEC [${names(x.mask).join(" + ") || "없음"}]`)];
            for (const l of lineTargets) if (l !== "rev") explain[l] = { ok: true, how: `인포맥스 세부 줄 배분(모든 해 정확): ${partition.join(" · ")}` };
          }
        }
      }
      // 인포맥스 미결 사유(오너 결정 2026-09-28 — 외부 대조는 여기까지): 원데이터(매출·순이익)는 SEC 와 같은데 FactSet 이 SEC 미공시 금액으로 줄을
      // 다시 나눠(판관비 속 감가상각 등) 구성을 SEC 로 재현할 수 없음 — FactSet 정의서 미확보
      if (S.full && fsDiag?.anchor && !partition) for (const l of Object.keys(explain)) if (!explain[l].ok) explain[l].why = `${explain[l].why ?? ""} · FactSet 자체 배분 — 정의서 미확보(원데이터 매출·순이익은 SEC 일치)`;
      const ok = idOk && Object.values(explain).every((x) => x.ok);
      if (!ok && partitionWhy) for (const l of Object.keys(explain)) if (!explain[l].ok) explain[l].why = `${explain[l].why ?? ""} · ${partitionWhy}`;
      return { verdict: ok ? "②구성분해" : "미결", identity: idOk, explain, partition, partitionWhy, fsDiag, years: table.map((t) => t.year), table, resid, std };
    };
    const annualYrs = yrs.filter((y) => y.year !== "LTM"), hasLtm = yrs.some((y) => y.year === "LTM");
    const a1 = annualYrs.length ? analyze(annualYrs) : null;
    const a2 = hasLtm ? analyze(yrs) : null;
    const yearOk = {};
    for (const y of annualYrs) yearOk[y.year] = a1?.verdict !== "미결";
    if (hasLtm) yearOk.LTM = a2?.verdict !== "미결" && (a1 == null || a1.verdict !== "미결" || annualYrs.length === 0);
    const main = a1 ?? a2;
    results.push({ sym, src, metric, ...main, verdict: main.verdict, yearOk, ltm: a2 ? { verdict: a2.verdict, explain: a2.explain, partition: a2.partition } : null, years: yrs.map((y) => y.year), cells: cs.length,
      // 검증기가 이 결과를 쓸 때 같은 값인지 확인(감사 HIGH-2 — 이전 실행 결과를 값 확인 없이 붙이던 문제)
      vals: Object.fromEntries(yrs.map((y) => [y.year, { ext: y.ext, app: y.ours }])) });
  }
  const mine = results.filter((x) => x.sym === sym);
  console.log(`${sym.padEnd(5)} ${mine.map((x) => `${x.src}/${x.metric}:${x.verdict ?? "오류"}`).join("  ")}`);
}

const out = pathResolve(`reports/recon/recon-${new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 16).replace(/[-:T]/g, "")}.json`);
mkdirSync(pathResolve("reports/recon"), { recursive: true });
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), from: FROM, results }, null, 1));
const cnt = {};
for (const x of results) { if (!x.verdict) continue; if (x.yearOk) for (const ok of Object.values(x.yearOk)) cnt[ok ? "②구성분해" : "미결"] = (cnt[ok ? "②구성분해" : "미결"] ?? 0) + 1; else cnt[x.verdict] = (cnt[x.verdict] ?? 0) + (x.cells ?? 1); }
console.log(`\n칸 수 — ${Object.entries(cnt).map(([k, v]) => `${k} ${v}`).join(" · ")} · 결과 ${out}`);
