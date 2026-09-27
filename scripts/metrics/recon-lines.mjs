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
  let face = [], root = null;
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
    break;
  }
  return { ...p, facts, face, root, labels };
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
async function saLines(sym) {
  const get = async (path) => {
    const t = await (await fetch(`https://stockanalysis.com/stocks/${sym.toLowerCase()}/financials/${path}/__data.json?x-sveltekit-invalidated=001`, { headers: { "user-agent": SA_UA, accept: "application/json" }, signal: AbortSignal.timeout(20_000) })).text();
    const node = JSON.parse(t).nodes.find((n) => n?.type === "data" && JSON.stringify(n.data).includes("financialData"));
    return saUnflatten(node.data).financialData;
  };
  const f = await get("income-statement");
  const out = new Map();
  f.datekey.forEach((d, i) => {
    if (d === "TTM") return;
    const v = (k) => f[k]?.[i] ?? null;
    const sga = v("sgna"), rnd = v("rnd"), amort = v("goodwillIntangibleAmortization"), opex = v("opex");
    out.set(d, {
      rev: v("revenue"), cogs: v("cor"), gp: v("gp"), sga, rnd, amort,
      other: opex != null ? opex - (sga ?? 0) - (rnd ?? 0) - (amort ?? 0) : null, op: v("opinc"), da: v("depAmorEbitda"),
    });
  });
  return { rows: out, unit: 1e6, lines: { sga: "sgna", rnd: "rnd", amort: "goodwillIntangibleAmortization", other: "opex − sgna − rnd − 상각" } };
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
  const out = new Map();
  for (const r of ya) {
    const sga = r.sellingGeneralAndAdministration ?? null, rnd = r.researchAndDevelopment ?? null, opex = r.operatingExpense ?? null;
    out.set(new Date(r.date).toISOString().slice(0, 10), {
      rev: r.totalRevenue ?? null, cogs: r.costOfRevenue ?? null, gp: r.grossProfit ?? null, sga, rnd, amort: null,
      other: opex != null ? opex - (sga ?? 0) - (rnd ?? 0) : null, op: r.totalOperatingIncomeAsReported ?? r.operatingIncome ?? null, da: r.reconciledDepreciation ?? null,
    });
  }
  return { rows: out, unit: 1, lines: { sga: "sellingGeneralAndAdministration", rnd: "researchAndDevelopment", other: "operatingExpense − 판관비 − 연구개발비" } };
}
const IM = "https://globalmonitor.einfomax.co.kr";
async function infomaxLines(sym) {
  const post = (p, b) => fetch(IM + p, { method: "POST", headers: { "content-type": "application/json", referer: IM + "/sss.html" }, body: JSON.stringify(b), signal: AbortSignal.timeout(15_000) }).then((r) => r.json());
  const t = await post("/facset/tickerlist/usa", { ticker: sym });
  const code = t?._source?.["인포맥스코드"];
  if (!code || t._source["티커"]?.toUpperCase() !== sym) return null;
  const k = await post("/facset/getKeyData", { param: code });
  const M = (v) => (v != null ? Math.round(v * 1e6) : null);
  const out = new Map();
  for (const r of k?.y_report ?? []) {
    const rev = M(r["매출"]), gp = M(r["매출총이익"]), op = M(r["영업이익"]), sga = M(r["판관비"]);
    out.set(String(r["결산년월"]).slice(0, 10), {
      rev, gp, cogs: rev != null && gp != null ? rev - gp : null, sga, rnd: null, amort: null,
      // 인포맥스(FactSet) 영업이익 = 매출총이익 − 판관비 인지 칸마다 확인 — 아니면 그 차이가 "기타"
      other: gp != null && sga != null && op != null ? gp - sga - op : null, op, da: M(r["ebitda"]) != null && op != null ? M(r["ebitda"]) - op : null,
    });
  }
  // 인포맥스(FactSet) 판관비 = 판관비 + 연구개발비(AMAT·AMD 실측 — 연구개발비 줄이 따로 없음)
  return { rows: out, unit: 1e3, sgaIncludesRnd: true, lines: { sga: "판관비(연구개발비 포함)", other: "매출총이익 − 판관비 − 영업이익" } };
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
  // 두 항목 — 크기로 가지치기(첫 해 기준)
  const y0 = ys[0], t0 = d.get(y0);
  const byV = cand.map((f) => ({ f, v: f.vals.get(y0) })).filter((x) => x.v !== 0 && Math.abs(x.v) <= Math.abs(t0) * 20 + 1e9);
  for (let i = 0; i < byV.length; i++) for (let j = i + 1; j < byV.length; j++) for (const a of [1, -1]) for (const b of [1, -1]) {
    if (Math.abs(a * byV[i].v + b * byV[j].v - t0) > tol) continue;
    if (ys.every((y) => Math.abs(a * byV[i].f.vals.get(y) + b * byV[j].f.vals.get(y) - d.get(y)) <= tol)) return { terms: [{ k: byV[i].f.k, s: a }, { k: byV[j].f.k, s: b }] };
  }
  return null;
}

// ── 대상 칸(최신 검증 결과) ──────────────────────────────────────────────
const FROM = args.from ?? "verify-us-20260927-1733";
const files = readdirSync("reports/verify").filter((x) => x >= FROM && x.startsWith("verify-us-") && x.endsWith(".json")).sort();
const latest = new Map();
for (const x of files) for (const r of JSON.parse(readFileSync(`reports/verify/${x}`, "utf8")).results) latest.set(r.sym, r);
const METRICS = ["매출", "매출원가", "매출총이익", "영업이익", "감가상각비"];
const WEAK = new Set(["외부정의분해불가", "외부단독이탈", "③"]);
const want = args.symbols ? new Set(String(args.symbols).split(",").map((s) => s.trim().toUpperCase())) : null;
const SRC = { Yahoo: yahooLines, StockAnalysis: saLines, 인포맥스: infomaxLines };

const results = [];
for (const [sym, r] of latest) {
  if (want && !want.has(sym)) continue;
  // 대상: 연간 열 외부 대조 중 약한 분류(구성 분해 없이 넘긴 칸)
  const cells = [];
  for (const x of r.review ?? []) {
    const m = /^(\d{4})Y (.+)$/.exec(x.item);
    if (!m || !METRICS.includes(m[2])) continue;
    const cls = x.metricClass ?? x.revenueClass;
    if (!cls) continue;
    for (const [n, c] of Object.entries(cls)) if (WEAK.has(c)) cells.push({ year: m[1], metric: m[2], src: n, cls: c, ours: x.ours, ext: x.sources[n] });
  }
  if (!cells.length) continue;
  const cik = await cikOf(sym);
  if (!cik) { results.push({ sym, err: "CIK 없음" }); continue; }
  const sub = JSON.parse(await secRaw(`https://data.sec.gov/submissions/CIK${cik}.json`));
  const rc = sub.filings.recent;
  const ks = [];
  for (let i = 0; i < rc.form.length && ks.length < 2; i++) if (/^(10-K|20-F)$/.test(rc.form[i])) ks.push({ accn: rc.accessionNumber[i], report: rc.reportDate[i], form: rc.form[i] });
  const tenK = [];
  for (const p of ks) { try { const t = await readTenK(cik, p); if (t) tenK.push(t); } catch (e) { results.push({ sym, err: `10-K ${p.report} 판독 실패: ${String(e).slice(0, 80)}` }); } }
  if (!tenK.length) continue;
  // 항목 풀 — 최신 10-K 우선(재작성), 없으면 이전 10-K
  const pool = new Map();
  for (const t of tenK) for (const [k, vs] of t.facts) { if (!pool.has(k)) pool.set(k, new Map()); for (const [y, v] of vs) if (!pool.get(k).has(y)) pool.get(k).set(y, v); }
  const poolArr = [...pool].map(([k, vals]) => ({ k, vals }));
  const face = tenK[0].face, labels = tenK[0].labels;
  const faceVal = (id, y) => pool.get(id)?.get(y) ?? null;
  const yEnd = (yr) => [...(pool.get("us-gaap_Revenues") ?? pool.get(face.find((f) => catOf(f.id) === "rev")?.id ?? "") ?? new Map()).keys()].find((e) => e.startsWith(yr)) ?? [...new Set(poolArr.flatMap((p) => [...p.vals.keys()]))].find((e) => e.slice(0, 4) === yr);

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
    const rowOf = (end) => [...S.rows].find(([d]) => Math.abs(Date.parse(d) - Date.parse(end)) <= 10 * 864e5)?.[1] ?? null;
    // 앱(= SEC) 연도별 값 — 본표 줄 합으로 분해할 때 쓰는 SEC 줄 값
    // 앱 값(= SEC 본표, A층 통과) — 같은 해 매출·매출원가·영업이익
    const appOf = (yr, m) => (r.review ?? []).find((x) => x.item === `${yr}Y ${m}`)?.ours ?? null;
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
      if (aOp != null && aRev != null && aCogs != null) sec.other = aRev - aCogs - sec.sga - sec.rnd - sec.amort - aOp;
      if (S.sgaIncludesRnd) { sec.sga += sec.rnd; secLines.sga.push(...secLines.rnd); sec.rnd = 0; secLines.rnd = []; }
      yrs.push({ ...c, end, row, sec, secLines });
    }
    if (!yrs.length) { results.push({ sym, src, metric, verdict: "미결", why: "연도 대응 없음(SEC 결산일 ↔ 외부 기간)", cells: cs.length }); continue; }
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
    let partition = null;
    if (!Object.values(explain).every((x) => x.ok) && idOk && ["영업이익", "매출원가", "매출총이익"].includes(metric) && explain.rev?.ok) {
      // 매출 줄 제외 — 개념 이름 분류가 놓치는 매출 줄(MCD "Sales by Company-operated restaurants" 회사 고유 개념)은 가산(+) 줄 중 이름·라벨이 매출
      const isRev = (f) => catOf(f.id, labels.get(f.id)) === "rev" || (f.w > 0 && /Revenue|Sales|Fees|Rent/i.test(`${NM(f.id)} ${labels.get(f.id) ?? ""}`) && !/Gain|Loss|Cost|Expense/i.test(NM(f.id)));
      const lines = face.filter((f) => !isRev(f)).map((f) => ({ id: f.id, label: labels.get(f.id) ?? NM(f.id), amt: Object.fromEntries(yrs.map((y) => [y.year, -f.w * (faceVal(f.id, y.end) ?? 0)])) }))
        .filter((l) => yrs.some((y) => Math.abs(l.amt[y.year]) > 0.5));
      const targets = (metric === "영업이익" ? ["cogs", "sga", "rnd", "amort", "other"] : ["cogs"]).filter((c) => yrs.every((y) => y.row[c] != null) && !(c === "rnd" && S.sgaIncludesRnd));
      if (lines.length <= 16 && targets.length) {
        const fits = (mask, c) => yrs.every((y) => { let s = 0; lines.forEach((l, i) => { if (mask & (1 << i)) s += l.amt[y.year]; }); return Math.abs(s - y.row[c]) <= tol * Math.max(1, lines.length / 2); });
        const solve = (ti, used) => {
          if (ti === targets.length) return [];
          for (let mask = 0; mask < 1 << lines.length; mask++) {
            if (mask & used) continue;
            if (!fits(mask, targets[ti])) continue;
            const rest = solve(ti + 1, used | mask);
            if (rest) return [{ c: targets[ti], mask }, ...rest];
          }
          return null;
        };
        const sol = solve(0, 0);
        if (sol) {
          const used = sol.reduce((m, x) => m | x.mask, 0);
          const nm = { cogs: "원가", sga: S.sgaIncludesRnd ? "판관비(연구개발비 포함)" : "판관비", rnd: "연구개발비", amort: "무형상각", other: "기타 영업비용" };
          const names = (mask) => lines.filter((_, i) => mask & (1 << i)).map((l) => l.label);
          partition = [...sol.map((x) => `외부 ${nm[x.c]} = SEC 본표 [${names(x.mask).join(" + ") || "없음"}]`), `외부 영업이익에서 제외 = [${names(((1 << lines.length) - 1) & ~used).join(" + ") || "없음"}]`];
          if (metric !== "영업이익") partition.pop();
          for (const l of lineTargets) if (l !== "rev") explain[l] = { ok: true, how: `본표 줄 배분(모든 해 정확): ${partition.join(" · ")}` };
        }
      }
    }
    const ok = idOk && Object.values(explain).every((x) => x.ok);
    results.push({ sym, src, metric, verdict: ok ? "②구성분해" : "미결", identity: idOk, explain, partition, years: table.map((t) => t.year), cells: cs.length, table, resid, std });
  }
  const mine = results.filter((x) => x.sym === sym);
  console.log(`${sym.padEnd(5)} ${mine.map((x) => `${x.src}/${x.metric}:${x.verdict ?? "오류"}`).join("  ")}`);
}

const out = pathResolve(`reports/recon/recon-${new Date(Date.now() + 9 * 36e5).toISOString().slice(0, 16).replace(/[-:T]/g, "")}.json`);
mkdirSync(pathResolve("reports/recon"), { recursive: true });
writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), from: FROM, results }, null, 1));
const cnt = {};
for (const x of results) if (x.verdict) cnt[x.verdict] = (cnt[x.verdict] ?? 0) + (x.cells ?? 1);
console.log(`\n칸 수 — ${Object.entries(cnt).map(([k, v]) => `${k} ${v}`).join(" · ")} · 결과 ${out}`);
