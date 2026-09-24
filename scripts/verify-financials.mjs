/**
 * 재무 숫자 검증 (오너 지시 2026-09-23 "검증체계는 구축해라", 2026-09-24 재구축).
 *
 * 1층(단일 계산 모듈 강제)은 eslint.config.mjs 의 no-restricted-syntax 규칙이다.
 * 이 스크립트는 **실행 중인 앱의 API** 를 호출해 사용자가 보는 숫자를 검사한다.
 *
 * ── 2026-09-24 재구축 이유 (독립 감사에서 재현된 결함) ──────────────────
 *  - 양쪽 화면이 모두 빈칸이면 "통과"로 쳤다 → TSM·ASML 은 연도 열이 통째로 없는데 통과.
 *  - 검사가 앱 대 앱 비교뿐이라 모든 화면에 같이 퍼진 오류(순이익 ×1.1)를 못 잡았다.
 *  - 연도를 앱과 같은 방식(결산일 연도)으로 맞춰 52/53주 결산 회사(WEN)의 연도 누락을 놓쳤다.
 *  - 조회 실패·검사 0건·건너뜀이 "실패 0"으로 끝났다(조용히 사라지는 검사).
 *  - 기준값이 없으면 정의가 다른 값으로 조용히 대체했다(AVGO — 우선주배당 포함 순이익).
 *  - 개요 검사는 화면 값을 읽지 않고 식을 다시 짜서 계산했다.
 *
 * ── 원칙 ───────────────────────────────────────────────────────────────
 *  1. 통과는 **양쪽 값이 있고 같을 때만**. 양쪽 빈칸은 "검증불가(양쪽 빈칸)".
 *  2. 있어야 할 값이 빈칸이면 **실패**(기대치 검사). 기대치는 앱이 아니라 SEC 원자료로 정한다.
 *  3. 기준값은 대체하지 않는다. 정의상 같은 값으로 바꿀 때만 쓰고 결과에 사유를 남긴다.
 *  4. 조회 실패·검사 누락은 모두 기록하고 종료코드 1 로 끝난다.
 *  5. 앱 계산을 재현하지 않는다 — 앱이 실제로 낸 값(API·verify-row)만 비교한다.
 *
 * ── 층 ────────────────────────────────────────────────────────────────
 *  A. SEC 원자료 대조(미국) — 앱 순이익·EPS 를 SEC companyfacts(+XBRL 인스턴스)와 직접.
 *     EPS 분할 보정 계수는 Yahoo 분할 이력으로 따로 구한다(앱 로직과 독립).
 *  B. 결산 기간 대조 — SEC 10-K 결산일 목록과 앱 연도 열(날짜 ±7일).
 *  C. 화면 간 동일성 — 하이라이트↔재무분석↔손익·대차대조표↔컨센서스↔개요·유니버스(verify-row).
 *  D. 항등식·부호 규칙 — EV 브릿지, EV/EBITDA, 분모 0 이하면 배수 빈칸, 자산=부채+자본.
 *  E. 공시 내부 정합성 — 공시 EPS × 가중평균 주식수 ≈ 보통주 귀속 순이익(회사 공시 자체).
 *  F. 외부 대조(검토 목록, 판정 아님) — Yahoo EBITDA·차입금(기준일 일치할 때만), 인포맥스 주식수.
 *
 * 실행:
 *   node scripts/verify-financials.mjs --symbols=AAPL,WMT
 *   node scripts/verify-financials.mjs --universe | --sp500 [--limit=50]
 *   node scripts/verify-financials.mjs --market=kr --symbols=005930
 *   옵션: --base=http://localhost:3000 · --concurrency=2 · --no-external
 * 결과: reports/verify/verify-{market}-{YYYYMMDD-HHmm KST}.json. 실패·오류·누락이 있으면 종료코드 1.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

// ── 인자 ─────────────────────────────────────────────────────────────
const args = {};
for (const a of process.argv.slice(2)) {
  const m = /^--([a-z0-9-]+)(?:=(.*))?$/i.exec(a);
  if (!m) die(`알 수 없는 인자: ${a}`);
  args[m[1]] = m[2] ?? true;
}
function die(msg) {
  console.error(`오류: ${msg}`);
  process.exit(2);
}
const KNOWN = new Set(["symbols", "universe", "sp500", "limit", "market", "base", "concurrency", "no-external", "post", "missing"]);
for (const k of Object.keys(args)) if (!KNOWN.has(k)) die(`알 수 없는 옵션 --${k}`);
if (args.symbols === true) die("--symbols 에 종목을 지정하세요 (예: --symbols=AAPL,WMT)");
const MARKET = String(args.market ?? "us").toLowerCase();
if (MARKET !== "us" && MARKET !== "kr") die(`--market 은 us 또는 kr (받은 값: ${args.market})`);
const CONCURRENCY = Number(args.concurrency ?? 2);
if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1) die(`--concurrency 는 1 이상의 정수 (받은 값: ${args.concurrency})`);
if (args.limit != null && !(Number.isInteger(Number(args.limit)) && Number(args.limit) > 0)) die(`--limit 은 양의 정수`);
const BASE = String(args.base ?? "http://localhost:3000").replace(/\/$/, "");
const EXTERNAL = !args["no-external"];

function loadEnvLocal() {
  const env = { ...process.env };
  try {
    const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*?)"?\s*$/);
      if (m && (env[m[1]] === undefined || env[m[1]] === "")) env[m[1]] = m[2];
    }
  } catch {
    /* .env.local 없어도 됨 */
  }
  return env;
}
const env = loadEnvLocal();
const AUTH = env.CRON_SECRET ? { authorization: `Bearer ${env.CRON_SECRET}` } : { "x-app-token": env.APP_PASSWORD ?? "" };

async function getJson(path, timeoutMs = 240_000, headers = {}) {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store", headers });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

async function symbolList() {
  if (args.symbols) return String(args.symbols).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  // 유니버스 중 아직 검증 결과가 없는 종목만(새로 담긴 종목) — 관리자 화면 "미검증"과 같은 목록
  if (args.missing) {
    const r = await fetch(`${BASE}/api/cron/verify-results?market=${MARKET}`, { headers: AUTH });
    if (!r.ok) throw new Error(`미검증 목록 조회 실패 HTTP ${r.status} ${(await r.text()).slice(0, 80)}`);
    const items = (await r.json()).items.map((i) => i.symbol);
    if (!items.length) {
      console.log("미검증 종목 없음");
      process.exit(0);
    }
    return items;
  }
  if (args.universe) {
    const r = await fetch(`${BASE}/api/cron/universe-symbols?market=${MARKET}`, { headers: AUTH });
    if (!r.ok) throw new Error(`유니버스 목록 조회 실패 HTTP ${r.status} ${(await r.text()).slice(0, 80)}`);
    return (await r.json()).items.map((i) => i.symbol);
  }
  if (args.sp500) {
    if (MARKET !== "us") die("--sp500 은 미국 전용");
    const res = await fetch("https://en.wikipedia.org/w/index.php?title=List_of_S%26P_500_companies&action=raw", {
      headers: { "user-agent": "financial-verify-script" },
    });
    if (!res.ok) throw new Error(`S&P 500 목록 조회 실패 HTTP ${res.status}`);
    const raw = await res.text();
    const tbl = raw.slice(raw.indexOf("{|"), raw.indexOf("|}", raw.indexOf("{|")));
    const out = [];
    // 금융업(은행 레이아웃)도 포함한다 — 예전엔 빼서 은행 경로가 검증되지 않았다
    for (const row of tbl.split("\n|-").slice(1)) {
      const m = row.match(/\{\{(?:NyseSymbol|NasdaqSymbol|[A-Za-z]+Symbol)\|([A-Z.\-]+)/i);
      if (m) out.push(m[1].replace(".", "-"));
    }
    if (out.length < 400) throw new Error(`S&P 500 목록 파싱 이상 (${out.length}개)`);
    return args.limit ? out.slice(0, Number(args.limit)) : out;
  }
  die("--symbols=… | --universe | --sp500 중 하나를 지정하세요");
}

// ── SEC ──────────────────────────────────────────────────────────────
const SEC_UA = env.SEC_USER_AGENT || "global-market-research (personal use) contact@example.com";
async function secJson(url) {
  const r = await fetch(url, { headers: { "user-agent": SEC_UA }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`SEC ${url} → HTTP ${r.status}`);
  return r.json();
}
async function secText(url) {
  const r = await fetch(url, { headers: { "user-agent": SEC_UA }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`SEC ${url} → HTTP ${r.status}`);
  return r.text();
}
let cikMap = null;
// 앱(edgar.ts CIK_OVERRIDE)과 같은 보정 — 목록이 어긋나면 SEC 대조 결과에 드러난다
const CIK_OVERRIDE = { XOM: "0000034088" };
async function cikOf(sym) {
  if (!cikMap) {
    const j = await secJson("https://www.sec.gov/files/company_tickers.json");
    cikMap = new Map(Object.values(j).map((r) => [r.ticker.toUpperCase().replace(".", "-"), String(r.cik_str).padStart(10, "0")]));
  }
  return CIK_OVERRIDE[sym.toUpperCase()] ?? cikMap.get(sym.toUpperCase().replace(".", "-")) ?? null;
}

// ── 판정 도우미 ───────────────────────────────────────────────────────
const PASS = "pass", FAIL = "fail", NA = "unverifiable";
const EXACT = 1e-9; // 화면 간 동일성 — 같은 모듈을 거치므로 부동소수 오차만
function same(a, b, tol = EXACT) {
  if (a == null && b == null) return { status: NA, note: "양쪽 빈칸" };
  if (a == null || b == null) return { status: FAIL, note: `한쪽만 빈칸 (${a} vs ${b})` };
  const d = Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
  return d <= tol ? { status: PASS } : { status: FAIL, note: `${a} vs ${b} (차 ${(d * 100).toFixed(4)}%)` };
}
/** 앱 값 vs 원자료 기준값 — 기준값이 있으면 앱 값도 있어야 한다 */
function vsSource(app, src, tol, srcNote = "") {
  if (src == null) return { status: NA, note: `원자료 없음${srcNote ? ` (${srcNote})` : ""}` };
  if (app == null) return { status: FAIL, note: `원자료 ${src} 있는데 앱 빈칸${srcNote ? ` · ${srcNote}` : ""}` };
  const d = Math.abs(app - src) / Math.max(Math.abs(src), 1e-12);
  return d <= tol
    ? { status: PASS, ...(srcNote ? { note: srcNote } : {}) }
    : { status: FAIL, note: `앱 ${app} vs 원자료 ${src} (차 ${(d * 100).toFixed(3)}%)${srcNote ? ` · ${srcNote}` : ""}` };
}
const dayDiff = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;
/** SEC 세전이익 개념 — 앱 edgar-ev.ts 와 같은 두 개념(지분법 포함/제외) */
const PRETAX_TAGS = [
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
];

// ── SEC 연간 사실 (결산 기간 = (start, end) 단위, 연도 키 아님) ────────────
function annualPeriods(facts, ns, concept, unit) {
  // end → 가장 최근 공시 사실 (10-K·10-K/A·20-F, 300~400일 기간)
  const m = new Map();
  for (const e of facts?.[ns]?.[concept]?.units?.[unit] ?? []) {
    if (!e.start || !/^(10-K|20-F)/.test(e.form)) continue;
    const d = (Date.parse(e.end) - Date.parse(e.start)) / 864e5;
    if (d < 300 || d > 400) continue;
    const p = m.get(e.end);
    if (!p || (e.filed ?? "") >= (p.filed ?? "")) m.set(e.end, e);
  }
  return m;
}
/** 결산일(±7일)로 찾기 */
function atEnd(map, date) {
  let best = null;
  for (const [end, e] of map) if (dayDiff(end, date) <= 7 && (!best || dayDiff(end, date) < dayDiff(best.end, date))) best = e;
  return best;
}

// ── 클래스별 공시(Visa·Alphabet) — 10-K XBRL 인스턴스를 앱과 별개로 직접 읽는다 ──
async function classFactsFromInstances(cik, maxFilings = 3) {
  const sub = await secJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const r = sub.filings.recent;
  const out = new Map(); // 결산일 → { eps, shares, basis, basic }
  let n = 0;
  for (let i = 0; i < r.form.length && n < maxFilings; i++) {
    if (r.form[i] !== "10-K") continue;
    n++;
    const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${r.accessionNumber[i].replace(/-/g, "")}`;
    const idx = await secJson(`${base}/index.json`);
    const name = idx.directory.item.map((x) => x.name).find((x) => /_htm\.xml$/i.test(x));
    if (!name) continue;
    const xml = await secText(`${base}/${name}`);
    const ctx = new Map();
    for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
      const b = m[2];
      const start = /<(?:xbrli:)?startDate>([^<]+)</.exec(b)?.[1];
      const end = /<(?:xbrli:)?endDate>([^<]+)</.exec(b)?.[1];
      // explicitMember 만 해석 — typedMember 가 있으면 차원 개수에만 반영해 "차원 없음"으로 오인하지 않는다
      const dims = [...b.matchAll(/dimension="([^"]+)"[^>]*>([^<]*)</g)].map((d) => [d[1].split(":").pop(), d[2].trim().split(":").pop()]);
      ctx.set(m[1], { start, end, dims });
    }
    const facts = (tag) => {
      const res = [];
      for (const m of xml.matchAll(new RegExp(`<us-gaap:${tag}(?=[\\s>])([^>]*)>([^<]+)</us-gaap:${tag}>`, "g"))) {
        const c = ctx.get(/contextRef="([^"]+)"/.exec(m[1])?.[1]);
        if (!c?.start || !c.end) continue;
        const d = (Date.parse(c.end) - Date.parse(c.start)) / 864e5;
        if (d < 300 || d > 400) continue;
        const cls = c.dims.length === 1 && c.dims[0][0] === "StatementClassOfStockAxis" ? c.dims[0][1] : null;
        if (c.dims.length && !cls) continue;
        res.push({ end: c.end, val: Number(m[2]), cls });
      }
      return res;
    };
    const isA = (m) => /classa(member)?$/i.test(m ?? "");
    const eps = facts("EarningsPerShareDiluted"), sh = facts("WeightedAverageNumberOfDilutedSharesOutstanding");
    const epsB = facts("EarningsPerShareBasic"), shB = facts("WeightedAverageNumberOfSharesOutstandingBasic");
    for (const end of new Set([...eps, ...sh, ...epsB].map((e) => e.end))) {
      if (out.has(end)) continue;
      const at = (arr, pred) => arr.find((e) => e.end === end && pred(e));
      const e0 = at(eps, (e) => !e.cls), eA = at(eps, (e) => isA(e.cls)), s0 = at(sh, (e) => !e.cls), sA = at(sh, (e) => isA(e.cls));
      const eB = at(epsB, (e) => !e.cls);
      // 같은 클래스 값이 문맥 ID 만 달리 반복되는 경우 — 클래스당 하나(값이 다르면 판정 보류)
      const byCls = new Map();
      let conflict = false;
      for (const e of shB.filter((x) => x.end === end && x.cls)) {
        if (byCls.has(e.cls) && byCls.get(e.cls) !== e.val) conflict = true;
        byCls.set(e.cls, e.val);
      }
      const filed = r.filingDate[i];
      if (e0 && s0) out.set(end, { eps: e0.val, shares: s0.val, filed, basis: "인스턴스(차원 없음)" });
      // Class A as-converted 는 회사 전체 EPS 가 아예 없는 Visa 형에서만 성립(Alphabet 은 C 가 남는다)
      else if (!e0 && eA && sA) out.set(end, { eps: eA.val, shares: sA.val, filed, asConverted: true, basis: "인스턴스 — Class A EPS × Class A 희석주식수(as-converted)" });
      // 희석 주식수는 클래스끼리 더하면 이중 계산(Class A 희석분에 B 전환분 포함) → 기본 EPS × 기본 주식수 합
      else if (eB && byCls.size && !conflict)
        out.set(end, { eps: eB.val, shares: [...byCls.values()].reduce((t, v) => t + v, 0), filed, basic: true, basis: `인스턴스 — 기본 EPS × 기본 주식수 클래스 합(${[...byCls.keys()].map((k) => k.replace(/Member$/, "")).join("+")})` });
    }
  }
  return out;
}

// ── 총수익 안의 비영업 수익(지분법·기타수익) — 앱(edgar-revenue-dims.ts)과 별개로 10-K 원본을 직접 읽는다 ──
// 영업이익 태그가 없는 회사만. 기대 매출(결산일 → { v, basis }):
//   (1) 원본 Revenues 에 제품·서비스 차원의 지분법·기타수익 멤버가 있으면 총수익 − 그 멤버 합(XOM)
//   (2) 없으면 원본의 차원 없는 지분법·기타수익 태그 합이 "총수익 − 고객계약 매출"과 0.5% 안에서 맞고(차이 ≥ 1%)
//       연간 고객계약 매출이 총수익을 넘는 해가 없을 때 고객계약 매출(CVX)
async function nonopSplitFromInstances(cik, G) {
  const out = new Map();
  if ((G.OperatingIncomeLoss?.units?.USD ?? []).some((e) => e.end >= "2020-01-01") || !G.Revenues) return out;
  const sub = await secJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const r = sub.filings.recent;
  // 연간(300일 초과)만 — 10-K 에 fp=FY 로 달린 4분기 값을 연간 기대값으로 쓰지 않게(감사 2026-09-24)
  const isYear = (e) => e.start && (Date.parse(e.end) - Date.parse(e.start)) / 864e5 > 300;
  const rfcFy = (G.RevenueFromContractWithCustomerExcludingAssessedTax?.units?.USD ?? []).filter((e) => e.fp === "FY" && isYear(e));
  const revFy = (G.Revenues?.units?.USD ?? []).filter((e) => e.fp === "FY" && isYear(e));
  const rfcOverTotal = revFy.some((t) => rfcFy.some((x) => x.start === t.start && x.end === t.end && x.val > t.val));
  let n = 0, structural = 0;
  const rfcCand = new Map();
  for (let i = 0; i < r.form.length && n < 3; i++) {
    if (r.form[i] !== "10-K") continue;
    n++;
    const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${r.accessionNumber[i].replace(/-/g, "")}`;
    const idx = await secJson(`${base}/index.json`);
    const name = idx.directory.item.map((x) => x.name).find((x) => /_htm\.xml$/i.test(x));
    if (!name) continue;
    const xml = await secText(`${base}/${name}`);
    const ctx = new Map();
    for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
      const b = m[2];
      ctx.set(m[1], {
        start: /<(?:xbrli:)?startDate>([^<]+)</.exec(b)?.[1], end: /<(?:xbrli:)?endDate>([^<]+)</.exec(b)?.[1],
        dims: [...b.matchAll(/dimension="([^"]+)"[^>]*>([^<]*)</g)].map((d) => [d[1].split(":").pop(), d[2].trim().split(":").pop()]),
      });
    }
    const annual = (c) => c?.start && c.end && (Date.parse(c.end) - Date.parse(c.start)) / 864e5 > 300;
    const total = new Map(), dimNonop = new Map(), undim = new Map();
    for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*)>(-?[\d.]+)<\/\1:\2>/g)) {
      const c = ctx.get(/contextRef="([^"]+)"/.exec(m[3])?.[1]);
      if (!annual(c) || !/unitRef="[^"]*usd/i.test(m[3])) continue;
      const v = Number(m[4]);
      if (m[1] === "us-gaap" && m[2] === "Revenues") {
        if (!c.dims.length) total.set(c.end, v);
        else if (c.dims.length === 1 && c.dims[0][0] === "ProductOrServiceAxis" && /EquityAffiliate|EquityMethod|EquityCompan|OtherRevenueMember|OtherIncomeMember/i.test(c.dims[0][1])) {
          const k = c.end + "|" + c.dims[0][1];
          if (!dimNonop.has(k)) dimNonop.set(k, { end: c.end, v });
        }
      } else if (!c.dims.length && /^(EquityMethodInvestmentIncome|IncomeFromEquityAffiliates|IncomeLossFromEquityMethodInvestments|EquityInEarningsOfAffiliates|NonoperatingIncome|OtherIncome|OtherNonoperatingIncome)$/.test(m[2])) {
        const k = c.end + "|" + m[2];
        if (!undim.has(k)) undim.set(k, { end: c.end, v });
      }
    }
    if (dimNonop.size) {
      for (const [end, t] of total) {
        if (out.has(end)) continue;
        const parts = [...dimNonop.values()].filter((d) => d.end === end);
        if (parts.length) out.set(end, { v: t - parts.reduce((a, d) => a + d.v, 0), basis: "10-K 원본 총수익 − 지분법·기타수익(제품·서비스 차원)" });
      }
    } else {
      for (const [end, t] of total) {
        const rf = rfcFy.find((x) => x.end === end);
        if (!rf || t - rf.val < 0.01 * Math.abs(t)) continue;
        const list = [...undim.values()].filter((d) => d.end === end).slice(0, 10);
        for (let mask = 1; mask < 1 << list.length; mask++) {
          const v = list.filter((_, j) => mask & (1 << j)).reduce((a, d) => a + d.v, 0);
          if (Math.abs(t - v - rf.val) <= 0.005 * Math.abs(rf.val)) { structural++; break; }
        }
        rfcCand.set(end, rf.val);
      }
    }
  }
  if (!out.size && structural >= 2 && !rfcOverTotal)
    for (const e of rfcFy) if (!out.has(e.end)) out.set(e.end, { v: e.val, basis: "고객계약 매출(총수익 − 지분법·기타수익, 10-K 원본으로 구조 확인)" });
  return out;
}

// ── Yahoo (분할 이력·외부 대조) ───────────────────────────────────────
let yf = null;
async function yahoo() {
  if (!yf) {
    const req = createRequire(new URL("../package.json", import.meta.url));
    const mod = await import(new URL(`file:///${req.resolve("yahoo-finance2").replace(/\\/g, "/")}`).href);
    const YF = mod.default?.default ?? mod.default ?? mod;
    yf = new YF({ suppressNotices: ["yahooSurvey", "ripHistorical"], validation: { logErrors: false } });
  }
  return yf;
}
/** 분할 이력 [{date, ratio}] — EPS 분할 보정 계수를 앱과 독립으로 구한다 */
async function splitsOf(sym) {
  const c = await (await yahoo()).chart(sym, { period1: "2000-01-01", interval: "1mo", events: "split" });
  const all = (c.events?.splits ?? []).map((s) => ({ date: new Date(s.date).toISOString().slice(0, 10), num: s.numerator, den: s.denominator, ratio: s.numerator / s.denominator }));
  // Yahoo 는 분사(spin-off) 가격 조정도 "분할"로 준다(WDC→SNDK 1323:1000, GE→GEV 1253:1000).
  // 주식수가 바뀌는 진짜 분할·병합만 EPS 보정에 쓰고(분자·분모가 작은 정수), 분사는 따로 돌려준다.
  const isSplit = (s) => Number.isInteger(s.num) && Number.isInteger(s.den) && s.num <= 100 && s.den <= 100 && (s.num <= 20 || s.den === 1) && (s.den <= 20 || s.num === 1);
  return { splits: all.filter(isSplit), spinoffs: all.filter((s) => !isSplit(s)) };
}
const IM = "https://globalmonitor.einfomax.co.kr";
/** 인포맥스(FactSet) 연간 재무 — USD 환산값(백만). 외화 공시 기업의 독립 대조 기준 */
async function infomaxAnnual(sym) {
  const post = (p, b) => fetch(IM + p, { method: "POST", headers: { "content-type": "application/json", referer: IM + "/sss.html" }, body: JSON.stringify(b), signal: AbortSignal.timeout(15_000) }).then((r) => (r.ok ? r.json() : Promise.reject(new Error("인포맥스 HTTP " + r.status))));
  const t = await post("/facset/tickerlist/usa", { ticker: sym });
  const code = t?._source?.["인포맥스코드"];
  if (!code || t._source["티커"]?.toUpperCase() !== sym) return null;
  const k = await post("/facset/getKeyData", { param: code });
  const M = (v) => (v != null ? v * 1e6 : null);
  // 인포맥스 = FactSet(오너 지시 2026-09-24 — "잘 활용"). 백만 달러 단위, EPS 는 달러
  const row = (r) => ({
    end: String(r["결산년월"]).slice(0, 10), rev: M(r["매출"]), ni: M(r["당기순익"]), ebitda: M(r["ebitda"]),
    op: M(r["영업이익"]), assets: M(r["자산총계"]), mc: M(r["시가총액"]), ev: M(r["ev희석화수량"]), eps: r["eps"] ?? null,
    da: r["ebitda"] != null && r["영업이익"] != null ? M(r["ebitda"] - r["영업이익"]) : null,
  });
  const out = (k?.y_report ?? []).map(row);
  out.quarters = (k?.q_report ?? []).map(row).sort((a, b) => a.end.localeCompare(b.end));
  return out;
}
/**
 * StockAnalysis.com 재무(검증 대조 전용 — 오너 결정 2026-09-24 "검증 스크립트에만", 앱·DB 에는 넣지 않는다).
 * SvelteKit 데이터 엔드포인트(devalue 평탄화 배열). 브라우저 UA 가 없으면 Cloudflare 확인 페이지가 온다.
 */
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
async function saStatement(sym, path, quarterly = false) {
  const url = `https://stockanalysis.com/stocks/${sym.toLowerCase()}/financials/${path}/__data.json?${quarterly ? "p=quarterly&" : ""}x-sveltekit-invalidated=001`;
  const r = await fetch(url, { headers: { "user-agent": SA_UA, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  const t = await r.text();
  if (!r.ok || t.startsWith("<")) throw new Error(`StockAnalysis ${path} HTTP ${r.status}${t.startsWith("<") ? " (확인 페이지)" : ""}`);
  const node = JSON.parse(t).nodes.find((n) => n?.type === "data" && JSON.stringify(n.data).includes("financialData"));
  const f = node ? saUnflatten(node.data).financialData : null;
  if (!f?.datekey) throw new Error(`StockAnalysis ${path} 재무 데이터 없음`);
  return f;
}
/** 값 비교 — 소스의 보고 단위 안에서 같은가(인포맥스는 백만 달러 단위, 나머지는 달러) */
const sameAt = (a, b, unit) => a != null && b != null && Math.abs(a - b) <= Math.max(unit / 2, Math.abs(b) * 1e-12);

/** 환율 일별 종가 "통화 1단위당 USD" — 검증기가 앱과 별개로 받는다(외화 공시 환산 대조용) */
const fxCacheV = new Map();
async function fxDaily(cur) {
  if (fxCacheV.has(cur)) return fxCacheV.get(cur);
  const y = await yahoo();
  const pull = async (s) => (await y.chart(s, { period1: "2014-01-01", interval: "1d" })).quotes.filter((q) => q.close > 0).map((q) => ({ d: new Date(q.date).toISOString().slice(0, 10), c: q.close }));
  let rows = [];
  try { rows = (await pull(cur + "USD=X")).map((q) => ({ d: q.d, r: q.c })); } catch { rows = []; }
  if (rows.length < 100) rows = (await pull(cur + "=X")).map((q) => ({ d: q.d, r: 1 / q.c }));
  fxCacheV.set(cur, rows);
  return rows;
}
const fxAvg = (rows, start, end) => { const x = rows.filter((q) => q.d >= start && q.d <= end); return x.length ? x.reduce((s, q) => s + q.r, 0) / x.length : null; };
async function infomaxShares(sym) {
  const post = (p, b) => fetch(IM + p, { method: "POST", headers: { "content-type": "application/json", referer: `${IM}/sss.html` }, body: JSON.stringify(b), signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`인포맥스 HTTP ${r.status}`))));
  const t = await post("/facset/tickerlist/usa", { ticker: sym });
  const code = t?._source?.["인포맥스코드"];
  if (!code || t._source["티커"]?.toUpperCase() !== sym) return null;
  const p = (await post("/facset/getPriceData", { param: code }))?.[0];
  return p?.["주식수"] ? { shares: p["주식수"] * 1000, date: p["주식수일"] } : null;
}

// ── 미국 종목 1개 ─────────────────────────────────────────────────────
async function verifyUs(sym) {
  const u = `/api/markets/us/${encodeURIComponent(sym)}`;
  const checks = [];
  const add = (layer, name, col, r) => checks.push({ layer, name, col, ...r });
  const review = [];

  const support = await getJson(`${u}/support`);
  if (support && support.supported === false) return { sym, skipped: "모기지 리츠(지원 제외)", allowedSkip: true, checks, review };

  // 조회 실패는 전부 기록한다(예전엔 컨센서스 실패가 조용히 검사 16건을 지웠다)
  const fetched = {};
  for (const [k, p] of Object.entries({
    hl: `${u}/highlights`, an: `${u}/financials?view=analysis`, ov: `${u}/overview`, tt: `${u}/ttm`,
    cs: `${u}/consensus`, is: `${u}/financials?view=is&period=annual`, bs: `${u}/financials?view=bs&period=annual`,
  })) {
    try { fetched[k] = await getJson(p); } catch (e) { fetched[k] = null; add("응답", `API 응답 ${k}`, "-", { status: FAIL, note: String(e).slice(0, 120) }); }
  }
  let row = null;
  try { row = await getJson(`/api/cron/verify-row?market=us&symbol=${encodeURIComponent(sym)}`, 240_000, AUTH); }
  catch (e) { add("응답", "API 응답 verify-row", "-", { status: FAIL, note: String(e).slice(0, 120) }); }
  const { hl, an, ov, cs, is, bs } = fetched;
  const h = hl?.highlights;
  if (!h) return { sym, error: "하이라이트 없음", checks, review };

  // ── SEC 원자료
  const cik = await cikOf(sym);
  if (!cik) return { sym, error: "SEC CIK 없음", checks, review };
  const f = await secJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
  if (!f?.facts) return { sym, error: "SEC companyfacts 형식 이상", checks, review };
  const sub = await secJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const sic = Number(sub.sic ?? 0);
  const G = f.facts["us-gaap"] ?? {};
  const ann = (c, unit = "USD") => annualPeriods(f.facts, "us-gaap", c, unit);
  const has20F = Object.keys(f.facts).includes("ifrs-full") || (sub.filings?.recent?.form ?? []).some((x) => /^20-F/.test(x));
  // 보고 통화 = 매출·순이익·자산 태그의 단위(외화 차입금 태그 등 일부 항목의 외화 단위는 무관 — MCD 오판)
  const reportUnits = new Set(["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "NetIncomeLoss", "ProfitLoss", "Assets"].flatMap((t) => Object.keys(G[t]?.units ?? {})));
  const usdOnly = reportUnits.size === 0 || [...reportUnits].every((u) => u === "USD");
  // 외화·IFRS 공시(ASML·TSM·SPOT) — 앱은 USD 로 환산해 보여준다. 검증기는 환산을 재현하지 않고
  // 인포맥스(FactSet, 독립 USD 환산)와 대조한다.
  const foreign = !usdOnly || Object.keys(f.facts).includes("ifrs-full");
  let imAnnual = null, imErr = "";
  const hardErrors = [];
  if (foreign || EXTERNAL) imAnnual = await infomaxAnnual(sym).catch((e) => { imErr = String(e).slice(0, 60); return null; });
  // 외화 공시 원통화 값(결산일별) — us-gaap 외화 단위(ASML) 또는 ifrs-full(TSM·SPOT)
  const natCur = foreign ? ([...reportUnits].find((u) => u !== "USD") ?? Object.keys(f.facts["ifrs-full"]?.Revenue?.units ?? f.facts["ifrs-full"]?.RevenueFromContractsWithCustomers?.units ?? {}).find((u) => u !== "USD")) : null;
  const natAnnual = (pairs, unit) => {
    const m = new Map();
    for (const [ns, t] of pairs) for (const e of f.facts[ns]?.[t]?.units?.[unit] ?? []) {
      if (!e.start || !/^(10-K|20-F)/.test(e.form) || (Date.parse(e.end) - Date.parse(e.start)) / 864e5 < 300) continue;
      const p = m.get(e.end); if (!p || (e.filed ?? "") > (p.filed ?? "")) m.set(e.end, e);
    }
    return m;
  };
  const natRev = natCur ? natAnnual([["us-gaap", "Revenues"], ["us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax"], ["ifrs-full", "Revenue"], ["ifrs-full", "RevenueFromContractsWithCustomers"]], natCur) : new Map();
  const natNi = natCur ? natAnnual([["us-gaap", "NetIncomeLoss"], ["ifrs-full", "ProfitLossAttributableToOwnersOfParent"]], natCur) : new Map();
  const natEps = natCur ? natAnnual([["us-gaap", "EarningsPerShareDiluted"], ["ifrs-full", "DilutedEarningsLossPerShare"]], natCur + "/shares") : new Map();
  // companyfacts 가 최신 20-F/10-K 를 빠뜨린 경우(TSM 2025) — 원본 XBRL 인스턴스에서 원통화 값을 직접 읽는다
  if (natCur) {
    const rc2 = sub.filings?.recent ?? {};
    for (let i = 0; i < (rc2.form ?? []).length; i++) {
      if (!/^(10-K|20-F)$/.test(rc2.form[i]) || !rc2.reportDate?.[i]) continue;
      const end = rc2.reportDate[i];
      if (atEnd(natRev, end) && atEnd(natNi, end) && atEnd(natEps, end)) continue;
      try {
        const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${rc2.accessionNumber[i].replace(/-/g, "")}`;
        const idx = await secJson(base + "/index.json");
        const name = idx.directory.item.map((x) => x.name).find((x) => /_htm\.xml$/i.test(x));
        if (!name) continue;
        const xml = await secText(base + "/" + name);
        const ctx = new Map();
        for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
          const b = m[2];
          ctx.set(m[1], { start: /<(?:xbrli:)?startDate>([^<]+)</.exec(b)?.[1], end: /<(?:xbrli:)?endDate>([^<]+)</.exec(b)?.[1], dimmed: /dimension="/.test(b) });
        }
        const read = (ns, tag, unitRe) => {
          for (const m of xml.matchAll(new RegExp(`<${ns}:${tag}(?=[\\s>])([^>]*)>([^<]+)</${ns}:${tag}>`, "g"))) {
            const c = ctx.get(/contextRef="([^"]+)"/.exec(m[1])?.[1]);
            const unit = /unitRef="([^"]+)"/.exec(m[1])?.[1] ?? "";
            if (!c || c.dimmed || !c.start || c.end !== end || !unitRe.test(unit)) continue;
            if ((Date.parse(c.end) - Date.parse(c.start)) / 864e5 < 300) continue;
            return { start: c.start, end: c.end, val: Number(m[2]), form: rc2.form[i], filed: rc2.filingDate[i] };
          }
          return null;
        };
        const cu = new RegExp(natCur, "i");
        const put = (map, e) => { if (e && !atEnd(map, end)) map.set(end, e); };
        put(natRev, read("ifrs-full", "Revenue", cu) ?? read("ifrs-full", "RevenueFromContractsWithCustomers", cu) ?? read("us-gaap", "Revenues", cu));
        put(natNi, read("ifrs-full", "ProfitLossAttributableToOwnersOfParent", cu) ?? read("us-gaap", "NetIncomeLoss", cu));
        put(natEps, read("ifrs-full", "DilutedEarningsLossPerShare", cu) ?? read("us-gaap", "EarningsPerShareDiluted", cu));
      } catch (e) {
        hardErrors.push(`원통화 인스턴스 판독 실패(${end}): ${String(e).slice(0, 50)}`);
      }
    }
  }
  const nativeAt = (date) => {
    const r = atEnd(natRev, date), n = atEnd(natNi, date), e = atEnd(natEps, date);
    const any = r ?? n ?? e; if (!any) return null;
    return { start: any.start, end: any.end, rev: r?.val ?? null, ni: n?.val ?? null, eps: e?.val ?? null };
  };
  let fxRows = null, fxErr = "", adrK = 1;
  if (natCur) {
    fxRows = await fxDaily(natCur).catch((e) => { fxErr = `환율 조회 실패: ${String(e).slice(0, 50)}`; hardErrors.push(fxErr); return null; });
    // ADR 비율 — SEC 표지 주식수(보통주) ÷ 인포맥스 주식수(ADR). 1.5배 안이면 1:1
    const dei = (f.facts.dei?.EntityCommonStockSharesOutstanding?.units?.shares ?? []).reduce((b, e) => (!b || e.end > b.end ? e : b), null);
    const ims = await infomaxShares(sym).catch(() => null);
    if (dei && ims?.shares) { const r = dei.val / ims.shares; adrK = r > 1.5 || r < 1 / 1.5 ? r : 1; }
  }

  const niP = ann("NetIncomeLoss"), plP = ann("ProfitLoss"), nciP = ann("NetIncomeLossAttributableToNoncontrollingInterest");
  const epsP = ann("EarningsPerShareDiluted", "USD/shares"), epsBP = ann("EarningsPerShareBasic", "USD/shares");
  const wDilP = ann("WeightedAverageNumberOfDilutedSharesOutstanding", "shares"), wBasP = ann("WeightedAverageNumberOfSharesOutstandingBasic", "shares");
  const niDilP = ann("NetIncomeLossAvailableToCommonStockholdersDiluted"), niBasP = ann("NetIncomeLossAvailableToCommonStockholdersBasic");
  const prefDivP = ann("PreferredStockDividendsIncomeStatementImpact");
  // 매출 후보 — 결산기 판정용(모든 후보의 결산일 합집합)과 매출 대조용(결산기별 첫 후보)
  // 오너 결정 2026-09-24: 총매출(Revenues) 우선 — 손익계산서 첫 줄
  const REV_TAGS = ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet", "RevenuesNetOfInterestExpense"];
  const revByTag = REV_TAGS.map((t) => [t, ann(t)]);
  const revP = new Map(revByTag.flatMap(([, m]) => [...m]));
  const nonopSplit = foreign ? new Map() : new Map([...(await nonopSplitFromInstances(cik, G).catch((e) => { hardErrors.push(`비영업 수익 분리 원본 판독 실패: ${String(e).slice(0, 60)}`); return new Map(); }))].map(([end, e]) => [end, { ...e, end }]));
  // Yahoo 연간 총매출 — 비영업 분리 회사만(독립 확인용)
  const yRev = new Map();
  if (nonopSplit.size) {
    try {
      const ys = await (await yahoo()).fundamentalsTimeSeries(sym, { period1: "2018-01-01", type: "annual", module: "financials" }, { validateResult: false });
      for (const r of ys) if (r.totalRevenue != null) yRev.set(new Date(r.date).toISOString().slice(0, 10), r.totalRevenue);
    } catch (e) { hardErrors.push(`Yahoo 연간 매출 조회 실패: ${String(e).slice(0, 60)}`); }
  }
  const secRevenue = (end) => { for (const [t, m] of revByTag) { const e = atEnd(m, end); if (e) return { v: e.val, tag: t }; } return null; };
  // 비지배지분·우선주 "흔적" — 결산일 기준. 흔적이 있는 해에는 순이익 정의 대체를 하지 않는다(검증불가)
  const traceEnds = (tags) => {
    const s = new Set();
    for (const t of tags) for (const arr of Object.values(G[t]?.units ?? {})) for (const e of arr) if (e.val && /^(10-K|20-F)/.test(e.form)) s.add(e.end);
    return s;
  };
  const nciTrace = traceEnds(["NetIncomeLossAttributableToNoncontrollingInterest", "MinorityInterest", "RedeemableNoncontrollingInterestEquityCarryingAmount", "NetIncomeLossAttributableToRedeemableNoncontrollingInterest", "TemporaryEquityCarryingAmountAttributableToParent"]);
  const prefTrace = traceEnds(["PreferredStockDividendsIncomeStatementImpact", "DividendsPreferredStock", "PreferredStockValue", "PreferredStockValueOutstanding", "PreferredStockDividendsAndOtherAdjustments", "TemporaryEquityCarryingAmountAttributableToParent", "UndistributedEarningsLossAllocatedToParticipatingSecuritiesBasic", "DistributedEarnings"]);
  const traceNear = (set, end) => [...set].some((e) => dayDiff(e, end) <= 7);

  /** 지배주주 순이익(기준값) — { v, note } | { v:null, why } */
  function parentNi(end) {
    const n = atEnd(niP, end);
    if (n) return { v: n.val };
    const pl = atEnd(plP, end), nci = atEnd(nciP, end);
    if (pl && nci) return { v: pl.val - nci.val, note: "ProfitLoss − 비지배지분" };
    if (pl && !traceNear(nciTrace, end)) return { v: pl.val, note: "ProfitLoss(그 해 비지배지분 흔적 없음)" };
    if (pl) return { v: null, why: "NetIncomeLoss 없음, ProfitLoss 에 비지배지분이 섞였는지 확정 불가" };
    return { v: null, why: "순이익 태그 없음" };
  }
  /**
   * SEC 원자료로 직접 계산한 TTM(최근 사업연도 + 당기 누적 − 전년 동기 누적) — { v, end } | null.
   * 앱 LTM 계산을 재현하려는 게 아니라 공시 숫자만으로 같은 기간의 합계를 따로 낸다.
   */
  function secTtm(tag) {
    const arr = (G[tag]?.units?.USD ?? []).filter((e) => e.start && /^(10-K|10-Q)/.test(e.form));
    if (!arr.length) return null;
    const dur = (e) => (Date.parse(e.end) - Date.parse(e.start)) / 864e5;
    const latestEnd = arr.reduce((m, e) => (e.end > m ? e.end : m), "");
    const pick = (pred) => arr.filter(pred).sort((a, b) => ((a.filed ?? "") < (b.filed ?? "") ? 1 : -1))[0] ?? null;
    const fyLatest = pick((e) => e.end === latestEnd && dur(e) > 300 && dur(e) < 400);
    if (fyLatest) return { v: fyLatest.val, end: latestEnd, how: "최근 사업연도" };
    const cur = arr.filter((e) => e.end === latestEnd && dur(e) < 300).sort((a, b) => dur(b) - dur(a))[0];
    if (!cur) return null;
    const prior = pick((e) => Math.abs(dayDiff(e.end, cur.end) - 365) <= 10 && Math.abs(dur(e) - dur(cur)) <= 10);
    const fy = pick((e) => dur(e) > 300 && dur(e) < 400 && dayDiff(e.end, cur.start) <= 10);
    if (!prior || !fy) return null;
    return { v: fy.val + cur.val - prior.val, end: latestEnd, how: "사업연도 + 당기누적 − 전년동기" };
  }
  /** 보통주 귀속 순이익(기준값) */
  function commonNi(end) {
    const d = atEnd(niDilP, end) ?? atEnd(niBasP, end);
    if (d) return { v: d.val };
    const p = parentNi(end);
    if (p.v == null) return p;
    const pd = atEnd(prefDivP, end);
    if (pd) return { v: p.v - pd.val, note: [p.note, "− 우선주배당"].filter(Boolean).join(" ") };
    if (!traceNear(prefTrace, end)) return { v: p.v, note: [p.note, "우선주·참가증권 흔적 없음"].filter(Boolean).join(" · ") };
    return { v: null, why: "우선주·참가증권 흔적이 있는데 보통주 귀속 순이익 태그 없음" };
  }

  let splits = [], splitErr = "";
  // 분할 이력 조회 실패 시 계수 1로 대체하지 않는다 — EPS 대조를 검증불가로 두고 실행 전체를 실패 처리(재감사)
  try { const sp = await splitsOf(sym); splits = sp.splits; for (const x of sp.spinoffs) review.push({ item: `분사 가격조정 ${x.date} (Yahoo 비율 ${x.num}:${x.den})`, note: "EPS 분할 보정에서 제외 — 앱 과거 주가가 이 조정을 받았다면 분사 이전 연도 시가총액·PER 이 낮게 나온다(점검 필요)" }); } catch (e) { splitErr = `분할 이력 조회 실패: ${String(e).slice(0, 60)}`; hardErrors.push(splitErr); }
  /** 공시 EPS 를 오늘 주식 기준으로 — 공시(filed) 이후에 일어난 분할만 나눈다 */
  const splitAdj = (e) => splits.filter((s) => s.date > (e.filed ?? e.end)).reduce((k, s) => k * s.ratio, 1);

  let inst = new Map(), instErr = "";
  const bank = !h.rows.some((r) => r.key === "ev");
  const secBank = sic >= 6020 && sic <= 6199;
  add("B", "금융 레이아웃 = SEC 업종(SIC 6020~6199 은행·신용)", "-", bank === secBank || (bank && sic >= 6000 && sic < 6800)
    ? { status: PASS, note: `SIC ${sic}` } : { status: FAIL, note: `앱 ${bank ? "은행" : "일반"} 레이아웃 vs SIC ${sic}` });

  // ── B. 결산 기간 대조
  const fyCols = h.columns.filter((c) => c.kind === "fy");
  const ifrsEnds = [];
  for (const t of ["Revenue", "RevenueFromContractsWithCustomers", "ProfitLoss"]) for (const arr of Object.values(f.facts["ifrs-full"]?.[t]?.units ?? {})) for (const e of arr) if (e.start && /^20-F/.test(e.form) && (Date.parse(e.end) - Date.parse(e.start)) / 864e5 > 300) ifrsEnds.push(e.end);
  // 외화 us-gaap(ASML) 결산일 — 단위와 무관하게
  for (const t of ["Revenues", "NetIncomeLoss"]) for (const [u, arr] of Object.entries(G[t]?.units ?? {})) if (u !== "USD") for (const e of arr) if (e.start && /^(10-K|20-F)/.test(e.form) && (Date.parse(e.end) - Date.parse(e.start)) / 864e5 > 300) ifrsEnds.push(e.end);
  // SEC 공시 목록의 연간 보고 기준일 — companyfacts 가 공시를 통째로 빠뜨리는 경우(TSM 2025 20-F·BE)에도 결산기를 안다
  const rc = sub.filings?.recent ?? {};
  for (let i = 0; i < (rc.form ?? []).length; i++) if (/^(10-K|20-F)$/.test(rc.form[i]) && rc.reportDate?.[i]) ifrsEnds.push(rc.reportDate[i]);
  const secEnds = [...new Set([...niP.keys(), ...plP.keys(), ...revP.keys(), ...ifrsEnds])].sort();
  if (!secEnds.length) add("B", "SEC 연간 결산 존재", "-", { status: FAIL, note: has20F ? "20-F/IFRS 제출사 — us-gaap 연간 재무 없음(앱이 IFRS 를 안 읽음)" : "SEC 연간 순이익·매출 태그 없음" });
  if (foreign && !imAnnual) add("A", "외화 공시 대조 기준(인포맥스) 확보", "-", { status: FAIL, note: imErr || "인포맥스 종목 없음 — 외화 공시 원자료 대조 불가" });
  if (fyCols.length === 0) add("B", "연도 열 존재", "-", { status: FAIL, note: "하이라이트 연도 열 0개" });
  if (fyCols.length && secEnds.length) {
    // SEC 최근 5개 결산기가 모두 앱 열에 있어야 한다 — 앱 범위 안만 보면 최신 연도 누락을 놓친다(재감사)
    const today = new Date().toISOString().slice(0, 10);
    for (const end of secEnds.filter((e) => e <= today).slice(-5))
      if (!fyCols.some((c) => dayDiff(c.date, end) <= 7))
        add("B", "SEC 10-K 결산기 ↔ 앱 연도 열", end, { status: FAIL, note: `SEC 결산일 ${end} 에 해당하는 연도 열 없음` });
    for (const c of fyCols)
      add("B", "SEC 10-K 결산기 ↔ 앱 연도 열", c.label, secEnds.some((e) => dayDiff(e, c.date) <= 7)
        ? { status: PASS } : { status: FAIL, note: `앱 열 결산일 ${c.date} 이 SEC 결산일 목록에 없음` });
    const labs = fyCols.map((c) => c.label);
    if (new Set(labs).size !== labs.length) add("B", "연도 라벨 중복 없음", "-", { status: FAIL, note: labs.join(",") });
  }

  // ── 앱 값 표
  const H = {};
  const valRow = (k, i) => h.valuationRows.find((r) => r.key === k)?.values[i] ?? null;
  h.columns.forEach((c, i) => {
    if (c.kind === "estimate") return;
    const lab = c.kind === "ltm" ? "LTM" : c.label;
    const r = (k) => h.rows.find((x) => x.key === k)?.values[i] ?? null;
    H[lab] = {
      date: c.date, mc: r("mktcap"), op: r("opunits"), cash: r("cash"), debt: r("debt"), pn: r("pref_nci"),
      ev: r("ev"), ebitda: r("ebitda"), ni: r("ni"), eps: r("eps"), rev: r("revenue") ?? r("net_revenue"),
      per: valRow("per", i), pbr: valRow("pbr", i), psr: valRow("psr", i), evx: valRow("ev_ebitda", i),
    };
  });
  const evBlocked = (h.notes ?? []).find((n) => /EV.*(미표시|표시하지 않|계산하지 않)/.test(n));
  // 앱이 붙인 "EV 미표시" 사유를 그대로 믿지 않는다(재감사) — 원자료·결정 목록으로 따로 확인
  // 금융 자회사 보유사 = 오너 결정 목록(CLAUDE.md "EV 미표시: … F·GM·CAT·DE 등") + SEC 할부금융 채권 태그
  const CAPTIVE = new Set(["F", "GM", "CAT", "DE"]);
  const DEBT_TAGS = ["LongTermDebt", "LongTermDebtNoncurrent", "LongTermDebtCurrent", "DebtCurrent", "LongTermDebtAndCapitalLeaseObligations", "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities", "DebtLongtermAndShorttermCombinedAmount", "NotesPayable", "ShortTermBorrowings", "CommercialPaper", "ConvertibleNotesPayable", "ConvertibleNotesPayableCurrent", "SeniorNotes", "LineOfCredit", "LinesOfCreditCurrent", "OtherLongTermDebt", "OtherLongTermDebtNoncurrent", "DebtInstrumentCarryingAmount", "FinanceLeaseLiability", "FinanceLeaseLiabilityNoncurrent"];
  /** EV 가 빈 열의 사유를 **그 열 날짜 기준으로** 원자료에서 확인 — 사유 문구만 믿지 않는다(재감사).
   *  안내문은 종목 단위라, 예전엔 문구가 하나라도 있으면 EV 가 있는 연도까지 실패로 쳤다(SNDK 오판). */
  const evBlockOkAt = (date) => {
    if (!evBlocked) return null;
    // 3차 감사: 할부금융 태그 하나로 인정하던 것(PEP·MRK 도 태그 1개)을 오너 결정 목록만으로 좁힘
    if (/금융 자회사|할부금융/.test(evBlocked)) return CAPTIVE.has(sym) ? "금융 자회사(오너 결정 목록)" : null;
    // 3차 감사: SIC 6000~6799 전체(리츠·보험 포함) → 앱 은행 레이아웃 + SIC 6020~6199 일치일 때만
    if (/은행|금융업|예수|보험/.test(evBlocked)) return bank && secBank ? `은행 레이아웃·SIC ${sic}` : null;
    if (/차입금 태그|태그 미공시|태그 없음|표준 태그/.test(evBlocked)) {
      // 그 날짜(±7일) 또는 1년 안쪽 이전 기말에 차입금 태그가 하나도 없어야 "미공시"가 맞다
      const tagged = DEBT_TAGS.some((t) => (G[t]?.units?.USD ?? []).some((e) => !e.start && e.end <= date && (Date.parse(date) - Date.parse(e.end)) / 864e5 <= 400 || (!e.start && dayDiff(e.end, date) <= 7)));
      return tagged ? null : "그 날짜 SEC 차입금 태그 없음 확인";
    }
    return null;
  };
  const rowOf = (stmt, name) => stmt?.sections?.flatMap((s) => s.items ?? []).find((x) => x.accountName === name)?.values ?? {};
  const lab = (k) => (k === "현재/LTM" ? "LTM" : k);
  const A = {}, IS = {}, BS = {};
  for (const [name, key] of [["EV/EBITDA", "evx"], ["PER", "per"], ["PBR", "pbr"], ["PSR", "psr"]])
    for (const [k, v] of Object.entries(rowOf(an, name))) (A[lab(k)] ??= {})[key] = v;
  for (const [name, key] of [["EBITDA", "ebitda"], ["희석 EPS", "eps"], ["당기순이익", "ni"], ["매출액", "rev"], ["순수익", "rev"]])
    for (const [k, v] of Object.entries(rowOf(is, name))) if (v != null || (IS[lab(k)] ??= {})[key] == null) (IS[lab(k)] ??= {})[key] = v;
  // 영업이익 행은 합성 방식에 따라 이름 뒤에 설명이 붙는다("영업이익 (소계 없음 · …)")
  const rowStarts = (stmt, prefix) => stmt?.sections?.flatMap((s) => s.items ?? []).find((x) => x.accountName?.startsWith(prefix))?.values ?? {};
  for (const [prefix, key] of [["영업이익", "op"], ["세전이익", "pretax"]])
    for (const [k, v] of Object.entries(rowStarts(is, prefix))) (IS[lab(k)] ??= {})[key] = v;
  for (const [k, v] of Object.entries(rowOf(is, "감가상각비"))) (IS[lab(k)] ??= {}).da = v;
  // 앱 일회성비용 주석 행(edgar-oneoff.ts) — 외부 영업이익 차이의 원인 확인용
  for (const [k, v] of Object.entries(rowStarts(is, "일회성비용"))) (IS[lab(k)] ??= {}).oneOff = v;
  // 앱 영업이익 행 이름 — "영업이익" 그대로면 공시 태그, 뒤에 설명이 붙으면 합성(소계 없는 손익계산서 등)
  const opRowName = is?.sections?.flatMap((s) => s.items ?? []).find((x) => x.accountName?.startsWith("영업이익"))?.accountName ?? null;
  for (const [name, key] of [["총차입금", "debt"], ["순차입금", "nd"], ["자산 총계", "assets"], ["부채와 자본 총계", "le"]])
    for (const [k, v] of Object.entries(rowOf(bs, name))) (BS[lab(k)] ??= {})[key] = v;
  const C = {};
  for (const r of cs?.rows ?? []) if (!r.isEstimate) C[`${r.fy}Y`] = r;
  // 컨센서스 화면은 최근 몇 개 연도만 보여준다 — 그 범위 안에서만 연도 존재를 요구
  const cActual = (cs?.rows ?? []).filter((r) => !r.isEstimate);
  if (cs && !cActual.length) add("C", "컨센서스 실적 행 존재", "-", { status: FAIL, note: "컨센서스 응답에 실적 연도 행이 0개" });
  const cMin = cActual.length ? Math.min(...cActual.map((r) => r.fy)) : Infinity;
  const eqP = new Map([...annualEnds("StockholdersEquity")]);
  function annualEnds(tag) {
    const m = new Map();
    for (const e of G[tag]?.units?.USD ?? []) if (!e.start && /^10-K/.test(e.form)) { const p = m.get(e.end); if (!p || (e.filed ?? "") >= (p.filed ?? "")) m.set(e.end, e); }
    return m;
  }
  const opP = new Map([...ann("OperatingIncomeLoss"), ...ann("IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest")]);

  for (const [c, x] of Object.entries(H)) {
    const isFy = c !== "LTM";
    // ── A. SEC 원자료 대조 (연도 열만 — 결산일로 매칭)
    if (isFy && foreign) {
      // 3차 감사: 인포맥스 대조(허용 1.5~2.5%)는 환율 방식 오류(기말/평균 혼동 1~4%)를 놓친다 →
      // 앱 USD ÷ 원통화 공시값으로 앱이 쓴 환율을 역산해, 검증기가 따로 구한 기간 평균 환율과 0.3% 대조.
      const nat = nativeAt(x.date);
      const avg = nat && fxRows ? fxAvg(fxRows, nat.start, nat.end) : null;
      const rateCheck = (name, app, native, k = 1) => {
        if (native == null || avg == null) return add("A", name, c, { status: NA, note: fxErr || "원통화 공시값 없음" });
        if (app == null) return add("A", name, c, { status: FAIL, note: `원통화 ${native} 있는데 앱 빈칸` });
        const implied = app / (native * k);
        const d = Math.abs(implied - avg) / avg;
        // 앱·검증기가 같은 공시값·같은 일별 환율을 쓰므로 정확히 같아야 한다(오너 지시 — "0% 맞춰라").
        // 허용은 부동소수점 오차(1e-9)뿐.
        add("A", name, c, d <= 1e-9 ? { status: PASS, note: `앱 환율 ${implied.toPrecision(6)} ≈ 평균 ${avg.toPrecision(6)}` } : { status: FAIL, note: `앱이 쓴 환율 ${implied.toPrecision(6)} vs 기간 평균 ${avg.toPrecision(6)} (차 ${(d * 100).toFixed(2)}%)` });
      };
      rateCheck("매출 환산 환율 = 기간 평균(외화)", x.rev, nat?.rev ?? null);
      rateCheck("순이익 환산 환율 = 기간 평균(외화)", x.ni, nat?.ni ?? null);
      rateCheck("EPS 환산 환율 = 기간 평균(외화·ADR)", x.eps, nat?.eps ?? null, adrK);
      const im = imAnnual?.find((r) => dayDiff(r.end, x.date) <= 7);
      // FactSet 과 우리 환산의 환율 출처·집계 차이 — 실측 0.1~0.3% → 허용 1.5%
      if (im?.rev && x.rev) review.push({ item: `${c} 매출 vs 인포맥스(USD 환산)`, ours: x.rev, other: im.rev, gapPct: ((x.rev - im.rev) / im.rev) * 100 });
      // 순이익은 허용 2.5% — 인포맥스는 분기별로 환산해 합산하는 것으로 보여(TSM 매출·순이익 역산 환율이 다름)
      // 이익 계절성만큼 연평균 환산과 갈린다(실측 TSM 1.8~1.9%)
      if (im?.ni && x.ni) review.push({ item: `${c} 순이익 vs 인포맥스(USD 환산)`, ours: x.ni, other: im.ni, gapPct: ((x.ni - im.ni) / Math.abs(im.ni)) * 100 });
    } else if (isFy) {
      const pn = parentNi(x.date);
      add("A", "순이익 앱 = SEC 지배주주 순이익", c, vsSource(x.ni, pn.v, EXACT, pn.note ?? pn.why ?? ""));
      // 매출 — 은행은 순수익을 합성(이자수익 − 이자비용 등)해 태그 하나와 대조할 수 없다
      if (bank) add("A", "매출 앱 = SEC 매출", c, { status: NA, note: "은행 순수익은 합성값" });
      else {
        const sp = atEnd(nonopSplit, x.date);
        const sr = sp ? { v: sp.v, tag: sp.basis } : secRevenue(x.date);
        let res = vsSource(x.rev, sr?.v ?? null, EXACT, sr?.tag ?? "");
        // 분리 기준은 앱과 같은 판정 규칙이라 독립 검증이 아니다(감사) — Yahoo 연간 매출도 같아야 통과
        if (sp && res.status === PASS) {
          const yv = yRev.get([...yRev.keys()].find((d) => dayDiff(d, x.date) <= 7));
          res = yv == null ? { status: NA, note: `${sp.basis} — Yahoo 연간 매출 없음(독립 확인 불가)` }
            : Math.abs(yv - x.rev) <= 5e5 ? { status: PASS, note: `${sp.basis} · Yahoo ${yv} 일치` }
            : { status: FAIL, note: `${sp.basis} 로는 맞지만 Yahoo 연간 매출 ${yv} 와 다름` };
        }
        add("A", "매출 앱 = SEC 매출", c, res);
      }
      const e = atEnd(epsP, x.date);
      if (e && e.val === 0 && pn.v) {
        add("A", "EPS 앱 = SEC 공시 EPS(분할 보정)", c, x.eps == null ? { status: PASS, note: "공시 EPS 0(자리표시자) → 앱 빈칸" } : { status: FAIL, note: `공시 EPS 0(자리표시자)인데 앱 ${x.eps}` });
      } else if (e && splitErr) {
        add("A", "EPS 앱 = SEC 공시 EPS(분할 보정)", c, { status: NA, note: splitErr });
      } else if (e) {
        const k = splitAdj(e);
        const expected = e.val / k;
        const r = vsSource(x.eps, expected, 0, "");
        // EPS 는 센트 반올림 공시라 절대 허용 0.006 + 상대 0.3%
        const ok = x.eps != null && Math.abs(x.eps - expected) <= 0.006 / k + 0.003 * Math.abs(expected);
        add("A", "EPS 앱 = SEC 공시 EPS(분할 보정)", c, x.eps == null ? r : ok
          ? { status: PASS, ...(k !== 1 ? { note: `분할 보정 ÷${k}(Yahoo 분할 이력)` } : {}) }
          : { status: FAIL, note: `앱 ${x.eps} vs 공시 ${e.val}${k !== 1 ? ` ÷ 분할 ${k}` : ""} = ${expected}${splitErr ? ` · ${splitErr}` : ""}` });
      } else {
        if (!inst.size && !instErr) inst = await classFactsFromInstances(cik).catch((err) => { instErr = String(err).slice(0, 80); return new Map(); });
        const ie = [...inst].find(([end]) => dayDiff(end, x.date) <= 7)?.[1];
        add("A", "EPS 앱 = SEC 공시 EPS(분할 보정)", c, ie && !ie.basic && !splitErr
          // 인스턴스 값은 그 10-K 공시일 기준 — 이후 분할만 나눈다(최근 10-K 는 이미 재작성값일 수 있음)
          ? vsSource(x.eps, ie.eps / splitAdj({ end: x.date, filed: ie.filed }), 0.003, ie.basis)
          : { status: NA, note: instErr ? `인스턴스 판독 실패: ${instErr}` : ie?.basic ? "희석 EPS 는 클래스별로만 공시(기본 EPS 만 확인 가능)" : "공시 희석 EPS 없음" });
      }
    }
    // LTM 순이익 — SEC 분기 공시로 따로 계산한 TTM 과 대조(재감사: LTM 순이익은 원자료 대조가 없었음)
    if (!isFy && foreign) add("A", "LTM 순이익 앱 = SEC TTM", c, { status: NA, note: "외화 공시 — 분기 XBRL 없음(20-F)·환산은 인포맥스 대조로" });
    else if (!isFy) {
      const hasNciNow = [...nciTrace].some((e) => dayDiff(e, x.date) <= 400);
      const t = secTtm("NetIncomeLoss") ?? (hasNciNow ? null : secTtm("ProfitLoss"));
      if (!t) add("A", "LTM 순이익 앱 = SEC TTM", c, { status: NA, note: "SEC 분기 순이익으로 TTM 계산 불가" });
      // 3차 감사: 앱 LTM 이 SEC 최신 분기보다 늦으면(한 분기 뒤처짐) 검증불가가 아니라 실패
      else if (Date.parse(x.date) < Date.parse(t.end) - 7 * 864e5) add("A", "LTM 순이익 앱 = SEC TTM", c, { status: FAIL, note: `앱 LTM 기준일 ${x.date} 이 SEC 최신 결산 ${t.end} 보다 늦음(분기 누락)` });
      else if (dayDiff(t.end, x.date) > 7) add("A", "LTM 순이익 앱 = SEC TTM", c, { status: NA, note: `기준일 다름(앱 ${x.date} / SEC ${t.end})` });
      else add("A", "LTM 순이익 앱 = SEC TTM", c, vsSource(x.ni, t.v, 5e-4, t.how));
    }
    // ── C. 화면 간 동일성
    if (!bank) add("C", "EV/EBITDA 하이라이트=재무분석", c, same(A[c]?.evx ?? null, x.evx));
    add("C", "PER 하이라이트=재무분석", c, same(A[c]?.per ?? null, x.per));
    add("C", "PBR 하이라이트=재무분석", c, same(A[c]?.pbr ?? null, x.pbr));
    add("C", "PSR 하이라이트=재무분석", c, same(A[c]?.psr ?? null, x.psr));
    add("C", "순이익 하이라이트=손익계산서", c, same(IS[c]?.ni ?? null, x.ni));
    add("C", "EPS 하이라이트=손익계산서", c, same(IS[c]?.eps ?? null, x.eps));
    add("C", "매출 하이라이트=손익계산서", c, same(IS[c]?.rev ?? null, x.rev));
    if (isFy) {
      if (!C[c]) { if (Number(c.slice(0, 4)) >= cMin || !cs) add("C", "컨센서스 연도 존재", c, cs ? { status: FAIL, note: "컨센서스 범위 안인데 이 연도 행 없음" } : { status: NA, note: "컨센서스 응답 없음" }); }
      else {
        if (!bank) add("C", "EV/EBITDA 컨센서스=하이라이트", c, same(C[c].evEbitda ?? null, x.evx));
        add("C", "PER 컨센서스=하이라이트", c, same(C[c].per ?? null, x.per));
        add("C", "PBR 컨센서스=하이라이트", c, same(C[c].pbr ?? null, x.pbr));
        add("C", "순이익 컨센서스=하이라이트", c, same(C[c].netIncome ?? null, x.ni));
        add("C", "EPS 컨센서스=하이라이트", c, same(C[c].eps ?? null, x.eps));
      }
    }
    if (!bank) {
      add("C", "EBITDA 하이라이트=손익계산서", c, same(IS[c]?.ebitda ?? null, x.ebitda));
      add("C", "차입금 하이라이트=대차대조표 주석", c, same(BS[c]?.debt ?? null, x.debt));
      add("C", "순차입금 하이라이트=대차대조표 주석", c, same(BS[c]?.nd ?? null, x.debt == null ? null : x.debt + (x.cash ?? 0)));
    }
    // ── D. 항등식·부호 규칙·기대치
    const signRule = (name, mult, den) => {
      if (den == null) return;
      if (den <= 0) add("D", `${name} 부호 규칙(분모 ≤ 0 → 빈칸)`, c, mult == null ? { status: PASS } : { status: FAIL, note: `분모 ${den} 인데 ${name} ${mult}` });
      else add("D", `${name} 기대치(분모 > 0 → 값 있음)`, c, mult != null ? { status: PASS } : { status: FAIL, note: `분모 ${den} 인데 ${name} 빈칸` });
    };
    // 시가총액이 없는 해(상장 전)는 배수·EV 를 기대하지 않는다 — 대신 시가총액 부재를 기록
    if (x.mc == null) add("D", "시가총액 존재", c, { status: NA, note: "시가총액 없음(상장 전 등) — 배수·EV 기대치 생략" });
    if (x.mc != null) signRule("PER", x.per, x.eps);
    // 원자료로 정한 기대치 — 전 화면에서 같이 비어도 잡힌다(재감사: EBITDA·PBR·PSR 빈칸 회귀가 검증불가로만 남았음)
    if (isFy && !bank && atEnd(opP, x.date) && x.ebitda == null) add("D", "EBITDA 기대치(SEC 영업이익·세전이익 있음)", c, { status: FAIL, note: "SEC 에 이익 태그가 있는데 앱 EBITDA 빈칸" });
    // 영업이익·세전이익 = SEC 원자료 정확 일치(오너 지시 2026-09-24 — "허용치를 좁히는 것보다 완벽하게 일치").
    // 예전 "매출 25% 이내 괴리" 는 영업외 이익이 큰 정상 회사(GOOG 지분평가익·WDC)를 떨어뜨리고 보험·리츠 오류
    // (7.7%·12%)는 통과시켰다(재감사). 기간은 연도 열 = 10-K 결산일, LTM = SEC 분기 공시로 직접 낸 TTM.
    { const op = IS[c]?.op, pt = IS[c]?.pretax;
      const secAt = (tag) => {
        if (isFy) return atEnd(ann(tag), x.date)?.val ?? null;
        const t = secTtm(tag);
        return t && dayDiff(t.end, x.date) <= 7 ? t.v : null;
      };
      const secPt = PRETAX_TAGS.map(secAt).find((v) => v != null) ?? null;
      add("A", "세전이익 앱 = SEC 세전이익", c, vsSource(pt, secPt, EXACT));
      const synth = opRowName != null && opRowName !== "영업이익";
      const fin = sic >= 6000 && sic <= 6499;
      if (fin) {
        // 금융·보험: 앱 규칙 = 세전이익 − 지분법이익(CLAUDE.md "금융·보험업 영업이익 근사")
        const eq = secAt("IncomeLossFromEquityMethodInvestments") ?? 0;
        add("A", "영업이익 앱 = SEC 세전이익 − 지분법(금융·보험)", c, secPt == null ? { status: NA, note: "SEC 세전이익 없음" } : vsSource(op, secPt - eq, EXACT));
      } else if (!synth) {
        add("A", "영업이익 앱 = SEC 영업이익", c, vsSource(op, secAt("OperatingIncomeLoss"), EXACT));
      } else {
        // 합성 영업이익(소계 없는 손익계산서): SEC 세전이익에서 영업외 항목 태그를 되돌려 정확 대조.
        // NonoperatingIncomeExpense 가 회사마다 "영업외 합계"(이자·지분법 포함)이기도 하고 "기타수익" 한 줄이기도
        // 해서(DIS — 이자비용·지분법이 별도 줄) 두 해석을 모두 계산하고, 앱이 어느 쪽과 정확히 같은지 기록한다.
        // 태그 조합(영업외 합계·이자·지분법)으로 되살리는 식은 회사마다 태그 범위·부호가 달라 추측이 된다
        // (DIS: NonoperatingIncomeExpense 가 "기타수익" 한 줄뿐, 태그 조합 1,918 vs 손익계산서 실제 5,100).
        // 손익계산서 표시 구조의 독립 재구현 전까지는 판정하지 않고 미결로 남긴다 — 허용치·추측으로 통과시키지 않는다.
        add("A", "영업이익(합성) 앱 = SEC 손익계산서 구조", c, { status: NA, note: `미결 — 합성 영업이익 "${opRowName}", SEC 영업이익 태그 없음(독립 구조 재구현 필요). 세전이익 ${secPt}` });
      }
      if (fin && pt != null && op != null && pt > 0 && op < 0) add("D", "금융·보험 영업이익 부호(세전 흑자 → 영업 적자 불가)", c, { status: FAIL, note: `세전이익 ${pt} 인데 영업이익 ${op}` });
    }
    if (x.mc != null && x.rev != null) signRule("PSR", x.psr, x.rev);
    if (isFy && x.mc != null) { const eq = atEnd(eqP, x.date)?.val; if (eq != null) signRule("PBR", x.pbr, eq); }
    if (!bank && x.mc != null) {
      if (x.ev == null) {
        const ok = evBlockOkAt(x.date);
        add("D", "EV 기대치", c, ok ? { status: NA, note: `EV 미표시 — ${ok}` } : { status: FAIL, note: evBlocked ? `EV 미표시 — 앱 사유 "${evBlocked.slice(0, 50)}" 를 이 날짜 원자료로 확인 못함` : "EV 미표시 사유 없이 빈칸" });
      }
      else {
        const sum = (x.mc ?? 0) + (x.op ?? 0) + (x.debt ?? 0) + (x.pn ?? 0) + (x.cash ?? 0); // cash 행은 음수
        add("D", "EV = 시총+파트너지분+차입금+우선주·NCI−현금", c, same(x.ev, sum));
        if (x.ebitda != null && x.ebitda > 0) add("D", "EV/EBITDA = EV÷EBITDA", c, same(x.evx, x.ev / x.ebitda));
        signRule("EV/EBITDA", x.evx, x.ebitda);
        if (x.mc > 1e9 && !x.debt && !x.cash) add("D", "차입금·현금 원자료 반영", c, { status: FAIL, note: "대형주인데 차입금·현금이 모두 0/빈칸" });
      }
    }
    // 자산총계 = SEC Assets(결산일 시점 값, 최신 제출분)
    if (BS[c]?.assets != null) {
      // 최신 제출분 — 단 나중 공시가 본문 반올림값("$189 billion")으로 다시 태깅한 값은 버린다(먼저 공시된 정밀값을
      // 1억·10억·100억 단위로 반올림한 값과 정확히 같을 때, AXP 2021 — CLAUDE.md "반올림 재태깅 제거")
      const cand = (G.Assets?.units?.USD ?? []).filter((e) => !e.start && dayDiff(e.end, x.date) <= 7).sort((p, q) => (p.filed ?? "").localeCompare(q.filed ?? ""));
      const rounded = (e) => cand.some((o) => (o.filed ?? "") < (e.filed ?? "") && o.val !== e.val && [1e8, 1e9, 1e10].some((u) => Math.round(o.val / u) * u === e.val));
      const a = cand.filter((e) => !rounded(e)).at(-1) ?? null;
      add("A", "자산총계 앱 = SEC 자산총계", c, vsSource(BS[c].assets, a?.val ?? null, EXACT));
    }
    if (BS[c]) add("D", "자산 총계 = 부채와 자본 총계", c, BS[c].assets == null || BS[c].le == null ? { status: NA, note: "대차대조표 값 없음" } : same(BS[c].assets, BS[c].le, 5e-4));

    // ── E. 공시 내부 정합성 (공시 EPS × 가중평균 ≈ 보통주 귀속 순이익)
    if (isFy && foreign) add("E", "공시 EPS × 가중평균 ≈ 보통주 귀속 순이익", c, { status: NA, note: "외화 공시 — 원통화 공시값끼리의 정합성은 미검사" });
    else if (isFy) {
      const e = atEnd(epsP, x.date) ?? null;
      const ie = [...inst].find(([end]) => dayDiff(end, x.date) <= 7)?.[1];
      let eps = e?.val ?? null, w = null, ni = null, notes = [];
      if (e && eps !== 0) {
        if (eps < 0) { w = atEnd(wBasP, x.date)?.val ?? null; notes.push("적자 연도 — 기본 주식수(반희석 제외)"); }
        else if (atEnd(wDilP, x.date)) w = atEnd(wDilP, x.date).val;
        else if (atEnd(wBasP, x.date) && atEnd(epsBP, x.date)?.val === eps) { w = atEnd(wBasP, x.date).val; notes.push("희석 EPS = 기본 EPS 라 기본 주식수"); }
        const cn = commonNi(x.date); ni = cn.v; if (cn.note) notes.push(cn.note); if (cn.why) notes.push(cn.why);
      } else if (ie) {
        eps = ie.eps; w = ie.shares; notes.push(ie.basis);
        const cn = ie.asConverted ? parentNi(x.date) : commonNi(x.date);
        ni = cn.v; if (ie.asConverted) notes.push("분자 = 지배주주 순이익(as-converted 분모와 같은 범위)");
        if (cn.why) notes.push(cn.why);
      }
      if (eps != null && eps !== 0 && w && ni != null) {
        // EPS 는 센트 반올림 → |순이익/주식수 − EPS| ≤ 0.005 + 가중평균 반올림 0.3%
        const implied = ni / w;
        let ok = Math.abs(implied - eps) <= 0.005 + 0.003 * Math.abs(eps);
        let unitNote = "";
        if (!ok) for (const k of [1e3, 1e6]) if (Math.abs(ni / (w * k) - eps) <= 0.005 + 0.003 * Math.abs(eps)) { ok = true; unitNote = `공시 주식수 단위 오류(×${k})`; }
        const r = ok ? { status: PASS, note: [unitNote, ...notes].filter(Boolean).join(" · ") || undefined }
          : { status: FAIL, note: `순이익/주식수 ${implied.toFixed(4)} vs 공시 EPS ${eps} · ${notes.join(" · ")}` };
        if (unitNote) {
          // 앱이 실제로 보정했는지 — 앱 EPS 가 공시 EPS 와 맞는지는 A 층에서 따로 판정한다
          r.note += " · 앱 보정 여부는 A층 EPS 대조로 확인";
        }
        if (r.status === FAIL) {
          // 공시 수치끼리 안 맞는 것 — 회사 공시 문제. A층(앱=공시)이 통과했을 때만 검토 목록으로
          const aRes = checks.find((k) => k.layer === "A" && k.col === c && k.name.startsWith("EPS"));
          if (aRes?.status === PASS) { review.push({ item: `${c} 공시 EPS×주식수≠보통주 순이익(앱 EPS=공시 EPS 확인됨)`, note: r.note }); add("E", "공시 EPS × 가중평균 ≈ 보통주 귀속 순이익", c, { status: NA, note: `공시 자체 불일치 — 검토 목록 · ${r.note}` }); }
          else add("E", "공시 EPS × 가중평균 ≈ 보통주 귀속 순이익", c, r);
        } else add("E", "공시 EPS × 가중평균 ≈ 보통주 귀속 순이익", c, r);
      } else add("E", "공시 EPS × 가중평균 ≈ 보통주 귀속 순이익", c, { status: NA, note: [e == null && !ie && "공시 희석 EPS 없음", e?.val === 0 && "공시 EPS 0", !w && "가중평균 주식수 없음", ni == null && "보통주 귀속 순이익 없음", instErr && `인스턴스: ${instErr}`, ...notes].filter(Boolean).join(" · ") });
    }
  }

  // ── C. 개요·유니버스 — 앱이 실제로 계산한 값(verify-row) vs 하이라이트 LTM
  const L = H.LTM;
  if (row && L) {
    const m = row.overview?.multiples ?? null, uv = row.universe ?? null;
    if (!m) add("C", "개요 멀티플 계산됨", "LTM", { status: FAIL, note: `개요 멀티플 없음 ${JSON.stringify(row.overview?.warnings ?? [])}` });
    else {
      add("C", "시가총액 개요=하이라이트", "LTM", same(m.marketCap, L.mc));
      add("C", "PER(TTM) 개요=하이라이트", "LTM", same(m.perTtm, L.per));
      add("C", "PBR 개요=하이라이트", "LTM", same(m.pbr, L.pbr));
      add("C", "PSR 개요=하이라이트", "LTM", same(m.psr, L.psr));
      if (!bank) add("C", "EV/EBITDA 개요=하이라이트", "LTM", same(m.evEbitda, L.evx));
    }
    if (!uv || uv.error) add("C", "유니버스 행 계산됨", "LTM", { status: FAIL, note: uv?.error ?? "응답 없음" });
    else {
      add("C", "시가총액 유니버스=하이라이트", "LTM", same(uv.marketCap, L.mc));
      add("C", "PER(TTM) 유니버스=하이라이트", "LTM", same(uv.perTtm, L.per));
      add("C", "PBR 유니버스=하이라이트", "LTM", same(uv.pbr, L.pbr));
    }
  }

  // ── F. 외부 대조 — 지표×기간마다 Yahoo·StockAnalysis·인포맥스를 한 줄에 모은다(오너 지시 2026-09-24 —
  // "단순히 한곳만 일치한다고 통과하면 안 된다"). 각 소스가 제 보고 단위 안에서 앱과 같은지 기록하고, 다른
  // 소스는 차이를 남긴다. 외부 소스는 정의가 제각각이라 판정(실패)이 아니라 원인 규명 대상 목록이다.
  // 기준일이 앱과 같은(±7일) 값만 넣는다.
  if (EXTERNAL && !bank && L) {
    const recon = new Map();
    const put = (item, ours, name, v, unit = 1) => {
      if (ours == null || v == null || !Number.isFinite(v)) return;
      const r = recon.get(item) ?? { item, ours, srcs: {} };
      r.srcs[name] = { v, unit };
      recon.set(item, r);
    };
    const errs = [];
    const iso = (d) => new Date(d).toISOString().slice(0, 10);
    const withLease = rowOf(bs, "총차입금 (운용리스 포함)")["현재/LTM"];

    // Yahoo — 연간·분기(EBITDA 는 앱과 같은 정의: 공시 영업이익 + 감가상각비)
    let yq = [], ya = [];
    try {
      const y = await yahoo();
      yq = await y.fundamentalsTimeSeries(sym, { period1: new Date(Date.now() - 500 * 864e5), type: "quarterly", module: "all" }, { validateResult: false });
      ya = await y.fundamentalsTimeSeries(sym, { period1: "2018-01-01", type: "annual", module: "all" }, { validateResult: false });
    } catch (e) {
      errs.push(`Yahoo: ${String(e).slice(0, 60)}`);
    }
    const yEbitda = (r) => (r.totalOperatingIncomeAsReported != null && r.reconciledDepreciation != null ? r.totalOperatingIncomeAsReported + r.reconciledDepreciation : null);
    for (const [c, x] of Object.entries(H)) {
      if (c === "LTM") continue;
      const r = ya.find((r) => dayDiff(iso(r.date), x.date) <= 7);
      if (!r) continue;
      put(`${c} 매출`, x.rev, "Yahoo", r.totalRevenue);
      put(`${c} 순이익`, x.ni, "Yahoo", r.netIncome ?? r.netIncomeCommonStockholders);
      put(`${c} EBITDA`, x.ebitda, "Yahoo", yEbitda(r));
      put(`${c} 영업이익`, IS[c]?.op, "Yahoo", r.totalOperatingIncomeAsReported);
      put(`${c} 감가상각비`, IS[c]?.da, "Yahoo", r.reconciledDepreciation);
    }
    const last4 = yq.filter((r) => r.totalOperatingIncomeAsReported != null).slice(-4);
    if (last4.length === 4 && dayDiff(iso(last4.at(-1).date), L.date) <= 7) {
      if (last4.every((r) => yEbitda(r) != null)) put("LTM EBITDA", L.ebitda, "Yahoo", last4.reduce((s, r) => s + yEbitda(r), 0));
      if (last4.every((r) => r.totalRevenue != null)) put("LTM 매출", L.rev, "Yahoo", last4.reduce((s, r) => s + r.totalRevenue, 0));
    }
    const bsq = yq.filter((r) => r.totalDebt != null).at(-1);
    if (bsq && dayDiff(iso(bsq.date), L.date) <= 7) put("LTM 총차입금(운용리스 포함)", withLease, "Yahoo", bsq.totalDebt);

    // StockAnalysis — TTM 은 최근 분기말이 앱 LTM 기준일과 같을 때만
    if (!foreign) {
      try {
        const bq = await saStatement(sym, "balance-sheet", true);
        const qEnd = bq.datekey.find((d) => d !== "TTM");
        const ttmOk = qEnd && dayDiff(qEnd, L.date) <= 7;
        if (ttmOk) put("LTM 총차입금(운용리스 포함)", withLease, "StockAnalysis", bq.debt?.[bq.datekey.indexOf(qEnd)]);
        const inc = await saStatement(sym, "income-statement");
        for (const [c, x] of Object.entries(H)) {
          const k = c === "LTM" ? (ttmOk ? inc.datekey.indexOf("TTM") : -1) : inc.datekey.findIndex((d) => d !== "TTM" && dayDiff(d, x.date) <= 7);
          if (k < 0) continue;
          put(`${c} 매출`, x.rev, "StockAnalysis", inc.revenue?.[k]);
          put(`${c} 순이익`, x.ni, "StockAnalysis", inc.netinc?.[k]);
          put(`${c} EBITDA`, x.ebitda, "StockAnalysis", inc.ebitda?.[k]);
          put(`${c} 영업이익`, IS[c]?.op, "StockAnalysis", inc.opinc?.[k]);
          put(`${c} 감가상각비`, IS[c]?.da, "StockAnalysis", inc.depAmorEbitda?.[k]);
        }
      } catch (e) {
        errs.push(String(e).slice(0, 80));
      }
    }

    // 인포맥스(FactSet) — 연간(백만 달러 단위)
    if (!foreign && imAnnual) {
      for (const [c, x] of Object.entries(H)) {
        if (c === "LTM") continue;
        const im = imAnnual.find((r) => dayDiff(r.end, x.date) <= 7);
        if (!im) continue;
        put(`${c} 매출`, x.rev, "인포맥스", im.rev, 1e6);
        put(`${c} 순이익`, x.ni, "인포맥스", im.ni, 1e6);
        put(`${c} EBITDA`, x.ebitda, "인포맥스", im.ebitda, 1e6);
        put(`${c} 영업이익`, IS[c]?.op, "인포맥스", im.op, 1e6);
        put(`${c} 감가상각비`, IS[c]?.da, "인포맥스", im.da, 1e6);
        put(`${c} 자산총계`, BS[c]?.assets, "인포맥스", im.assets, 1e6);
        // SEC 공시 EPS 는 소수 둘째 자리 — 인포맥스는 순이익÷주식수로 넷째 자리까지 내므로 공시 정밀도(±0.005)로 비교
        put(`${c} 희석 EPS`, x.eps, "인포맥스", im.eps, 0.01);
        put(`${c} 시가총액(결산일)`, x.mc, "인포맥스", im.mc, 1e6);
        // 인포맥스 "ev희석화수량" 은 표준 EV 가 아니다 — AAPL 2025: EV − 시가총액 = +1,168억 ≈ 인포맥스 총채무(채무자본금×자본총계
        // 1,124억), 현금을 빼지 않은 값으로 보인다. 정의가 다른 값이라 대조하지 않는다(시가총액은 일치 확인됨).
      }
      // LTM — 인포맥스 분기 4개 합(최근 분기말이 앱 LTM 기준일과 같을 때만)
      const q4 = (imAnnual.quarters ?? []).filter((r) => r.end <= L.date || dayDiff(r.end, L.date) <= 7).slice(-4);
      if (q4.length === 4 && dayDiff(q4[3].end, L.date) <= 7) {
        const sum = (k) => (q4.every((r) => r[k] != null) ? q4.reduce((s, r) => s + r[k], 0) : null);
        put("LTM 매출", L.rev, "인포맥스", sum("rev"), 4e6);
        put("LTM 순이익", L.ni, "인포맥스", sum("ni"), 4e6);
        put("LTM EBITDA", L.ebitda, "인포맥스", sum("ebitda"), 4e6);
        put("LTM 영업이익", IS.LTM?.op, "인포맥스", sum("op"), 4e6);
        put("LTM 감가상각비", IS.LTM?.da, "인포맥스", sum("da"), 4e6);
      }
    }
    try {
      const im = await infomaxShares(sym);
      const px = ov?.quote?.last;
      if (im && px && L.mc) put("현재 주식수(시총÷현재가)", L.mc / px, "인포맥스", im.shares, 1e3);
    } catch (e) {
      errs.push(`인포맥스 주식수: ${String(e).slice(0, 60)}`);
    }

    // 외부 불일치의 원인을 숫자로 확인한다(추정으로 통과시키지 않는다 — 식이 성립할 때만 "원인 확인").
    const opPassed = (col) => checks.some((k) => k.col === col && k.status === PASS && /^영업이익 앱 = SEC (영업이익|세전이익 − 지분법)/.test(k.name));
    // 지표 → A층(SEC 원자료 정확 대조) 검사 이름
    const A_OF = { 매출: /^매출 앱 = SEC 매출/, 순이익: /^(LTM )?순이익 앱 = SEC/, "희석 EPS": /^EPS 앱 = SEC 공시 EPS/, 자산총계: /^자산총계 앱 = SEC/ };
    const aPassed = (col, metric) => A_OF[metric] && checks.some((k) => k.col === col && k.status === PASS && A_OF[metric].test(k.name));
    const causeOf = (r, n) => {
      const col = r.item.split(" ")[0];
      const metric = r.item.slice(col.length + 1);
      const v = r.srcs[n].v, unit = r.srcs[n].unit;
      const within = (d) => Math.abs(d) <= Math.max(unit, 1e6);
      // ① 외부가 일회성 항목을 뺀 조정값 — 차이가 앱 일회성비용 행과 같다
      const oneOff = /^(영업이익|EBITDA)$/.test(metric) ? IS[col]?.oneOff : null;
      if (oneOff != null && oneOff !== 0 && within(v - r.ours - oneOff)) return { ok: "일회성 항목 조정 — 차이 = 앱 일회성비용" };
      // ② 외화 공시의 Yahoo 는 원통화 — 같은 해 두 지표에서 "앱 ÷ Yahoo" 비율(=환율)이 같다
      if (foreign && n === "Yahoo") {
        const other = ["매출", "순이익", "영업이익"].filter((m) => m !== metric).map((m) => recon.get(`${col} ${m}`)).find((x) => x?.srcs.Yahoo?.v);
        if (other) {
          const k1 = r.ours / v, k2 = other.ours / other.srcs.Yahoo.v;
          if (Math.abs(k1 / k2 - 1) < 1e-6 && Math.abs(k1 - 1) > 1e-3) return { ok: `Yahoo 원통화 표시 — 앱÷Yahoo 비율 ${k1.toPrecision(6)} 이 ${other.item} 과 같음(환율)` };
        }
      }
      // ③ 앱 = SEC 원자료(A층 정확 일치) → 외부는 다른 정의·조정 값
      if (metric === "영업이익" && opPassed(col)) return { ok: "앱 = SEC 공시 영업이익(A층 일치) — 외부는 조정·재분류 영업이익" };
      if (aPassed(col, metric)) return { ok: `앱 = SEC 공시 ${metric}(A층 정확 일치) — ${n} 는 다른 정의·조정` };
      // ⑥ 감가상각비·EBITDA: 차이 = SEC 운용리스 사용권자산 상각 — 외부는 운용리스 상각을 감가상각에 넣고 앱은 뺀다
      //    (CLAUDE.md: 운용리스 비용은 임차료 성격이라 EBITDA 에 이미 반영, PEP 2025 Yahoo 4,178 = 3,451 + 727)
      if (/^(감가상각비|EBITDA)$/.test(metric)) {
        const ol = col === "LTM" ? secTtm("OperatingLeaseRightOfUseAssetAmortizationExpense")?.v : atEnd(ann("OperatingLeaseRightOfUseAssetAmortizationExpense"), H[col]?.date ?? "")?.val;
        if (ol && within(v - r.ours - ol)) return { ok: `운용리스 사용권자산 상각(${ol}) 포함 여부 — 앱은 제외(임차료 성격)` };
      }
      // ⑤ 감가상각비: 다른 외부 소스가 앱과 정확히 같다(앱 = 현금흐름표 본표 줄) → 이 소스는 다른 정의
      if (metric === "감가상각비") {
        const same = Object.keys(r.srcs).filter((m) => m !== n && sameAt(r.ours, r.srcs[m].v, r.srcs[m].unit));
        if (same.length) return { ok: `앱(현금흐름표 본표 줄) = ${same.join("·")} — ${n} 는 다른 정의` };
      }
      // ④ EBITDA: 같은 소스의 영업이익 차이 + 감가상각비 차이로 정확히 분해되면 구성요소 항목으로 넘긴다
      if (metric === "EBITDA") {
        const o = recon.get(`${col} 영업이익`), d = recon.get(`${col} 감가상각비`);
        const dOp = o?.srcs[n] ? o.srcs[n].v - o.ours : null, dDa = d?.srcs[n] ? d.srcs[n].v - d.ours : null;
        if (dOp != null && dDa != null && within(v - r.ours - dOp - dDa))
          return { ok: `구성요소로 분해 — 영업이익 차 ${dOp}, 감가상각비 차 ${dDa} (각 항목 참조)` };
      }
      if (oneOff != null && oneOff !== 0 && Math.abs(v - r.ours - oneOff) <= Math.abs(v) * 1e-3) return { guess: `일회성 항목 조정 — 잔차 ${v - r.ours - oneOff}` };
      if (Math.abs(v - r.ours) <= Math.abs(v) * 5e-4) return { guess: `0.05% 이내 — 소스 반올림·주식수 기준일 차 추정(차 ${v - r.ours})` };
      return {};
    };
    for (const r of recon.values()) {
      const names = Object.keys(r.srcs);
      const matched = names.filter((n) => sameAt(r.ours, r.srcs[n].v, r.srcs[n].unit));
      const causes = Object.fromEntries(names.filter((n) => !matched.includes(n)).map((n) => [n, causeOf(r, n)]));
      const explained = names.filter((n) => causes[n]?.ok);
      const why = (n) => (causes[n]?.ok ? ` [원인 확인: ${causes[n].ok}]` : causes[n]?.guess ? ` [원인 추정: ${causes[n].guess}]` : "");
      const off = names.filter((n) => !matched.includes(n)).map((n) => `${n} ${r.srcs[n].v} (${(((r.ours - r.srcs[n].v) / Math.abs(r.srcs[n].v)) * 100).toFixed(2)}%)${why(n)}`);
      review.push({
        item: r.item,
        ours: r.ours,
        sources: Object.fromEntries(names.map((n) => [n, r.srcs[n].v])),
        matched,
        explained,
        causes: Object.fromEntries(Object.entries(causes).map(([n, c]) => [n, c.ok ?? (c.guess ? `추정: ${c.guess}` : null)])),
        verdict: off.length ? `${matched.length}/${names.length}곳 일치 — 불일치: ${off.join(", ")}` : `${names.length}곳 모두 일치`,
      });
    }

    for (const e of errs) review.push({ item: "외부 소스 조회 실패", note: e });
  }
  return { sym, checks, review, hardErrors };
}

// ── 한국 종목 1개 (kr/dart-ev.ts 단일 기준) ─────────────────────────────
// 한국은 아직 원자료(DART) 직접 대조 층이 없다 — 화면 간·항등식·기대치·LTM 기준일만.
async function verifyKr(sym) {
  const u = `/api/markets/kr/${encodeURIComponent(sym)}`;
  const checks = [];
  const add = (layer, name, col, r) => checks.push({ layer, name, col, ...r });
  const fetched = {};
  for (const [k, p] of Object.entries({
    hl: `${u}/highlights`, an: `${u}/financials?view=analysis`, tt: `${u}/ttm`,
    cs: `${u}/consensus`, bs: `${u}/financials?view=bs&period=annual`, is: `${u}/financials?view=is&period=annual`,
  })) {
    try { fetched[k] = await getJson(p); } catch (e) { fetched[k] = null; add("응답", `API 응답 ${k}`, "-", { status: FAIL, note: String(e).slice(0, 120) }); }
  }
  let row = null;
  try { row = await getJson(`/api/cron/verify-row?market=kr&symbol=${encodeURIComponent(sym)}`, 240_000, AUTH); }
  catch (e) { add("응답", "API 응답 verify-row", "-", { status: FAIL, note: String(e).slice(0, 120) }); }
  const { hl, an, tt, cs, bs, is } = fetched;
  const h = hl?.highlights;
  if (!h) return { sym, error: "하이라이트 없음", checks, review: [] };
  const fyCols = h.columns.filter((c) => c.kind === "fy");
  if (fyCols.length < 3) add("B", "연도 열 존재", "-", { status: FAIL, note: `연도 열 ${fyCols.length}개` });

  const H = {};
  h.columns.forEach((c, i) => {
    if (c.kind === "estimate") return;
    const lab = c.kind === "ltm" ? "LTM" : c.label;
    const r = (k) => h.rows.find((x) => x.key === k)?.values[i] ?? null;
    const v = (k) => h.valuationRows.find((x) => x.key === k)?.values[i] ?? null;
    H[lab] = { mc: r("mktcap"), pref: r("pref_mcap"), cash: r("cash"), debt: r("debt"), nci: r("nci"), ev: r("ev"), ebitda: r("ebitda"), ni: r("ni"), eps: r("eps"), per: v("per"), pbr: v("pbr"), psr: v("psr"), evx: v("ev_ebitda") };
  });
  const evBlocked = (h.notes ?? []).find((n) => /EV.*(미표시|표시하지 않|계산하지 않)/.test(n));
  const rowOf = (stmt, name) => stmt?.sections?.flatMap((s) => s.items ?? []).find((x) => x.accountName === name)?.values ?? {};
  const lab = (k) => (k === "현재/LTM" ? "LTM" : k);
  const A = {};
  for (const [name, key] of [["EV/EBITDA", "evx"], ["PER", "per"], ["PBR", "pbr"], ["PSR", "psr"]])
    for (const [k, v] of Object.entries(rowOf(an, name))) (A[lab(k)] ??= {})[key] = v;
  const C = {};
  for (const r of cs?.rows ?? []) if (!r.isEstimate) C[`${r.fy}Y`] = r;
  const cActual = (cs?.rows ?? []).filter((r) => !r.isEstimate);
  if (cs && !cActual.length) add("C", "컨센서스 실적 행 존재", "-", { status: FAIL, note: "컨센서스 응답에 실적 연도 행이 0개" });
  const cMin = cActual.length ? Math.min(...cActual.map((r) => r.fy)) : Infinity;
  // 손익계산서(연간 라벨 "FY2025" → "2025Y") — 순이익·EPS 화면 간 대조(재감사: 한국은 순이익·EPS 검사가 없었음)
  const IS = {};
  for (const [name, key] of [["당기순이익", "ni"], ["희석 EPS", "eps"], ["매출액", "rev"]])
    for (const [k, v] of Object.entries(rowOf(is, name))) (IS[k.replace(/^FY(\d{4})$/, "$1Y")] ??= {})[key] = v;
  const BS = {};
  for (const [name, key] of [["총차입금", "debt"], ["순차입금", "nd"]])
    for (const [k, v] of Object.entries(rowOf(bs, name))) (BS[k.replace(/^FY(\d{4})$/, "$1Y")] ??= {})[key] = v;

  // LTM 기준일 — 손익 TTM 이 분기까지 왔는데 재무상태표 스냅샷이 연말값이면 현금·차입금·자본이 낡았다
  const t = tt?.ttm;
  if (t?.snapshot) {
    // 손익 TTM 이 분기까지 왔으면 스냅샷 라벨은 정확히 그 분기("2026 Q2")여야 한다 —
    // 연말값 폴백("FY2025 (… 연말값)")·일부 항목 폴백 라벨은 실패로 둔다.
    const fq = (t.periodLabel ?? "").match(/\+\s*(\d{4})\s*(1분기|반기|3분기)/);
    const want = fq ? `${fq[1]} Q${{ "1분기": 1, 반기: 2, "3분기": 3 }[fq[2]]}` : null;
    const ok = want ? t.snapshot.label === want : /^FY\d{4}$/.test(t.snapshot.label ?? "");
    add("B", "LTM 재무상태표 기준일 = 손익 TTM 기준 분기", "LTM", ok
      ? { status: PASS, note: `손익 ${t.periodLabel} / 재무상태표 ${t.snapshot.label}` }
      : { status: FAIL, note: `손익 ${t.periodLabel} / 재무상태표 ${t.snapshot.label}${want ? ` (기대 ${want})` : ""}` });
  } else add("B", "LTM 스냅샷 존재", "LTM", { status: FAIL, note: "ttm.snapshot 없음" });

  for (const [c, x] of Object.entries(H)) {
    if (c !== "LTM") {
      add("C", "순이익 하이라이트=손익계산서", c, same(IS[c]?.ni ?? null, x.ni));
      add("C", "EPS 하이라이트=손익계산서", c, same(IS[c]?.eps ?? null, x.eps));
      add("C", "차입금 하이라이트=대차대조표 주석", c, same(BS[c]?.debt ?? null, x.debt));
      add("C", "순차입금 하이라이트=대차대조표 주석", c, same(BS[c]?.nd ?? null, x.debt == null ? null : x.debt + (x.cash ?? 0)));
      if (!C[c]) { if (Number(c.slice(0, 4)) >= cMin || !cs) add("C", "컨센서스 연도 존재", c, cs ? { status: FAIL, note: "컨센서스 범위 안인데 이 연도 행 없음" } : { status: NA, note: "컨센서스 응답 없음" }); }
      else {
        add("C", "EV/EBITDA 컨센서스=하이라이트", c, same(C[c].evEbitda ?? null, x.evx));
        add("C", "PER 컨센서스=하이라이트", c, same(C[c].per ?? null, x.per));
        add("C", "PBR 컨센서스=하이라이트", c, same(C[c].pbr ?? null, x.pbr));
      }
    }
    add("C", "EV/EBITDA 하이라이트=재무분석", c, same(A[c]?.evx ?? null, x.evx));
    add("C", "PER 하이라이트=재무분석", c, same(A[c]?.per ?? null, x.per));
    add("C", "PBR 하이라이트=재무분석", c, same(A[c]?.pbr ?? null, x.pbr));
    add("C", "PSR 하이라이트=재무분석", c, same(A[c]?.psr ?? null, x.psr));
    if (x.mc == null) add("D", "시가총액 존재", c, { status: NA, note: "시가총액 없음(상장 전 등) — 배수·EV 기대치 생략" });
    if (x.eps != null && x.mc != null) {
      if (x.eps <= 0) add("D", "PER 부호 규칙(분모 ≤ 0 → 빈칸)", c, x.per == null ? { status: PASS } : { status: FAIL, note: `EPS ${x.eps} 인데 PER ${x.per}` });
      else add("D", "PER 기대치(분모 > 0 → 값 있음)", c, x.per != null ? { status: PASS } : { status: FAIL, note: `EPS ${x.eps} 인데 PER 빈칸` });
    }
    if (!evBlocked && x.mc != null) {
      if (x.ev == null) add("D", "EV 기대치", c, { status: FAIL, note: "EV 미표시 사유 없이 빈칸" });
      else {
        const sum = (x.mc ?? 0) + (x.pref ?? 0) + (x.debt ?? 0) + (x.nci ?? 0) + (x.cash ?? 0);
        add("D", "EV = 보통주+우선주 시총+차입금+NCI−현금", c, same(x.ev, sum));
        if (x.ebitda != null && x.ebitda > 0) add("D", "EV/EBITDA = EV÷EBITDA", c, same(x.evx, x.ev / x.ebitda));
        if (x.ebitda != null && x.ebitda <= 0) add("D", "EV/EBITDA 부호 규칙", c, x.evx == null ? { status: PASS } : { status: FAIL, note: `EBITDA ${x.ebitda} 인데 ${x.evx}` });
      }
    }
  }
  const L = H.LTM;
  if (row && L) {
    const m = row.overview?.multiples ?? null, uv = row.universe ?? null;
    if (!m) add("C", "개요 멀티플 계산됨", "LTM", { status: FAIL, note: `개요 멀티플 없음 ${JSON.stringify(row.overview?.warnings ?? [])}` });
    else {
      add("C", "시가총액 개요=하이라이트", "LTM", same(m.marketCap, L.mc));
      add("C", "PER(TTM) 개요=하이라이트", "LTM", same(m.perTtm, L.per));
      add("C", "PBR 개요=하이라이트", "LTM", same(m.pbr, L.pbr));
      add("C", "PSR 개요=하이라이트", "LTM", same(m.psr, L.psr));
      add("C", "EV/EBITDA 개요=하이라이트", "LTM", same(m.evEbitda, L.evx));
    }
    if (!uv || uv.error) add("C", "유니버스 행 계산됨", "LTM", { status: FAIL, note: uv?.error ?? "응답 없음" });
    else {
      add("C", "시가총액 유니버스=하이라이트", "LTM", same(uv.marketCap, L.mc));
      add("C", "PER(TTM) 유니버스=하이라이트", "LTM", same(uv.perTtm, L.per));
      add("C", "PBR 유니버스=하이라이트", "LTM", same(uv.pbr, L.pbr));
    }
  }
  return { sym, checks, review: [] };
}

// ── 실행 ─────────────────────────────────────────────────────────────
const syms = await symbolList();
if (!syms.length) die("검증 대상 0종목");
const kst = new Date(Date.now() + 9 * 3600e3).toISOString();
// 초까지 — 같은 분에 연달아 돌리면 결과 파일이 덮어써졌다
const stamp = `${MARKET}-${kst.slice(0, 10).replace(/-/g, "")}-${kst.slice(11, 19).replace(/:/g, "")}`;
const dir = new URL("../reports/verify/", import.meta.url);
mkdirSync(dir, { recursive: true });
const partialFile = new URL(`verify-${stamp}.partial.json`, dir);
console.log(`검증 대상 ${syms.length}종목 · ${MARKET} · ${BASE} · 외부대조 ${EXTERNAL ? "켬" : "끔"}`);

const results = [];
let idx = 0;
async function worker() {
  while (idx < syms.length) {
    const s = syms[idx++];
    try {
      const r = MARKET === "kr" ? await verifyKr(s) : await verifyUs(s);
      results.push(r);
      const f = r.checks.filter((c) => c.status === FAIL).length;
      const n = r.checks.filter((c) => c.status === NA).length;
      const p = r.checks.filter((c) => c.status === PASS).length;
      console.log(`${s.padEnd(7)} ${r.skipped ? `건너뜀: ${r.skipped}` : r.error ? `오류: ${r.error}` : `실패 ${f} · 검증불가 ${n} · 통과 ${p} · 외부 전부일치 ${r.review.filter((x) => x.matched && !/불일치/.test(x.verdict)).length} · 외부 불일치 ${r.review.filter((x) => /불일치/.test(x.verdict ?? "")).length} · 기타검토 ${r.review.filter((x) => !x.matched).length}`}`);
    } catch (e) {
      results.push({ sym: s, error: String(e).slice(0, 160), checks: [], review: [] });
      console.log(`${s.padEnd(7)} 오류: ${String(e).slice(0, 120)}`);
    }
    if (results.length % 10 === 0) writeFileSync(partialFile, JSON.stringify({ base: BASE, market: MARKET, total: syms.length, results }));
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const all = results.flatMap((r) => r.checks.map((c) => ({ sym: r.sym, ...c })));
const fails = all.filter((c) => c.status === FAIL);
const errors = results.filter((r) => r.error || r.hardErrors?.length);
const badSkips = results.filter((r) => r.skipped && !r.allowedSkip);
const empty = results.filter((r) => !r.error && !r.skipped && r.checks.filter((c) => c.status === PASS).length === 0);
const missing = syms.filter((s) => !results.some((r) => r.sym === s));

const byName = {};
for (const c of all) {
  const b = (byName[`${c.layer} ${c.name}`] ??= { pass: 0, fail: 0, unverifiable: 0, naWhy: {} });
  b[c.status]++;
  if (c.status === NA) b.naWhy[(c.note ?? "").split(" · ")[0].slice(0, 40)] = (b.naWhy[(c.note ?? "").split(" · ")[0].slice(0, 40)] ?? 0) + 1;
}
console.log("\n── 검사 항목별 (층 A=SEC 원자료 B=결산기간 C=화면간 D=항등식·기대치 E=공시정합성) ──");
for (const [n, b] of Object.entries(byName).sort()) {
  console.log(`  ${n.padEnd(52)} 통과 ${b.pass} · 실패 ${b.fail} · 검증불가 ${b.unverifiable}`);
  for (const [why, k] of Object.entries(b.naWhy)) console.log(`      └ 검증불가 ${k}: ${why}`);
}
if (fails.length) {
  console.log("\n── 실패 상세 ──");
  for (const f of fails) console.log(`  ${f.sym} ${f.col} [${f.layer}] ${f.name}: ${f.note ?? ""}`);
}
const reviews = results.flatMap((r) => (r.review ?? []).map((x) => ({ sym: r.sym, ...x })));
// 외부 대조는 허용치 없이 — 소스 하나라도 앱과 다르면 원인 규명 대상으로 전부 보인다
const shownReviews = reviews.filter((x) => !x.verdict || /불일치/.test(x.verdict));
if (shownReviews.length) {
  console.log("\n── 외부 대조 불일치·기타 검토 (원인 규명 대상) ──");
  for (const x of shownReviews) console.log(`  ${x.sym} ${x.item}: ${x.verdict ?? x.note ?? ""}`);
}
const out = new URL(`verify-${stamp}.json`, dir);
writeFileSync(out, JSON.stringify({ base: BASE, market: MARKET, at: new Date().toISOString(), symbols: syms, results }, null, 2));
rmSync(partialFile, { force: true });

// 관리자 화면(/admin/verify)용 저장 — 종목별 최신 결과로 교체. 통과 항목은 건수만.
if (args.post) {
  const docs = results.map((r) => {
    const cs = r.checks ?? [];
    const rv = r.review ?? [];
    const pick = (st) => cs.filter((c) => c.status === st).map((c) => ({ layer: c.layer, name: c.name, col: c.col, note: c.note ?? "" }));
    return {
      market: MARKET,
      symbol: r.sym,
      runAt: new Date().toISOString(),
      base: BASE,
      commit: process.env.GITHUB_SHA ?? null,
      counts: {
        fail: cs.filter((c) => c.status === FAIL).length,
        unverifiable: cs.filter((c) => c.status === NA).length,
        pass: cs.filter((c) => c.status === PASS).length,
        extAllMatch: rv.filter((x) => x.verdict && !/불일치/.test(x.verdict)).length,
        extMismatch: rv.filter((x) => /불일치/.test(x.verdict ?? "")).length,
        otherReview: rv.filter((x) => !x.verdict).length,
      },
      fails: pick(FAIL),
      unverifiable: pick(NA),
      external: rv,
      errors: [r.error, r.skipped && !r.allowedSkip ? `건너뜀: ${r.skipped}` : null, ...(r.hardErrors ?? [])].filter(Boolean),
    };
  });
  for (let i = 0; i < docs.length; i += 10) {
    const res = await fetch(`${BASE}/api/cron/verify-results`, {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ results: docs.slice(i, i + 10) }),
    });
    if (!res.ok) {
      console.error(`결과 저장 실패 HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
      process.exit(1);
    }
  }
  console.log(`결과 저장 ${docs.length}종목 → ${BASE}/admin/verify`);
}
console.log(`\n실패 ${fails.length} · 오류 ${errors.length} · 부당 건너뜀 ${badSkips.length} · 통과 0건 종목 ${empty.length} · 누락 ${missing.length} · 결과 ${decodeURIComponent(out.pathname)}`);
process.exit(fails.length || errors.length || badSkips.length || empty.length || missing.length ? 1 : 0);
