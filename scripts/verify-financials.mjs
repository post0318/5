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
 * 2차 감사 반영(2026-09-24): 영업이익 합성 판정은 SEC 본표 근거로만 · 모기지 리츠 건너뜀은 SEC 원자료로 확인될 때만 ·
 * LTM EBITDA·PBR 기대치 · 외부·SEC 조회 실패 전부 종료코드 1 · 감가상각비 = SEC 현금흐름표 본표 줄 합(A층, 운용리스 상각
 * 원인 확인의 전제) · EBITDA = 영업이익 + 감가상각비(D층, 미국·한국) · 연도 라벨 = SEC fy(B층) · 국내 FnGuide 순이익(지배)
 * 정의 일치·EV(비지배지분)·EPS(자사주 포함 주식수) 원인 확인.
 * 2026-09-24 감가상각비: A층 현금흐름표 줄 합에서 손상(손상 포함 줄 — TSLA·XOM)·중단사업 감가상각(중단사업 포함 현금흐름표 —
 * WDC·MMM·JNJ)을 10-K 원본 태그로 따로 빼서 대조(예전 줄 합 대조는 앱과 같이 틀렸다 — 공통모드) · StockAnalysis 원인
 * ⑦ 앱 = depAmorEbitda + 현금흐름표 기타상각.
 * 2026-09-25: A층 EPS — 총 희석 EPS 태그가 없으면 같은 10-K 의 계속영업 + 중단영업 희석 EPS 합(DELL FY2022) · A층 결산일
 * 주식수(앱 시총 ÷ 결산일 실제 종가 = SEC 본표 주식수) · 인포맥스 원인 ⑨ EPS = SEC 순이익 ÷ 희석주식수 자체 계산,
 * ⑩ 결산일 시가총액 = 전년도 주식수 사용, 앱=SEC 본표=StockAnalysis 인데 인포맥스만 다르면 "외부 단독 이탈"(원인 확인 아님).
 * 2026-09-25 매출 닫기(docs/metrics/revenue.md §6): A층 매출 기대값 = 손익계산서 본표(_pre 표시 순서·_cal 계산 관계)의 첫 총매출 줄
 * (태그 순서 아님, 최신 판본) — 연간·분기(3개월, Q4 = 사업연도 − 9개월)·LTM. C층 매출 소비처 전부(총괄·컨센서스·개요·유니버스)와
 * 성장률·마진·PSR 재계산, D층 분기 4개 합 = 연간·LTM = 최근 4분기 합(R4 반올림 차 명시), F층 매출 ①/②/외부 단독 이탈/③ 분류.
 *
 * 실행:
 *   node scripts/verify-financials.mjs --symbols=AAPL,WMT
 *   node scripts/verify-financials.mjs --universe | --sp500 [--limit=50]
 *   node scripts/verify-financials.mjs --market=kr --symbols=005930
 *   옵션: --base=http://localhost:3000 · --concurrency=2 · --no-external
 *         --metric=revenue (매출 닫기 모드 — 종료코드 = 매출 검사 실패·매출 ③ 오류·조회 실패. 기본 실행은 종전 기준)
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
const KNOWN = new Set(["symbols", "universe", "sp500", "limit", "market", "base", "concurrency", "no-external", "post", "missing", "metric"]);
// 매출 닫기 모드(revenue.md §8) — 종료코드를 매출 검사 실패·매출 ③ 오류·조회 실패 기준으로. 기본 실행은 종전 그대로
const METRIC = args.metric == null ? null : String(args.metric).toLowerCase();
if (METRIC != null && METRIC !== "revenue") die(`--metric 은 revenue 만 지원 (받은 값: ${args.metric})`);
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
/** 공시 원본(인스턴스) — 한 종목 안에서 같은 원본을 여러 대조가 다시 받지 않게 최근 12건만 캐시(SEC 요청 절약) */
const instCache = new Map();
function secInstance(url) {
  if (!instCache.has(url)) {
    instCache.set(url, secText(url).catch((e) => { instCache.delete(url); throw e; }));
    if (instCache.size > 12) instCache.delete(instCache.keys().next().value);
  }
  return instCache.get(url);
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

// ── 반올림 재태깅 판정(검증기 독립 구현 — 앱 코드 import 안 함) ─────────────────────────────
// 나중 공시가 같은 기간 값을 먼저 공시된 정밀값의 100만·1억·10억·100억 단위 반올림값으로 다시 태깅하면(MCD 2022 자산총계:
// 50,435,600,000 → 2025 10-K 에서 백만 단위 50,436,000,000, AXP 2021 "$189 billion") 그 값은 기준값에서 뺀다
// (오너 승인 2026-09-25 — 1e6 추가). 같은 기간(start·end 동일)끼리만. 규칙은 앱(edgar-series.ts dropRoundedRetags)과 같게 —
// 나중 값 |값| ≥ 1억(작은 값은 판정 안 함), 먼저 값이 그 단위의 배수가 아닐 때만(이미 둥근 값끼리는 재태깅 아님).
const RETAG_UNITS = [1e6, 1e8, 1e9, 1e10];
function roundedRetagUnit(e, list) {
  if (!e.val || Math.abs(e.val) < 1e8) return null;
  for (const o of list) {
    if ((o.filed ?? "") >= (e.filed ?? "") || o.start !== e.start || o.end !== e.end || o.val === e.val) continue;
    const u = RETAG_UNITS.find((k) => o.val % k !== 0 && Math.round(o.val / k) * k === e.val);
    if (u) return u;
  }
  return null;
}
/** 최신 공시값(반올림 재태깅 제외). 제외한 나중 값이 있으면 { ...선택값, retag: { val, filed, unit } } */
function latestPrecise(list) {
  const sorted = [...list].sort((a, b) => (a.filed ?? "").localeCompare(b.filed ?? ""));
  const flags = sorted.map((e) => roundedRetagUnit(e, sorted));
  const keep = sorted.filter((_, i) => !flags[i]);
  const e = keep.at(-1) ?? null;
  const di = flags.map((u, i) => (u ? i : -1)).filter((i) => i >= 0).at(-1);
  return e && di != null && di >= 0 ? { ...e, retag: { val: sorted[di].val, filed: sorted[di].filed, unit: flags[di] } } : e;
}
/** 기준값 메모 — 먼저 공시된 정밀값과 나중 반올림값이 갈리면 둘 다 남긴다 */
const retagNote = (e) => (e?.retag ? `반올림 재태깅 제외 — 먼저 공시된 정밀값 ${e.val}(${e.filed}) 채택, 나중 공시 ${e.retag.val}(${e.retag.filed})는 ${e.retag.unit} 단위 반올림` : "");

// ── SEC 연간 사실 (결산 기간 = (start, end) 단위, 연도 키 아님) ────────────
function annualPeriods(facts, ns, concept, unit) {
  // end → 가장 최근 공시 사실 (10-K·10-K/A·20-F, 300~400일 기간) — 반올림 재태깅 제외
  const g = new Map();
  for (const e of facts?.[ns]?.[concept]?.units?.[unit] ?? []) {
    if (!e.start || !/^(10-K|20-F)/.test(e.form)) continue;
    const d = (Date.parse(e.end) - Date.parse(e.start)) / 864e5;
    if (d < 300 || d > 400) continue;
    g.set(e.end, [...(g.get(e.end) ?? []), e]);
  }
  return new Map([...g].map(([end, list]) => [end, latestPrecise(list)]));
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

// ── 외부 정의 차이 원인(R1~R3·R5·R6)용 공시 원본 판독 — 앱 모듈과 별개로 검증기가 직접 읽는다 ───────────────
function parseContexts(xml) {
  const ctx = new Map();
  for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
    const b = m[2];
    ctx.set(m[1], {
      start: /<(?:xbrli:)?startDate>\s*([^<\s]+)/.exec(b)?.[1], end: /<(?:xbrli:)?endDate>\s*([^<\s]+)/.exec(b)?.[1],
      instant: /<(?:xbrli:)?instant>\s*([^<\s]+)/.exec(b)?.[1],
      // 명시 멤버는 멤버명, 유형 멤버(typedMember)는 안쪽 값 — 2026 택사노미의 손익 위치 축(StatementOfIncomeLocationBalanceAxis)은
      // 유형 멤버에 QName(us-gaap:Revenues)을 담는다(GOOG 2026-06 10-Q)
      dims: [...b.matchAll(/dimension="([^"]+)"[^>]*>\s*(?:<[^>/]+>\s*([^<]*?)\s*<\/[^>]+>|([^<]*?))\s*</g)].map((d) => [d[1].split(":").pop(), (d[2] ?? d[3] ?? "").split(":").pop() || "(typed)"]),
    });
  }
  return ctx;
}
/**
 * 기준일(±7일)의 정기공시(10-Q/10-K) 한 건 — 그 날짜 시점값 전부(차원 포함)·라벨·재무상태표 본표 계산 구조.
 * → { form, filed, date, facts: [{ id, dims, v }], labels: Map, kids: Map(부모 → 자식[]), faceIds: Set, roots }
 */
async function filingAtDate(cik, sub, date) {
  const rc = sub.filings?.recent ?? {};
  const k = (rc.form ?? []).findIndex((fm, i) => /^(10-[QK]|20-F|40-F)$/.test(fm) && rc.reportDate?.[i] && dayDiff(rc.reportDate[i], date) <= 7);
  if (k < 0) return null;
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${rc.accessionNumber[k].replace(/-/g, "")}`;
  const names = (await secJson(base + "/index.json")).directory.item.map((x) => x.name);
  const xsd = names.find((x) => /\.xsd$/i.test(x));
  const calName = names.find((x) => /_cal\.xml$/i.test(x)) ?? xsd, labName = names.find((x) => /_lab\.xml$/i.test(x)) ?? xsd;
  const instName = names.find((x) => /_htm\.xml$/i.test(x));
  if (!instName || !calName) return null;
  const xml = await secText(`${base}/${instName}`);
  const ctx = parseContexts(xml);
  const facts = [], durFacts = [];
  for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*?)contextRef="([^"]+)"([^>]*)>\s*(-?[\d.]+)\s*</g)) {
    const c = ctx.get(m[4]);
    const unit = /unitRef="([^"]+)"/.exec(`${m[3]} ${m[5]}`)?.[1] ?? "";
    if (c?.start && c.end && dayDiff(c.end, rc.reportDate[k]) <= 1) { durFacts.push({ id: `${m[1]}_${m[2]}`, dims: c.dims, start: c.start, end: c.end, v: Number(m[6]), unit }); continue; }
    if (!c?.instant || dayDiff(c.instant, rc.reportDate[k]) > 1) continue;
    facts.push({ id: `${m[1]}_${m[2]}`, dims: c.dims, v: Number(m[6]), unit });
  }
  const cal = await secText(`${base}/${calName}`);
  const lab = labName === calName ? cal : await secText(`${base}/${labName}`);
  const locMap = (x) => { const r = new Map(); for (const l of x.matchAll(/<link:loc\b([^>]*)\/?>/g)) { const id = /xlink:label="([^"]+)"/.exec(l[1])?.[1], h = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1]; if (id && h) r.set(id, h); } return r; };
  const labels = new Map();
  { const loc = locMap(lab), text = new Map();
    for (const m of lab.matchAll(/<link:label\b([^>]*)>([^<]*)<\/link:label>/g)) { const id = /xlink:label="([^"]+)"/.exec(m[1])?.[1]; if (id && !/documentation/i.test(m[1])) text.set(id, [...(text.get(id) ?? []), m[2].trim()]); }
    for (const a of lab.matchAll(/<link:labelArc\b([^>]*)\/?>/g)) { const f = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? ""), t = text.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? ""); if (f && t) labels.set(f, [...(labels.get(f) ?? []), ...t]); } }
  const kids = new Map(), faceIds = new Set(), hasParent = new Set();
  for (const m of cal.matchAll(/<link:calculationLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/link:calculationLink>/g)) {
    const role = m[1].split("/").pop() ?? "";
    if (!/BALANCESHEET|FINANCIALPOSITION|FINANCIALCONDITION/i.test(role) || /Parenth|Detail|Table|Polic/i.test(role)) continue;
    const loc = locMap(m[2]);
    for (const a of m[2].matchAll(/<link:calculationArc\b([^>]*)\/?>/g)) {
      const fr = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? ""), to = loc.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
      if (!fr || !to) continue;
      kids.set(fr, [...(kids.get(fr) ?? []), to]); faceIds.add(fr); faceIds.add(to); hasParent.add(to);
    }
  }
  return { form: rc.form[k], filed: rc.filingDate[k], date: rc.reportDate[k], facts, durFacts, labels, kids, faceIds, roots: [...faceIds].filter((x) => !hasParent.has(x)) };
}
/**
 * 재무상태표 본표 차입금·리스 줄 — 검증기 독립 판정(개념명·라벨 규칙, 앱과 같은 성격의 규칙이라 공통모드). 차입금 성격 노드를 만나면
 * 그 아래로 내려가지 않는다(소계·하위 줄 이중 합산 방지). IFRS(ifrs-full·회사 고유)는 리스부채를 차입금에 포함(CLAUDE.md 한국·IFRS 규칙).
 * → { faceVals: [{ id, v }], faceSum, val0, nm, lab }
 */
function faceDebtLines(fl, unitRe = /usd/i) {
  const lab = (id) => (fl.labels.get(id) ?? []).join(" | ");
  const nm = (id) => id.replace(/^[a-z0-9-]+_/, "");
  // 단위 지정 — 20-F 는 원통화와 USD 편의 환산값이 같은 개념에 나란히 있다(TSM)
  const val0 = (id) => fl.facts.find((x) => x.id === id && !x.dims.length && unitRe.test(x.unit ?? ""))?.v ?? null;
  const STD = /Debt|Borrowing|Bonds?Issued|BondsPayable|NotesPayable|CommercialPaper|LinesOfCredit|LineOfCredit|FinanceLease|CapitalLease|OperatingLeaseLiabilit|LeaseLiabilit|ConvertibleNotes|SeniorNotes|LoansPayable|NotesAndLoans|ShortTermNonBankLoans|FinancingObligation/;
  const CUS = /debt|borrowing|bonds payable|notes payable|commercial paper|lease liabilit|lease obligation|finance lease|capital lease|financing obligation/i;
  const EXC = /Interest|Accrued|Derivative|Asset|Receivable|Securit|Investment|Tax|Unamortized|Issuance|Discount|Premium/i;
  const isDebt = (id) => { const std = id.startsWith("us-gaap_"); return std ? STD.test(nm(id)) && !EXC.test(nm(id)) : (CUS.test(lab(id)) || STD.test(nm(id))) && !EXC.test(`${nm(id)} ${lab(id)}`); };
  const lines = [], seen = new Set();
  const walk = (id, d) => { if (d > 8 || seen.has(id)) return; seen.add(id); if (isDebt(id)) { lines.push(id); return; } for (const k of fl.kids.get(id) ?? []) walk(k, d + 1); };
  for (const r0 of fl.roots) walk(r0, 0);
  const faceVals = lines.map((id) => ({ id, v: val0(id) })).filter((x) => x.v != null);
  return { faceVals, faceSum: faceVals.reduce((t, x) => t + x.v, 0), val0, nm, lab };
}
/**
 * 20-F 총차입금 기대값(오너 결정 "원칙 유지" 2026-09-25 — 앱 규칙의 재구현, 공통모드):
 *  본표 차입금 줄 + 리스. IFRS 는 리스 전액 — 본표에 유동·비유동 리스 중 한쪽만 있으면 없는 쪽을 주석값으로 더하고, 본표에 리스 줄이
 *  없으면 주석 리스 전액을 더한다. 단 본표 차입금 줄 라벨이 리스를 포함한다고 밝히면(NVO) 더하지 않는다. US-GAAP 20-F(ASML)는 미국
 *  규칙 ③과 같이 본표에 금융리스 줄이 없으면 주석 금융리스만 더한다(운용리스 제외). 본표에 차입금 줄이 아예 없으면(SAP — 금융부채
 *  합산 줄) 태그 폴백: ifrs Borrowings + LeaseLiabilities.
 * → { sum, parts: [{ what, id, v, kind }], face } | null   kind: face | curLease | nonLease | lease | finLease | fallback
 */
function expectedForeignDebt(fl, unitRe) {
  const fd = faceDebtLines(fl, unitRe);
  const v0 = (id) => fl.facts.find((x) => x.id === id && !x.dims.length && unitRe.test(x.unit ?? ""))?.v ?? null;
  const ifrs = fl.facts.some((x) => x.id.startsWith("ifrs-full_"));
  const parts = fd.faceVals.map((x) => ({ what: "본표", id: x.id, v: x.v, kind: "face" }));
  const has = (re) => fd.faceVals.some((x) => re.test(fd.nm(x.id)));
  if (!fd.faceVals.length) {
    if (!ifrs) return null;
    const b = v0("ifrs-full_Borrowings"), l = v0("ifrs-full_LeaseLiabilities");
    if (b == null) return null;
    parts.push({ what: "태그 폴백(본표 차입금 줄 없음)", id: "ifrs-full_Borrowings", v: b, kind: "fallback" });
    if (l != null) parts.push({ what: "태그 폴백 리스", id: "ifrs-full_LeaseLiabilities", v: l, kind: "lease" });
  } else if (ifrs) {
    // 리스가 차입금 줄 안에 표시되는지 — 본표 차입금 줄 라벨이 리스를 밝히거나, 회사가 리스·차입금을 한 개념으로 공시(NVO
    // nvo:LeaseAndBorrowingUndiscountedCashFlow — 차입금 만기표에 리스를 합쳐 공시)
    const combo = fl.facts.find((x) => !x.dims.length && /LeaseAndBorrowing|BorrowingsAndLease|BorrowingsIncludingLease|LeaseLiabilitiesAndBorrowings/i.test(x.id));
    const leaseInDebt = fd.faceVals.some((x) => /lease/i.test(fd.lab(x.id)) && !/LeaseLiabilit/.test(fd.nm(x.id))) || !!combo;
    if (leaseInDebt) parts.push({ what: `리스는 차입금 줄 안에 포함(${combo ? combo.id.replace(/^[a-z0-9-]+_/, "") : "본표 라벨"}) — 가산 안 함`, id: "-", v: 0, kind: "note" });
    const cur = has(/^CurrentLeaseLiabilities$/), non = has(/^NoncurrentLeaseLiabilities$/), tot = has(/^LeaseLiabilities$/);
    if (!leaseInDebt && !tot) {
      if (cur && !non) { const x = v0("ifrs-full_NoncurrentLeaseLiabilities"); if (x != null) parts.push({ what: "주석 비유동 리스", id: "ifrs-full_NoncurrentLeaseLiabilities", v: x, kind: "nonLease" }); }
      else if (non && !cur) { const x = v0("ifrs-full_CurrentLeaseLiabilities"); if (x != null) parts.push({ what: "주석 유동 리스", id: "ifrs-full_CurrentLeaseLiabilities", v: x, kind: "curLease" }); }
      else if (!cur && !non) { const x = v0("ifrs-full_LeaseLiabilities"); if (x != null) parts.push({ what: "주석 리스 전액", id: "ifrs-full_LeaseLiabilities", v: x, kind: "lease" }); }
    }
  } else if (!has(/FinanceLease|CapitalLease/)) {
    const c = v0("us-gaap_FinanceLeaseLiabilityCurrent"), n = v0("us-gaap_FinanceLeaseLiabilityNoncurrent"), t = v0("us-gaap_FinanceLeaseLiability");
    if (c != null || n != null) { if (c != null) parts.push({ what: "주석 금융리스(유동)", id: "us-gaap_FinanceLeaseLiabilityCurrent", v: c, kind: "finLease" }); if (n != null) parts.push({ what: "주석 금융리스(비유동)", id: "us-gaap_FinanceLeaseLiabilityNoncurrent", v: n, kind: "finLease" }); }
    else if (t != null) parts.push({ what: "주석 금융리스", id: "us-gaap_FinanceLeaseLiability", v: t, kind: "finLease" });
  }
  return { sum: parts.reduce((t, x) => t + x.v, 0), parts, face: fd, v0 };
}
/**
 * 최근 10-K 인스턴스들의 연간(300일 초과) 매출 사실(차원 포함) — 먼저 읽은(최신) 공시 우선. [{ id, start, end, dims, v }]
 * 매출 줄에 인식된 파생상품 손익(현금흐름위험회피 재분류·비지정 파생상품 — 손익계산서 위치 차원)도 함께 읽는다(R8 확장).
 * 파생상품 표는 2~3개 연도만 싣고 옛 연도는 그 해 10-K 에만 있다(LRCX FY2022·CAT 2021) → `ends` 결산일의 10-K 는 최근 3건 밖이어도 읽는다.
 */
const REV_HEDGE_TAGS = "OtherComprehensiveIncomeLossCashFlowHedgeGainLossReclassificationBeforeTax|DerivativeInstrumentsGainLossReclassifiedFromAccumulatedOCIIntoIncomeEffectivePortionNet|DerivativeGainLossOnDerivativeNet|GainLossOnDerivativeInstrumentsNetPretax";
// 매출 줄에 인식된 파생상품 손익 성분(R8 확장) — 손익 위치 축(명시 멤버 또는 2026 택사노미 유형 멤버 QName)이 매출·판매인 사실만
const LOC_AXES = ["IncomeStatementLocationAxis", "StatementOfIncomeLocationBalanceAxis"];
const HEDGE_REL = "DerivativeInstrumentsGainLossByHedgingRelationshipAxis", HEDGE_DES = "HedgingDesignationAxis";
const revLoc = (ds) => ds.some((d) => LOC_AXES.includes(d[0]) && /Revenue|Sales/i.test(d[1]) && !/Cost|Expense/i.test(d[1]));
const DERIV_FAM = {
  cf: { ids: ["OtherComprehensiveIncomeLossCashFlowHedgeGainLossReclassificationBeforeTax", "DerivativeInstrumentsGainLossReclassifiedFromAccumulatedOCIIntoIncomeEffectivePortionNet"], pred: () => true },
  nd: { ids: ["DerivativeGainLossOnDerivativeNet", "GainLossOnDerivativeInstrumentsNetPretax"], pred: (ds) => !ds.some((d) => d[0] === HEDGE_REL) && !ds.some((d) => d[0] === HEDGE_DES && /^Designated/i.test(d[1])) },
};
/** 같은 기간 사실 중 분해 차원(위치·관계·지정 제외)이 같은 것은 하나만 — 차원 없는 합계가 있으면 그것, 없으면 멤버 합 */
function aggDeriv(facts) {
  const byKey = new Map();
  for (const x of facts) { const k = x.dims.filter((d) => ![...LOC_AXES, HEDGE_REL, HEDGE_DES].includes(d[0])).map((d) => d.join("=")).sort().join("|"); if (!byKey.has(k)) byKey.set(k, x.v); }
  return byKey.has("") ? byKey.get("") : [...byKey.values()].reduce((t, y) => t + y, 0);
}
/**
 * 한 기간의 사실들(facts, 공시 순번 fi 포함) → 성분 선택지 [{ id, v }]. 성분마다 공시 한 건의 사실만 합친다(공시마다 차원 구성이 달라
 * 섞으면 두 번 더해진다). 공시별 값은 각각 선택지 — 나중 10-K 가 같은 기간을 0.1B 단위로 다시 공시하는 경우(XOM 2024 −661 → −700)
 * 정밀값 공시로도 대조(반올림값 허용이 아니라 정밀값 공시를 찾아 쓰는 것)
 */
function revDerivFamily(facts, kind) {
  const { ids, pred } = DERIV_FAM[kind];
  for (const id of ids) {
    const fs = facts.filter((x) => x.id === id && revLoc(x.dims) && pred(x.dims));
    if (!fs.length) continue;
    return [...new Set(fs.map((x) => x.fi))].map((fi) => ({ id, v: aggDeriv(fs.filter((x) => x.fi === fi)) })).filter((o, i, a) => o.v !== 0 && a.findIndex((p) => p.v === o.v) === i);
  }
  return [];
}
async function annualRevenueDimFacts(cik, sub, maxFilings = 3, ends = []) {
  const rc = sub.filings?.recent ?? {};
  const out = [], seen = new Set();
  let n = 0;
  for (let i = 0; i < (rc.form ?? []).length; i++) {
    if (rc.form[i] !== "10-K") continue;
    n++;
    if (n > maxFilings && !ends.some((e) => rc.reportDate?.[i] && dayDiff(rc.reportDate[i], e) <= 7)) continue;
    const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${rc.accessionNumber[i].replace(/-/g, "")}`;
    const name = (await secJson(base + "/index.json")).directory.item.map((x) => x.name).find((x) => /_htm\.xml$/i.test(x));
    if (!name) continue;
    const xml = await secInstance(`${base}/${name}`);
    const ctx = parseContexts(xml);
    for (const m of xml.matchAll(new RegExp(String.raw`<us-gaap:(Revenues|RevenueFromContractWithCustomerExcludingAssessedTax|${REV_HEDGE_TAGS})\b([^>]*?)contextRef="([^"]+)"([^>]*)>\s*(-?[\d.]+)\s*<`, "g"))) {
      const c = ctx.get(m[3]);
      if (!c?.start || !c.end || (Date.parse(c.end) - Date.parse(c.start)) / 864e5 < 300) continue;
      // 파생상품 사실은 공시별로 남긴다 — 나중 10-K 가 같은 기간을 0.1B 단위로 다시 공시하기도 해서(XOM 2023: 986 → 1,000) 공시마다 따로 대조
      const key = `${m[1]}|${c.start}|${c.end}|${c.dims.flat().join(",")}${/^(Revenues|RevenueFromContract)/.test(m[1]) ? "" : `|${n}`}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: m[1], start: c.start, end: c.end, dims: c.dims, v: Number(m[5]), fi: n });
    }
  }
  return out;
}

// ── 매출 A층 — 손익계산서 본표 구조(_pre 표시 순서 + _cal 계산 관계)에서 매출 줄을 검증기가 직접 판독(revenue.md §6, 2026-09-25) ──
// 태그 우선순위로 고르지 않는다. 공시마다: 손익계산서 역할의 표시 순서에서 매출 성격 줄 중 계산 구조상 다른 매출 줄의 하위가 아닌
// **첫 줄**(= 총매출 줄)을 고른다. 값은 그 줄을 공시한 가장 최근 정기공시 기준(최신 판본 — companyfacts 전 판본 중 최신, 반올림 재태깅 제외).
// 영업이익 태그가 없는 회사(XOM 형)는 총매출 줄의 비영업 성분(지분법·기타수익 — 제품·서비스 차원 멤버 또는 계산 하위 줄)을 뺀다
// (앱 규칙 재구현 — 공통모드 표기). 앱 모듈(src/lib/fin/**)은 import 하지 않는다(설계 §8 S3).
const REV_STD_RE = /^us-gaap_(Revenues?(?:[A-Z]\w*)?|SalesRevenue\w*|RegulatedAndUnregulatedOperatingRevenue)$/;
const REV_EXCL_RE = /Abstract$|Member$|Axis$|Domain$|Table$|LineItems$|Remaining|Deferred|Unbilled|Receivable|Percent|PerformanceObligation|Cost|Backlog|IncreaseDecrease|GainLoss|NotYet/;
const REV_LABEL_RE = /\b(revenues?|net sales|sales)\b/i;
const REV_LABEL_EXCL = /cost|expense|provision|after|deferred|unearned|per share|receivable|percent/i;
const NONOP_KID_RE = /EquityMethod|EquityAffiliat|EquityInEarnings|IncomeFromEquity|NonoperatingIncome|OtherNonoperating|OtherIncome|InvestmentIncome/i;
const NONOP_MEMBER_RE = /EquityAffiliate|EquityMethod|EquityCompan|^(OtherRevenueMember|OtherIncomeMember)$/i;
function xbrlLinks(xml, kind) {
  const out = [];
  for (const m of xml.matchAll(new RegExp(`<link:${kind}Link\\b[^>]*xlink:role="([^"]+)"[^>]*>([\\s\\S]*?)<\\/link:${kind}Link>`, "g"))) {
    const loc = new Map();
    for (const l of m[2].matchAll(/<link:loc\b([^>]*)\/?>/g)) { const id = /xlink:label="([^"]+)"/.exec(l[1])?.[1], h = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1]; if (id && h) loc.set(id, h); }
    const arcs = [];
    for (const a of m[2].matchAll(new RegExp(`<link:${kind}Arc\\b([^>]*)\\/?>`, "g"))) {
      const fr = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? ""), to = loc.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
      if (fr && to) arcs.push({ fr, to, order: Number(/\border="([^"]+)"/.exec(a[1])?.[1] ?? 0), w: Number(/\bweight="([^"]+)"/.exec(a[1])?.[1] ?? 1) });
    }
    out.push({ role: m[1].split("/").pop() ?? "", arcs });
  }
  return out;
}
function xbrlLabels(lab) {
  const loc = new Map(), text = new Map(), labels = new Map();
  for (const l of lab.matchAll(/<link:loc\b([^>]*)\/?>/g)) { const id = /xlink:label="([^"]+)"/.exec(l[1])?.[1], h = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1]; if (id && h) loc.set(id, h); }
  for (const m of lab.matchAll(/<link:label\b([^>]*)>([^<]*)<\/link:label>/g)) { const id = /xlink:label="([^"]+)"/.exec(m[1])?.[1]; if (id && !/documentation/i.test(m[1])) text.set(id, [...(text.get(id) ?? []), m[2].trim()]); }
  for (const a of lab.matchAll(/<link:labelArc\b([^>]*)\/?>/g)) { const f = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? ""), t = text.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? ""); if (f && t) labels.set(f, [...(labels.get(f) ?? []), ...t]); }
  return labels;
}
/** 공시 한 건의 손익계산서 총매출 줄 → { role, concept, label, nonopKids, nonopMembers, instUrl } | null */
async function faceRevenueLine(cik, accn) {
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accn.replace(/-/g, "")}`;
  const names = (await secJson(base + "/index.json")).directory.item.map((x) => x.name);
  const xsd = names.find((x) => /\.xsd$/i.test(x));
  const preN = names.find((x) => /_pre\.xml$/i.test(x)) ?? xsd, calN = names.find((x) => /_cal\.xml$/i.test(x)) ?? xsd, labN = names.find((x) => /_lab\.xml$/i.test(x)) ?? xsd;
  const instN = names.find((x) => /_htm\.xml$/i.test(x));
  if (!preN || !calN) return null;
  const texts = new Map();
  const get = async (n) => { if (!texts.has(n)) texts.set(n, await secText(`${base}/${n}`)); return texts.get(n); };
  const pres = xbrlLinks(await get(preN), "presentation"), cals = xbrlLinks(await get(calN), "calculation");
  let labels = null;
  const labelOf = async (id) => { labels ??= labN ? xbrlLabels(await get(labN)) : new Map(); return (labels.get(id) ?? []).join(" | "); };
  const isRev = async (id) => {
    if (REV_EXCL_RE.test(id)) return false;
    if (id.startsWith("us-gaap_")) return REV_STD_RE.test(id);
    if (/^(dei|srt|country|currency|ecd)_/.test(id)) return false;
    const l = await labelOf(id);
    return REV_LABEL_RE.test(l) && !REV_LABEL_EXCL.test(l);
  };
  const isRole = (r) => /INCOME|OPERATIONS|EARNINGS/i.test(r) && !/Parenth|Detail|Table|Polic|Tax|Segment|PerShare|Narrative|Schedule/i.test(r);
  // 포괄손익 단독 역할은 뒤로(손익·포괄손익 결합 보고서만 있는 회사는 그 역할을 쓴다)
  const roles = pres.filter((p) => isRole(p.role)).sort((a, b) => Number(/Comprehensive/i.test(a.role)) - Number(/Comprehensive/i.test(b.role)));
  for (const p of roles) {
    const kids = new Map(), hasP = new Set();
    for (const a of p.arcs) { kids.set(a.fr, [...(kids.get(a.fr) ?? []), a]); hasP.add(a.to); }
    const order = [], members = [];
    const walk = (id, d, axis) => {
      if (d > 14) return;
      order.push(id);
      if (axis && /Member$/.test(id)) members.push({ axis, id });
      for (const a of (kids.get(id) ?? []).sort((x, y) => x.order - y.order)) walk(a.to, d + 1, /Axis$/.test(id) ? id : axis);
    };
    for (const r of [...new Set(p.arcs.map((a) => a.fr))].filter((x) => !hasP.has(x))) walk(r, 0, null);
    const cands = [];
    for (const id of order) if (!cands.includes(id) && (await isRev(id))) cands.push(id);
    if (!cands.length) continue;
    const calArcs = cals.find((c) => c.role === p.role)?.arcs ?? cals.filter((c) => isRole(c.role)).flatMap((c) => c.arcs);
    const up = new Map();
    for (const a of calArcs) up.set(a.to, [...(up.get(a.to) ?? []), a.fr]);
    const underRev = (id) => { const seen = new Set(), st = [...(up.get(id) ?? [])]; while (st.length) { const x = st.pop(); if (seen.has(x)) continue; seen.add(x); if (cands.includes(x)) return true; st.push(...(up.get(x) ?? [])); } return false; };
    const top = cands.find((id) => !underRev(id));
    if (!top) continue;
    return {
      role: p.role, concept: top, label: top.startsWith("us-gaap_") ? top.slice(8) : `${top}("${(await labelOf(top)).split(" | ")[0]}")`,
      nonopKids: calArcs.filter((a) => a.fr === top && NONOP_KID_RE.test(a.to.replace(/^[a-z0-9-]+_/, ""))).map((a) => ({ id: a.to, w: a.w })),
      nonopMembers: members.filter((m) => /ProductOrServiceAxis$/.test(m.axis) && NONOP_MEMBER_RE.test(m.id.replace(/^[a-z0-9-]+_/, ""))).map((m) => m.id.replace(/^[a-z0-9-]+_/, "")),
      // 본표 매출 하위 줄 — 계산 구조의 직접 하위(가중치 포함)와 표시 구조의 제품·서비스 차원 멤버(R9 하위 줄 합 대조용)
      kids: calArcs.filter((a) => a.fr === top).map((a) => ({ id: a.to, w: a.w })),
      psMembers: [...new Set(members.filter((m) => /ProductOrServiceAxis$/.test(m.axis)).map((m) => m.id.replace(/^[a-z0-9-]+_/, "")))],
      instUrl: instN ? `${base}/${instN}` : null,
    };
  }
  return null;
}
/** 공시 원본(인스턴스)의 총매출 줄 값 — 비영업 분리면 총액 − 비영업 성분(기간별). [{ start, end, val, nonop }] */
async function faceInstanceRevenue(face, split) {
  const xml = await secInstance(face.instUrl);
  const ctx = parseContexts(xml);
  const want = new Set([face.concept, ...face.nonopKids.map((k) => k.id)]);
  const tot = new Map(), parts = new Map();
  // 비영업 분리 회사가 영업 매출 줄을 제품·서비스 차원 멤버로 직접 태깅한 값(XOM SalesAndOtherOperatingRevenueMember) — 분리값의 독립 확인용
  const tagged = new Map();
  for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*?)contextRef="([^"]+)"([^>]*)>\s*(-?[\d.]+)\s*</g)) {
    const id = `${m[1]}_${m[2]}`;
    if (!want.has(id) || !/unitRef="[^"]*usd/i.test(`${m[3]} ${m[5]}`)) continue;
    const c = ctx.get(m[4]);
    if (!c?.start || !c.end) continue;
    const k = `${c.start}|${c.end}`, v = Number(m[6]);
    if (id === face.concept && !c.dims.length) { if (!tot.has(k)) tot.set(k, v); continue; }
    if (!split) continue;
    if (id === face.concept && c.dims.length === 1 && /ProductOrServiceAxis$/.test(c.dims[0][0]) && !face.nonopMembers.includes(c.dims[0][1]))
      tagged.set(k, [...(tagged.get(k) ?? []), { member: c.dims[0][1], v }]);
    let pk = null, pv = v;
    if (id === face.concept && c.dims.length === 1 && /ProductOrServiceAxis$/.test(c.dims[0][0]) && face.nonopMembers.includes(c.dims[0][1])) pk = c.dims[0][1];
    else if (id !== face.concept && !c.dims.length) { pk = id; pv = v * (face.nonopKids.find((x) => x.id === id)?.w ?? 1); }
    if (pk) { const mp = parts.get(k) ?? new Map(); if (!mp.has(pk)) mp.set(pk, pv); parts.set(k, mp); }
  }
  const out = [];
  for (const [k, t] of tot) {
    const [start, end] = k.split("|");
    const mp = parts.get(k);
    if (split && !mp?.size) continue; // 비영업 성분을 못 찾은 기간은 기대값을 만들지 않는다(총액을 그대로 쓰지 않음)
    const nonop = split ? [...mp.values()].reduce((a, b) => a + b, 0) : 0;
    out.push({ start, end, val: t - nonop, nonop: split ? [...mp].map(([id, v]) => `${id.replace(/^[a-z0-9-]+_/, "")} ${v}`).join(" + ") : "", tagged: tagged.get(k) ?? [] });
  }
  return out;
}
/** 인스턴스의 USD 수치 사실 [{ id, start, end, dims, v }] — want(개념 id 집합)만 */
function usdFacts(xml, want) {
  const ctx = parseContexts(xml), out = [];
  for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*?)contextRef="([^"]+)"([^>]*)>\s*(-?[\d.]+)\s*</g)) {
    const id = `${m[1]}_${m[2]}`;
    if (!want(id) || !/unitRef="[^"]*usd/i.test(`${m[3]} ${m[5]}`)) continue;
    const c = ctx.get(m[4]);
    if (c?.start && c.end) out.push({ id, start: c.start, end: c.end, dims: c.dims, v: Number(m[6]) });
  }
  return out;
}
/**
 * R9 본표 매출 하위 줄 합 — 10-K(최신부터)마다 연간 기간별 합계 줄과 하위 줄 합: 계산 구조의 직접 하위(가중치) 합, 표시 구조의
 * 제품·서비스 차원 멤버 합. 기간마다 그 기간을 담은 가장 최근 10-K 한 건만. 하위 합이 합계 줄과 반올림 차(줄 수 × 백만/2) 안일 때만
 * (하위 줄이 합계를 이루는 구조임을 확인). → Map(결산일 → { src, total, sums: [[설명, 값]] })
 */
async function faceRevenueParts(faces) {
  const out = new Map();
  for (const f of faces.filter((x) => x.form === "10-K" && !x.any && x.instUrl)) {
    const kidIds = new Set((f.kids ?? []).map((k) => k.id));
    const facts = usdFacts(await secInstance(f.instUrl), (id) => id === f.concept || kidIds.has(id));
    const dd = (x) => (Date.parse(x.end) - Date.parse(x.start)) / 864e5;
    for (const t of facts.filter((x) => x.id === f.concept && !x.dims.length && dd(x) >= 300 && dd(x) <= 400)) {
      if ([...out.keys()].some((e) => dayDiff(e, t.end) <= 7)) continue;
      const same = (x) => x.start === t.start && x.end === t.end;
      const sums = [];
      const kv = (f.kids ?? []).map((k) => ({ ...k, x: facts.find((x) => x.id === k.id && !x.dims.length && same(x)) }));
      if (kv.length >= 2 && kv.every((k) => k.x)) sums.push([`계산 하위 줄 ${kv.map((k) => `${k.id.replace(/^[a-z0-9-]+_/, "")} ${k.w * k.x.v}`).join(" + ")}`, kv.reduce((s, k) => s + k.w * k.x.v, 0), kv.length]);
      const mv = new Map();
      for (const x of facts) if (x.id === f.concept && same(x) && x.dims.length === 1 && /ProductOrServiceAxis$/.test(x.dims[0][0]) && (f.psMembers ?? []).includes(x.dims[0][1]) && !mv.has(x.dims[0][1])) mv.set(x.dims[0][1], x.v);
      if (mv.size >= 2) sums.push([`제품·서비스 멤버 ${[...mv].map(([k, v]) => `${k} ${v}`).join(" + ")}`, [...mv.values()].reduce((s, v) => s + v, 0), mv.size]);
      // 하위 합 = 합계 줄이면 R9 가 아니다(그 경우 외부 = 합계 줄 자체 — 다른 규칙 몫). 반올림 차만 남는 경우만
      const ok = sums.filter(([, s, k]) => s !== t.v && Math.abs(s - t.v) <= k * 0.5e6).map(([h, s]) => [h, s]);
      if (ok.length) out.set(t.end, { src: `${f.form} ${f.report}`, total: t.v, sums: ok });
    }
  }
  return out;
}
/** 정기공시들(faces, 최신부터)의 매출 위치 파생상품 사실 — 모든 기간(3개월·9개월·연간). fi = 공시 순번(작을수록 최신) */
async function derivFactsOf(faces) {
  const want = new Set(Object.values(DERIV_FAM).flatMap((f) => f.ids.map((i) => `us-gaap_${i}`)));
  const out = [];
  for (const [fi, f] of faces.entries()) for (const x of usdFacts(await secInstance(f.instUrl), (id) => want.has(id))) out.push({ ...x, id: x.id.slice(8), fi });
  return out;
}
/**
 * 매출 SEC 기대값 모델 — 최근 10-K 3건·10-Q 4건의 본표 매출 줄. 기간 P 의 기대값 = P 를 공시한 가장 최근(읽은) 공시의 본표 매출 줄
 * 개념으로, 그 개념의 P 값 중 최신 판본. 은행 레이아웃(bank)이고 본표에서 매출 줄을 못 찾으면 순수익을 검증기가 따로 합성한다
 * (RevenuesNetOfInterestExpense → Revenues → 순이자이익 + 비이자이익 — 앱과 같은 순서라 공통모드 표기).
 * → { annualAt(E), quarterAt(E, isQ4), ltmAt(L), split, faces } | { why }
 */
async function secFaceRevenue(cik, sub, G, bank) {
  const rc = sub.filings?.recent ?? {};
  const picks = [];
  let nK = 0, nQ = 0;
  for (let i = 0; i < (rc.form ?? []).length && (nK < 3 || nQ < 4); i++) {
    const fm = rc.form[i];
    if (fm === "10-K" && nK < 3) nK++; else if (fm === "10-Q" && nQ < 4) nQ++; else continue;
    picks.push({ accn: rc.accessionNumber[i], form: fm, filed: rc.filingDate[i], report: rc.reportDate[i] });
  }
  const splitGate = !(G.OperatingIncomeLoss?.units?.USD ?? []).some((e) => e.end >= "2020-01-01");
  const PERIODIC = /^(10-K|10-Q|20-F|40-F)/;
  const pools = new Map(); // key → [{ start, end, val, filed, form, accn, nonop }]
  const faces = [];
  for (const p of picks) {
    const fc = await faceRevenueLine(cik, p.accn);
    if (!fc) continue;
    const split = splitGate && (fc.nonopKids.length > 0 || fc.nonopMembers.length > 0);
    const custom = !fc.concept.startsWith("us-gaap_");
    const key = `${fc.concept}${split ? "|split" : ""}`;
    if (custom || split) {
      if (!fc.instUrl) continue;
      const rows = await faceInstanceRevenue(fc, split);
      pools.set(key, [...(pools.get(key) ?? []), ...rows.map((r) => ({ ...r, filed: p.filed, form: p.form, accn: p.accn }))]);
    } else if (!pools.has(key)) {
      pools.set(key, (G[fc.concept.slice(8)]?.units?.USD ?? []).filter((e) => e.start && PERIODIC.test(e.form ?? "")));
    }
    faces.push({ ...p, ...fc, key, split });
  }
  if (!faces.length && bank) {
    const tagPool = (t) => (G[t]?.units?.USD ?? []).filter((e) => e.start && PERIODIC.test(e.form ?? ""));
    for (const t of ["RevenuesNetOfInterestExpense", "Revenues"]) if (tagPool(t).length) { pools.set(t, tagPool(t)); faces.push({ key: t, any: true, label: `${t}(본표 매출 줄 판독 실패 — 은행 순수익 합성, 공통모드)` }); }
    const nonint = tagPool("NoninterestIncome");
    const syn = tagPool("InterestIncomeExpenseNet").map((e) => { const n = nonint.find((x) => x.start === e.start && x.end === e.end && x.accn === e.accn); return n ? { ...e, val: e.val + n.val } : null; }).filter(Boolean);
    if (syn.length) { pools.set("NII+NONINT", syn); faces.push({ key: "NII+NONINT", any: true, label: "순이자이익 + 비이자이익(은행 순수익 합성, 공통모드)" }); }
  }
  if (!faces.length) return { why: `최근 정기공시 ${picks.length}건의 손익계산서 본표에서 매출 줄을 찾지 못함` };
  const dd = (e) => (Date.parse(e.end) - Date.parse(e.start)) / 864e5;
  /** 조건에 맞는 기간 — 그 기간을 공시한 가장 최근 공시의 본표 개념으로, 최신 판본 */
  const find = (pred) => {
    for (const f of faces) {
      const ms = (pools.get(f.key) ?? []).filter(pred);
      const own = f.any ? ms[0] : ms.find((e) => e.accn === f.accn);
      if (!own) continue;
      const e = f.split || !f.concept?.startsWith("us-gaap_") && !f.any
        ? ms.filter((x) => x.start === own.start && x.end === own.end).sort((a, b) => (a.filed ?? "").localeCompare(b.filed ?? "")).at(-1)
        : latestPrecise(ms.filter((x) => x.start === own.start && x.end === own.end));
      const how = f.any ? f.label : `${f.form} ${f.report} 본표 매출 줄 ${f.label}${f.split ? ` − 비영업(${e.nonop}) · 공통모드(비영업 분리는 앱 규칙 재구현)` : ""}`;
      return { v: e.val, start: e.start, end: e.end, split: !!f.split, retag: e.retag ?? null, tagged: e.tagged ?? [], how: [how, `판본 ${e.form ?? ""} ${e.filed ?? ""}`.trim(), retagNote(e)].filter(Boolean).join(" · ") };
    }
    return null;
  };
  const annualAt = (E) => find((e) => dayDiff(e.end, E) <= 7 && dd(e) >= 300 && dd(e) <= 400);
  const ytdAt = (start, E) => find((e) => dayDiff(e.start, start) <= 5 && dayDiff(e.end, E) <= 3);
  const quarterAt = (E, isQ4) => {
    if (isQ4) {
      const fy = annualAt(E);
      if (!fy) return null;
      const nine = find((e) => dayDiff(e.start, fy.start) <= 5 && dd(e) >= 250 && dd(e) <= 290 && e.end < fy.end);
      return nine ? { v: fy.v - nine.v, split: fy.split, how: `사업연도 ${fy.v}(${fy.how}) − 9개월 ${nine.v}(${nine.how})` } : null;
    }
    const q = find((e) => dayDiff(e.end, E) <= 3 && dd(e) >= 80 && dd(e) <= 100);
    if (q) return { v: q.v, split: q.split, how: `3개월 ${q.how}` };
    return null;
  };
  const ltmAt = (L) => {
    const fy0 = annualAt(L);
    if (fy0) return { ...fy0, how: `최근 사업연도 ${fy0.how}` };
    const fy = find((e) => dd(e) >= 300 && dd(e) <= 400 && e.end < L && (Date.parse(L) - Date.parse(e.end)) / 864e5 < 370);
    if (!fy) return null;
    const s = new Date(Date.parse(fy.end) + 864e5).toISOString().slice(0, 10);
    const cur = ytdAt(s, L);
    if (!cur) return null;
    const ys = (d) => new Date(Date.parse(d) - 365 * 864e5).toISOString().slice(0, 10);
    const prior = find((e) => dayDiff(e.start, ys(cur.start)) <= 7 && dayDiff(e.end, ys(L)) <= 7 && Math.abs(dd(e) - dd(cur)) <= 10);
    if (!prior) return null;
    return { v: fy.v + cur.v - prior.v, split: fy.split, how: `사업연도 ${fy.v} + 당기 누적 ${cur.v} − 전년 동기 ${prior.v} (${fy.how})` };
  };
  return { annualAt, quarterAt, ltmAt, split: faces.some((f) => f.split), faces };
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
/**
 * FnGuide 투자지표(국내 — 검증 스크립트 전용, 오너 결정 2026-09-24). 신버전 `wcomp.fnguide.com` 은 서버렌더 페이지
 * 안에 `invValueIndex` JSON 을 싣는다(옛 `comp.fnguide.com/SVO2` 는 폐지). 금액은 억원, EPS 는 원.
 * 열: 연도(YYYY/12) + 최근 분기(직전 4분기 기준 행은 TTM, 그 외 행은 누적).
 */
async function fnguideInvest(code) {
  // 종목은 cmp_cd 로 지정한다 — gicode 는 무시되고 기본 종목(삼성전자)이 온다(실측). 응답 종목 코드를 반드시 확인
  const r = await fetch(`https://wcomp.fnguide.com/CompanyInfo/Invest?cmp_cd=${code}`, { headers: { "user-agent": SA_UA }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`FnGuide HTTP ${r.status}`);
  const html = await r.text();
  const got = /cmp_cd:\s*'(\d{6})'/.exec(html)?.[1];
  if (got !== code) throw new Error(`FnGuide 응답 종목 ${got} ≠ 요청 ${code}`);
  const m = /invValueIndex:\s*(\{[^\n]*)\n/.exec(html);
  if (!m) throw new Error("FnGuide invValueIndex 없음");
  const j = JSON.parse(m[1].trim().replace(/,\s*$/, ""));
  const cols = j.header.map((x) => ({ ym: x.YYMM, cd: x.CD }));
  const num = (s) => (s == null || s === "" ? null : Number(String(s).replace(/,/g, "")));
  const rows = j.data.map((d) => ({ grp: d.GRP_CD, nm: String(d.NM).trim(), vals: Object.fromEntries(cols.map((c) => [c.ym, num(d[c.cd])])) }));
  const pick = (grp, nm) => rows.find((x) => x.grp === grp && x.nm === nm)?.vals ?? {};
  return {
    cols: cols.map((c) => c.ym),
    ebitda: pick(3, "EBITDA"), // EV/EBITDA 블록 — 연도는 연간, 최근 분기 열은 직전 4분기
    ev: pick(3, "EV"),
    rev: pick(3, "매출액"),
    epsTtm: pick(3, "EPS"), // 연도는 연간 EPS, 최근 분기 열은 직전 4분기
    niParent: pick(1, "당기순이익(지배)"), // 최근 분기 열은 누적(반기 등) — 연도만 대조
    eqParent: pick(1, "자본총계(지배)"),
  };
}

/**
 * FnGuide 재무제표(국내, 검증 스크립트 전용). 같은 서버렌더 페이지의 `finBalance`·`finIncome` JSON — 금액은 억원(소수 둘째
 * 자리 = 백만원). 연도 열은 최근 3개 연도(YYYY/12)뿐, 최근 분기 열은 버린다. 비지배지분(EV 원인 판정 전제)과 지배·비지배
 * 당기순이익(연결 순이익 대조)을 준다.
 */
async function fnguideFinance(code) {
  const r = await fetch(`https://wcomp.fnguide.com/CompanyInfo/Finance?cmp_cd=${code}`, { headers: { "user-agent": SA_UA }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`FnGuide 재무제표 HTTP ${r.status}`);
  const html = await r.text();
  const got = /cmp_cd:\s*'(\d{6})'/.exec(html)?.[1];
  if (got !== code) throw new Error(`FnGuide 재무제표 응답 종목 ${got} ≠ 요청 ${code}`);
  const block = (key) => {
    const i = html.indexOf(`${key}:`);
    if (i < 0) throw new Error(`FnGuide ${key} 없음`);
    const s = html.indexOf("{", i), e = html.indexOf("\n", s);
    return JSON.parse(html.slice(s, e).trim().replace(/,\s*$/, ""));
  };
  const num = (s) => (s == null || s === "" ? null : Number(String(s).replace(/,/g, "")));
  const series = (j, name) => {
    const d = j.data.find((x) => String(x.NAME).trim() === name);
    if (!d) return {};
    return Object.fromEntries(j.header.filter((h) => /^\d{4}\/\d{2}$/.test(h.YYMM)).map((h) => [h.YYMM, num(d[h.CD])]));
  };
  const bal = block("finBalance"), inc = block("finIncome");
  return {
    nci: series(bal, "비지배주주지분"),
    niParent: series(inc, "(지배주주지분)당기순이익"),
    niNci: series(inc, "(비지배주주지분)당기순이익"),
  };
}

/** 값 비교 — 소스의 보고 단위 안에서 같은가(인포맥스는 백만 달러 단위, 나머지는 달러) */
/** 값을 나누는 가장 큰 10의 거듭제곱(최대 100만) — 공시 보고 단위 추정 */
const secUnitAny = (v) => { let u = 1; const a = Math.abs(Math.round(v)); while (u < 1e6 && a % (u * 10) === 0) u *= 10; return u; };
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

/**
 * 모기지 리츠 판정 — 앱 /support 응답과 별개로 SEC 원자료(submissions SIC + companyfacts)에서 직접 확인한다.
 * 기준은 오너 결정(CLAUDE.md "모기지 리츠는 종목분석 대상에서 제외")의 판정 요건: SIC 6798 + 순이자손익 공시 +
 * (최근 결산 자산 대비 레포 차입 또는 모기지·채권성 금융자산 10% 이상, 또는 최근 연간 이자수익이 매출의 50% 이상).
 * 앱 함수를 import 하지 않고 검증기가 따로 계산한다. → { ok, note }
 */
async function secMortgageReit(sym) {
  const cik = await cikOf(sym);
  if (!cik) return { ok: false, note: "SEC CIK 없음" };
  const sub = await secJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
  if (String(sub.sic ?? "") !== "6798") return { ok: false, note: `SIC ${sub.sic ?? "없음"} ≠ 6798(리츠)` };
  const f = await secJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
  const G = f?.facts?.["us-gaap"] ?? {};
  const usd = (t) => G[t]?.units?.USD ?? [];
  if (!usd("InterestIncomeExpenseNet").length) return { ok: false, note: "SIC 6798 이나 순이자손익(InterestIncomeExpenseNet) 공시 없음" };
  const assetsLatest = usd("Assets").filter((e) => !e.start).reduce((b, e) => (!b || e.end > b.end || (e.end === b.end && (e.filed ?? "") > (b.filed ?? "")) ? e : b), null);
  if (!assetsLatest?.val) return { ok: false, note: "자산총계 없음" };
  const d = assetsLatest.end, a = assetsLatest.val;
  const at = (t) => usd(t).filter((e) => !e.start && dayDiff(e.end, d) <= 6).reduce((m, e) => Math.max(m, e.val ?? 0), 0);
  const repo = Math.max(0, ...["SecuritiesSoldUnderAgreementsToRepurchase", "SecuritiesSoldUnderAgreementsToRepurchaseCarryingAmount"].map(at));
  const finTags = ["AvailableForSaleSecuritiesDebtSecurities", "AvailableForSaleSecurities", "MarketableSecurities", "DebtSecuritiesAvailableForSaleExcludingAccruedInterest", "LoansAndLeasesReceivableNetReportedAmount", "LoansReceivableHeldForInvestmentNet", "FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLoss", "MortgageLoansOnRealEstateCommercialAndConsumerNet", "TradingSecurities", "HeldToMaturitySecurities", "MortgageLoansOnRealEstate", "LoansAndLeasesReceivableNetOfDeferredIncome"];
  const fin = Math.max(0, ...finTags.map(at));
  if (repo / a >= 0.1) return { ok: true, note: `SIC 6798 · 레포 차입 ${(repo / a * 100).toFixed(1)}% of 자산(${d})` };
  if (fin / a >= 0.1) return { ok: true, note: `SIC 6798 · 모기지·채권성 금융자산 ${(fin / a * 100).toFixed(1)}% of 자산(${d})` };
  const latestAnnual = (t) => usd(t).filter((e) => e.start && e.fp === "FY" && /^10-K/.test(e.form) && (Date.parse(e.end) - Date.parse(e.start)) / 864e5 > 300)
    .reduce((b, e) => (!b || e.end > b.end || (e.end === b.end && (e.filed ?? "") > (b.filed ?? "")) ? e : b), null)?.val ?? 0;
  const interest = Math.max(0, ...["InterestAndDividendIncomeOperating", "InterestIncomeOperating", "InterestAndFeeIncomeLoansAndLeases", "InterestIncome"].map(latestAnnual));
  const revenue = Math.max(0, ...["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "OperatingLeaseLeaseIncome"].map(latestAnnual));
  const den = Math.max(revenue, interest);
  if (den > 0 && interest / den >= 0.5) return { ok: true, note: `SIC 6798 · 이자수익 비중 ${(interest / den * 100).toFixed(1)}%` };
  return { ok: false, note: `SIC 6798 이나 레포 ${(repo / a * 100).toFixed(1)}%·금융자산 ${(fin / a * 100).toFixed(1)}%·이자수익 비중 ${den ? (interest / den * 100).toFixed(1) : "-"}% — 모기지 리츠 요건 미충족` };
}

/**
 * 감가상각비 독립 대조 기준 — 최신 10-K 의 현금흐름표 계산 구조(_cal.xml, 없으면 .xsd 내장)에서 영업활동 조정 항목 중
 * 감가상각·상각 줄을 골라 그 10-K 원본(XBRL 인스턴스)의 연간 값을 더한다(CLAUDE.md "감가상각비 = 현금흐름표 영업활동
 * 조정 항목의 감가상각·상각 줄 합"). 앱 모듈(edgar-cf-structure.ts)을 import 하지 않고 검증기가 따로 읽는다.
 * 제외: 사채할인·발행비, 주식보상, 운용리스(사용권자산 상각·리스비용), 콘텐츠, 계약획득원가·인센티브, 투자·증권, 재고,
 * 연금. 표준 개념은 개념명으로만, 회사 고유 개념은 라벨로 판정하고, 고유 줄의 주 라벨이 "Depreciation…"/"Amortization
 * of intangible…" 로 시작하면 제외어가 있어도 포함한다(AMZN·ISRG). → { byEnd: Map(결산일 → 합), lines } | { why }
 */
async function secCashFlowDa(cik, sub) {
  const rk = sub.filings?.recent ?? {};
  const ik = (rk.form ?? []).findIndex((fm) => fm === "10-K");
  if (ik < 0) return { why: "10-K 없음" };
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${rk.accessionNumber[ik].replace(/-/g, "")}`;
  const names = (await secJson(base + "/index.json")).directory.item.map((x) => x.name);
  const xsd = names.find((x) => /\.xsd$/i.test(x));
  const calName = names.find((x) => /_cal\.xml$/i.test(x)) ?? xsd;
  const labName = names.find((x) => /_lab\.xml$/i.test(x)) ?? xsd;
  const instName = names.find((x) => /_htm\.xml$/i.test(x));
  if (!calName || !labName || !instName) return { why: `10-K 파일 없음(계산 ${!!calName}·라벨 ${!!labName}·인스턴스 ${!!instName})` };
  const cal = await secText(`${base}/${calName}`);
  const lab = labName === calName ? cal : await secText(`${base}/${labName}`);
  const locMap = (x) => {
    const m = new Map();
    for (const l of x.matchAll(/<link:loc\b([^>]*)\/?>/g)) {
      const id = /xlink:label="([^"]+)"/.exec(l[1])?.[1], href = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1];
      if (id && href) m.set(id, href);
    }
    return m;
  };
  // 개념 → 표시 라벨(정의문 제외)
  const labels = new Map();
  {
    const loc = locMap(lab), text = new Map();
    for (const m of lab.matchAll(/<link:label\b([^>]*)>([^<]*)<\/link:label>/g)) {
      const id = /xlink:label="([^"]+)"/.exec(m[1])?.[1];
      if (id && !/documentation/i.test(/xlink:role="([^"]*)"/.exec(m[1])?.[1] ?? "")) text.set(id, [...(text.get(id) ?? []), m[2].trim()]);
    }
    for (const a of lab.matchAll(/<link:labelArc\b([^>]*)\/?>/g)) {
      const from = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? ""), t = text.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
      if (from && t) labels.set(from, [...(labels.get(from) ?? []), ...t]);
    }
  }
  const DA = /deprecia|amortiz/i;
  const EXCL = /debt|discount|premium|issuance|financing\s*costs?|deferred\s*(financing|charges)|stock|share-?based|compensation|operating[\s-]*lease|lease\s*expense|content|contract\s*(cost|acquisition)|capitalized\s*software|investment|securities|bond|inventory|incentive|acquisition\s*costs|defined\s*benefit|pension|postretirement/i;
  let lines = null;
  let cfMeta = { impairLines: [], separateImpair: [], continuing: false };
  for (const m of cal.matchAll(/<link:calculationLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/link:calculationLink>/g)) {
    const role = m[1].split("/").pop() ?? "";
    if (!/CASHFLOW/i.test(role) || /Detail|Table|Parenth|Supplement/i.test(role)) continue;
    const loc = locMap(m[2]);
    const arcs = [];
    for (const a of m[2].matchAll(/<link:calculationArc\b([^>]*)\/?>/g)) {
      const from = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? ""), to = loc.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
      if (from && to) arcs.push([from, to]);
    }
    const root = arcs.find(([fr]) => /^us-gaap_NetCashProvidedByUsedInOperatingActivities(ContinuingOperations)?$/.test(fr))?.[0];
    if (!root) continue;
    lines = [];
    const seen = new Set();
    const impairLines = [], separateImpair = [];
    // 감가상각 줄의 부모 노드 — 계속사업 판정용
    const parentOf = new Map();
    const walk = (id, depth) => {
      if (depth > 3) return;
      for (const [fr, to] of arcs) {
        if (fr !== id || seen.has(to)) continue;
        seen.add(to);
        const std = to.startsWith("us-gaap_");
        const labs = labels.get(to) ?? [];
        const text = std ? to.slice(8) : labs.join(" | ") || to;
        const leads = !std && labs.some((l) => /^(depreciation|amortization of (acquired |acquisition-related )?intangible)/i.test(l));
        const isDa = DA.test(text) && (!EXCL.test(text) || leads);
        // 손상 포함 여부는 개념명·라벨 둘 다(XOM 표준 개념 + 라벨 "(includes impairments)")
        if (/impair/i.test(`${to} ${labs.join(" ")}`)) (isDa ? impairLines : separateImpair).push(to);
        if (isDa) { lines.push(to); parentOf.set(to, id); }
        else walk(to, depth + 1);
      }
    };
    walk(root, 0);
    // 계속사업 기준: 조상이 계속사업 소계이거나, 조상의 자식에 계속사업 이익 출발·중단사업 전체 손익 차감 줄이 있다
    // (GE·EMR 계속사업 소계, DD·BAX·HON 계속사업 이익 출발). 중단사업 "처분이익"만 빼는 줄(JNJ)은 해당 없음
    const up = new Map(arcs.map(([fr, to]) => [to, fr]));
    const contOf = (id) => {
      for (let p = parentOf.get(id), k = 0; p && k < 6; p = up.get(p), k++) {
        if (/ContinuingOperations$/.test(p)) return true;
        if (arcs.some(([fr, to]) => fr === p && /^us-gaap_(IncomeLossFromContinuingOperations|IncomeLossFromDiscontinuedOperations|DiscontinuedOperationIncomeLossFromDiscontinuedOperation)/.test(to))) return true;
      }
      return false;
    };
    cfMeta = {
      impairLines,
      separateImpair: separateImpair.filter((x) => !/inventor/i.test(`${x} ${(labels.get(x) ?? []).join(" ")}`)),
      continuing: lines.length > 0 && lines.every(contOf),
    };
    break;
  }
  if (!lines) return { why: "최신 10-K 에 현금흐름표 계산 구조(영업활동 루트) 없음" };
  if (!lines.length) return { why: "현금흐름표 영업활동 조정 항목에 감가상각·상각 줄 없음" };
  const xml = await secText(`${base}/${instName}`);
  const ctx = new Map();
  for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
    if (/dimension="/.test(m[2])) continue;
    const s = /<(?:xbrli:)?startDate>\s*([^<\s]+)/.exec(m[2])?.[1], e = /<(?:xbrli:)?endDate>\s*([^<\s]+)/.exec(m[2])?.[1];
    if (s && e && (Date.parse(e) - Date.parse(s)) / 864e5 > 300) ctx.set(m[1], `${s}|${e}`);
  }
  const want = new Set(lines);
  const vals = new Map(); // "선|기간" → 값(첫 값)
  for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*)>\s*(-?[\d.]+)\s*<\/\1:\2>/g)) {
    const id = `${m[1]}_${m[2]}`;
    if (!want.has(id) || !/unitRef="[^"]*usd/i.test(m[3])) continue;
    const p = ctx.get(/contextRef="([^"]+)"/.exec(m[3])?.[1] ?? "");
    if (p && !vals.has(`${id}|${p}`)) vals.set(`${id}|${p}`, Number(m[4]));
  }
  const byEnd = new Map();
  for (const [k, v] of vals) { const end = k.split("|").at(-1); byEnd.set(end, (byEnd.get(end) ?? 0) + v); }
  // ── 감가상각 줄에 섞인 손상차손·중단사업 감가상각(오너 결정 2026-09-24 — EBITDA = 영업이익 + 감가상각비는 같은 범위,
  // 감가상각비에 손상차손 불포함). 앱 모듈을 쓰지 않고 이 10-K 원본에서 직접 읽는다(예전 A층은 줄 합만 봐서 손상·중단사업이
  // 섞인 앱 값을 통과시켰다 — 공통모드). 기간별 조정 내역은 notes, 원본에서 금액을 확인할 수 없는 기간은 unresolved(미결).
  const facts = []; // { id, end, dims: [[축, 멤버]], v } — 1년 기간만
  {
    const ctxAll = new Map();
    for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
      const s = /<(?:xbrli:)?startDate>\s*([^<\s]+)/.exec(m[2])?.[1], e = /<(?:xbrli:)?endDate>\s*([^<\s]+)/.exec(m[2])?.[1];
      if (!s || !e || (Date.parse(e) - Date.parse(s)) / 864e5 <= 300) continue;
      ctxAll.set(m[1], { end: e, dims: [...m[2].matchAll(/dimension="([^"]+)"[^>]*>\s*([^<\s]+)\s*</g)].map((d) => [d[1], d[2]]) });
    }
    const dup = new Set();
    for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*)>\s*(-?[\d.]+)\s*<\/\1:\2>/g)) {
      if (!/Impair|WriteDown|Writeoff|WriteOff|Discontinued|DisposalGroup/i.test(m[2]) || !/unitRef="[^"]*usd/i.test(m[3])) continue;
      const c = ctxAll.get(/contextRef="([^"]+)"/.exec(m[3])?.[1] ?? "");
      if (!c) continue;
      const id = `${m[1]}_${m[2]}`, key = `${id}|${c.end}|${c.dims.flat().join(",")}`;
      if (dup.has(key)) continue;
      dup.add(key);
      facts.push({ id, end: c.end, dims: c.dims, v: Number(m[4]) });
    }
  }
  const nm = (id) => id.replace(/^[a-z-]+_/, "");
  const isImp = (id) => /Impairment|WriteDown|Writeoff|WriteOff/.test(nm(id))
    && !/Inventor|Receivable|Loan|Credit|Securit|Investment|EquityMethod|OtherThanTemporary|Tax|Accumulated|Reversal|Recover|PerShare|Percent|Discontinued|Allowance|Debt|Contract|Unrealized|Gain|Restructuring|Deprecia|Amortiz|Number|Count/.test(nm(id))
    && !cfMeta.separateImpair.includes(id);
  const isDiscDa = (id) => /Discontinued|DisposalGroup/.test(nm(id)) && /Depreciation\w*Amortization/.test(nm(id)) && !/Accumulated|PerShare/.test(nm(id));
  const isDiscNi = (id) => /^us-gaap_(IncomeLossFromDiscontinuedOperations|DiscontinuedOperationIncomeLossFromDiscontinuedOperation)/.test(id) && !/Share/.test(id);
  const notes = new Map(), unresolved = new Map();
  const lineByEnd = new Map(byEnd); // 조정 전 줄 합(외부 소스 원인 판정 ⑧)
  let anyDisc = false;
  for (const [end, sum0] of byEnd) {
    let sum = sum0;
    const at = facts.filter((f) => f.end === end);
    if (cfMeta.impairLines.length) {
      // 손상: 개념마다 차원 없는 값 N + 단일 축 차원 합(어느 축 합이 N 과 같으면 내역 → N). 개념 사이는 포함관계라 최댓값
      let imp = 0, how = "";
      for (const id of new Set(at.filter((f) => isImp(f.id)).map((f) => f.id))) {
        const fs = at.filter((f) => f.id === id);
        const n = fs.find((f) => !f.dims.length)?.v;
        const axes = new Map();
        for (const f of fs) {
          if (f.dims.length !== 1 || /OperatingSegmentsMember$/.test(f.dims[0][1])) continue;
          const a = axes.get(f.dims[0][0]) ?? new Map();
          if (!a.has(f.dims[0][1])) a.set(f.dims[0][1], f.v);
          axes.set(f.dims[0][0], a);
        }
        const sums = [];
        for (const a of axes.values()) { const t = [...a.values()].reduce((x, y) => x + y, 0); if (!sums.some((x) => Math.abs(x - t) < 1)) sums.push(t); }
        const breakdown = n != null && sums.some((t) => Math.abs(t - n) < 1);
        const total = breakdown ? n : (n ?? 0) + sums.reduce((x, y) => x + y, 0);
        if (total > imp) { imp = total; how = `${nm(id)}${n != null ? " 차원 없는 값" : ""}${!breakdown && sums.length ? " + 차원 합(공통모드 — 앱과 같은 합산 규칙)" : ""}`; }
      }
      if (imp > 0 && imp < sum) { sum -= imp; notes.set(end, [notes.get(end), `손상 포함 줄 − 손상 ${imp}(${how} · 공통모드(규칙 재구현 — 손상 개념 제외 목록·축 합산이 앱과 같은 규칙))`].filter(Boolean).join(" · ")); }
      else if (imp > 0) unresolved.set(end, `손상 ${imp} ≥ 감가상각 줄 ${sum} — 손상 금액 확인 불가`);
    }
    if (!cfMeta.continuing) {
      let disc = null;
      for (const id of new Set(at.filter((f) => isDiscDa(f.id)).map((f) => f.id))) {
        const fs = at.filter((f) => f.id === id);
        let v = fs.find((f) => !f.dims.length)?.v;
        if (v == null) {
          const g = new Map();
          for (const f of fs) { const d = f.dims.find((x) => /DisposalGroups?Including|ByDisposalGroup/i.test(x[0])) ?? f.dims[0]; if (d && !g.has(d[1])) g.set(d[1], f.v); }
          if (g.size) v = [...g.values()].reduce((x, y) => x + y, 0);
        }
        if (v != null) disc = Math.max(disc ?? 0, v);
      }
      const discNi = at.some((f) => isDiscNi(f.id) && !f.dims.length && f.v !== 0);
      if (discNi || disc != null) anyDisc = true;
      if (disc != null && disc > 0 && disc < sum) { sum -= disc; notes.set(end, [notes.get(end), `중단사업 감가상각 ${disc} 차감(현금흐름표가 중단사업 포함 · 공통모드(규칙 재구현 — 중단사업 태그·차원 판정이 앱과 같은 규칙))`].filter(Boolean).join(" · ")); }
      else if (discNi && !(disc > 0)) unresolved.set(end, "중단사업 손익이 있는데 중단사업 감가상각 태그 없음 — 계속사업 감가상각 확인 불가");
    }
    byEnd.set(end, sum);
  }
  const tags = `${cfMeta.impairLines.length ? " (손상 포함 줄)" : ""}${!cfMeta.continuing && anyDisc ? " (중단사업 포함 현금흐름표)" : ""}`;
  return { byEnd, lineByEnd, notes, unresolved, lines: `${rk.reportDate?.[ik] ?? ""} 10-K 줄: ${lines.map((l) => l.replace(/^[a-z-]+_/, "")).join("+")}${tags}` };
}

/**
 * 앱이 응답에 실은 조회 실패 경고(감사 2026-09-25) — 앱은 원본 조회 실패를 값 대신 문구로 알린다. src 에서 확인한 문구:
 *  - 하이라이트 notes·재무제표 source·컨센서스 notes: "⚠ 일부 공시 조회 실패(…)" (fetchWarnings — SEC 429 등, "외화 환산 환율
 *    조회 실패", "인포맥스 분기 조회 실패(LTM 최신 분기)" 포함)
 *  - 컨센서스 notes: "추정치(yahoo) 조회 실패 — 실적만 표시", "연간 재무제표 조회 실패"
 *  - 한국 하이라이트 notes: "일부 연도 시가총액: KRX 조회 실패 → …", 개요 warnings: "시세 조회 실패"
 * 문구를 하나씩 나열하지 않고 응답 전체에서 "조회 실패" 를 찾는다(새 문구도 잡히게). 있으면 hardErrors → 종료코드 1.
 */
function appFetchWarnings(obj) {
  const s = JSON.stringify(obj ?? "");
  return [...new Set([...s.matchAll(/[^"\\]{0,60}조회 실패[^"\\]{0,80}/g)].map((m) => m[0].trim()))];
}

// ── 미국 종목 1개 ─────────────────────────────────────────────────────
async function verifyUs(sym) {
  const u = `/api/markets/us/${encodeURIComponent(sym)}`;
  const checks = [];
  const add = (layer, name, col, r) => checks.push({ layer, name, col, ...r });
  const review = [];
  // 조회 실패(SEC·외부 소스) — 결과를 바꾸지 않아도 전부 기록하고 종료코드 1(감사: 선언 전 사용·누락 경로)
  const hardErrors = [];

  const support = await getJson(`${u}/support`);
  // 앱의 "지원 제외" 응답만 믿지 않는다(감사) — SEC 원자료로 모기지 리츠임을 따로 확인할 때만 허용된 건너뜀
  if (support && support.supported === false) {
    const mr = await secMortgageReit(sym).catch((e) => ({ ok: false, note: `SEC 조회 실패: ${String(e).slice(0, 60)}` }));
    return mr.ok
      ? { sym, skipped: `모기지 리츠(지원 제외) — SEC 확인(규칙 재구현·공통모드): ${mr.note}`, allowedSkip: true, checks, review, hardErrors }
      : { sym, skipped: `앱이 지원 제외했으나 SEC 원자료로 모기지 리츠 확인 못함 — ${mr.note}`, allowedSkip: false, checks, review, hardErrors };
  }

  // 조회 실패는 전부 기록한다(예전엔 컨센서스 실패가 조용히 검사 16건을 지웠다)
  const fetched = {};
  for (const [k, p] of Object.entries({
    hl: `${u}/highlights`, an: `${u}/financials?view=analysis`, ov: `${u}/overview`, tt: `${u}/ttm`,
    cs: `${u}/consensus`, is: `${u}/financials?view=is&period=annual`, bs: `${u}/financials?view=bs&period=annual`,
    // 매출 소비처(revenue.md §3) — 총괄(연간·분기)·손익계산서 분기
    sm: `${u}/financials?view=summary&period=annual`, smq: `${u}/financials?view=summary&period=quarter`, isq: `${u}/financials?view=is&period=quarter`,
  })) {
    try { fetched[k] = await getJson(p); } catch (e) { fetched[k] = null; add("응답", `API 응답 ${k}`, "-", { status: FAIL, note: String(e).slice(0, 120) }); }
  }
  let row = null;
  try { row = await getJson(`/api/cron/verify-row?market=us&symbol=${encodeURIComponent(sym)}`, 240_000, AUTH); }
  catch (e) { add("응답", "API 응답 verify-row", "-", { status: FAIL, note: String(e).slice(0, 120) }); }
  for (const [k, v] of Object.entries({ ...fetched, "verify-row": row })) for (const w of appFetchWarnings(v)) hardErrors.push(`앱 조회 실패 경고(${k}): ${w}`);
  const { hl, an, ov, cs, is, bs, sm, smq, isq } = fetched;
  const revErrors = []; // 매출 외부 대조 ③ 오류(revenue.md §0)
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
  // companyfacts 가 앱 LTM 기준일의 공시(10-Q/10-K)를 아직 반영하지 않은 경우(KO·MDLZ·V — 앱은 공시 원본으로 채운다)
  // 그 공시 원본에서 차원 없는 USD 기간 값을 읽어 채운다. 검증기가 따로 구현한 것이고, 이미 있는 기간은 건드리지 않는다.
  // 이게 없으면 LTM 은 "기준일 다름"으로 SEC 대조가 빠졌다.
  {
    const ltmDate = h.columns.find((c) => c.kind === "ltm")?.date;
    const durEnds = ["NetIncomeLoss", "ProfitLoss", "Revenues"].flatMap((t) => (G[t]?.units?.USD ?? []).filter((e) => e.start).map((e) => e.end));
    const latest = durEnds.sort().at(-1);
    const rc = sub.filings?.recent ?? {};
    const k = ltmDate && (!latest || (latest < ltmDate && dayDiff(latest, ltmDate) > 7))
      ? (rc.form ?? []).findIndex((fm, i) => /^10-[QK]$/.test(fm) && rc.reportDate?.[i] && dayDiff(rc.reportDate[i], ltmDate) <= 7)
      : -1;
    if (k >= 0) {
      try {
        const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${rc.accessionNumber[k].replace(/-/g, "")}`;
        const idx = await secJson(base + "/index.json");
        const name = idx.directory.item.map((x) => x.name).find((x) => /_htm\.xml$/i.test(x));
        const xml = name ? await secText(base + "/" + name) : "";
        const ctx = new Map();
        for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
          if (/dimension="/.test(m[2])) continue;
          const s = /<(?:xbrli:)?startDate>\s*([^<\s]+)/.exec(m[2])?.[1], e = /<(?:xbrli:)?endDate>\s*([^<\s]+)/.exec(m[2])?.[1];
          if (s && e) ctx.set(m[1], { start: s, end: e });
        }
        let added = 0;
        for (const m of xml.matchAll(/<us-gaap:([A-Za-z0-9_]+)\b([^>]*)>\s*(-?[\d.]+)\s*<\/us-gaap:\1>/g)) {
          const c = ctx.get(/contextRef="([^"]+)"/.exec(m[2])?.[1] ?? "");
          if (!c || !/unitRef="[^"]*usd"/i.test(m[2])) continue;
          const arr = ((G[m[1]] ??= { units: {} }).units.USD ??= []);
          if (arr.some((e) => e.start === c.start && e.end === c.end)) continue;
          const days = (Date.parse(c.end) - Date.parse(c.start)) / 864e5;
          arr.push({ start: c.start, end: c.end, val: Number(m[3]), form: rc.form[k], filed: rc.filingDate[k], accn: rc.accessionNumber[k], fp: days > 300 ? "FY" : "Q", fy: 0 });
          added++;
        }
        review.push({ item: "SEC 최신 공시 보강", note: `companyfacts 미반영 ${rc.form[k]} ${rc.reportDate[k]} 원본에서 ${added}개 값 보강` });
      } catch (e) {
        hardErrors.push(`최신 공시 원본 조회 실패: ${String(e).slice(0, 60)}`);
      }
    }
  }
  const ann = (c, unit = "USD") => annualPeriods(f.facts, "us-gaap", c, unit);
  /** 결산일(±7일)의 연간 사실 전부(10-K·20-F, 300~400일) — 공시일 순. 최초·최신 공시를 구분할 때 */
  const annualAllAt = (concept, unit, date) => (G[concept]?.units?.[unit] ?? [])
    .filter((e) => { const d = (Date.parse(e.end) - Date.parse(e.start)) / 864e5; return e.start && /^(10-K|20-F)/.test(e.form ?? "") && d >= 300 && d <= 400 && dayDiff(e.end, date) <= 7; })
    .sort((a, b) => (a.filed ?? "").localeCompare(b.filed ?? ""));
  const has20F = Object.keys(f.facts).includes("ifrs-full") || (sub.filings?.recent?.form ?? []).some((x) => /^20-F/.test(x));
  // 보고 통화 = 매출·순이익·자산 태그의 단위(외화 차입금 태그 등 일부 항목의 외화 단위는 무관 — MCD 오판)
  const reportUnits = new Set(["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "NetIncomeLoss", "ProfitLoss", "Assets"].flatMap((t) => Object.keys(G[t]?.units ?? {})));
  const usdOnly = reportUnits.size === 0 || [...reportUnits].every((u) => u === "USD");
  // 외화·IFRS 공시(ASML·TSM·SPOT) — 앱은 USD 로 환산해 보여준다. 검증기는 환산을 재현하지 않고
  // 인포맥스(FactSet, 독립 USD 환산)와 대조한다.
  const foreign = !usdOnly || Object.keys(f.facts).includes("ifrs-full");
  let imAnnual = null, imErr = "";
  if (foreign || EXTERNAL) {
    imAnnual = await infomaxAnnual(sym).catch((e) => { imErr = String(e).slice(0, 60); return null; });
    if (!imAnnual) hardErrors.push(`인포맥스 연간 재무 조회 실패: ${imErr || "종목 없음(null)"}`);
  }
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
    const ims = await infomaxShares(sym).catch((e) => { hardErrors.push(`인포맥스 주식수(ADR 비율) 조회 실패: ${String(e).slice(0, 60)}`); return null; });
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
  // 매출 A층 기대값 — 손익계산서 본표 매출 줄(검증기 독립 판독, 태그 순서 아님). 외화 공시는 환율 대조로 따로(아래)
  let revFace = null, revFaceWhy = foreign ? "외화 공시 — 환산 환율 대조로 검증" : "";
  if (!foreign) {
    const bankLayout = !h.rows.some((r) => r.key === "ev");
    try { const r = await secFaceRevenue(cik, sub, G, bankLayout); if (r.why) revFaceWhy = r.why; else revFace = r; }
    catch (e) { revFaceWhy = `본표 매출 줄 판독 실패: ${String(e).slice(0, 60)}`; hardErrors.push(revFaceWhy); }
  }
  // Yahoo 연간 총매출 — 비영업 분리 회사만(독립 확인용)
  const yRev = new Map();
  if (revFace?.split) {
    try {
      const ys = await (await yahoo()).fundamentalsTimeSeries(sym, { period1: "2018-01-01", type: "annual", module: "financials" }, { validateResult: false });
      for (const r of ys) if (r.totalRevenue != null) yRev.set(new Date(r.date).toISOString().slice(0, 10), r.totalRevenue);
    } catch (e) { hardErrors.push(`Yahoo 연간 매출 조회 실패: ${String(e).slice(0, 60)}`); }
  }
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
    if (n) return { v: n.val, ...(n.retag ? { note: retagNote(n) } : {}) };
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
    // 최신 공시값 — 같은 기간의 반올림 재태깅은 제외(가장 최근 기간 묶음 안에서)
    const pick = (pred) => {
      const c = arr.filter(pred).sort((a, b) => ((a.filed ?? "") < (b.filed ?? "") ? 1 : -1));
      return c.length ? latestPrecise(c.filter((e) => e.start === c[0].start && e.end === c[0].end)) : null;
    };
    const fyLatest = pick((e) => e.end === latestEnd && dur(e) > 300 && dur(e) < 400);
    if (fyLatest) return { v: fyLatest.val, end: latestEnd, how: ["최근 사업연도", retagNote(fyLatest)].filter(Boolean).join(" · ") };
    const cur = arr.filter((e) => e.end === latestEnd && dur(e) < 300).sort((a, b) => dur(b) - dur(a))[0];
    if (!cur) return null;
    const prior = pick((e) => Math.abs(dayDiff(e.end, cur.end) - 365) <= 10 && Math.abs(dur(e) - dur(cur)) <= 10);
    const fy = pick((e) => dur(e) > 300 && dur(e) < 400 && dayDiff(e.end, cur.start) <= 10);
    if (!prior || !fy) return null;
    return { v: fy.val + cur.val - prior.val, end: latestEnd, how: ["사업연도 + 당기누적 − 전년동기", ...[fy, prior].map(retagNote)].filter(Boolean).join(" · ") };
  }
  /**
   * SEC 3개월값 4개 합(원인 R4 — Yahoo·인포맥스 LTM 은 분기 값 합이다). 기준일 ltmEnd 로 끝나는 최근 1년 안의 분기 종료일
   * 4개마다 10-Q 3개월값, 없으면(회계연도 4분기) 사업연도 − 9개월 누적. 각 값은 반올림 재태깅 제외 최신 공시.
   * → { sum, parts } | null (분기 4개를 못 채우면 null)
   */
  function secQuarterSum(tag, ltmEnd) {
    const arr = (G[tag]?.units?.USD ?? []).filter((e) => e.start && /^(10-K|10-Q)/.test(e.form ?? ""));
    const dur = (e) => (Date.parse(e.end) - Date.parse(e.start)) / 864e5;
    const ends = [];
    for (const e of arr) {
      const d = dur(e);
      if (!((d >= 80 && d <= 100) || (d >= 350 && d <= 380))) continue;
      const age = (Date.parse(ltmEnd) - Date.parse(e.end)) / 864e5;
      if (age < -7 || age > 340) continue;
      if (!ends.some((x) => dayDiff(x, e.end) <= 7)) ends.push(e.end);
    }
    if (ends.length !== 4) return null;
    const parts = [];
    for (const end of ends.sort()) {
      const q = arr.filter((e) => dayDiff(e.end, end) <= 3 && dur(e) >= 80 && dur(e) <= 100);
      if (q.length) { const p = latestPrecise(q.filter((e) => e.start === q.at(-1).start)); parts.push({ end, v: p.val, how: "3개월" }); continue; }
      const fy = arr.filter((e) => dayDiff(e.end, end) <= 3 && dur(e) >= 350 && dur(e) <= 380);
      if (!fy.length) return null;
      const fyE = latestPrecise(fy.filter((e) => e.start === fy.at(-1).start));
      const nine = arr.filter((e) => e.start === fyE.start && dur(e) >= 260 && dur(e) <= 285);
      if (!nine.length) return null;
      const n9 = latestPrecise(nine.filter((e) => e.end === nine.at(-1).end));
      parts.push({ end, v: fyE.val - n9.val, how: `사업연도 ${fyE.val} − 9개월 ${n9.val}` });
    }
    return { sum: parts.reduce((t, p) => t + p.v, 0), parts };
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

  let splits = [], spinoffs = [], splitErr = "";
  // 분할 이력 조회 실패 시 계수 1로 대체하지 않는다 — EPS 대조를 검증불가로 두고 실행 전체를 실패 처리(재감사)
  try { const sp = await splitsOf(sym); splits = sp.splits; spinoffs = sp.spinoffs; for (const x of sp.spinoffs) review.push({ item: `분사 가격조정 ${x.date} (Yahoo 비율 ${x.num}:${x.den})`, note: "EPS 분할 보정에서 제외 — 앱 과거 주가가 이 조정을 받았다면 분사 이전 연도 시가총액·PER 이 낮게 나온다(점검 필요)" }); } catch (e) { splitErr = `분할 이력 조회 실패: ${String(e).slice(0, 60)}`; hardErrors.push(splitErr); }
  /** 공시 EPS 를 오늘 주식 기준으로 — 공시(filed) 이후에 일어난 분할만 나눈다 */
  const splitAdj = (e) => splits.filter((s) => s.date > (e.filed ?? e.end)).reduce((k, s) => k * s.ratio, 1);
  /** 계속영업·중단영업 희석 EPS — 같은 10-K(accn)에 둘 다 있는 가장 최근 공시 → { cont, disc, filed } | null */
  const contDiscEps = (date) => {
    const cont = annualAllAt("IncomeLossFromContinuingOperationsPerDilutedShare", "USD/shares", date);
    // 중단영업 희석 EPS 는 대체 태그도 본다(앱 fyEps 와 같은 두 개념)
    const disc = [...annualAllAt("IncomeLossFromDiscontinuedOperationsNetOfTaxPerDilutedShare", "USD/shares", date),
      ...annualAllAt("DiscontinuedOperationIncomeLossFromDiscontinuedOperationNetOfTaxPerDilutedShare", "USD/shares", date)];
    for (let i = cont.length - 1; i >= 0; i--) {
      const d = disc.filter((x) => x.accn && x.accn === cont[i].accn).at(-1);
      if (d) return { cont: cont[i].val, disc: d.val, filed: cont[i].filed };
    }
    return null;
  };

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
    // 연도 라벨의 연도 자체 — SEC 가 붙인 사업연도(fy = DocumentFiscalYearFocus)와 대조(감사: 결산일만 보고 연도는 안 봤다).
    // companyfacts 의 fy 는 "그 공시의" 사업연도라, 각 연간 공시(accn)에서 가장 늦은 결산일(=당기)에만 붙여 쓴다.
    // 52/53주 결산(1월 1~7일 결산)은 SEC fy 가 전년도라 CLAUDE.md fiscalYearOf 규칙과 같은 결과가 나와야 한다.
    const byAccn = new Map();
    for (const ns of ["us-gaap", "ifrs-full"]) for (const con of Object.values(f.facts[ns] ?? {})) for (const arr of Object.values(con.units ?? {})) for (const e of arr) {
      if (e.fp !== "FY" || !/^(10-K|20-F)$/.test(e.form) || !e.start || !e.fy || !e.accn) continue;
      const d = (Date.parse(e.end) - Date.parse(e.start)) / 864e5;
      if (d < 300 || d > 400) continue;
      const p = byAccn.get(e.accn);
      if (!p || e.end > p.end) byAccn.set(e.accn, { end: e.end, fy: e.fy, filed: e.filed ?? "" });
    }
    const fyByEnd = new Map(); // 당기 결산일 → { fy, filed } (같은 결산일이면 최신 제출분)
    for (const v of byAccn.values()) { const p = fyByEnd.get(v.end); if (!p || v.filed > p.filed) fyByEnd.set(v.end, v); }
    for (const c of fyCols) {
      const s = [...fyByEnd].filter(([end]) => dayDiff(end, c.date) <= 7).sort((a, b) => dayDiff(a[0], c.date) - dayDiff(b[0], c.date))[0]?.[1];
      const y = Number(/^(\d{4})/.exec(c.label)?.[1]);
      // 1~2월 결산을 "시작 연도"로 부르는 회사(HD·TGT — 2025-02-02 결산 = fiscal 2024)는 앱(결산일 연도)과 1년 어긋난다.
      // 어느 기준으로 라벨을 붙일지 오너 결정 보류(2026-09-24) — 그 관행에 정확히 해당할 때만 검증불가로 두고 나머지 불일치는 실패.
      // 1월 1~7일 결산(52/53주, WEN)은 앱 규칙상 전년도 라벨이어야 하므로 이 예외에서 뺀다(감사 3차 — 회귀를 가렸다).
      const endY = Number(s?.end.slice(0, 4)), endM = Number(s?.end.slice(5, 7)), endD = Number(s?.end.slice(8, 10));
      const startYearNaming = s && endM <= 2 && !(endM === 1 && endD <= 7) && y === endY && s.fy === endY - 1;
      add("B", "연도 라벨 = SEC 공시 사업연도(fy)", c.label, !s ? { status: NA, note: `결산일 ${c.date} 의 SEC 연간 공시 fy 없음` }
        : y === s.fy ? { status: PASS, note: `결산일 ${s.end} · SEC fy ${s.fy}` }
        : startYearNaming ? { status: NA, note: `보류(오너 결정 대기): 회사는 시작 연도로 부름 — 앱 ${c.label}(결산일 연도) vs SEC fy ${s.fy} (결산일 ${s.end})` }
        : { status: FAIL, note: `앱 라벨 ${c.label} vs SEC fy ${s.fy} (결산일 ${s.end})` });
    }
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
      revYoy: r("revenue_yoy") ?? r("net_revenue_yoy"), ebitdaM: r("ebitda_m"), niM: r("ni_m"),
    };
  });
  const evBlocked = (h.notes ?? []).find((n) => /EV.*(미표시|표시하지 않|계산하지 않)/.test(n));
  // 앱이 붙인 "EV 미표시" 사유를 그대로 믿지 않는다(재감사) — 원자료·결정 목록으로 따로 확인
  // 금융 자회사 보유사 = 오너 결정 목록(CLAUDE.md "EV 미표시: … F·GM·CAT·DE 등") + SEC 할부금융 채권 태그
  const CAPTIVE = new Set(["F", "GM", "CAT", "DE"]);
  const DEBT_TAGS = ["LongTermDebt", "LongTermDebtNoncurrent", "LongTermDebtCurrent", "DebtCurrent", "LongTermDebtAndCapitalLeaseObligations", "LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities", "DebtLongtermAndShorttermCombinedAmount", "NotesPayable", "ShortTermBorrowings", "CommercialPaper", "ConvertibleNotesPayable", "ConvertibleNotesPayableCurrent", "SeniorNotes", "LineOfCredit", "LinesOfCreditCurrent", "OtherLongTermDebt", "OtherLongTermDebtNoncurrent", "DebtInstrumentCarryingAmount", "FinanceLeaseLiability", "FinanceLeaseLiabilityNoncurrent"];
  /** EV 가 빈 열의 사유를 **그 열 날짜 기준으로** 원자료에서 확인 — 사유 문구만 믿지 않는다(재감사).
   *  안내문은 종목 단위라, 예전엔 문구가 하나라도 있으면 EV 가 있는 연도까지 실패로 쳤다(SNDK 오판). */
  let ltmEvCheck = null; // 20-F LTM EV 미표시 사유의 독립 확인 결과(루프 전 비동기로 채운다)
  let fyDebtCheck = null; // 20-F 최근 FY 총차입금 기대값 대조(A층)
  // 금융 자회사 보유사 — 오너 결정 목록(CLAUDE.md) 이면서 SEC 최신 기말 금융채권(할부·리스 채권)이 자산의 10% 이상일 때
  let captiveSec = null;
  if (CAPTIVE.has(sym)) {
    const latest = (t) => (G[t]?.units?.USD ?? []).filter((e) => !e.start).reduce((b, e) => (!b || e.end > b.end || (e.end === b.end && (e.filed ?? "") > (b.filed ?? "")) ? e : b), null);
    const a = latest("Assets");
    const recv = ["FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLoss", "NotesAndLoansReceivableNetNoncurrent", "FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLossNoncurrent", "FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLossCurrent", "LoansAndLeasesReceivableNetReportedAmount", "SalesTypeAndDirectFinancingLeasesLeaseReceivable"]
      .map(latest).filter((e) => e && a && dayDiff(e.end, a.end) <= 7);
    const tot = recv.reduce((m, e) => Math.max(m, e.val), 0);
    captiveSec = a && tot / a.val >= 0.1 ? `금융 자회사 보유(오너 결정 목록 + SEC 금융채권 ${tot} = 자산의 ${(tot / a.val * 100).toFixed(1)}%, ${a.end})` : null;
    if (!captiveSec) review.push({ item: "금융 자회사 보유 판정", note: `오너 결정 목록 종목이나 SEC 금융채권 비중 10% 미만·태그 없음 — EV 미표시 강제 검사 생략` });
  }
  const evBlockOkAt = (date) => {
    if (!evBlocked) return null;
    // 20-F LTM(Yahoo 분기)에서 앱이 EV 구성요소를 못 채워 LTM EV 를 비운 경우 — 사유("Yahoo FY말 총차입금 ≠ SEC")를 검증기가 따로
    // 확인했을 때만 인정(Yahoo 연간 총차입금 원통화 vs 앱 FY말 총차입금 ÷ 검증기 기말 환율). LTM 열에만.
    if (/LTM EV 미표시\(Yahoo 분기 LTM\)/.test(evBlocked)) return H.LTM && date === H.LTM.date && ltmEvCheck?.ok ? ltmEvCheck.ok : null;
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
  // "매출액" 첫 행 = 성장률(1년 YoY) 절 — 3년 CAGR 절의 같은 이름 행보다 앞에 있다
  for (const [name, key] of [["EV/EBITDA", "evx"], ["PER", "per"], ["PBR", "pbr"], ["PSR", "psr"], ["매출액", "revYoy"], ["순이익률 (%)", "niM"], ["영업이익률 (%)", "opM"]])
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
    for (const e of G[tag]?.units?.USD ?? []) if (!e.start && /^10-K/.test(e.form)) m.set(e.end, [...(m.get(e.end) ?? []), e]);
    return new Map([...m].map(([end, list]) => [end, latestPrecise(list)]));
  }
  const opP = new Map([...ann("OperatingIncomeLoss"), ...ann("IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest")]);

  // 영업이익 태그가 손익계산서 본표(계산 구조)에 실제로 있는가 — 앱이 구조 판독에 실패해 부문 주석 영업이익(DIS 형)으로
  // 조용히 돌아가도 같은 태그와 비교하면 통과해 버린다(재감사 HIGH). 최신 10-K 계산 구조(.xsd 내장 포함)로 따로 확인.
  let opOnFace = null;
  try {
    const rk = sub.filings?.recent ?? {};
    const ik = (rk.form ?? []).findIndex((fm) => fm === "10-K");
    if (ik >= 0) {
      const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${rk.accessionNumber[ik].replace(/-/g, "")}`;
      const names = (await secJson(base + "/index.json")).directory.item.map((x) => x.name);
      const calName = names.find((x) => /_cal\.xml$/i.test(x)) ?? names.find((x) => /\.xsd$/i.test(x));
      if (calName) {
        const cal = await secText(base + "/" + calName);
        opOnFace = false;
        for (const m of cal.matchAll(/<link:calculationLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/link:calculationLink>/g)) {
          const role = m[1].split("/").pop() ?? "";
          if (!/INCOME|OPERATIONS|EARNINGS/i.test(role) || /Detail|Table|Parenth|Tax|Segment/i.test(role)) continue;
          if (/#us-gaap_OperatingIncomeLoss"/.test(m[2])) { opOnFace = true; break; }
        }
      }
    }
  } catch (e) {
    hardErrors.push(`손익계산서 계산 구조 조회 실패: ${String(e).slice(0, 60)}`);
  }
  // 감가상각비 독립 대조 기준(최신 10-K 현금흐름표 본표 줄) — 은행·외화 공시 제외.
  // NFLX 는 콘텐츠 상각을 감가상각비에 넣는 오너 결정 종목이라(CLAUDE.md) 이 기준과 정의가 달라 대조하지 않는다.
  const CONTENT_DA = new Set(["NFLX"]);
  let cfDa = null, cfDaWhy = "";
  if (bank) cfDaWhy = "은행 레이아웃";
  else if (foreign) cfDaWhy = "외화 공시(USD 환산값)";
  else if (CONTENT_DA.has(sym)) cfDaWhy = "콘텐츠 상각 포함 종목(오너 결정) — 현금흐름표 기준과 정의 다름";
  else {
    try {
      const r = await secCashFlowDa(cik, sub);
      if (r.byEnd) cfDa = r; else cfDaWhy = r.why;
    } catch (e) {
      cfDaWhy = `현금흐름표 계산 구조 조회 실패: ${String(e).slice(0, 60)}`;
      hardErrors.push(cfDaWhy);
    }
  }
  // 앱 LTM 이 SEC 최신 정기공시 보고일보다 이르면(앱·companyfacts 가 같이 뒤처져도) 실패 — 재감사 HIGH
  {
    const rk = sub.filings?.recent ?? {};
    const latestRep = (rk.form ?? []).map((fm, i) => (/^10-[QK]$/.test(fm) ? rk.reportDate?.[i] : null)).filter(Boolean).sort().at(-1);
    const ltm = H.LTM?.date;
    if (latestRep && ltm) add("B", "앱 LTM 기준일 ≥ SEC 최신 정기공시 보고일", "LTM", Date.parse(ltm) >= Date.parse(latestRep) - 7 * 864e5
      ? { status: PASS, note: `앱 ${ltm} / SEC ${latestRep}` }
      : { status: FAIL, note: `앱 LTM ${ltm} 이 SEC 최신 정기공시 ${latestRep} 보다 이름(분기 누락)` });
  }

  // 결산일 실제 종가 = Yahoo 일별 종가(분할·분사 소급 조정값) × 결산일 이후 분할·분사 가격조정 계수(Yahoo 분할 이력, 앱과 독립).
  // 분사(WDC→SNDK 1323:1000)도 Yahoo 가 과거 종가를 조정하므로 되돌린다(EPS 보정과 달리 가격만의 조정).
  // 앱 결산일 주식수 = 앱 시가총액 ÷ 이 값 — 앱이 실제 종가를 썼다면 공시 주식수(정수)가 그대로 나온다.
  if (foreign && natCur && fxRows && H.LTM) { // 20-F FY 차입금 기대값은 항상 대조, LTM EV 공란 사유는 앱이 비웠을 때만 쓰인다
    try {
      // 감사 m2 + 오너 결정 "원칙 유지": SEC 원자료 FY 20-F 로 앱 규칙(본표 차입금 줄 + 리스)의 기대 차입금을 따로 계산하고(공통모드),
      // 앱 FY 차입금이 그 값(× 기말 환율)과 같은지, Yahoo FY 총차입금과의 차이가 무엇인지 숫자로 분해한 뒤, 그 차이 항목이 Yahoo 분기
      // 재무상태표에 없어서 같은 정의로 LTM 을 채울 수 없는지 확인한다.
      const c0 = Object.keys(H).filter((c) => c !== "LTM").sort((a, b) => H[a].date.localeCompare(H[b].date)).at(-1);
      const y0 = await yahoo();
      const ya = c0 ? await y0.fundamentalsTimeSeries(sym, { period1: "2018-01-01", type: "annual", module: "balance-sheet" }, { validateResult: false }) : [];
      const yr = ya.find((r) => r.totalDebt != null && dayDiff(new Date(r.date).toISOString().slice(0, 10), H[c0].date) <= 7);
      const yq = await y0.fundamentalsTimeSeries(sym, { period1: new Date(Date.parse(H.LTM.date) - 200 * 864e5), type: "quarterly", module: "balance-sheet" }, { validateResult: false });
      const yqL = yq.map((r) => ({ ...r, end: new Date(r.date).toISOString().slice(0, 10) })).filter((r) => dayDiff(r.end, H.LTM.date) <= 7).at(-1);
      const fl = c0 ? await filingAtDate(cik, sub, H[c0].date) : null;
      const unitRe = new RegExp(natCur, "i");
      const ex = fl ? expectedForeignDebt(fl, unitRe) : null;
      const rate = fxRows.filter((q) => q.d <= H[c0]?.date).at(-1)?.r ?? null;
      const partsTxt = ex ? ex.parts.map((x) => `${x.what} ${x.id.replace(/^[a-z0-9-]+_/, "")} ${x.v}`).join(" + ") : "";
      if (ex && rate != null) fyDebtCheck = { col: c0, r: vsSource(BS[c0]?.debt ?? null, ex.sum * rate, EXACT, `SEC ${fl.form} ${fl.date} 기대 차입금 ${ex.sum} ${natCur} = ${partsTxt} × 기말 환율 ${rate} · 공통모드(앱 규칙 재구현·Yahoo 환율)`) };
      if (!yr || !ex) ltmEvCheck = { why: `Yahoo 연간 총차입금 또는 SEC ${c0} 기대 차입금 없음 — 사유 확인 불가` };
      else if (fyDebtCheck?.r.status !== PASS) ltmEvCheck = { why: `앱 ${c0} 차입금이 SEC 기대 차입금과 다름 — 사유 확인 전제 불성립` };
      else {
        const added = ex.parts.filter((x) => x.kind !== "face" && x.kind !== "note");
        const faceSum = ex.face.faceSum;
        const qHas = (k) => yqL && yqL[k] != null;
        let why = null;
        // (가) Yahoo FY = 본표 차입금 줄만 — 앱이 더한 주석 리스가 Yahoo 분기 재무상태표에 없다(TSM 유동 리스·ASML 금융리스)
        if (added.length && added.every((x) => ["curLease", "nonLease", "lease", "finLease"].includes(x.kind)) && Math.abs(yr.totalDebt - faceSum) <= 0.5) {
          const field = { curLease: "currentCapitalLeaseObligation", nonLease: "longTermCapitalLeaseObligation", lease: "capitalLeaseObligations", finLease: "capitalLeaseObligations" };
          const missing = added.filter((x) => !qHas(field[x.kind]));
          if (missing.length === added.length) why = `Yahoo ${c0} 총차입금 ${yr.totalDebt} = SEC 본표 차입금 줄 합 ${faceSum}(앱이 더한 ${added.map((x) => `${x.what} ${x.v}`).join(" + ")} 제외), Yahoo 분기(${yqL?.end ?? "없음"}) 재무상태표에 ${[...new Set(missing.map((x) => field[x.kind]))].join("·")} 없음`;
        }
        // (나) 본표 차입금 줄 없음(SAP): Yahoo FY = 사채 + CP + 리스, SEC Borrowings 에 그 밖의 차입금이 더 있다
        if (!why && ex.parts.some((x) => x.kind === "fallback")) {
          const bonds = ex.v0("ifrs-full_BondsIssued"), cp = ex.v0("ifrs-full_CommercialPapersIssued"), lease = ex.v0("ifrs-full_LeaseLiabilities") ?? 0, bor = ex.v0("ifrs-full_Borrowings");
          if (bonds != null && bor != null && Math.abs(yr.totalDebt - (bonds + (cp ?? 0) + lease)) <= 0.5 && bor - bonds - (cp ?? 0) > 0)
            why = `Yahoo ${c0} 총차입금 ${yr.totalDebt} = SEC 사채 ${bonds} + CP ${cp ?? 0} + 리스 ${lease} — SEC Borrowings ${bor} 의 기타 차입금 ${bor - bonds - (cp ?? 0)} 을 Yahoo 는 넣지 않음(분기 재무상태표에도 그 구분 없음)`;
        }
        ltmEvCheck = why ? { ok: `LTM EV 미표시 사유 확인 — ${why} → 같은 정의로 LTM 차입금을 채울 수 없음 · 앱 ${c0} 차입금 = SEC 기대값(${partsTxt})`, yDebt: yr.totalDebt }
          : { why: `Yahoo ${c0} 총차입금 ${yr.totalDebt} vs SEC 기대 ${ex.sum}(${partsTxt}) — 차이를 Yahoo 분기에 없는 항목으로 분해 못함` };
      }
    } catch (e) {
      hardErrors.push(`LTM EV 미표시 사유 확인(Yahoo 연간 재무상태표) 조회 실패: ${String(e).slice(0, 60)}`);
    }
  }
  let yCloses = null;
  if (!foreign && fyCols.length && !splitErr) {
    try {
      const first = fyCols.map((cc) => cc.date).sort()[0];
      const ch = await (await yahoo()).chart(sym, { period1: new Date(Date.parse(first) - 20 * 864e5), interval: "1d" });
      yCloses = ch.quotes.filter((q) => q.close != null).map((q) => ({ d: new Date(q.date).toISOString().slice(0, 10), c: q.close }));
    } catch (e) {
      hardErrors.push(`Yahoo 일별 종가(결산일 주식수) 조회 실패: ${String(e).slice(0, 60)}`);
    }
  }
  const actualClose = (date) => {
    const q = yCloses?.filter((r) => r.d <= date).at(-1);
    return q && dayDiff(q.d, date) <= 7 ? q.c * [...splits, ...spinoffs].filter((s) => s.date > date).reduce((k, s) => k * s.ratio, 1) : null;
  };
  const appShares = (col) => { const p = H[col]?.mc != null ? actualClose(H[col].date) : null; return p ? H[col].mc / p : null; };
  /** SEC 결산일 본표 주식수 — 그 해 10-K(그 결산일 값을 처음 공시한 10-K) 기준, 후보 순서: 유통주식수 → 자본변동표
   *  SharesOutstanding → 발행 − 자기주식(같은 공시) → 발행(자기주식 태그 없음). CLAUDE.md 결산일 주식수 순서의 재구현(공통모드)
   *  — 가중평균 1.2배 검사·자본변동표 클래스 차원(WMT·BE·META)은 구현하지 않는다(그 경우 검증불가). */
  const secYearEndShares = (date, tol = 7) => {
    const firstAt = (t) => (G[t]?.units?.shares ?? []).filter((e) => !e.start && /^10-K/.test(e.form ?? "") && dayDiff(e.end, date) <= tol)
      .sort((a, b) => (a.filed ?? "").localeCompare(b.filed ?? ""))[0] ?? null;
    for (const t of ["CommonStockSharesOutstanding", "SharesOutstanding"]) { const e = firstAt(t); if (e) return { v: e.val, how: `${t}(${e.filed} 10-K)` }; }
    const iss = firstAt("CommonStockSharesIssued"), trs = firstAt("TreasuryStockShares") ?? firstAt("TreasuryStockCommonShares");
    if (iss && trs && iss.accn && iss.accn === trs.accn) return { v: iss.val - trs.val, how: `발행 ${iss.val} − 자기주식 ${trs.val}(${iss.filed} 10-K)` };
    if (iss && !trs) return { v: iss.val, how: `발행주식수(${iss.filed} 10-K, 자기주식 태그 없음)` };
    return null;
  };
  /** SEC 자산총계(결산일 ±7일, 최신 기준일 묶음) — 반올림 재태깅 제외 */
  const assetsAt = (date) => {
    // 정기공시(10-K·10-Q·20-F)만 — 앱 재무상태표는 정기공시 판본으로 짠다(edgar-series ANNUAL_FORMS). 8-K 재작성본(GE 2021: 2023-04 8-K 가
    // LDTI 소급 적용으로 자산 198,874 → 205,378 백만, 자본 40,310 → 32,044)은 재무상태표 표시 기준이 아니다(자기자본만 PBR 분모에 재작성본 우선).
    const l = (G.Assets?.units?.USD ?? []).filter((e) => !e.start && /^(10-[KQ]|20-F|40-F)/.test(e.form ?? "") && dayDiff(e.end, date) <= 7);
    if (!l.length) return null;
    const end = l.map((e) => e.end).sort((p, q) => dayDiff(p, date) - dayDiff(q, date))[0];
    return latestPrecise(l.filter((e) => e.end === end));
  };
  /**
   * 결산일 주식수 SEC 후보 전부(감사 2026-09-25 — 불일치를 무조건 검증불가로 두면 가격 ×3 주입도 통과했다).
   * 기대값(expected) — 앱과 같은 규칙의 재구현(공통모드, 오너 결정 2026-09-25 "정확한 값 우선"):
   *  1. 판본: 같은 개념·같은 결산일의 공시값 중 **최신 공시**(나중 공시 정정). 단 최신값이 그 해 10-K 값의 분할 소급본(정수 배수)
   *     이거나 단위 오류(1000배 이상)면 그 해 10-K 값. 먼저 공시된 정밀값의 반올림으로 다시 태깅한 값은 판본에서 뺀다(MRVL 2022).
   *  2. 순서: 유통주식수 → 자본변동표 SharesOutstanding → 발행 − 자기주식(같은 공시의 두 값끼리만) → 발행. 같은 해 가중평균과
   *     1.2배 안(또는 정수 분할배수)인 첫 값.
   *  3. 정밀도: 같은 공시(accn) 안에서 반올림 범위(1천~100만) 안으로 일치하는 후보 중 가장 정밀한 값(CAT: 유통주식수 535,900,000
   *     대신 발행 − 자기주식 535,888,051).
   * 그 밖의 후보(판정 근거 표시용): 판본에서 밀린 값, 분할 소급본(÷ 그 사이 Yahoo 분할 배수), 표지(dei), 가중평균.
   * 자본변동표 클래스 차원(WMT·BE·META)은 없다 → 본표 후보가 없으면 검증불가.
   */
  const secShareCandidates = (date) => {
    const inst = (t) => (G[t]?.units?.shares ?? []).filter((e) => !e.start && /^10-[KQ]/.test(e.form ?? "") && dayDiff(e.end, date) <= 7)
      .sort((a, b) => (a.filed ?? "").localeCompare(b.filed ?? ""));
    const splitK = (filed) => splits.filter((s) => s.date > date && s.date <= (filed ?? "")).reduce((k, s) => k * s.ratio, 1);
    const nearInt = (r) => Math.round(r) >= 2 && Math.abs(r / Math.round(r) - 1) < 1e-3;
    /** 판본 선택 — list: [{ v, filed, form, accn }] 공시일 순 → { pick, why } */
    const choose = (list) => {
      if (!list.length) return null;
      const first10k = list.find((e) => /^10-K/.test(e.form ?? "")) ?? list[0];
      const kept = list.filter((e, i) => !list.slice(0, i).some((o) => roundingOf(e.v, o.v)));
      const latest = kept.at(-1);
      const r = latest.v / first10k.v;
      if (latest !== first10k && (nearInt(r) || nearInt(1 / r) || r >= 1000 || r <= 1 / 1000)) return { pick: first10k, why: `그 해 10-K — 최신 공시 ${latest.v}(${latest.filed})는 분할 소급·단위 오류` };
      return { pick: latest, why: latest === list.at(-1) ? (latest === first10k ? "그 해 10-K" : "최신 공시(정정)") : `최신 공시 — 나중 반올림 재태깅 ${list.at(-1).v}(${list.at(-1).filed}) 제외` };
    };
    const cands = [], ordered = [];
    const addOthers = (list, pick, lab) => {
      for (const e of list) {
        if (e === pick) continue;
        const k = splitK(e.filed);
        cands.push(k !== 1 ? { v: e.v / k, how: `${lab} 분할 소급본 ${e.v}(${e.filed} ${e.form}) ÷ 분할 ${k}` } : { v: e.v, how: `${lab} 다른 판본 ${e.v}(${e.filed} ${e.form})` });
      }
    };
    for (const t of ["CommonStockSharesOutstanding", "SharesOutstanding"]) {
      const l = inst(t).map((e) => ({ v: e.val, filed: e.filed, form: e.form, accn: e.accn }));
      const c = choose(l);
      if (c) ordered.push({ v: c.pick.v, accns: new Set(l.filter((e) => e.v === c.pick.v).map((e) => e.accn)), how: `${t}(${c.pick.filed} ${c.pick.form} · ${c.why})` });
      addOthers(l, c?.pick, t);
    }
    // 발행 − 자기주식: 같은 공시(accn)의 두 값끼리만
    const iss = inst("CommonStockSharesIssued"), trs = [...inst("TreasuryStockShares"), ...inst("TreasuryStockCommonShares")];
    const pairs = iss.map((e) => { const t = trs.find((x) => x.accn && x.accn === e.accn); return t ? { v: e.val - t.val, filed: e.filed, form: e.form, accn: e.accn, iss: e.val, trs: t.val } : null; }).filter(Boolean);
    const cp = choose(pairs);
    if (cp) ordered.push({ v: cp.pick.v, accns: new Set(pairs.filter((e) => e.v === cp.pick.v).map((e) => e.accn)), how: `발행 ${cp.pick.iss} − 자기주식 ${cp.pick.trs}(${cp.pick.filed} ${cp.pick.form} · ${cp.why})` });
    addOthers(pairs, cp?.pick, "발행 − 자기주식");
    // 발행주식수 단독 — 순서상 마지막 후보(발행 − 자기주식이 1.2배 검사에서 빠질 때: PEP 는 "발행" 태그가 유통 주식수라 발행 − 자기주식
    // 899M 이 가중평균 1,389M 과 안 맞는다)
    {
      const li = iss.map((e) => ({ v: e.val, filed: e.filed, form: e.form, accn: e.accn }));
      const ci = choose(li);
      if (ci) ordered.push({ v: ci.pick.v, accns: new Set(li.filter((e) => e.v === ci.pick.v).map((e) => e.accn)), how: `발행주식수(${ci.pick.filed} ${ci.pick.form} · ${ci.why}${trs.length ? "" : ", 자기주식 태그 없음"})` });
      addOthers(li, ci?.pick, "발행주식수");
    }
    const cover = (f.facts.dei?.EntityCommonStockSharesOutstanding?.units?.shares ?? []).filter((e) => /^10-K/.test(e.form ?? "") && e.end > date && dayDiff(e.end, date) <= 120);
    for (const e of cover) cands.push({ v: e.val, how: `표지(dei ${e.end}, ${e.filed} 10-K)`, otherDate: true });
    const wD = atEnd(ann("WeightedAverageNumberOfDilutedSharesOutstanding", "shares"), date), wB = atEnd(ann("WeightedAverageNumberOfSharesOutstandingBasic", "shares"), date);
    for (const [lab, w] of [["희석", wD], ["기본", wB]]) if (w) cands.push({ v: w.val, how: `가중평균 ${lab}(${w.filed})`, otherDate: true });
    const w = wD?.val ?? wB?.val ?? null;
    // 가중평균 주식수 단위 오류(MCD 716.4 = 백만 주 — CLAUDE.md fixScale)는 ×1천·×100만으로 맞춰 본다
    const plausible = (v) => { if (!w) return true; return [1, 1e3, 1e6].some((u) => { const r = v / (w * u); return (r >= 1 / 1.2 && r <= 1.2) || [2, 3, 4, 5, 10, 20, 50, 100].some((n) => Math.abs(r * n - 1) < 0.2 || Math.abs(r / n - 1) < 0.2); }); };
    let expected = ordered.find((o) => plausible(o.v)) ?? null;
    // 정밀도 — 같은 공시 안에서 기대값을 반올림값으로 갖는 더 정밀한 후보가 있으면 그 값(여러 단계면 가장 정밀한 것까지)
    for (let guard = 0; expected && guard < 4; guard++) {
      // 같은 공시 = 두 값이 함께 실린 공시(accn)가 하나라도 있음(판본 선택으로 고른 공시는 서로 다를 수 있다 — CAT)
      const finer = ordered.find((o) => o !== expected && [...o.accns].some((a) => a && expected.accns.has(a)) && roundingOf(expected.v, o.v));
      if (!finer) break;
      expected = { ...finer, how: `${finer.how} · 같은 공시의 ${expected.v}(${expected.how.split("(")[0]})보다 정밀 — 정확한 값 우선` };
    }
    return { expected, ordered, all: [...ordered, ...cands] };
  };
  /** a 가 b 를 1천·1만·10만·100만 단위로 반올림한 값인가(b 가 더 정밀) */
  const roundingOf = (a, b) => a !== b && [1e3, 1e4, 1e5, 1e6].some((u) => b % u !== 0 && Math.abs(Math.round(b / u) * u - a) <= 0.5);
  const SHARES_A = "결산일 주식수 앱(시총÷실제 종가) = SEC 본표 주식수";
  const sharesPassed = (col) => checks.some((k) => k.col === col && k.status === PASS && k.name === SHARES_A);
  /** SEC 공시 단위(값을 나누는 가장 큰 10의 거듭제곱, 최대 100만) */
  const secUnit = (v) => { let u = 1; while (u < 1e6 && v % (u * 10) === 0) u *= 10; return u; };

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
      // 결산일 주식수·시가총액 — 기대값(그 해 10-K 본표)과 정확 일치(±0.5주)면 통과. 앱이 기대값의 반올림본(나중 공시·분할
      // 소급본 — 정밀값이 있는데 덜 정밀한 값)을 쓰면 실패(CLAUDE.md "결산일마다 그 해의 10-K 값(공시 당시 기준)"), 어느 SEC
      // 후보와도 맞지 않으면 실패(가격·분할 오판 신호 — 비율이 분할·분사 배수·정수배면 메모). 다른 후보와만 맞으면 판정 보류.
      if (x.mc != null) {
        const sc = secShareCandidates(x.date), as = appShares(c), ex = sc.expected;
        const hit = (v) => as != null && Math.abs(as - v) <= 0.5;
        let r, used = ex; // 시가총액 기대값에 쓸 주식수(정밀 후보로 통과하면 그 값)
        // 본표 후보(유통·자본변동표·발행−자기주식·발행)가 하나도 없으면 판정하지 않는다 — 표지·가중평균만으로는 기준이 안 된다
        // (WMT: 자본변동표 클래스 차원 경로 미구현)
        if (!sc.ordered.length) r = { status: NA, note: `SEC 결산일 본표 주식수 태그 없음(자본변동표 클래스 차원 경로 미구현)${sc.all.length ? ` · 참고 후보 ${sc.all.map((o) => `${o.v}(${o.how})`).join(", ")}` : ""}` };
        else if (as == null) r = { status: NA, note: yCloses ? "결산일 종가 없음" : "Yahoo 일별 종가 없음" };
        else if (ex && hit(ex.v)) {
          // 같은 결산일의 본표 후보만(표지·가중평균은 다른 기준일이라 "더 정밀한 값"이 아니다)
          const finer = sc.all.find((o) => !o.otherDate && roundingOf(ex.v, o.v));
          r = { status: PASS, note: [`${ex.how} · 규칙 재구현(후보 순서·1.2배 검사는 공통모드)`, finer && `앱 결함 후보 — 더 정밀한 SEC 후보 ${finer.v}(${finer.how}), 본표 값이 반올림 공시`].filter(Boolean).join(" · ") };
        } else {
          const m = sc.all.find((o) => hit(o.v));
          // 앱이 쓴 값이 기대값보다 더 정밀(기대값 = 앱 값의 반올림 — NVDA 2024 2,464,300,000 분할 소급본 vs 그 해 10-K 2,464,000,000)
          // → 오너 결정 "정확한 값 우선"(2026-09-25): 그 해 10-K 값의 반올림 범위 안이면 통과
          if (m && ex && !m.otherDate && roundingOf(ex.v, m.v)) { r = { status: PASS, note: `정확한 값 우선 — 앱 ${as.toFixed(1)} = ${m.how}: 그 해 10-K 값 ${ex.v}(${ex.how})보다 정밀하고 그 반올림 범위 안 · 규칙 재구현(공통모드)` }; used = { v: m.v, how: m.how }; }
          else if (m && ex && !m.otherDate && roundingOf(m.v, ex.v)) r = { status: FAIL, note: `앱 ${as.toFixed(1)} = ${m.how} — 그 해 10-K 정밀값 ${ex.v}(${ex.how})의 반올림본(덜 정밀한 값 선택)` };
          else if (m) r = { status: NA, note: `판정 보류 — 앱 ${as.toFixed(1)} = ${m.how}, 기대 ${ex ? `${ex.v}(${ex.how})` : "없음(1.2배 검사 통과 후보 없음)"}` };
          else {
            const base = ex?.v ?? sc.all[0].v, k = as / base;
            const ratios = [...splits, ...spinoffs].map((s) => s.ratio);
            const sig = ratios.find((q) => Math.abs(k / q - 1) < 1e-3 || Math.abs(k * q - 1) < 1e-3) ?? (Math.abs(k - Math.round(k)) < 1e-3 && Math.round(k) >= 2 ? Math.round(k) : Math.abs(1 / k - Math.round(1 / k)) < 1e-3 && Math.round(1 / k) >= 2 ? `1/${Math.round(1 / k)}` : null);
            r = { status: FAIL, note: `앱 ${as.toFixed(1)} 이 SEC 후보 어느 것과도 다름(기대 ${ex ? `${ex.v} ${ex.how}` : "없음"}; 후보 ${sc.all.map((o) => o.v).join(", ")})${sig != null ? ` · 앱÷SEC = ${k.toFixed(4)} ≈ ${sig} — 결산일 가격·분할 오판 신호` : ""}` };
          }
        }
        add("A", SHARES_A, c, r);
        const px = actualClose(x.date);
        // 주식수 판정이 보류면 시가총액도 보류(같은 기대값을 쓰므로 판정만 중복된다)
        add("A", "결산일 시가총액 앱 = 결산일 실제 종가 × SEC 본표 주식수", c, r.status === NA ? { status: NA, note: `주식수 판정 보류 — ${r.note.slice(0, 80)}` }
          : !used || px == null ? { status: NA, note: !used ? "기대 주식수 없음" : "결산일 종가 없음" }
          : vsSource(x.mc, px * used.v, EXACT, `실제 종가 ${px}(Yahoo 종가 + 분할·분사 되돌림) × ${used.v}(${used.how})`));
      }
      // 매출 = SEC 본표 매출 줄(검증기 판독, 최신 판본) — 정확 일치. 은행도 본표 매출 줄(없으면 순수익 합성)
      {
        const sr = revFace?.annualAt(x.date) ?? null;
        let res = !revFace ? { status: NA, note: revFaceWhy } : vsSource(x.rev, sr?.v ?? null, EXACT, sr?.how ?? "읽은 공시(10-K 3건) 범위 밖");
        // 비영업 분리 기준은 앱과 같은 판정 규칙이라 독립 검증이 아니다(감사) — Yahoo 연간 매출도 같아야 통과
        if (sr?.split && res.status === PASS) {
          const yv = yRev.get([...yRev.keys()].find((d) => dayDiff(d, x.date) <= 7));
          // Yahoo 가 없으면 회사가 같은 공시에서 영업 매출 줄을 제품·서비스 차원 멤버로 직접 태깅한 값으로 확인(분리 규칙과 독립 —
          // 총액 − 비영업을 검증기가 계산한 값이 회사 자신의 태깅값과 정확히 같아야 한다. XOM 2021 SalesAndOtherOperatingRevenueMember)
          const own = yv == null ? sr.tagged?.find((t) => t.v === x.rev) : null;
          res = own ? { status: PASS, note: `${sr.how} · 회사 태깅 영업 매출 줄 ${own.member} ${own.v} 와 정확 일치(분리 규칙과 독립 확인 — Yahoo 연간 없음)` }
            : yv == null ? { status: NA, note: `${sr.how} — Yahoo 연간 매출 없음(독립 확인 불가)` }
            : Math.abs(yv - x.rev) <= secUnit(yv) / 2 ? { status: PASS, note: `${sr.how} · Yahoo ${yv} 일치(Yahoo 보고 단위 ${secUnit(yv)} 안)` }
            : { status: FAIL, note: `${sr.how} 로는 맞지만 Yahoo 연간 매출 ${yv} 와 다름` };
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
        // 정확 비교(오너 원칙 — 허용치 통과 금지, 2026-09-25). 앱 fyEps = 공시값 × splitFactorsByYear 계수이고 반올림하지
        // 않는다(edgar-pershare.ts) → 기준 = 공시값 ÷ Yahoo 분할 배수, 부동소수 오차(상대 1e-9)만. 예전 허용치(0.006 + 0.3%)는
        // 작은 EPS 의 1% 오류·+0.004 오류를 통과시켰다(자체 주입).
        const r = vsSource(x.eps, expected, EXACT, "");
        const ok = x.eps != null && Math.abs(x.eps - expected) <= EXACT * Math.max(1, Math.abs(expected));
        add("A", "EPS 앱 = SEC 공시 EPS(분할 보정)", c, x.eps == null ? r : ok
          ? { status: PASS, ...(k !== 1 ? { note: `분할 보정 ÷${k}(Yahoo 분할 이력)` } : {}) }
          : { status: FAIL, note: `앱 ${x.eps} vs 공시 ${e.val}${k !== 1 ? ` ÷ 분할 ${k}` : ""} = ${expected}${splitErr ? ` · ${splitErr}` : ""}` });
      } else if (contDiscEps(x.date)) {
        // 총 희석 EPS 태그가 없고 계속영업·중단영업 희석 EPS 가 같은 10-K 에 둘 다 공시된 해 — 두 태그값의 합이 SEC 기준
        // (DELL FY2022 = 6.26 + 0.76). 공시 총 EPS 와 반올림 0.01 차이가 날 수 있어 허용치 없이 태그값 합 그대로 비교
        const cd = contDiscEps(x.date);
        if (splitErr) add("A", "EPS 앱 = SEC 공시 EPS(분할 보정)", c, { status: NA, note: splitErr });
        else {
          const k = splitAdj({ end: x.date, filed: cd.filed });
          const expected = (cd.cont + cd.disc) / k;
          const basis = `계속영업 ${cd.cont} + 중단영업 ${cd.disc} 희석 EPS(${cd.filed} 10-K, 총 EPS 태그 없음)${k !== 1 ? ` ÷ 분할 ${k}` : ""}`;
          add("A", "EPS 앱 = SEC 공시 EPS(분할 보정)", c, x.eps == null ? vsSource(null, expected, 0, basis)
            : Math.abs(x.eps - expected) <= 1e-9 * Math.max(1, Math.abs(expected)) ? { status: PASS, note: basis }
            : { status: FAIL, note: `앱 ${x.eps} vs ${basis} = ${expected}` });
        }
      } else {
        if (!inst.size && !instErr) inst = await classFactsFromInstances(cik).catch((err) => { instErr = String(err).slice(0, 80); hardErrors.push(`SEC 인스턴스(클래스별 EPS) 판독 실패: ${instErr}`); return new Map(); });
        const ie = [...inst].find(([end]) => dayDiff(end, x.date) <= 7)?.[1];
        add("A", "EPS 앱 = SEC 공시 EPS(분할 보정)", c, ie && !ie.basic && !splitErr
          // 인스턴스 값은 그 10-K 공시일 기준 — 이후 분할만 나눈다(최근 10-K 는 이미 재작성값일 수 있음)
          ? vsSource(x.eps, ie.eps / splitAdj({ end: x.date, filed: ie.filed }), EXACT, `${ie.basis} · 정확 비교(앱 classAEps 는 인스턴스 값을 그대로 씀)`)
          : { status: NA, note: instErr ? `인스턴스 판독 실패: ${instErr}` : ie?.basic ? "희석 EPS 는 클래스별로만 공시(기본 EPS 만 확인 가능)" : "공시 희석 EPS 없음" });
      }
    }
    // LTM 순이익 — SEC 분기 공시로 따로 계산한 TTM 과 대조(재감사: LTM 순이익은 원자료 대조가 없었음)
    if (!isFy && foreign) add("A", "LTM 순이익 앱 = SEC TTM", c, { status: NA, note: "외화 공시 — 분기 XBRL 없음(20-F)·환산은 인포맥스 대조로" });
    else if (!isFy) {
      const hasNciNow = [...nciTrace].some((e) => dayDiff(e, x.date) <= 400);
      // 감사 m1: 옛날에 끊긴 태그(기준일이 앱 LTM 과 다름)면 다음 태그로 — NetIncomeLoss → ProfitLoss − 비지배(또는 비지배 흔적이
      // 없으면 ProfitLoss) → 보통주 귀속 순이익(우선주 흔적 없을 때만)
      const fresh = (t0) => (t0 && dayDiff(t0.end, x.date) <= 7 ? t0 : null);
      const plNci = () => { const a = fresh(secTtm("ProfitLoss")), b = fresh(secTtm("NetIncomeLossAttributableToNoncontrollingInterest")); return a && b ? { v: a.v - b.v, end: a.end, how: `ProfitLoss − 비지배지분(${a.how})` } : null; };
      const t = fresh(secTtm("NetIncomeLoss")) ?? (hasNciNow ? plNci() : fresh(secTtm("ProfitLoss")))
        ?? (![...prefTrace].some((e) => dayDiff(e, x.date) <= 400) ? fresh(secTtm("NetIncomeLossAvailableToCommonStockholdersBasic")) : null)
        ?? secTtm("NetIncomeLoss") ?? (hasNciNow ? null : secTtm("ProfitLoss"));
      if (!t) add("A", "LTM 순이익 앱 = SEC TTM", c, { status: NA, note: "SEC 분기 순이익으로 TTM 계산 불가" });
      // 3차 감사: 앱 LTM 이 SEC 최신 분기보다 늦으면(한 분기 뒤처짐) 검증불가가 아니라 실패
      else if (Date.parse(x.date) < Date.parse(t.end) - 7 * 864e5) add("A", "LTM 순이익 앱 = SEC TTM", c, { status: FAIL, note: `앱 LTM 기준일 ${x.date} 이 SEC 최신 결산 ${t.end} 보다 늦음(분기 누락)` });
      else if (dayDiff(t.end, x.date) > 7) add("A", "LTM 순이익 앱 = SEC TTM", c, { status: NA, note: `기준일 다름(앱 ${x.date} / SEC ${t.end})` });
      else add("A", "LTM 순이익 앱 = SEC TTM", c, vsSource(x.ni, t.v, EXACT, t.how));
      // LTM 매출 = SEC 본표 매출 줄로 사업연도 + 당기 누적 − 전년 동기 누적(전부 최신 판본, revenue.md §2)
      const lr = revFace?.ltmAt(x.date) ?? null;
      add("A", "매출 앱 = SEC 매출", c, !revFace ? { status: NA, note: revFaceWhy } : vsSource(x.rev, lr?.v ?? null, EXACT, lr?.how ?? `기준일 ${x.date} 의 SEC 누적 매출 조합 불가`));
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
      const secNotes = [];
      const secAt = (tag) => {
        if (isFy) { const e = atEnd(ann(tag), x.date); if (e?.retag) secNotes.push(`${tag}: ${retagNote(e)}`); return e?.val ?? null; }
        const t = secTtm(tag);
        if (t && /반올림 재태깅/.test(t.how)) secNotes.push(`${tag}: ${t.how}`);
        return t && dayDiff(t.end, x.date) <= 7 ? t.v : null;
      };
      const secPt = PRETAX_TAGS.map(secAt).find((v) => v != null) ?? null;
      add("A", "세전이익 앱 = SEC 세전이익", c, vsSource(pt, secPt, EXACT, secNotes.join(" · ")));
      // 앱 라벨(합성 여부)은 판정 근거가 아니다(감사) — 합성(미결)은 SEC 쪽 근거(최신 10-K 본표에 영업이익 태그 없음)일
      // 때만. SEC 본표에 영업이익 태그가 있는데 앱이 합성했으면 실패.
      const synth = opRowName != null && opRowName !== "영업이익";
      const fin = sic >= 6000 && sic <= 6499;
      if (fin) {
        // 금융·보험: 앱 규칙 = 세전이익 − 지분법이익(CLAUDE.md "금융·보험업 영업이익 근사")
        const eq = secAt("IncomeLossFromEquityMethodInvestments") ?? 0;
        add("A", "영업이익 앱 = SEC 세전이익 − 지분법(금융·보험)", c, secPt == null ? { status: NA, note: "SEC 세전이익 없음" } : vsSource(op, secPt - eq, EXACT));
      } else if (!synth) {
        if (opOnFace === false) add("A", "영업이익 앱 = SEC 영업이익", c, { status: FAIL, note: "SEC 영업이익 태그가 손익계산서 본표에 없음(부문 주석값) — 앱이 구조 판독에 실패해 주석값을 쓴 것으로 보임" });
        else { secNotes.length = 0; const so = secAt("OperatingIncomeLoss"); add("A", "영업이익 앱 = SEC 영업이익", c, vsSource(op, so, EXACT, secNotes.join(" · "))); }
      } else if (opOnFace === true && secAt("OperatingIncomeLoss") != null) {
        // 행 이름은 행 전체에 하나라 일부 기간만 합성일 수 있다 — 값으로 판정(SEC 태그 값과 정확히 같아야 통과)
        add("A", "영업이익 앱 = SEC 영업이익", c, vsSource(op, secAt("OperatingIncomeLoss"), EXACT, `SEC 본표에 영업이익 태그 있음 — 앱 행 "${opRowName}"`));
      } else if (opOnFace === true) {
        add("A", "영업이익(합성) 앱 = SEC 손익계산서 구조", c, { status: NA, note: `미결 — 최신 10-K 본표엔 영업이익 태그가 있으나 이 기간 SEC 영업이익 값 없음. 합성 "${opRowName}"` });
      } else if (opOnFace === null) {
        add("A", "영업이익(합성) 앱 = SEC 손익계산서 구조", c, { status: NA, note: `SEC 본표 판독 불가(계산 구조 없음·조회 실패) — 합성 "${opRowName}" 의 근거 확인 못함` });
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
    // 감가상각비 = SEC 현금흐름표 본표 감가상각·상각 줄 합(최신 10-K 범위의 연도만, 정확 일치) — 외부 대조 원인 ⑥의 전제
    if (isFy && !bank && !foreign) {
      // 손상 포함 줄은 손상을, 중단사업 포함 현금흐름표는 중단사업 감가상각을 원본 태그로 따로 빼서 대조(계속사업·손상 제외 기준)
      const e = cfDa ? [...cfDa.byEnd].find(([end]) => dayDiff(end, x.date) <= 7) : null;
      const adjNote = e ? cfDa.notes.get(e[0]) : null;
      const unres = e ? cfDa.unresolved.get(e[0]) : null;
      add("A", "감가상각비 앱 = SEC 현금흐름표 감가상각·상각 줄 합", c, !cfDa ? { status: NA, note: cfDaWhy }
        : !e ? { status: NA, note: "최신 10-K 현금흐름표 기간 밖" }
        : unres ? { status: NA, note: `미결 — ${unres}(앱은 줄 값을 그대로 씀: ${IS[c]?.da ?? "빈칸"}, SEC 줄 합 ${e[1]}) · ${cfDa.lines}` }
        : vsSource(IS[c]?.da ?? null, e[1], EXACT, `규칙 재구현(줄 선택은 공통모드)${adjNote ? ` · ${adjNote}` : ""} · ${cfDa.lines}`));
    }
    // EBITDA = 영업이익 + 감가상각비(앱 손익계산서 주석·영업이익 행) — 은행 레이아웃 제외
    if (!bank) {
      const e = IS[c]?.ebitda ?? null, o = IS[c]?.op ?? null, d = IS[c]?.da ?? null;
      if (e != null || (o != null && d != null))
        add("D", "EBITDA = 영업이익 + 감가상각비(손익계산서)", c, e == null ? { status: FAIL, note: `영업이익 ${o}·감가상각비 ${d} 있는데 EBITDA 빈칸` }
          : o == null || d == null ? { status: FAIL, note: `EBITDA ${e} 있는데 구성요소 빈칸(영업이익 ${o}·감가상각비 ${d})` }
          : same(e, o + d));
    }
    // LTM 기대치 — 연도 열만 보던 EBITDA·PBR 기대치를 LTM 에도(감사). 기준은 SEC TTM·최신 분기 자본
    if (!isFy && !bank && !foreign) {
      const t = ["OperatingIncomeLoss", ...PRETAX_TAGS].map((tag) => ({ tag, t: secTtm(tag) })).find((r) => r.t && dayDiff(r.t.end, x.date) <= 7);
      if (t) add("D", "LTM EBITDA 기대치(SEC TTM 영업이익·세전이익 있음)", c, x.ebitda != null ? { status: PASS } : { status: FAIL, note: `SEC TTM ${t.tag} ${t.t.v}(${t.t.end}) 있는데 앱 LTM EBITDA 빈칸` });
    }
    if (!isFy && (x.mc != null || ov?.quote?.last != null)) {
      const ql = (G.StockholdersEquity?.units?.USD ?? []).filter((e) => !e.start && /^10-[QK]/.test(e.form) && dayDiff(e.end, x.date) <= 7);
      const q = ql.length ? latestPrecise(ql.filter((e) => e.end === ql.reduce((m, y) => (y.end > m ? y.end : m), ""))) : null;
      if (q) signRule("PBR", x.pbr, q.val);
    }
    if (x.mc != null && x.rev != null) signRule("PSR", x.psr, x.rev);
    if (isFy && x.mc != null) { const eq = atEnd(eqP, x.date)?.val; if (eq != null) signRule("PBR", x.pbr, eq); }
    // 감사 m3: 금융 자회사 보유사(오너 결정 목록 + SEC 금융채권 비중으로 독립 확인)는 EV 를 표시하면 안 된다
    if (captiveSec && x.ev != null) add("D", "금융 자회사 보유사 EV 미표시", c, { status: FAIL, note: `EV ${x.ev} 가 표시됨 — ${captiveSec}` });
    else if (captiveSec) add("D", "금융 자회사 보유사 EV 미표시", c, { status: PASS, note: captiveSec });
    if (!bank && x.mc != null) {
      if (x.ev == null) {
        const ok = evBlockOkAt(x.date);
        add("D", "EV 기대치", c, ok ? { status: NA, note: `EV 미표시 — ${ok}` } : { status: FAIL, note: evBlocked ? `EV 미표시 — 앱 사유 "${evBlocked.slice(0, 50)}" 를 이 날짜 원자료로 확인 못함${ltmEvCheck?.why ? ` · ${ltmEvCheck.why}` : ""}` : "EV 미표시 사유 없이 빈칸" });
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
      // 최신 제출분 — 나중 공시의 반올림 재태깅(100만·1억·10억·100억 단위)은 제외(latestPrecise, 검증기 독립 판정)
      const a = assetsAt(x.date);
      add("A", "자산총계 앱 = SEC 자산총계", c, vsSource(BS[c].assets, a?.val ?? null, EXACT, retagNote(a)));
    }
    if (BS[c]) {
      // 대차대조표 항등식 — 같은 공시의 두 합계라 정확 일치(예전 허용 0.05% 제거). 반올림 재태깅이 갈리는 날짜면 SEC 두 값을 메모에
      const rn = retagNote(assetsAt(x.date));
      const r = BS[c].assets == null || BS[c].le == null ? { status: NA, note: "대차대조표 값 없음" } : same(BS[c].assets, BS[c].le);
      add("D", "자산 총계 = 부채와 자본 총계", c, rn ? { ...r, note: [r.note, `SEC 자산총계 ${rn}`].filter(Boolean).join(" · ") } : r);
    }

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
        // 공시 보고 단위만큼만 허용(예전 "0.005 + 0.3%" 허용치 대신, 2026-09-25): 순이익·가중평균 주식수는 각자 보고 단위
        // (값을 나누는 10의 거듭제곱, 최대 100만 — 예: 919,000,000 주 → ±50만 주) 반올림 구간, EPS 는 소수 자릿수(최소 센트)
        // 반올림 구간. 순이익 ÷ 주식수가 만들 수 있는 구간과 공시 EPS 반올림 구간이 겹치면 정합.
        const implied = ni / w;
        const epsUnit = 10 ** -Math.max(2, (String(eps).split(".")[1] ?? "").length);
        const consistent = (wk) => {
          const uN = secUnit(Math.abs(ni)), uW = secUnit(w) * wk;
          const cs = [(ni - uN / 2) / (w * wk - uW / 2), (ni - uN / 2) / (w * wk + uW / 2), (ni + uN / 2) / (w * wk - uW / 2), (ni + uN / 2) / (w * wk + uW / 2)];
          return Math.min(...cs) <= eps + epsUnit / 2 && Math.max(...cs) >= eps - epsUnit / 2;
        };
        let ok = consistent(1);
        let unitNote = "";
        if (!ok) for (const k of [1e3, 1e6]) if (consistent(k)) { ok = true; unitNote = `공시 주식수 단위 오류(×${k})`; }
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

  // ── 매출 A(분기)·C·D층(revenue.md §6, 2026-09-25) ────────────────────────────────────────────────
  // C: 소비처(하이라이트·손익계산서·총괄·재무분석·컨센서스 실적·개요·유니버스)가 같은 매출을 쓰는지 — 각 화면의 기준(연간/LTM)으로.
  //    재무분석·하이라이트의 성장률·마진·PSR 은 매출로 다시 계산해 정확히 같은지(부동소수 오차만).
  // D: 분기 4개 합 = 연간(같은 사업연도), LTM = 최근 4분기 합. 차이가 SEC 본표 매출의 "3개월값 합 − 누적값"과 정확히 같으면
  //    반올림 차(R4 — 누적·분기 공시값 반올림)로 명시하고 통과.
  {
    const revRow = (stmt) => { const a = rowOf(stmt, "매출액"); return Object.keys(a).length ? a : rowOf(stmt, "순수익"); };
    const SM = Object.fromEntries(Object.entries(revRow(sm)).map(([k, v]) => [lab(k), v]));
    const cols = [...Object.keys(H).filter((k) => k !== "LTM").sort((a, b) => H[a].date.localeCompare(H[b].date)), ...(H.LTM ? ["LTM"] : [])];
    const pct = (a, b) => (a != null && b != null && b !== 0 ? (a / b) * 100 : null);
    cols.forEach((c, i) => {
      const x = H[c], prev = i > 0 ? H[cols[i - 1]] : null;
      add("C", "매출 하이라이트=총괄", c, same(SM[c] ?? null, x.rev));
      if (C[c]) add("C", "매출 컨센서스 실적=하이라이트", c, same(C[c].revenue ?? null, x.rev));
      if (x.rev != null && prev?.rev) {
        const yoy = (x.rev / prev.rev - 1) * 100;
        add("C", "매출 성장률 하이라이트 = 매출 재계산(직전 열 대비)", c, same(x.revYoy, yoy));
        add("C", "매출 성장률 재무분석 = 매출 재계산(직전 열 대비)", c, same(A[c]?.revYoy ?? null, yoy));
        if (C[c] && c !== "LTM") add("C", "매출 성장률 컨센서스 = 매출 재계산(직전 연도 대비)", c, same(C[c].revenueYoY ?? null, yoy));
      }
      if (x.rev) {
        if (x.ni != null) add("C", "순이익률 하이라이트 = 순이익 ÷ 매출", c, same(x.niM, pct(x.ni, x.rev)));
        if (x.ni != null) add("C", "순이익률 재무분석 = 순이익 ÷ 매출", c, same(A[c]?.niM ?? null, pct(x.ni, x.rev)));
        if (x.ebitda != null) add("C", "EBITDA 마진 하이라이트 = EBITDA ÷ 매출", c, same(x.ebitdaM, pct(x.ebitda, x.rev)));
        if (IS[c]?.op != null) add("C", "영업이익률 재무분석 = 영업이익 ÷ 매출", c, same(A[c]?.opM ?? null, pct(IS[c].op, x.rev)));
        if (x.mc != null && x.rev > 0) add("C", "PSR 하이라이트 = 시가총액 ÷ 매출", c, same(x.psr, x.mc / x.rev));
      }
    });
    // 개요(연간 = 최근 사업연도, TTM = LTM)·유니버스(LTM 열) — 앱이 실제로 계산한 값(verify-row)
    const lastFy = cols.filter((c) => c !== "LTM").at(-1);
    if (row && H.LTM) {
      const inp = row.overview?.multiples?.inputs ?? null, m = row.overview?.multiples ?? null, uv = row.universe && !row.universe.error ? row.universe : null, L0 = H.LTM;
      add("C", "매출 개요(TTM) = 하이라이트 LTM", "LTM", same(inp?.revenueTtm ?? null, L0.rev));
      if (lastFy) add("C", "매출 개요(연간) = 하이라이트 최근 사업연도", lastFy, same(inp?.revenueAnnual ?? null, H[lastFy].rev));
      if (m?.marketCap != null && L0.rev > 0) add("C", "PSR 개요 = 시가총액 ÷ LTM 매출", "LTM", same(m.psr ?? null, m.marketCap / L0.rev));
      if (uv) {
        add("C", "매출 유니버스(LTM) = 하이라이트 LTM", "LTM", same(uv.revenueAnnual ?? null, L0.rev));
        if (L0.rev && IS.LTM?.op != null) add("C", "영업이익률 유니버스 = LTM 영업이익 ÷ 매출", "LTM", same(uv.opMargin ?? null, IS.LTM.op / L0.rev));
        if (L0.rev && L0.ni != null) add("C", "순이익률 유니버스 = LTM 순이익 ÷ 매출", "LTM", same(uv.netMargin ?? null, L0.ni / L0.rev));
      }
    }
    // 분기 — 손익계산서 분기 열(최근 5개, Q4 = 사업연도 − 9개월)
    const QP = isq?.periods ?? [], QV = revRow(isq), SMQ = revRow(smq);
    for (const p of QP) {
      add("C", "분기 매출 손익계산서 = 총괄", p.label, same(SMQ[p.label] ?? null, QV[p.label] ?? null));
      if (foreign) continue;
      const e = revFace?.quarterAt(p.endDate, p.fiscalQuarter === 4) ?? null;
      add("A", p.fiscalQuarter === 4 ? "분기 매출 앱 = SEC 매출(Q4 = 사업연도 − 9개월)" : "분기 매출 앱 = SEC 매출(3개월)", p.label,
        !revFace ? { status: NA, note: revFaceWhy } : vsSource(QV[p.label] ?? null, e?.v ?? null, EXACT, e?.how ?? "읽은 공시(10-Q 4건·10-K 3건) 범위 밖"));
    }
    // R4 판정 — 앱 차이(dApp)가 SEC 본표 매출의 (분기 합 − 누적)과 정확히 같은가
    const secQ = (p) => (foreign ? null : revFace?.quarterAt(p.endDate, p.fiscalQuarter === 4) ?? null);
    const r4 = (name, col, sumApp, total, qs, secTotal) => {
      const r0 = same(sumApp, total);
      if (r0.status !== FAIL || sumApp == null || total == null) return add("D", name, col, r0);
      const parts = qs.map(secQ);
      if (secTotal == null || parts.some((x) => x == null)) return add("D", name, col, { ...r0, note: `${r0.note} · SEC 분기·누적 대응값 없음(R4 판정 불가)` });
      const dSec = parts.reduce((t, x) => t + x.v, 0) - secTotal.v, dApp = sumApp - total;
      add("D", name, col, Math.abs(dSec - dApp) <= 0.5 && dSec !== 0
        ? { status: PASS, note: `R4 반올림 차 — 앱 분기 합 − ${col === "LTM" ? "LTM" : "연간"} = ${dApp} = SEC 본표 3개월값 합 − 누적값 ${dSec}(공시값 자체의 반올림)` }
        : { status: FAIL, note: `${r0.note} · 앱 차 ${dApp} ≠ SEC(분기 합 − 누적) ${dSec}` });
    };
    let fullYears = 0;
    for (const fy of new Set(QP.map((p) => p.fiscalYear))) {
      const qs = QP.filter((p) => p.fiscalYear === fy);
      if (new Set(qs.map((p) => p.fiscalQuarter)).size !== 4 || qs.length !== 4) continue;
      fullYears++;
      const q4 = qs.find((p) => p.fiscalQuarter === 4);
      const col = cols.find((c) => c !== "LTM" && dayDiff(H[c].date, q4.endDate) <= 7);
      const sumApp = qs.every((p) => QV[p.label] != null) ? qs.reduce((t, p) => t + QV[p.label], 0) : null;
      if (!col) { add("D", "분기 4개 합 = 연간 매출", `FY${fy}`, { status: NA, note: `연도 열 없음(Q4 결산일 ${q4.endDate})` }); continue; }
      r4("분기 4개 합 = 연간 매출", col, sumApp, H[col].rev, qs, foreign ? null : revFace?.annualAt(H[col].date) ?? null);
    }
    if (QP.length && !fullYears) add("D", "분기 4개 합 = 연간 매출", "-", { status: NA, note: `앱 분기 열(${QP.map((p) => p.label).join(",")})에 한 사업연도 4개 분기가 다 있지 않음` });
    if (H.LTM && QP.length) {
      const last4 = QP.filter((p) => p.endDate <= H.LTM.date || dayDiff(p.endDate, H.LTM.date) <= 7).slice(-4);
      const ok = last4.length === 4 && dayDiff(last4[3].endDate, H.LTM.date) <= 7 && last4.every((p, k) => k === 0 || (dayDiff(p.endDate, last4[k - 1].endDate) >= 80 && dayDiff(p.endDate, last4[k - 1].endDate) <= 100));
      if (!ok) add("D", "LTM 매출 = 최근 4분기 합", "LTM", { status: NA, note: `LTM 기준일 ${H.LTM.date} 로 끝나는 연속 4분기가 앱 분기 열에 없음` });
      else r4("LTM 매출 = 최근 4분기 합", "LTM", last4.every((p) => QV[p.label] != null) ? last4.reduce((t, p) => t + QV[p.label], 0) : null, H.LTM.rev, last4, foreign ? null : revFace?.ltmAt(H.LTM.date) ?? null);
    }
  }

  // ── D. 손익 항등식 — 연간 전 열(감사 2026-09-25: LTM 만 보던 것을 확장). 매출총이익 = 매출 − 매출원가, 세전이익 = 영업이익 − 영업외손익.
  // 회사 공시값 자체가 반올림만큼 어기는 경우(GEV 형)는 SEC 10-K 값으로 같은 차이가 정확히 재현될 때만 검증불가·검토 목록(LTM 과 같은 규칙).
  // LTM 열은 아래 LTM 블록(SEC TTM 으로 같은 예외)
  {
    const isRows = is?.sections?.flatMap((s) => s.items ?? []) ?? [];
    const cv = (name, key) => isRows.find((x) => x.accountName === name)?.values?.[key] ?? null;
    const cogsTags = ["CostOfRevenue", "CostOfGoodsAndServicesSold"];
    for (const per of is?.periods ?? []) {
      if (per.label === "현재/LTM") continue;
      const key = per.label, col = key.replace(/^FY(\d{4})$/, "$1Y");
      const rev = cv("매출액", key) ?? cv("순수익", key), cogs = cv("(−) 매출원가", key), gp = cv("매출총이익", key);
      if (rev == null || cogs == null || gp == null) continue;
      let r0 = same(gp, rev - cogs);
      if (r0.status === FAIL && !foreign && per.endDate) {
        const at = (tags) => tags.map((t) => atEnd(ann(t), per.endDate)).find(Boolean) ?? null;
        const sRev = at(REV_TAGS), sCogs = at(cogsTags), sGp = at(["GrossProfit"]);
        const dApp = gp - (rev - cogs), dSec = sRev && sCogs && sGp ? sGp.val - (sRev.val - sCogs.val) : null;
        if (dSec != null && Math.abs(dApp - dSec) <= 0.5 && Math.abs(gp - sGp.val) <= 0.5) {
          r0 = { status: NA, note: `공시 자체 불일치 — SEC 10-K 매출총이익 ${sGp.val} − (매출 ${sRev.val} − 원가 ${sCogs.val}) = ${dSec}, 앱 차이 ${dApp} 와 같음(회사 공시 반올림)` };
          review.push({ item: `${col} 매출총이익 ≠ 매출 − 원가(회사 공시 자체)`, note: r0.note });
        }
      }
      add("D", "매출총이익 = 매출액 − 매출원가", col, r0);
    }
  }

  // ── D. fin 조립 항등식 불성립(architecture.md Gap.IDENTITY — 감사 2026-09-25) — 앱 손익계산서 응답의 finIssues.
  // 매출 줄이 걸린 불성립(그 열 매출을 앱이 비웠음)은 FAIL, 매출과 무관한 줄은 "다음 지표 미결" 검토 목록. BASIS_SHIFT 등 gaps 도 목록화
  {
    const fi = is?.finIssues ?? [];
    for (const q of fi) {
      if (q.rev?.length) add("D", "fin 조립 항등식(매출 경로)", q.col, { status: FAIL, note: `매출 줄이 걸린 조립 항등식 불성립 — 앱이 이 열 매출을 비움: ${q.rev.join("; ")}` });
      if (q.other?.length || q.gaps?.some((g) => g !== "IDENTITY"))
        review.push({ item: `${q.col} fin 조립 미결(다음 지표)`, note: `gaps[${(q.gaps ?? []).join("·")}]${q.other?.length ? ` · 매출 외 줄 항등식 불성립(매출 값 유지): ${q.other.join("; ")}` : ""}` });
    }
    if (is && !fi.some((q) => q.rev?.length)) add("D", "fin 조립 항등식(매출 경로)", "-", { status: PASS, note: fi.length ? `매출 경로 불성립 없음(미결 ${fi.length}열은 검토 목록)` : "미완전 열 없음" });
  }

  // ── D. LTM 열 일관성(감사 결함 3 연계, 2026-09-25) — 인포맥스 분기로 LTM 손익 일부를 채우는 외화 공시(TSM·ASML·SPOT)에서
  // LTM 매출총이익(SEC 연말) < 영업이익(인포맥스 최근 4분기)처럼 기간이 다른 구성요소가 한 열에 섞였다.
  if (H.LTM) {
    const isRows = is?.sections?.flatMap((s) => s.items ?? []) ?? [];
    const lv = (name) => isRows.find((x) => x.accountName === name)?.values?.["현재/LTM"] ?? null;
    const rev = lv("매출액") ?? lv("순수익"), cogs = lv("(−) 매출원가"), gp = lv("매출총이익"), op = IS.LTM?.op ?? null, nonop = lv("(−) 영업외손익"), pt = IS.LTM?.pretax ?? null;
    if (gp != null && op != null) add("D", "LTM 매출총이익 ≥ 영업이익", "LTM", gp >= op ? { status: PASS } : { status: FAIL, note: `매출총이익 ${gp} < 영업이익 ${op} — 구성요소 기간이 섞였을 가능성` });
    if (rev != null && cogs != null && gp != null) {
      let r0 = same(gp, rev - cogs);
      // 회사 공시값 자체가 이 항등식을 반올림만큼 어기는 경우(GEV: 2025 상반기 매출 17,143 − 원가 13,828 = 3,315 인데 매출총이익 3,316
      // 태깅) — SEC TTM 으로 같은 차이가 정확히 재현되면 앱 결함이 아니라 공시 자체 불일치(검증불가·검토 목록)
      if (r0.status === FAIL && !foreign) {
        const tt = (tags) => tags.map((t) => secTtm(t)).find((t) => t && dayDiff(t.end, H.LTM.date) <= 7) ?? null;
        const sRev = tt(REV_TAGS), sCogs = tt(["CostOfRevenue", "CostOfGoodsAndServicesSold"]), sGp = tt(["GrossProfit"]);
        const dApp = gp - (rev - cogs), dSec = sRev && sCogs && sGp ? sGp.v - (sRev.v - sCogs.v) : null;
        if (dSec != null && Math.abs(dApp - dSec) <= 0.5 && Math.abs(gp - sGp.v) <= 0.5) {
          r0 = { status: NA, note: `공시 자체 불일치 — SEC TTM 매출총이익 ${sGp.v} − (매출 ${sRev.v} − 원가 ${sCogs.v}) = ${dSec}, 앱 차이 ${dApp} 와 같음(회사 공시 반올림)` };
          review.push({ item: "LTM 매출총이익 ≠ 매출 − 원가(회사 공시 자체)", note: r0.note });
        }
      }
      add("D", "LTM 매출총이익 = 매출액 − 매출원가", "LTM", r0);
    }
    if (op != null && nonop != null && pt != null) add("D", "LTM 세전이익 = 영업이익 − 영업외손익", "LTM", same(pt, op - nonop));
    // 구성요소 기준일 — 하이라이트 LTM 열·재무상태표 LTM 기말·ttm 손익 기간(~날짜)·ttm 재무상태표 스냅샷·재무제표 source 의 ~날짜
    const iso = (s) => (/(\d{4}-\d{2}-\d{2})/.exec(s ?? "") ?? [])[1] ?? null;
    const dates = {
      "하이라이트 LTM 열": H.LTM.date,
      "재무상태표 LTM 기말": bs?.periods?.find((p) => p.label === "현재/LTM")?.endDate ?? null,
      "ttm 손익 기간": iso(/~\s*(\d{4}-\d{2}-\d{2})/.exec(fetched.tt?.ttm?.periodLabel ?? "")?.[1]),
      "ttm 재무상태표 스냅샷": iso(fetched.tt?.ttm?.snapshot?.label),
      "손익계산서 source": iso(/~\s*(\d{4}-\d{2}-\d{2})/.exec(is?.source ?? "")?.[1]),
    };
    const got = Object.entries(dates).filter(([, d]) => d);
    if (got.length >= 2) {
      const bad = got.some(([, d]) => dayDiff(d, got[0][1]) > 7);
      add("D", "LTM 구성요소 기준일 동일", "LTM", bad ? { status: FAIL, note: got.map(([k, d]) => `${k} ${d}`).join(" · ") } : { status: PASS, note: got.map(([k, d]) => `${k} ${d}`).join(" · ") });
    }
    // 조정 행(영업외·기타 등)이 인포맥스 분기 구성요소와 다른 출처(SEC 연말)에서 온 경우 — 앱이 notes 에 적은 인포맥스 대상 행 목록으로 판정
    const imList = (h.notes ?? []).map((n) => /현재\/LTM 열 ([^=]+?) = 인포맥스/.exec(n)?.[1]).find(Boolean);
    if (imList) {
      const im = new Set(imList.split("·").map((x) => x.trim()));
      const adj = [["(−) 매출원가", "매출원가"], ["매출총이익", "매출총이익"], ["(−) 영업외손익", "영업외손익"], ["세전이익", "세전이익"], ["(−) 법인세비용", "법인세비용"], ["(−) 기타", "기타"]]
        .filter(([row, k]) => !im.has(k) && lv(row) != null).map(([, k]) => k);
      add("D", "LTM 조정 행 기간 = 구성요소 기간", "LTM", adj.length ? { status: FAIL, note: `인포맥스 분기 합 행(${[...im].join("·")})과 다른 출처의 행이 같은 LTM 열에 있음: ${adj.join("·")}` } : { status: PASS, note: `인포맥스 분기 합 행만(${[...im].join("·")})` });
    }
  }

  if (fyDebtCheck) add("A", "20-F FY 총차입금 앱 = SEC 본표 차입금 + 리스(규칙 재구현)", fyDebtCheck.col, fyDebtCheck.r);

  // ── A. 20-F LTM(Yahoo 분기) 독립 재계산(감사 M1, 2026-09-25) — 앱이 "LTM 열 = Yahoo 분기"라고 밝힌 외화 공시(TSM·ASML·SPOT)는
  // 검증기가 Yahoo 분기 재무 + 일별 환율로 "최근 4개 분기 × 그 분기 평균 환율"(잔액은 최신 분기말 × 기말 환율)을 따로 계산해 정확 비교.
  // 원천(Yahoo)·환율(Yahoo)이 앱과 같아 공통모드 — 앱의 합산·환산 계산 오류를 잡는 검사이고 Yahoo 값 자체의 정합성은 보증하지 않는다.
  // 앱이 공란으로 둔 항목은 앱 notes 의 사유(Yahoo 연간 ≠ SEC FY)를 SEC 원본(검증기 판독)으로 따로 확인한다.
  const ltmYahooNote = (h.notes ?? []).find((n) => /LTM 열 = Yahoo 분기/.test(n));
  if (foreign && H.LTM && ltmYahooNote) {
    try {
      if (!fxRows) throw new Error(fxErr || "환율 없음");
      const yqq = await (await yahoo()).fundamentalsTimeSeries(sym, { period1: new Date(Date.parse(H.LTM.date) - 460 * 864e5), type: "quarterly", module: "all" }, { validateResult: false });
      const rows = yqq.map((r) => ({ ...r, end: new Date(r.date).toISOString().slice(0, 10) })).filter((r) => r.end <= H.LTM.date || dayDiff(r.end, H.LTM.date) <= 7).sort((a, b) => a.end.localeCompare(b.end));
      const last = rows.slice(-4);
      if (last.length !== 4 || dayDiff(last[3].end, H.LTM.date) > 7) add("A", "20-F LTM = Yahoo 분기 4개 × 분기 평균 환율", "LTM", { status: FAIL, note: `Yahoo 분기 4개(기준일 ${H.LTM.date})를 못 찾음 — ${last.map((r) => r.end).join(",")}` });
      else {
        const qStart = (e) => { const d = new Date(`${e}T00:00:00Z`); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 2, 1)).toISOString().slice(0, 10); };
        const avgR = last.map((r) => fxAvg(fxRows, qStart(r.end), r.end));
        const endR = fxRows.filter((q) => q.d <= last[3].end).at(-1)?.r ?? null;
        const flow = (k) => (last.every((r) => r[k] != null) ? last.reduce((t, r, i) => t + r[k] * avgR[i], 0) : null);
        const hv = (key) => h.rows.find((r) => r.key === key)?.values[h.columns.findIndex((cc) => cc.kind === "ltm")] ?? null;
        const isL = (name) => is?.sections?.flatMap((s0) => s0.items ?? []).find((x0) => x0.accountName === name)?.values?.["현재/LTM"] ?? null;
        const bsL = (name) => rowOf(bs, name)["현재/LTM"] ?? null;
        const blanks = /공란: (.+?)(?: · |$)/.exec(ltmYahooNote)?.[1] ?? "";
        const basis = `Yahoo 분기 ${last.map((r) => r.end).join("·")} × 분기 평균 환율(${natCur}→USD, Yahoo 일별 — 공통모드)`;
        const items = [
          ["매출", H.LTM.rev, flow("totalRevenue"), "totalRevenue"], ["매출원가", isL("(−) 매출원가"), flow("costOfRevenue"), "costOfRevenue"],
          ["매출총이익", isL("매출총이익"), flow("grossProfit"), "grossProfit"], ["영업이익", IS.LTM?.op ?? null, flow("totalOperatingIncomeAsReported"), "totalOperatingIncomeAsReported"],
          ["순이익", H.LTM.ni, flow("netIncome"), "netIncome"], ["감가상각비", IS.LTM?.da ?? null, flow("reconciledDepreciation"), "reconciledDepreciation"],
          ["영업활동 현금흐름", hv("ocf"), flow("operatingCashFlow"), "operatingCashFlow"], ["CapEx", hv("capex"), flow("capitalExpenditure"), "capitalExpenditure"],
        ];
        const bals = [
          ["자산 총계", bsL("자산 총계"), "totalAssets"], ["부채 총계", bsL("부채 총계"), "totalLiabilitiesNetMinorityInterest"],
          ["자본 총계", bsL("자본 총계"), "stockholdersEquity"], ["현금·현금성자산", bsL("현금·현금성자산"), "cashAndCashEquivalents"],
          ["유동자산 총계", bsL("유동자산 총계"), "currentAssets"], ["유동부채 총계", bsL("유동부채 총계"), "currentLiabilities"],
        ].map(([n0, app, k]) => [n0, app, last[3][k] != null && endR != null ? last[3][k] * endR : null, k]);
        let secFy = null; // 공란 사유 확인용 SEC FY(원통화) — 필요할 때만 판독
        const fyCol = Object.keys(H).filter((cc) => cc !== "LTM").sort((a, b) => H[a].date.localeCompare(H[b].date)).at(-1);
        for (const [n0, app, exp, k] of [...items, ...bals]) {
          const name = `20-F LTM ${n0} = Yahoo 분기${bals.some((b) => b[0] === n0) ? " 최신 분기말 × 기말 환율" : " 4개 × 분기 평균 환율"}`;
          if (app != null) { add("A", name, "LTM", exp == null ? { status: FAIL, note: `앱 ${app} 있는데 Yahoo ${k} 없음` } : vsSource(app, exp, EXACT, basis)); continue; }
          if (exp == null) { add("A", name, "LTM", { status: NA, note: `양쪽 빈칸(Yahoo ${k} 없음)` }); continue; }
          // 앱 공란 — notes 에 사유가 적힌 항목만, 사유(Yahoo 연간 ≠ SEC FY)를 SEC 원본으로 확인
          if (!blanks.includes(n0)) { add("A", name, "LTM", { status: FAIL, note: `Yahoo ${k} ${exp} 있는데 앱 공란(사유 없음)` }); continue; }
          if (n0 !== "CapEx") { add("A", name, "LTM", { status: NA, note: `앱 공란(사유 "${n0}") — SEC 대응 태그 독립 판독 미구현` }); continue; }
          secFy ??= fyCol ? await filingAtDate(cik, sub, H[fyCol].date) : null;
          const cap = secFy?.durFacts.filter((x0) => !x0.dims.length && /PurchaseOfPropertyPlantAndEquipment|PaymentsToAcquirePropertyPlantAndEquipment/.test(x0.id) && (Date.parse(x0.end) - Date.parse(x0.start)) / 864e5 > 300).sort((a, b) => Math.abs(b.v) - Math.abs(a.v))[0];
          const ya = await (await yahoo()).fundamentalsTimeSeries(sym, { period1: "2018-01-01", type: "annual", module: "cash-flow" }, { validateResult: false });
          const yr = ya.find((r) => r.capitalExpenditure != null && dayDiff(new Date(r.date).toISOString().slice(0, 10), H[fyCol].date) <= 7);
          if (!cap || !yr) { add("A", name, "LTM", { status: FAIL, note: `앱 공란 사유(CapEx: Yahoo 연간 ≠ SEC FY) 확인 불가 — SEC ${cap ? "있음" : "없음"}·Yahoo ${yr ? "있음" : "없음"}` }); continue; }
          const d = Math.abs(Math.abs(yr.capitalExpenditure) - Math.abs(cap.v));
          add("A", name, "LTM", d > secUnitAny(cap.v) / 2 ? { status: NA, note: `앱 공란 — 사유 확인: Yahoo ${fyCol} CapEx ${Math.abs(yr.capitalExpenditure)} ≠ SEC ${secFy.form} ${cap.id.replace(/^[a-z-]+_/, "")} ${Math.abs(cap.v)} ${natCur}(정의 차이)` }
            : { status: FAIL, note: `앱 공란인데 Yahoo ${fyCol} CapEx ${Math.abs(yr.capitalExpenditure)} = SEC ${Math.abs(cap.v)} — 사유 불성립` });
        }
      }
    } catch (e) {
      hardErrors.push(`20-F LTM 독립 재계산(Yahoo 분기·환율) 조회 실패: ${String(e).slice(0, 60)}`);
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
    // StockAnalysis 현금흐름표 "기타 상각"(otherAmortization, 기간별) — 원인 판정 ⑦ 용
    const saOtherAmort = new Map();
    // StockAnalysis 손익 조정 항목(기간별) — 원인 R7(합성 영업이익 회사의 SA 영업이익 분류) 용
    const saIsAdj = new Map();
    let saUnitIs = 1e6;
    // StockAnalysis 연간 재무상태표 결산일 보통주 주식수(sharesOutTotalCommon) — 인포맥스 시가총액 "외부 단독 이탈" 판정용
    const saYearEndShares = new Map();
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
    // 감사 M1: 외화 공시는 Yahoo 가 원통화라 USD 앱 값과 직접 비교하지 않는다(환산 비교는 A층 "20-F LTM" 검사가 한다)
    for (const [c, x] of Object.entries(H)) {
      if (c === "LTM" || foreign) continue;
      const r = ya.find((r) => dayDiff(iso(r.date), x.date) <= 7);
      if (!r) continue;
      put(`${c} 매출`, x.rev, "Yahoo", r.totalRevenue);
      put(`${c} 순이익`, x.ni, "Yahoo", r.netIncome ?? r.netIncomeCommonStockholders);
      put(`${c} EBITDA`, x.ebitda, "Yahoo", yEbitda(r));
      put(`${c} 영업이익`, IS[c]?.op, "Yahoo", r.totalOperatingIncomeAsReported);
      put(`${c} 감가상각비`, IS[c]?.da, "Yahoo", r.reconciledDepreciation);
    }
    const last4 = foreign ? [] : yq.filter((r) => r.totalOperatingIncomeAsReported != null).slice(-4);
    if (last4.length === 4 && dayDiff(iso(last4.at(-1).date), L.date) <= 7) {
      if (last4.every((r) => yEbitda(r) != null)) put("LTM EBITDA", L.ebitda, "Yahoo", last4.reduce((s, r) => s + yEbitda(r), 0));
      if (last4.every((r) => r.totalRevenue != null)) put("LTM 매출", L.rev, "Yahoo", last4.reduce((s, r) => s + r.totalRevenue, 0));
    }
    const bsq = yq.filter((r) => r.totalDebt != null).at(-1);
    if (bsq && !foreign && dayDiff(iso(bsq.date), L.date) <= 7) put("LTM 총차입금(운용리스 포함)", withLease, "Yahoo", bsq.totalDebt);

    // StockAnalysis — TTM 은 최근 분기말이 앱 LTM 기준일과 같을 때만
    if (!foreign) {
      try {
        const bq = await saStatement(sym, "balance-sheet", true);
        const qEnd = bq.datekey.find((d) => d !== "TTM");
        const ttmOk = qEnd && dayDiff(qEnd, L.date) <= 7;
        if (ttmOk) put("LTM 총차입금(운용리스 포함)", withLease, "StockAnalysis", bq.debt?.[bq.datekey.indexOf(qEnd)]);
        const ba = await saStatement(sym, "balance-sheet");
        for (const [c, x] of Object.entries(H)) {
          if (c === "LTM") continue;
          const k = ba.datekey.findIndex((d) => d !== "TTM" && dayDiff(d, x.date) <= 7);
          if (k >= 0 && ba.sharesOutTotalCommon?.[k] != null) saYearEndShares.set(c, ba.sharesOutTotalCommon[k]);
        }
        const inc = await saStatement(sym, "income-statement");
        // 보고 단위 — 대형주는 백만, 그 외는 천 단위(TER). 값이 모두 백만의 배수면 백만
        const saUnit = [inc.revenue, inc.netinc, inc.opinc].flat().every((v) => v == null || v % 1e6 === 0) ? 1e6 : 1e3;
        for (const [c, x] of Object.entries(H)) {
          const k = c === "LTM" ? (ttmOk ? inc.datekey.indexOf("TTM") : -1) : inc.datekey.findIndex((d) => d !== "TTM" && dayDiff(d, x.date) <= 7);
          if (k < 0) continue;
          put(`${c} 매출`, x.rev, "StockAnalysis", inc.revenue?.[k], saUnit);
          put(`${c} 순이익`, x.ni, "StockAnalysis", inc.netinc?.[k], saUnit);
          put(`${c} EBITDA`, x.ebitda, "StockAnalysis", inc.ebitda?.[k], saUnit);
          put(`${c} 영업이익`, IS[c]?.op, "StockAnalysis", inc.opinc?.[k], saUnit);
          put(`${c} 감가상각비`, IS[c]?.da, "StockAnalysis", inc.depAmorEbitda?.[k], saUnit);
          saIsAdj.set(c, { aw: inc.assetWritedown?.[k] ?? 0, mr: inc.mergerRestructureCharges?.[k] ?? 0, ou: inc.otherUnusualItems?.[k] ?? 0, orv: inc.otherRevenue?.[k] ?? 0, opRev: inc.operatingRevenue?.[k] ?? null, ga: inc.gainAssets?.[k] ?? 0, cg: inc.currencyGains?.[k] ?? 0 });
          saUnitIs = saUnit;
        }
        // 현금흐름표의 기타 상각 줄 — StockAnalysis 는 이 줄을 EBITDA 용 감가상각(depAmorEbitda)에서 뺀다(원인 ⑦)
        const cfs = await saStatement(sym, "cash-flow-statement");
        for (const [c, x] of Object.entries(H)) {
          const k = c === "LTM" ? (ttmOk ? cfs.datekey.indexOf("TTM") : -1) : cfs.datekey.findIndex((d) => d !== "TTM" && dayDiff(d, x.date) <= 7);
          if (k >= 0 && cfs.otherAmortization?.[k] != null) saOtherAmort.set(c, cfs.otherAmortization[k]);
        }
      } catch (e) {
        errs.push(`StockAnalysis: ${String(e).slice(0, 80)}`);
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
    // 근거로 쓰는 A층은 허용치 없는 정확 대조(EXACT)만 — EPS(분할 반올림 허용)·금융사 근사식(앱 정의 재계산)은 제외(재감사)
    const EXACT_A = { 영업이익: /^영업이익 앱 = SEC 영업이익$/, 매출: /^매출 앱 = SEC 매출$/, 순이익: /^(LTM )?순이익 앱 = SEC/, 자산총계: /^자산총계 앱 = SEC/ };
    const aPassed = (col, metric) => EXACT_A[metric] && checks.some((k) => k.col === col && k.status === PASS && EXACT_A[metric].test(k.name));
    const causeOf = (r, n, done) => {
      const col = r.item.split(" ")[0];
      const metric = r.item.slice(col.length + 1);
      const item0 = r.item;
      const v = r.srcs[n].v, unit = r.srcs[n].unit;
      const within = (d) => Math.abs(d) <= unit; // 소스의 보고 단위 안(재감사 — 예전엔 최소 100만)
      // 새 원인 규칙(R1~R6)은 SEC 원자료(정밀값)와 외부 값 하나를 비교하므로 외부 보고 단위의 절반만 허용(반올림 한 번)
      const withinH = (d) => Math.abs(d) <= unit / 2 + Math.abs(v) * 1e-12;
      // ① 외부가 일회성 항목을 뺀 조정값 — 차이가 앱 일회성비용 행과 같다
      const oneOff = /^(영업이익|EBITDA)$/.test(metric) ? IS[col]?.oneOff : null;
      if (oneOff != null && oneOff !== 0 && within(v - r.ours - oneOff)) return { ok: "일회성 항목 조정 — 차이 = 앱 일회성비용" };
      // ② 외화 공시의 Yahoo 는 원통화 — 같은 해 두 지표에서 "앱 ÷ Yahoo" 비율(=환율)이 같다
      if (foreign && n === "Yahoo") {
        const other = ["매출", "순이익", "영업이익"].filter((m) => m !== metric).map((m) => recon.get(`${col} ${m}`)).find((x) => x?.srcs.Yahoo?.v);
        if (other) {
          const k1 = r.ours / v, k2 = other.ours / other.srcs.Yahoo.v;
          // 허용치(1e-6) 대신 보고 단위(2026-09-25): 다른 지표의 비율로 환산한 값이 Yahoo 값과 두 Yahoo 값의 보고 단위 반올림 안에서 같다
          const ov = other.srcs.Yahoo.v, bound = secUnit(Math.abs(Math.round(v))) / 2 + Math.abs(v) * (secUnit(Math.abs(Math.round(ov))) / 2) / Math.abs(ov);
          if (Math.abs(r.ours / k2 - v) <= bound && Math.abs(k1 - 1) > 1e-3) return { ok: `Yahoo 원통화 표시 — 앱÷Yahoo 비율 ${k1.toPrecision(6)} 이 ${other.item} 과 같음(환율)` };
        }
      }
      // ⑨ 인포맥스 희석 EPS = SEC 순이익 ÷ SEC 희석 가중평균주식수(소수 넷째 자리, ±0.00005) — 인포맥스는 공시 EPS 가 아니라
      //    자체 계산한다(실측: AMAT 2021·CEG·DAL·HLT·MU 2022·PEP 2021 최신 공시 순이익, WDC 2022·DELL 2024 최초 공시 순이익).
      //    앱 EPS 가 A층 SEC 공시 EPS 대조를 통과한 기간만. 공통모드 아님 — SEC 원자료로 인포맥스 값을 독립 재현.
      //    A층 EPS 는 이제 정확 비교(상대 1e-9)지만, 인스턴스(클래스별) 경로도 같은 이름을 쓰므로 여기서 다시 공시 희석 EPS(분할
      //    보정) 또는 계속+중단영업 합과 **정확히** 같은지 확인한다(예전 허용치 0.006 + 0.3% 시절 MU 2024 0.70×1.01 주입이 통과했던 경로).
      const epsExact = (() => {
        if (!H[col]?.date || r.ours == null) return false;
        const e = atEnd(epsP, H[col].date), cd = e ? null : contDiscEps(H[col].date);
        const exp = e ? e.val / splitAdj(e) : cd ? (cd.cont + cd.disc) / splitAdj({ end: H[col].date, filed: cd.filed }) : null;
        return exp != null && Math.abs(r.ours - exp) <= 1e-9 * Math.max(1, Math.abs(exp));
      })();
      if (metric === "희석 EPS" && n === "인포맥스" && col !== "LTM" && epsExact && !splitErr
        && checks.some((k) => k.col === col && k.status === PASS && k.name === "EPS 앱 = SEC 공시 EPS(분할 보정)")) {
        const niL = annualAllAt("NetIncomeLoss", "USD", H[col].date);
        const sh = annualAllAt("WeightedAverageNumberOfDilutedSharesOutstanding", "shares", H[col].date).at(-1);
        if (sh?.val) {
          const k = splitAdj(sh); // 희석주식수 공시 뒤 분할 → 오늘 주식 기준
          for (const [lab, ni] of [["최신 공시", niL.at(-1)], ["최초 공시", niL[0]]]) {
            if (!ni) continue;
            const q = ni.val / (sh.val * k);
            if (Math.abs(q - v) <= 5e-5) return { ok: `인포맥스는 순이익 ÷ 희석주식수로 자체 계산(공시 EPS 아님) — SEC 순이익(${lab} ${ni.filed}) ${ni.val} ÷ 희석 가중평균 ${sh.val}${k !== 1 ? `×분할 ${k}` : ""} = ${q.toFixed(4)}, 앱 EPS = SEC 공시 EPS 정확 일치(A층 통과) · 공통모드 아님(SEC 원자료로 독립 재현)` };
          }
        }
      }
      // ⑩ 인포맥스 결산일 시가총액 ÷ 결산일 실제 종가 = 앱 직전 연도 결산일 주식수(±5천 주) — 인포맥스가 전년도 주식수를 쓴다
      //    (실측 MCD 2022·2023, MU 2022). 앱 그 해·직전 연도 주식수가 둘 다 A층 SEC 본표 주식수와 일치한 경우만.
      //    그 해 앱 = SEC 본표 = StockAnalysis(SEC 공시 단위 안)인데 인포맥스만 다르면 원인 확인이 아니라 "외부 단독 이탈"(PLTR 2021).
      if (metric === "시가총액(결산일)" && n === "인포맥스" && col !== "LTM" && sharesPassed(col)) {
        const px = actualClose(H[col].date), mine = appShares(col);
        if (px && mine) {
          // 인포맥스 시총 = 주식수 × 센트 단위 종가로 보인다(MCD 2022: 744,800,000 × 263.53 = 196,277,144,000 정확히) — Yahoo
          // 종가의 부동소수(263.5299987…)를 센트로 되돌려 나눈다. 허용 = 인포맥스 시총 보고 단위의 절반 ÷ 종가(주 단위 반올림)
          const pxC = Math.round(px * 100) / 100;
          const imSh = v / pxC, imTol = Math.max(secUnit(Math.round(v)) / 2 / pxC, 0.5);
          const gap = (p) => (Date.parse(H[col].date) - Date.parse(H[p].date)) / 864e5;
          const prev = Object.keys(H).find((p) => p !== "LTM" && gap(p) >= 330 && gap(p) <= 400);
          // 직전 연도 주식수: 앱 열이 있으면 그 열(A층 통과일 때만), 앱 열이 없으면(첫 열) SEC 본표 전년 결산일 값을 직접
          const secPrev = prev ? null : secYearEndShares(new Date(Date.parse(H[col].date) - 365 * 864e5).toISOString().slice(0, 10), 10);
          const ps = prev ? (sharesPassed(prev) ? appShares(prev) : null) : secPrev?.v ?? null;
          const psLab = prev ? `앱 ${prev} 주식수(= SEC 본표, A층 통과)` : `SEC 본표 전년 결산일 주식수 ${secPrev?.how ?? ""}(앱 열 없음)`;
          if (ps != null && Math.abs(imSh - ps) <= imTol)
            return { ok: `인포맥스가 전년도 주식수 사용 — 인포맥스 시총 ÷ 결산일 실제 종가 ${pxC} = ${imSh.toFixed(1)}주 = ${psLab} ${ps.toFixed(0)}주, 앱 ${col} 주식수 = SEC 본표(A층 통과 — 후보 순서 재구현, 공통모드)` };
          const sa = saYearEndShares.get(col), unit = secUnit(Math.round(mine));
          // 인포맥스 = StockAnalysis 인데 앱만 다르면(CAT 2021~2025: 둘 다 535,888,051 = 발행 − 자기주식, 앱 535,900,000 = 본표 유통주식수
          // 10만 주 반올림) 외부 탓이 아니다 — 정의차(앱 = 본표 반올림값, 외부 = 정확 주식수) 또는 앱 결함 후보. 원인(causes)에 넣지 않는다.
          if (sa != null && Math.abs(imSh - sa) <= imTol && Math.abs(sa - mine) > 0.5)
            return { defdiff: `정의차(앱 결함 후보) — 인포맥스 시총 ÷ 실제 종가 ${pxC} = ${imSh.toFixed(1)}주 = StockAnalysis ${sa}(정확 주식수), 앱 ${mine.toFixed(0)}주 = SEC 본표 반올림값(공시 단위 ${unit})` };
          // 전년도 주식수로도 설명되지 않음이 확인될 때만(전년 값을 모르면 분류하지 않는다 — MCD 2021 처럼 전년도 원인이 가려질 수 있다).
          // 인포맥스가 StockAnalysis 와도 달라야 한다(감사 — 외부 두 곳이 같은 값이면 "외부 단독"이 아니다)
          if (ps != null && sa != null && Math.abs(sa - mine) <= unit / 2 && Math.abs(imSh - mine) > imTol && Math.abs(imSh - sa) > imTol)
            return { outlier: `외부 단독 이탈(앱=SEC 본표) — 앱 주식수 ${mine.toFixed(0)} = SEC 본표(A층 통과) = StockAnalysis ${sa}(SEC 공시 단위 ${unit} 안), 인포맥스 시총 ÷ 실제 종가 ${pxC} = ${imSh.toFixed(1)}주 ≠ 전년도 ${ps.toFixed(0)}주` };
        }
      }
      // R1 Yahoo 총차입금 = SEC 본표 차입금·리스 줄 합(최신 정기공시 계산 구조). 앱(운용리스 포함) = 본표 줄 합 + 주석 유동 차입금
      //    + 주석 금융리스 + 본표 밖 운용리스 가 SEC 값으로 정확히(1달러) 성립할 때만 — 공통모드(본표 차입금 줄 선택은 앱과 같은 성격의
      //    규칙 재구현). 종목별 식: DAL(Yahoo 가 본표 ShortTermNonBankLoansAndNotesPayable 을 뺌)·SNDK(본표 밖 비유동 운용리스를 넣음).
      if (item0 === "LTM 총차입금(운용리스 포함)" && n === "Yahoo" && debtDec?.appOk) {
        const d = debtDec;
        const variants = [["", d.faceSum]];
        if (sym === "DAL") { const x = d.val0("us-gaap_ShortTermNonBankLoansAndNotesPayable"); if (x != null && d.onFace("us-gaap_ShortTermNonBankLoansAndNotesPayable")) variants.push(["종목별 식(DAL): Yahoo 는 본표 ShortTermNonBankLoansAndNotesPayable 제외", d.faceSum - x]); }
        if (sym === "SNDK") { const x = d.val0("us-gaap_OperatingLeaseLiabilityNoncurrent"); if (x != null && !d.onFace("us-gaap_OperatingLeaseLiabilityNoncurrent")) variants.push(["종목별 식(SNDK): Yahoo 는 본표 밖 비유동 운용리스 포함", d.faceSum + x]); }
        for (const [how, exp] of variants)
          if (withinH(v - exp)) return { ok: `Yahoo 총차입금 = SEC 본표 차입금·리스 줄 합 ${exp}(${d.fl.form} ${d.fl.date}: ${d.faceVals.map((x) => `${d.nm(x.id)} ${x.v}`).join(" + ")})${how ? ` · ${how}` : ""} — 앱 = 본표 합 + ${d.off.map((x) => `${x.why} ${d.nm(x.id)} ${x.v}`).join(" + ") || "없음"} (SEC 값으로 정확 성립) · 공통모드(본표 줄 선택 규칙 재구현)` };
      }
      // R2·R3 StockAnalysis 총차입금 = 앱 + 금리·통화금리 파생상품 부채(R2) + 본표 밖 회사 고유 금융 의무(R3, AMZN). 앱 차입금이
      //    SEC 본표·주석 값으로 정확히 분해될 때(R1 과 같은 전제)만 원인 확인, 아니면 추정. 파생상품 값이 금리 외 멤버에도 있으면 추정.
      if (item0 === "LTM 총차입금(운용리스 포함)" && n === "StockAnalysis" && (irDeriv || finOblig)) {
        const parts = [irDeriv && irDeriv.add !== 0 && [`금리 파생상품 부채 ${irDeriv.add}(${irDeriv.how}: ${irDeriv.members.join("·")})`, irDeriv.add], finOblig && [`본표 밖 금융 의무 ${finOblig.sum}(${finOblig.ids.join(" + ")})`, finOblig.sum]].filter(Boolean);
        for (let mask = 1; mask < 1 << parts.length; mask++) {
          const use = parts.filter((_, i) => mask & (1 << i)), add = use.reduce((t, x) => t + x[1], 0);
          if (!withinH(v - r.ours - add)) continue;
          const txt = `StockAnalysis 총차입금 = 앱 + ${use.map((x) => x[0]).join(" + ")}`;
          const dup = use.some((x) => x[0].startsWith("금리") && irDeriv.dup);
          return debtDec?.appOk && !dup ? { ok: `${txt} · 앱 = SEC 본표·주석 분해 정확 성립 · 공통모드 아님(파생상품·금융 의무는 SEC 원본값)` }
            : { guess: `${txt}${dup ? " — 같은 값이 금리 외 파생상품 멤버에도 있어 확정 못 함" : " — 앱 차입금 SEC 분해 미확인"}` };
        }
      }
      // R5·R6 연간 매출 차원 분해 — 인포맥스: Revenues − 현금흐름위험회피 AOCI 재분류분(NFLX), 또는 Σ 사업부문 고객계약 매출(GOOG, 잔여
      //    +100 은 성립 안 함 → 미해명). StockAnalysis(호텔 HLT·MAR): Revenues − 비용 환급 매출(ProductOrServiceAxis = …Reimburs…).
      //    전제: 앱 매출 = SEC(A층 정확 일치). 공통모드 아님(10-K 원본 차원값).
      // R6' 외부 = SEC 에 실제로 있는 반올림 재태깅 값(MCD 2022·2023 StockAnalysis 23,183·25,494 — 나중 10-K 가 과거 정밀값
      //    23,182.6·25,493.7 을 백만 단위로 다시 태깅). 앱은 dropRoundedRetags 로 먼저 공시된 정밀값을 쓴다(revenue.md R6).
      // R9 외부 = 그 기간을 담은 최신 10-K 의 본표 매출 하위 줄 합(회사가 줄마다 반올림해 하위 합 ≠ 합계 줄). MCD Yahoo 23,182 =
      //    14,106 + 8,748 + 328(2024 10-K, 합계 줄 23,183), IBM 2021 57,351 = 29,225 + 27,346 + 780(합계 줄 57,350).
      //    둘 다 SEC 사실값으로 외부 값을 정확히(보고 단위 반올림 없이) 재현할 때만. 공통모드 아님(10-K 원본 값).
      if (metric === "매출" && col !== "LTM" && aPassed(col, "매출") && H[col]?.date) {
        const sr = revFace?.annualAt(H[col].date);
        if (sr?.retag && Math.abs(v - sr.retag.val) <= 0.5)
          return { ok: `${n} 매출 = SEC 반올림 재태깅 값 ${sr.retag.val}(${sr.retag.filed} 공시, ${sr.retag.unit} 단위) — 앱 = 먼저 공시된 정밀값 ${sr.v}(반올림 재태깅 제외, A층 정확 일치) · 공통모드 아님(SEC 사실값)` };
        const p = [...(revParts ?? new Map())].find(([end]) => dayDiff(end, H[col].date) <= 7)?.[1];
        for (const [how, s] of p?.sums ?? []) if (Math.abs(v - s) <= 0.5)
          return { ok: `${n} 매출 = 본표 매출 하위 줄 합 ${s}(${p.src} ${how}) — 합계 줄 ${p.total} 과 회사 반올림 차 ${s - p.total}, 앱 = SEC 본표 합계(A층 정확 일치) · 공통모드 아님(10-K 원본 값)` };
      }
      if (metric === "매출" && col !== "LTM" && revDims && aPassed(col, "매출") && H[col]?.date) {
        // 기존 규칙(R3·R5·R8 AOCI 축·호텔 환급)은 최근 10-K 3건만(fi ≤ 3) — 옛 10-K 를 섞으면 같은 성분이 다른 멤버명으로 두 번 잡힌다
        const atAll = revDims.filter((x) => dayDiff(x.end, H[col].date) <= 7);
        const at = atAll.filter((x) => x.fi <= 3);
        const tot = at.find((x) => x.id === "Revenues" && !x.dims.length)?.v;
        const one = (pred) => at.filter((x) => x.dims.length >= 1 && pred(x.dims));
        const cands = [];
        // R8 확장 — 인포맥스 매출 = SEC 본표 매출 − 매출 줄에 인식된 파생상품 손익(현금흐름위험회피 재분류 cf · 비지정 파생상품 nd)
        //    − 매출 줄 차감 상각(제품·서비스 차원 …Amortization… 멤버 am). 손익계산서 위치 차원(IncomeStatementLocationAxis)이 매출·판매
        //    멤버인 사실만. 실측: AMAT 2021(cf 4)·PEP 2021(cf −6)·SBUX 2021(cf 1.8)·LRCX 2022(cf 45.057)·CAT 2021(cf −13)·
        //    KO 2021~2023(cf + nd)·XOM 2021~2023(nd)·VST 2021~2023(nd + am). 조합 중 하나가 정확히(인포맥스 보고 단위 반올림 안) 성립할 때만.
        if (n === "인포맥스") {
          const cf = revDerivFamily(atAll, "cf"), nd = revDerivFamily(atAll, "nd");
          // 매출 차감 상각 멤버는 옛 연도의 경우 그 해 10-K 에만 있다(VST 2022 RetailContractAmortizationMember −6) — 그 해 10-K 까지(atAll)
          const amF = atAll.filter((x) => (x.id === "Revenues" || x.id === "RevenueFromContractWithCustomerExcludingAssessedTax") && x.dims.length === 1 && /ProductOrServiceAxis$/.test(x.dims[0][0]) && /Amortization/i.test(x.dims[0][1]) && x.v !== 0);
          // 공시마다 멤버가 다를 수 있어(VST 2024 10-K IntangibleAmortizationAndOtherRevenuesMember −4 vs 2022 10-K RetailContractAmortizationMember −6)
          // 멤버·공시별 값을 각각 선택지로(같은 값은 하나)
          const am = amF.map((x) => ({ id: `${x.id}[${x.dims[0][1]}]`, v: x.v })).filter((o, i, a) => a.findIndex((p) => p.v === o.v) === i);
          // 성분별 선택지(빼지 않음 + 공시별 값) 조합 — 하나 이상 뺀 조합만
          let combos = [[]];
          for (const [lab, opts] of [["매출 위치 현금흐름위험회피 재분류", cf], ["매출 위치 비지정 파생상품 손익", nd], ["매출 차감 상각", am]])
            combos = combos.flatMap((c) => [c, ...opts.map((o) => [...c, [lab, o]])]);
          for (const use of combos.filter((c) => c.length))
            cands.push([`인포맥스 매출 = SEC 본표 매출 ${r.ours} − ${use.map(([lab, f]) => `${lab}(${f.id}) ${f.v}`).join(" − ")}`, r.ours - use.reduce((t, [, f]) => t + f.v, 0)]);
        }
        if (n === "인포맥스" && tot != null) {
          const cf = one((ds) => ds.some((d) => d[0] === "ReclassificationOutOfAccumulatedOtherComprehensiveIncomeAxis") && ds.some((d) => d[1] === "AccumulatedGainLossNetCashFlowHedgeParentMember")).filter((x) => x.id === "Revenues");
          if (cf.length === 1) cands.push([`인포맥스 매출 = Revenues ${tot} − 현금흐름위험회피 AOCI 재분류 ${cf[0].v}`, tot - cf[0].v]);
        }
        if (n === "인포맥스") {
          const seg = one((ds) => ds.length === 1 && ds[0][0] === "StatementBusinessSegmentsAxis").filter((x) => x.id === "RevenueFromContractWithCustomerExcludingAssessedTax");
          if (seg.length >= 2) cands.push([`인포맥스 매출 = Σ 사업부문 고객계약 매출(${seg.length}개 부문)`, seg.reduce((t, x) => t + x.v, 0)]);
        }
        if (n === "StockAnalysis" && tot != null) {
          // 환급 매출은 Revenues(MAR) 또는 고객계약 매출(HLT ReimbursementRevenueMember) 차원 — Revenues 쪽을 우선, 없으면 고객계약 매출
          const reAll = one((ds) => ds.length === 1 && ds[0][0] === "ProductOrServiceAxis" && /Reimburs/i.test(ds[0][1]) && !/Exclud/i.test(ds[0][1]));
          const re = reAll.some((x) => x.id === "Revenues") ? reAll.filter((x) => x.id === "Revenues") : reAll.filter((x) => x.id === "RevenueFromContractWithCustomerExcludingAssessedTax");
          if (re.length) cands.push([`StockAnalysis 매출 = Revenues ${tot} − 비용 환급 매출 ${re.map((x) => x.v).join("+")}`, tot - re.reduce((t, x) => t + x.v, 0)]);
        }
        // StockAnalysis 매출 = SA 영업매출(operatingRevenue, 앱과 정확 일치) + SA 기타매출(otherRevenue). 기타매출이 SEC 본표 "기타수익"
        //    줄(Revenues[OtherRevenueMember|OtherIncomeMember]) − SA 자산처분이익 − SA 환차익과 정확히 같을 때만(XOM 2021: 2,291 − 1,841 − 2
        //    = 448). SA 가 기타수익 중 처분·환 손익을 뺀 나머지를 매출에 넣는 정의. 비영업 분리 회사(앱이 기타수익을 뺀 회사)만.
        if (n === "StockAnalysis" && revFace?.split) {
          const a = saIsAdj.get(col), oth = at.filter((x) => x.id === "Revenues" && x.dims.length === 1 && /ProductOrServiceAxis$/.test(x.dims[0][0]) && /^(OtherRevenueMember|OtherIncomeMember)$/.test(x.dims[0][1]));
          if (a?.opRev === r.ours && a.orv && oth.length === 1 && oth[0].v === a.orv + a.ga + a.cg)
            cands.push([`StockAnalysis 매출 = SA 영업매출 ${a.opRev}(= 앱) + SA 기타매출 ${a.orv}(= SEC 기타수익 줄 ${oth[0].v} − SA 자산처분이익 ${a.ga} − SA 환차익 ${a.cg})`, r.ours + a.orv]);
        }
        for (const [how, exp] of cands) if (withinH(v - exp)) return { ok: `${how} = ${exp}, 앱 = SEC 매출(A층 정확 일치) · 공통모드 아님(10-K 원본 차원값)` };
      }
      // R4 Yahoo·인포맥스 LTM 매출 = SEC 3개월값 4개 합(4분기 = 사업연도 − 9개월 누적). 앱 LTM 은 사업연도 + 당기 누적 − 전년
      //    누적(SEC TTM) — 전제: 앱 LTM 매출 = SEC TTM(같은 태그, 1달러 안). 차이 = 누적값과 분기값 합의 재작성·반올림 차.
      //    공통모드 아님(SEC 분기 공시값으로 외부 값을 독립 재현). 실측 CL·GOOG·NVDA·ORCL.
      if (metric === "매출" && col === "LTM" && (n === "Yahoo" || n === "인포맥스") && L?.date) {
        for (const tag of REV_TAGS) {
          const t = secTtm(tag);
          if (!t || dayDiff(t.end, L.date) > 7 || Math.abs(t.v - r.ours) > 0.5) continue;
          const qs = secQuarterSum(tag, L.date);
          if (qs && withinH(v - qs.sum))
            return { ok: `${n} LTM 매출 = SEC ${tag} 3개월값 합 ${qs.sum}(${qs.parts.map((p) => `${p.end} ${p.how === "3개월" ? p.v : p.how}`).join(" + ")}) — 앱 = SEC TTM(${t.how}) ${t.v}, 차 ${r.ours - qs.sum} = 누적과 분기 합의 차 · 공통모드 아님(SEC 원자료로 독립 재현)` };
          break;
        }
      }
      // R8 분기 확장 — 인포맥스 LTM 매출 = Σ 분기(SEC 3개월 매출 − 그 분기 매출 위치 파생상품 손익). 4분기 = 연간 − 9개월(매출·파생 모두).
      //    성립하지 않고 한 분기만 어긋나면, 그 분기의 인포맥스 값이 인포맥스 자신의 연간 − 나머지 3분기와 다르고 그 차감값이 SEC 식과
      //    정확히 같을 때 인포맥스 자체 집계 불일치(외부 단독 이탈, 오너 승인 2026-09-25). GOOG: 2025 Q4 인포맥스 113,996 ≠ 인포맥스 연간
      //    402,962 − Q1~Q3 = 113,895 = SEC 113,829 − 파생(−126 − (−60)).
      if (metric === "매출" && col === "LTM" && n === "인포맥스" && revQDeriv && aPassed("LTM", "매출") && L?.date && imAnnual?.quarters) {
        // 비영업 분리 회사(XOM·CVX — revFace.split): 앱 LTM = SEC 본표 매출 − 비영업(분리값)이라 원 태그 TTM(secTtm)과 다르다.
        // 분기 4개도 분리값(revFace.quarterAt — 4분기는 사업연도 − 9개월)으로 구성해 같은 R8 분기 경로를 태운다(감사 2026-09-25)
        let tag = null, qs = null;
        if (revFace?.split) {
          const lt = revFace.ltmAt(L.date);
          const ends = imAnnual.quarters.filter((q) => q.end <= L.date || dayDiff(q.end, L.date) <= 7).slice(-4).map((q) => q.end);
          if (lt && Math.abs(lt.v - r.ours) <= 0.5 && ends.length === 4) {
            const ps = ends.map((E) => { const x = revFace.quarterAt(E, !!revFace.annualAt(E)); return x ? { end: E, v: x.v, how: x.how } : null; });
            if (ps.every(Boolean)) { tag = "본표 매출(비영업 분리)"; qs = { sum: ps.reduce((t, p) => t + p.v, 0), parts: ps }; }
          }
        } else {
          tag = REV_TAGS.find((t) => { const x = secTtm(t); return x && dayDiff(x.end, L.date) <= 7 && Math.abs(x.v - r.ours) <= 0.5; }) ?? null;
          qs = tag ? secQuarterSum(tag, L.date) : null;
        }
        const imQ = qs ? qs.parts.map((p) => imAnnual.quarters.find((q) => dayDiff(q.end, p.end) <= 7) ?? null) : [];
        if (qs && imQ.every((q) => q?.rev != null)) {
          const dur = (x) => (Date.parse(x.end) - Date.parse(x.start)) / 864e5;
          // 비영업 분리 회사만 — 위치 차원이 없는 사실(XOM 2025 3분기·2026 2분기 10-Q: 지정 차원만)을, 같은 개념·같은 비위치 차원이 다른
          // 공시에서 매출 위치로만 태깅됐을 때(매출 외 위치로 태깅된 적 없음) 매출 위치로 추정한다. 추정이라 결과는 잔차 메모에만 쓰인다
          // (이 경로는 ③ 을 ② 로 바꾸지 못한다 — 아래 split 분기)
          const nonLoc = (x) => x.dims.filter((d) => !LOC_AXES.includes(d[0])).map((d) => d.join("=")).sort().join("|");
          const locInferred = (x) => !!revFace?.split && !x.dims.some((d) => LOC_AXES.includes(d[0]))
            && revQDeriv.some((y) => y.id === x.id && revLoc(y.dims) && nonLoc(y) === nonLoc(x))
            && !revQDeriv.some((y) => y.id === x.id && y.dims.some((d) => LOC_AXES.includes(d[0])) && !revLoc(y.dims) && nonLoc(y) === nonLoc(x));
          let inferredUsed = false;
          const one = (kind, pred) => {
            const fs = revQDeriv.filter((x) => DERIV_FAM[kind].ids.includes(x.id) && (revLoc(x.dims) || locInferred(x)) && DERIV_FAM[kind].pred(x.dims) && pred(x));
            if (!fs.length) return null;
            const fi = Math.min(...fs.map((x) => x.fi));
            if (fs.some((x) => x.fi === fi && !revLoc(x.dims))) inferredUsed = true;
            const f0 = fs.find((x) => x.fi === fi);
            return { v: aggDeriv(fs.filter((x) => x.fi === fi)), start: f0.start, dur: dur(f0) };
          };
          // 분기 파생상품 손익 — 3개월 사실, 없으면 누적 차(같은 시작일의 누적 − 3개월 짧은 누적: 연간 − 9M, 9M − 6M, 6M − 3M)
          const derivQ = (kind, E) => {
            const q = one(kind, (x) => dayDiff(x.end, E) <= 7 && dur(x) >= 80 && dur(x) <= 100);
            if (q) return q.v;
            for (const [lo, hi] of [[300, 400], [250, 290], [160, 200]]) {
              const ytd = one(kind, (x) => dayDiff(x.end, E) <= 7 && dur(x) >= lo && dur(x) <= hi);
              if (!ytd) continue;
              const prev = one(kind, (x) => x.start === ytd.start && x.end < E && ytd.dur - dur(x) >= 80 && ytd.dur - dur(x) <= 100);
              return prev ? ytd.v - prev.v : null;
            }
            return null;
          };
          const fams = ["cf", "nd"].map((k) => [k, qs.parts.map((p) => derivQ(k, p.end))]).filter(([, vs]) => vs.every((x) => x != null) && vs.some((x) => x !== 0));
          // 위치 추정 사실을 쓴 식은 ②·외부 단독 이탈 판정에 쓰지 않는다(추정은 원인 확인이 아님) — 아래 잔차 메모로만
          for (let mask = 1; mask < 1 << fams.length && !inferredUsed; mask++) {
            const use = fams.filter((_, i) => mask & (1 << i));
            const exp = qs.parts.map((p, i) => p.v - use.reduce((t, [, vs]) => t + vs[i], 0));
            const txt = qs.parts.map((p, i) => `${p.end} ${p.v}${use.map(([k, vs]) => ` − ${k} ${vs[i]}`).join("")}`).join(" + ");
            const s = exp.reduce((t, x) => t + x, 0);
            if (withinH(v - s)) return { ok: `인포맥스 LTM 매출 = Σ 분기(SEC ${tag} 3개월 − 매출 위치 파생상품 손익) ${s}(${txt}) — 앱 = SEC TTM(A층 정확 일치) · 공통모드 아님(10-Q·10-K 원본 차원값)` };
            const bad = exp.map((x, i) => i).filter((i) => Math.abs(imQ[i].rev - exp[i]) > 0.5e6);
            if (bad.length !== 1) continue;
            const k = bad[0], qe = imQ[k].end;
            const ann = imAnnual.find((a) => (Date.parse(a.end) - Date.parse(qe)) / 864e5 > -8 && (Date.parse(a.end) - Date.parse(qe)) / 864e5 < 330);
            const fyQ = ann ? imAnnual.quarters.filter((q) => (Date.parse(ann.end) - Date.parse(q.end)) / 864e5 > -8 && (Date.parse(ann.end) - Date.parse(q.end)) / 864e5 < 330) : [];
            if (ann?.rev == null || fyQ.length !== 4 || fyQ.some((q) => q.rev == null)) continue;
            const derived = ann.rev - fyQ.filter((q) => q.end !== qe).reduce((t, q) => t + q.rev, 0);
            if (Math.abs(derived - exp[k]) <= 0.5e6)
              return { outlier: `외부 단독 이탈(인포맥스 자체 집계 불일치) — 인포맥스 ${qe} 분기 ${imQ[k].rev} ≠ 인포맥스 연간 ${ann.rev} − 나머지 3분기 = ${derived} = SEC 식(${txt.split(" + ")[k]}) ${exp[k]}, 나머지 3분기는 SEC 식과 정확 일치 · 앱 = SEC TTM(A층 정확 일치)` };
          }
          // 정확히 닫히지 않음(비영업 분리 회사) — ③ 유지(반올림 허용 없음, 오너 결정). 잔차 금액·분기·근거를 결과에 남긴다(감사 분해 재현).
          // 분기마다: 인포맥스 = SEC 분리값이면 "조정 없음", 아니면 SEC 분리값 − 매출 위치 파생상품 손익(가족 합)과 비교해 분기 잔차.
          // 다른 회사는 종전 "정의 미분해" 표기 유지
          if (revFace?.split) {
            const adj = qs.parts.map((p) => ["cf", "nd"].map((k) => derivQ(k, p.end)).filter((x) => x != null));
            const rows = qs.parts.map((p, i) => {
              const d = imQ[i].rev - p.v;
              if (d === 0) return { end: p.end, resid: 0, txt: `${p.end} 인포맥스 = SEC ${p.v}(조정 없음)` };
              const a = adj[i].reduce((t, x) => t + x, 0);
              return { end: p.end, resid: d + a, txt: `${p.end} 인포맥스 ${imQ[i].rev} − SEC ${p.v} = ${d}, 파생상품 손익 ${adj[i].length ? a : "없음"} → 잔차 ${d + a}` };
            });
            const resid = rows.reduce((t, x) => t + x.resid, 0);
            const inFy = (a, e) => { const d = (Date.parse(a.end) - Date.parse(e)) / 864e5; return d > -8 && d < 330; };
            // 인포맥스 연간 ≠ 자기 분기 4개 합(분기 값에만 조정이 들어간 경우) — 메모
            const selfGap = imAnnual.filter((a) => a.rev != null && qs.parts.some((p) => inFy(a, p.end))).map((a) => {
              const fq = imAnnual.quarters.filter((q) => inFy(a, q.end));
              if (fq.length !== 4 || fq.some((q) => q.rev == null)) return null;
              const sq = fq.reduce((t, q) => t + q.rev, 0);
              return sq === a.rev ? null : `인포맥스 ${a.end} 연간 ${a.rev} ≠ 자기 분기 4개 합 ${sq}(차 ${a.rev - sq})`;
            }).filter(Boolean);
            if (resid !== 0 || inferredUsed)
              return { appsec: `앱 = SEC 본표 매출(비영업 분리, A층 정확 일치) — 인포맥스 LTM 미분해 잔차 ${resid}(${rows.filter((x) => x.resid).map((x) => `${x.end} ${x.resid}`).join(", ") || "없음"}) · 분기별: ${rows.map((x) => x.txt).join(" · ")}${inferredUsed ? " · 일부 파생상품 사실은 위치 차원 없음 — 같은 개념·지정 차원이 다른 공시에서 매출 위치로만 태깅돼 매출로 추정" : ""}${selfGap.length ? ` · ${selfGap.join(" · ")}` : ""}` };
          }
        }
      }
      // 인포맥스 연간 매출 ≠ 인포맥스 자신의 분기 4개 합, 그리고 그 분기 합 = 앱 = SEC 본표(A층 정확 일치) — 인포맥스 집계 자체의
      //    불일치라 정의 차이(②)가 아니라 외부 단독 이탈로 둔다(HLT 2025: 연간 11,982 vs 분기 합 12,039 = SEC).
      if (metric === "매출" && col !== "LTM" && n === "인포맥스" && aPassed(col, "매출") && H[col]?.date && imAnnual?.quarters) {
        const E = H[col].date;
        const qs = imAnnual.quarters.filter((q) => (Date.parse(E) - Date.parse(q.end)) / 864e5 > -8 && (Date.parse(E) - Date.parse(q.end)) / 864e5 < 330);
        const s = qs.length === 4 && qs.every((q) => q.rev != null) ? qs.reduce((t, q) => t + q.rev, 0) : null;
        if (s != null && Math.abs(s - r.ours) <= 0.5e6 && Math.abs(v - s) > unit / 2)
          return { outlier: `외부 단독 이탈(인포맥스 자체 집계 불일치) — 인포맥스 연간 ${v} ≠ 인포맥스 분기 4개 합 ${s}(${qs.map((q) => `${q.end} ${q.rev}`).join(" + ")}) = 앱 = SEC 본표(A층 정확 일치)` };
      }
      // R7 합성 영업이익 회사(소계 없는 손익계산서 — XOM)의 StockAnalysis 영업이익 = 앱 − (SA 자산손상 + 합병·구조조정 + 기타 비경상)
      //    + SA 기타수익. SA 자체 분류(SEC 태그값과 다름) — SA 가 이 항목들을 영업 밖으로 옮긴다. 전제: 앱 세전이익 = SEC(A층 정확
      //    일치). 허용 = SA 보고 단위 × (항목 수 + 1) / 2(각 값이 단위 반올림). IBM 은 퇴직 관련 손익 등 다른 항목이 필요해 미적용.
      if (metric === "영업이익" && n === "StockAnalysis" && opRowName && opRowName !== "영업이익"
        && checks.some((k) => k.col === col && k.status === PASS && k.name === "세전이익 앱 = SEC 세전이익")) {
        const a = saIsAdj.get(col);
        if (a) {
          const exp = r.ours - (a.aw + a.mr + a.ou) + a.orv;
          const nz = [a.aw, a.mr, a.ou, a.orv].filter((x) => x).length;
          if (nz && Math.abs(v - exp) <= (saUnitIs * (nz + 1)) / 2)
            return { ok: `SA 자체 분류(SEC 태그값과 다름) — SA 영업이익 = 앱 합성 영업이익 − (자산손상 ${a.aw} + 합병·구조조정 ${a.mr} + 기타 비경상 ${a.ou}) + 기타수익 ${a.orv} = ${exp}, 앱 세전이익 = SEC(A층 통과)` };
        }
      }
      // ③ 앱 = SEC 원자료(A층 정확 일치)인데 외부 값의 정의를 숫자로 분해하지 못한 경우 — 원인 확인이 아니다(오너 결정 2026-09-25,
      //    "원인 확인은 숫자로 성립할 때만"). 별도 분류(appEqualsSec)로 남기고 explained 에 넣지 않는다 — 미해명 건수에 포함된다.
      if (aPassed(col, metric)) return { appsec: `앱 = SEC 공시 ${metric}(A층 정확 일치) — ${n} 정의 미분해` };
      // ⑥ 감가상각비·EBITDA: 차이 = SEC 운용리스 사용권자산 상각 — 외부는 운용리스 상각을 감가상각에 넣고 앱은 뺀다
      //    (CLAUDE.md: 운용리스 비용은 임차료 성격이라 EBITDA 에 이미 반영, PEP 2025 Yahoo 4,178 = 3,451 + 727)
      //    감사: 앱이 운용리스 상각을 한 번 더 뺀 오류도 이 식이 성립한다 → 앱 감가상각비가 SEC 현금흐름표 본표 줄 합과
      //    정확히 일치(A층 통과)한 기간에만 인정. EBITDA 는 영업이익도 확인(A층 정확 일치 또는 같은 소스와 일치)돼야 한다.
      //    독립 대조가 없는 기간(LTM·옛 연도·계산 구조 없음)은 적용하지 않는다(미해명).
      const daVerified = checks.some((k) => k.col === col && k.status === PASS && k.name === "감가상각비 앱 = SEC 현금흐름표 감가상각·상각 줄 합");
      const opVerified = metric !== "EBITDA" || aPassed(col, "영업이익") || (() => { const x = recon.get(`${col} 영업이익`)?.srcs[n]; return !!x && sameAt(IS[col]?.op, x.v, x.unit); })();
      if (/^(감가상각비|EBITDA)$/.test(metric) && daVerified && opVerified) {
        const ol = col === "LTM" ? secTtm("OperatingLeaseRightOfUseAssetAmortizationExpense")?.v : atEnd(ann("OperatingLeaseRightOfUseAssetAmortizationExpense"), H[col]?.date ?? "")?.val;
        if (ol && within(v - r.ours - ol)) return { ok: `운용리스 사용권자산 상각(${ol}) 포함 여부 — 앱은 제외(임차료 성격), 앱 감가상각비 = SEC 현금흐름표 본표 줄 합 확인(공통모드 A층 기준)` };
      }
      // ④ EBITDA: 같은 소스의 영업이익 차 + 감가상각비 차로 분해되고, **두 구성요소 모두 원인 확인**일 때만 확인.
      //    분해식 자체는 항상 성립하므로(앱 EBITDA = 영업이익 + 감가상각비, 인포맥스 감가상각비 = EBITDA − 영업이익)
      //    구성요소 판정 없이 확인으로 치면 틀린 EBITDA 가 지나간다(재감사 HIGH)
      if (metric === "EBITDA" && done) {
        const part = (m) => {
          const x = recon.get(`${col} ${m}`);
          if (!x?.srcs[n]) return null;
          return { d: x.srcs[n].v - x.ours, ok: sameAt(x.ours, x.srcs[n].v, x.srcs[n].unit) || !!done.get(`${col} ${m}|${n}`)?.ok };
        };
        const o = part("영업이익"), d = part("감가상각비");
        if (o && d && within(v - r.ours - o.d - d.d) && o.ok && d.ok) return { ok: `구성요소 모두 원인 확인 — 영업이익 차 ${o.d}, 감가상각비 차 ${d.d}` };
      }
      // ⑧ 감가상각비: 외부 = SEC 현금흐름표 줄 전액(손상·중단사업 감가상각 포함) — 앱은 A층에서 그 금액을 뺀 값과 정확히
      //    일치(daVerified)했고, 차이가 바로 그 조정액일 때만(TSLA·XOM 손상, WDC 중단사업)
      //    감사: 손상·중단사업 조정 판정이 앱과 같은 규칙(공통모드)이라 A층 통과만으로는 독립 근거가 아니다 → 제3 소스(n 이 아닌
      //    외부 소스)가 앱과 보고 단위 안에서 일치할 때만 원인 확인.
      if (metric === "감가상각비" && daVerified && cfDa && H[col]?.date) {
        const e = [...cfDa.lineByEnd].find(([end]) => dayDiff(end, H[col].date) <= 7);
        const adj = e ? cfDa.notes.get(e[0]) : null;
        const third = Object.keys(r.srcs).filter((m) => m !== n && sameAt(r.ours, r.srcs[m].v, r.srcs[m].unit));
        if (adj && within(v - e[1]) && third.length) return { ok: `${n} 는 현금흐름표 줄 전액(${e[1]}) — 앱은 ${adj} · 제3 소스 ${third.join("·")} = 앱` };
      }
      // ⑦ 감가상각비: StockAnalysis 는 현금흐름표 "기타 상각"(otherAmortization, 별도 줄)을 EBITDA 용 감가상각에서 뺀다 —
      //    앱 = depAmorEbitda + otherAmortization 이 정확히 성립할 때만(실측 35건: DAL·DELL·IBM·MU·NFLX·ORCL·META·MAR·PEP).
      //    앱 감가상각비가 SEC 현금흐름표 줄 대조(A층)를 통과한 기간에만 인정한다(⑥과 같은 전제 — 앱 오류가 이 식으로 가려지지 않게)
      if (metric === "감가상각비" && n === "StockAnalysis" && daVerified) {
        const oa = saOtherAmort.get(col);
        if (oa && within(v + oa - r.ours)) return { ok: `StockAnalysis 는 기타상각(현금흐름표 별도 줄 ${oa})을 EBITDA 감가상각에서 제외 — 앱 = depAmorEbitda + otherAmortization, 앱 감가상각비 = SEC 현금흐름표 줄 대조 통과` };
      }
      // ⑤ 감가상각비: 다른 외부 소스가 앱과 정확히 같다 — 앱이 맞다는 증거는 아니어서(SEC 독립 대조 없음) 추정만
      if (metric === "감가상각비") {
        const same = Object.keys(r.srcs).filter((m) => m !== n && sameAt(r.ours, r.srcs[m].v, r.srcs[m].unit));
        if (same.length) return { guess: `앱(현금흐름표 본표 줄) = ${same.join("·")} — ${n} 는 다른 정의로 보임` };
      }
      if (oneOff != null && oneOff !== 0 && Math.abs(v - r.ours - oneOff) <= Math.abs(v) * 1e-3) return { guess: `일회성 항목 조정 — 잔차 ${v - r.ours - oneOff}` };
      if (Math.abs(v - r.ours) <= Math.abs(v) * 5e-4) return { guess: `0.05% 이내 — 소스 반올림·주식수 기준일 차 추정(차 ${v - r.ours})` };
      return {};
    };
    // ── 원인 R1~R3·R5·R6 준비 — 해당 불일치가 있을 때만 공시 원본을 읽는다(SEC 요청 절약)
    const mism = (item, src) => { const x = recon.get(item); return !!x?.srcs[src] && !sameAt(x.ours, x.srcs[src].v, x.srcs[src].unit); };
    let debtDec = null, irDeriv = null, finOblig = null, revDims = null, revParts = null, revQDeriv = null;
    if (mism("LTM 총차입금(운용리스 포함)", "Yahoo") || mism("LTM 총차입금(운용리스 포함)", "StockAnalysis")) {
      try {
        const fl = await filingAtDate(cik, sub, L.date);
        if (fl) {
          const { faceVals, faceSum, val0, nm } = faceDebtLines(fl);
          const onFace = (id) => fl.faceIds.has(id);
          const firstOff = (ids) => { for (const id of ids) if (!onFace(id) && val0(id) != null) return { id, v: val0(id) }; return null; };
          const off = [];
          // 본표에 유동 차입금 줄(운용리스 제외 — "LongTermDebtAndCapitalLeaseObligationsCurrent" 는 차입금+금융리스 유동분)이 없을 때만 주석값
          if (!faceVals.some((x) => /Current/.test(nm(x.id)) && !/OperatingLease/.test(nm(x.id)))) {
            // DebtCurrent 는 단기차입금 포함 합계. 없으면 유동성 장기부채 + 단기차입금·CP(본표 밖 — AMZN ShortTermBorrowings 325)
            const dc = firstOff(["us-gaap_DebtCurrent"]);
            if (dc) off.push({ ...dc, why: "주석 유동 차입금" });
            else {
              const c = firstOff(["us-gaap_LongTermDebtAndCapitalLeaseObligationsCurrent", "us-gaap_LongTermDebtCurrent"]);
              if (c) off.push({ ...c, why: "주석 유동 차입금" });
              for (const id of ["us-gaap_ShortTermBorrowings", "us-gaap_CommercialPaper"]) { const x = firstOff([id]); if (x) off.push({ ...x, why: "주석 단기차입금" }); }
            }
          }
          // 본표의 일반 리스부채 줄(LeaseLiability·LeaseLiabilityNoncurrent — 금융·운용 합산, AMZN)이 이미 담은 쪽은 주석값을 보태지 않는다
          const genNon = faceVals.some((x) => /^LeaseLiability(Noncurrent)?$/.test(nm(x.id))), genCur = faceVals.some((x) => /^LeaseLiability(Current)?$/.test(nm(x.id)));
          if (!faceVals.some((x) => /FinanceLease|CapitalLease/.test(nm(x.id)))) {
            const cur = genCur ? null : firstOff(["us-gaap_FinanceLeaseLiabilityCurrent"]), non = genNon ? null : firstOff(["us-gaap_FinanceLeaseLiabilityNoncurrent"]);
            if (cur || non) { if (cur) off.push({ ...cur, why: "주석 금융리스" }); if (non) off.push({ ...non, why: "주석 금융리스" }); }
            else if (!genNon && !genCur) { const t = firstOff(["us-gaap_FinanceLeaseLiability"]); if (t) off.push({ ...t, why: "주석 금융리스" }); }
          }
          const opCur = genCur ? null : firstOff(["us-gaap_OperatingLeaseLiabilityCurrent"]), opNon = genNon ? null : firstOff(["us-gaap_OperatingLeaseLiabilityNoncurrent"]);
          if (opCur) off.push({ ...opCur, why: "본표 밖 운용리스" });
          if (opNon) off.push({ ...opNon, why: "본표 밖 운용리스" });
          if (!opCur && !opNon && !genNon && !genCur && !faceVals.some((x) => /OperatingLease/.test(nm(x.id)))) { const t = firstOff(["us-gaap_OperatingLeaseLiability"]); if (t) off.push({ ...t, why: "본표 밖 운용리스" }); }
          // 유동 운용리스 태그 없이 총액만 있고 본표엔 비유동만(MSFT: 유동분은 OperatingLeaseLiability[기타유동부채] 차원) → 총액 − 본표 비유동
          const faceOpNon = faceVals.find((x) => nm(x.id) === "OperatingLeaseLiabilityNoncurrent"), opTot = val0("us-gaap_OperatingLeaseLiability");
          if (!opCur && !genCur && faceOpNon && opTot != null && !onFace("us-gaap_OperatingLeaseLiability") && opTot - faceOpNon.v > 0) off.push({ id: "us-gaap_OperatingLeaseLiability", v: opTot - faceOpNon.v, why: `본표 밖 유동 운용리스(총액 ${opTot} − 본표 비유동)` });
          const offSum = off.reduce((t, x) => t + x.v, 0);
          debtDec = { fl, faceVals, faceSum, off, offSum, appOk: withLease != null && Math.abs(withLease - (faceSum + offSum)) <= 1, val0, onFace, nm };
          if (!debtDec.appOk) review.push({ item: "LTM 총차입금 SEC 본표 분해 불성립", note: `앱(운용리스 포함) ${withLease} ≠ 본표 줄 합 ${faceSum}(${faceVals.map((x) => `${nm(x.id)} ${x.v}`).join(" + ")}) + 주석·본표 밖 ${offSum}(${off.map((x) => `${x.why} ${nm(x.id)} ${x.v}`).join(" + ") || "없음"}) — ${fl.form} ${fl.date}. 차입금 원인 R1·R2·R3 은 추정까지만` });
          // R2 금리·통화금리 파생상품 부채(DerivativeInstrumentRiskAxis) — 멤버별로 위치(유동·비유동) 내역이 있으면 그 합, 없으면 차원 합
          const IR = /InterestRate|CrossCurrencyInterestRate/i;
          const irOf = (concept) => {
            const byM = new Map();
            for (const x of fl.facts) {
              if (x.id !== `us-gaap_${concept}`) continue;
              const risk = x.dims.find((d) => d[0] === "DerivativeInstrumentRiskAxis");
              if (!risk || !IR.test(risk[1])) continue;
              const loc = x.dims.some((d) => /StatementOfFinancialPositionLocation|BalanceSheetLocation/.test(d[0]));
              const b = byM.get(risk[1]) ?? { loc: [], no: [] };
              (loc ? b.loc : b.no).push(x.v);
              byM.set(risk[1], b);
            }
            if (!byM.size) return null;
            const sum = [...byM.values()].reduce((t, b) => t + (b.loc.length ? b.loc : b.no).reduce((a, y) => a + y, 0), 0);
            // 같은 값이 금리 외 멤버에도 있으면 어느 멤버 값인지 확정 못 함(DELL 13) → 추정
            // (위험 축이 있는 금리 외 멤버만 본다 — 위험 축 없는 합계 줄(WMT −1,337)은 같은 값이어도 중복이 아니다)
            const dup = sum !== 0 && fl.facts.some((x) => x.id.includes("Derivative") && Math.abs(x.v) === Math.abs(sum) && x.dims.some((d) => d[0] === "DerivativeInstrumentRiskAxis" && !IR.test(d[1])));
            return { sum, dup, members: [...byM.keys()] };
          };
          const liab = irOf("DerivativeFairValueOfDerivativeLiability"), net = liab ? null : irOf("DerivativeFairValueOfDerivativeNet");
          irDeriv = liab ? { ...liab, add: liab.sum, how: "DerivativeFairValueOfDerivativeLiability" } : net ? { ...net, add: -net.sum, how: "DerivativeFairValueOfDerivativeNet(부호 반전)" } : null;
          // R3 본표 밖 회사 고유 금융 의무(…FinancingObligation(s)Current/Noncurrent — AMZN)
          const fo = fl.facts.filter((x) => !x.id.startsWith("us-gaap_") && !x.dims.length && /FinancingObligations?(Current|Noncurrent)$/.test(x.id) && !onFace(x.id));
          finOblig = fo.length ? { sum: fo.reduce((t, x) => t + x.v, 0), ids: fo.map((x) => `${nm(x.id)} ${x.v}`) } : null;
        }
      } catch (e) {
        errs.push(`차입금 원인 판정 공시 원본(${L.date}) 조회 실패: ${String(e).slice(0, 60)}`);
      }
    }
    const revItems = [...recon.values()].filter((x) => /^\d{4}Y 매출$/.test(x.item) && ((x.srcs["인포맥스"] && !sameAt(x.ours, x.srcs["인포맥스"].v, x.srcs["인포맥스"].unit)) || (x.srcs.StockAnalysis && !sameAt(x.ours, x.srcs.StockAnalysis.v, x.srcs.StockAnalysis.unit))));
    if (revItems.length && !foreign) {
      // 불일치 연도의 그 해 10-K 도 읽는다(파생상품 표가 옛 연도를 안 싣는 경우 — LRCX FY2022·CAT 2021)
      const ends = revItems.map((x) => H[x.item.split(" ")[0]]?.date).filter(Boolean);
      try { revDims = await annualRevenueDimFacts(cik, sub, 3, ends); }
      catch (e) { errs.push(`매출 차원 공시 원본 조회 실패: ${String(e).slice(0, 60)}`); }
    }
    // R9 본표 매출 하위 줄 합 — 연간 매출이 어느 외부 소스와든 다를 때만, 이미 읽은 10-K 본표 구조(revFace.faces)의 원본에서
    const revAnyMism = [...recon.values()].some((x) => /^\d{4}Y 매출$/.test(x.item) && Object.values(x.srcs).some((s) => !sameAt(x.ours, s.v, s.unit)));
    if (revAnyMism && revFace && !foreign) {
      try { revParts = await faceRevenueParts(revFace.faces); }
      catch (e) { errs.push(`매출 본표 하위 줄 공시 원본 조회 실패: ${String(e).slice(0, 60)}`); }
    }
    // R8 분기 확장 — 인포맥스 LTM 매출이 다를 때만, 인포맥스 최근 4분기 결산일의 10-Q·10-K 원본에서 매출 위치 파생상품 손익
    if (mism("LTM 매출", "인포맥스") && revFace && !foreign && imAnnual?.quarters) {
      const qEnds = imAnnual.quarters.filter((q) => q.end <= L.date || dayDiff(q.end, L.date) <= 7).slice(-4).map((q) => q.end);
      // 분기 결산일 공시 + 누적 차(6M − 3M 등)에 필요한 그 사이 공시(LTM 창 첫 분기 − 100일 이후)
      const from = qEnds.length ? new Date(Date.parse(qEnds[0]) - 100 * 864e5).toISOString().slice(0, 10) : "";
      try { if (qEnds.length === 4) revQDeriv = await derivFactsOf(revFace.faces.filter((f) => !f.any && f.instUrl && (qEnds.some((E) => dayDiff(f.report, E) <= 7) || (f.report >= from && f.report <= L.date)))); }
      catch (e) { errs.push(`매출 분기 파생상품 공시 원본 조회 실패: ${String(e).slice(0, 60)}`); }
    }
    // 1차: EBITDA 외 항목 → 2차: EBITDA(구성요소 판정 결과를 쓴다)
    const done = new Map();
    const ordered = [...recon.values()].sort((a, b) => Number(/EBITDA$/.test(a.item)) - Number(/EBITDA$/.test(b.item)));
    for (const r of ordered) {
      const names = Object.keys(r.srcs);
      const matched = names.filter((n) => sameAt(r.ours, r.srcs[n].v, r.srcs[n].unit));
      const causes = Object.fromEntries(names.filter((n) => !matched.includes(n)).map((n) => [n, causeOf(r, n, done)]));
      for (const [n, c] of Object.entries(causes)) done.set(`${r.item}|${n}`, c);
      const explained = names.filter((n) => causes[n]?.ok);
      // 외부 단독 이탈 — 원인 확인이 아니다(explained 에 넣지 않는다). 앱 = SEC 본표 = 다른 소스일 때만 붙는 분류
      const outliers = names.filter((n) => causes[n]?.outlier);
      // 정의차(앱 결함 후보) — 원인도 이탈도 아니다. causes 에 넣지 않고 따로 남긴다
      const defDiffs = Object.fromEntries(names.filter((n) => causes[n]?.defdiff).map((n) => [n, causes[n].defdiff]));
      const appSec = Object.fromEntries(names.filter((n) => causes[n]?.appsec).map((n) => [n, causes[n].appsec]));
      const why = (n) => (causes[n]?.ok ? ` [원인 확인: ${causes[n].ok}]` : causes[n]?.outlier ? ` [${causes[n].outlier}]` : causes[n]?.defdiff ? ` [${causes[n].defdiff}]` : causes[n]?.appsec ? ` [${causes[n].appsec}]` : causes[n]?.guess ? ` [원인 추정: ${causes[n].guess}]` : "");
      const off = names.filter((n) => !matched.includes(n)).map((n) => `${n} ${r.srcs[n].v} (${(((r.ours - r.srcs[n].v) / Math.abs(r.srcs[n].v)) * 100).toFixed(2)}%)${why(n)}`);
      // 매출 분류(revenue.md §0): ① 일치 · ② 정의 차이(분해식 정확 성립 = 원인 확인) · 외부 단독 이탈(앱 = SEC 본표 정확 일치 +
      // 다른 외부 2곳 이상 앱과 일치 + 이 소스만 이탈) · ③ 오류(그 밖 전부 — 추정·미분해·앱≠SEC 포함)
      let revenueClass = null;
      if (/^(\d{4}Y|LTM) 매출$/.test(r.item)) {
        const col0 = r.item.split(" ")[0];
        // 외부 단독 이탈 두 경로: §0(앱 = SEC + 외부 2곳 이상 일치 + 이 소스만 이탈), 또는 그 소스 자체 집계 불일치가 숫자로 확인됨
        // (causes.outlier — 인포맥스 연간 ≠ 자기 분기 4개 합 = 앱 = SEC). 둘 다 앱 = SEC 본표(A층 정확 일치) 전제
        revenueClass = Object.fromEntries(names.map((n) => [n, matched.includes(n) ? "①" : causes[n]?.ok ? "②"
          : aPassed(col0, "매출") && ((matched.length >= 2 && names.length - matched.length === 1) || causes[n]?.outlier) ? "외부단독이탈" : "③"]));
        for (const n of names) if (revenueClass[n] === "③") revErrors.push({ item: r.item, source: n, ours: r.ours, other: r.srcs[n].v, note: `${why(n).trim() || "분해식 없음"}${aPassed(col0, "매출") ? "" : " · 앱 ≠ SEC 본표(A층 미통과)"}` });
      }
      review.push({
        ...(revenueClass ? { revenueClass } : {}),
        item: r.item,
        ours: r.ours,
        sources: Object.fromEntries(names.map((n) => [n, r.srcs[n].v])),
        matched,
        explained,
        ...(outliers.length ? { outliers } : {}),
        ...(Object.keys(defDiffs).length ? { definitionDiffs: defDiffs } : {}),
        ...(Object.keys(appSec).length ? { appEqualsSec: appSec } : {}),
        causes: Object.fromEntries(Object.entries(causes).map(([n, c]) => [n, c.ok ?? c.outlier ?? (c.guess ? `추정: ${c.guess}` : null)])),
        verdict: off.length ? `${matched.length}/${names.length}곳 일치 — 불일치: ${off.join(", ")}` : `${names.length}곳 모두 일치`,
      });
    }

    for (const e of errs) { review.push({ item: "외부 소스 조회 실패", note: e }); hardErrors.push(`외부 소스 조회 실패 — ${e}`); }
  }
  return { sym, checks, review, hardErrors, revErrors };
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
    H[lab] = { date: c.date, mc: r("mktcap"), pref: r("pref_mcap"), cash: r("cash"), debt: r("debt"), nci: r("nci"), ev: r("ev"), ebitda: r("ebitda"), ni: r("ni"), eps: r("eps"), per: v("per"), pbr: v("pbr"), psr: v("psr"), evx: v("ev_ebitda") };
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
  for (const [name, key] of [["당기순이익", "ni"], ["희석 EPS", "eps"], ["매출액", "rev"], ["영업이익", "op"], ["EBITDA", "ebitda"], ["감가상각비·무형자산상각비", "da"]])
    for (const [k, v] of Object.entries(rowOf(is, name))) (IS[k.replace(/^FY(\d{4})$/, "$1Y")] ??= {})[key] = v;
  // 지배주주 귀속 순이익 행 — FnGuide 당기순이익(지배)와 같은 정의(하이라이트 순이익은 연결·비지배 포함)
  // 정확 일치 — 부분일치는 "(비지배주주 귀속)" 에도 걸린다(감사 3차)
  const parentRow = is?.sections?.flatMap((s) => s.items ?? []).find((x) => x.accountName?.trim() === "(지배주주 귀속)");
  for (const [k, v] of Object.entries(parentRow?.values ?? {})) (IS[k.replace(/^FY(\d{4})$/, "$1Y")] ??= {}).niParent = v;
  const hardErrors = [];
  for (const [k, v] of Object.entries({ ...fetched, "verify-row": row })) for (const w of appFetchWarnings(v)) hardErrors.push(`앱 조회 실패 경고(${k}): ${w}`);
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
      // EBITDA = 영업이익 + 감가상각비·무형자산상각비(손익계산서 주석)
      { const e = IS[c]?.ebitda ?? null, o = IS[c]?.op ?? null, d = IS[c]?.da ?? null;
        if (e != null || (o != null && d != null))
          add("D", "EBITDA = 영업이익 + 감가상각비(손익계산서)", c, e == null ? { status: FAIL, note: `영업이익 ${o}·감가상각비 ${d} 있는데 EBITDA 빈칸` }
            : o == null || d == null ? { status: FAIL, note: `EBITDA ${e} 있는데 구성요소 빈칸(영업이익 ${o}·감가상각비 ${d})` }
            : same(e, o + d)); }
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

  // ── F. 외부 대조 — FnGuide·Yahoo(국내, 오너 지시 2026-09-24 "FnGuide 만 믿을 수 없다"). 소스마다 보고 단위 안에서 일치
  // (FnGuide 투자지표 억원·재무제표 백만원, Yahoo 백만원). 인베스팅닷컴은 스크립트 접근이 403 이라 브라우저 개별 확인만.
  const review = [];
  if (EXTERNAL) {
    const items = new Map(); // 항목 → { ours, src: { 소스: { v, unit, cause } } }
    const putS = (src, item, ours, v, unit, cause) => {
      if (ours == null || v == null) return;
      const it = items.get(item) ?? { ours, src: {} };
      it.src[src] = { v, unit, cause };
      items.set(item, it);
    };
    try {
      const fg = await fnguideInvest(sym);
      const fin = await fnguideFinance(sym);
      const ymOf = (d) => (d ? `${d.slice(0, 4)}/${d.slice(5, 7)}` : null);
      const put = (item, ours, v, unit, cause) => putS("FnGuide", item, ours, v, unit, cause);
      for (const [c, x] of Object.entries(H)) {
        const ym = ymOf(x.date);
        if (!ym || !fg.cols.includes(ym)) continue;
        const isLtm = c === "LTM";
        const eok = (v) => (v != null ? v * 1e8 : null);
        put(`${c} EBITDA`, x.ebitda, eok(fg.ebitda[ym]), 1e8);
        // FnGuide EV 는 비지배지분을 뺀 정의. 앱 비지배지분이 FnGuide 재무상태표 비지배주주지분과 백만원 단위로 먼저 일치하고,
        // 앱 EV − FnGuide EV 가 그 값과 억원 반올림(±0.5억) 안에서 같을 때만 원인 확인(감사 3차 — 앱 nci 를 그대로 믿으면
        // nci 오류가 EV 에 같이 들어간 경우를 정당화했다)
        const fNci = fin?.nci[ym];
        const nciOk = x.nci != null && fNci != null && Math.abs(x.nci - fNci * 1e8) <= 0.5e6;
        put(`${c} EV`, x.ev, eok(fg.ev[ym]), 1e8, (ours, v) =>
          nciOk && x.nci !== 0 && Math.abs(ours - v - x.nci) <= 0.5e8 ? `FnGuide EV 는 비지배지분 제외 — 앱 EV − FnGuide EV = 비지배지분 ${x.nci}(FnGuide 재무상태표와 일치, 억원 반올림 안)` : null);
        put(`${c} 비지배지분`, x.nci, fNci != null ? fNci * 1e8 : null, 1e6);
        put(`${c} 매출`, isLtm ? null : IS[c]?.rev ?? null, eok(fg.rev[ym]), 1e8);
        // EPS 는 원인 판정 없음 — FnGuide 는 자체 주식수로 계산하지만 앱 EPS 의 정확성을 독립 소스로 확인할 수 없어(DART 원자료
        // 대조 부재) "자사주 포함" 설명이 오류를 정당화할 수 있었다(감사 3차). 차이는 미해명으로 남긴다.
        put(`${c} EPS`, x.eps, fg.epsTtm[ym], 1);
        if (!isLtm) {
          // 연결 순이익 = FnGuide 지배 + 비지배 당기순이익(재무제표 페이지, 백만원 단위 두 값 합 → ±1백만)
          const fN = fin?.niParent[ym], fM = fin?.niNci[ym];
          put(`${c} 순이익(연결)`, x.ni, fN != null && fM != null ? (fN + fM) * 1e8 : null, 2e6);
          // 순이익(지배) = 앱 손익계산서 "(지배주주 귀속)" 행 — 하이라이트 순이익(연결)으로 대체하지 않는다
          if (fg.niParent[ym] == null) continue;
          if (IS[c]?.niParent == null) add("C", "손익계산서 (지배주주 귀속) 행 존재(FnGuide 값 있음)", c, { status: FAIL, note: `FnGuide 순이익(지배) ${fg.niParent[ym] * 1e8} · 앱 행 없음` });
          else put(`${c} 순이익(지배)`, IS[c].niParent, fg.niParent[ym] * 1e8, 1e8);
        }
      }
    } catch (e) {
      review.push({ item: "외부 소스 조회 실패", note: `FnGuide: ${String(e).slice(0, 80)}` });
      hardErrors.push(`외부 소스 조회 실패 — FnGuide: ${String(e).slice(0, 80)}`);
    }

    // Yahoo — 연간(원 단위, DART 백만원 공시 그대로). 코스피 .KS, 없으면 코스닥 .KQ
    try {
      const y = await yahoo();
      let ya = [];
      for (const suf of [".KS", ".KQ"]) {
        ya = (await y.fundamentalsTimeSeries(sym + suf, { period1: "2018-01-01", type: "annual", module: "all" }, { validateResult: false }))
          .filter((r) => r.totalRevenue != null);
        if (ya.length) break;
      }
      if (!ya.length) throw new Error("연간 재무 없음(.KS·.KQ)");
      const iso = (d) => new Date(d).toISOString().slice(0, 10);
      const yEbitda = (r) => (r.totalOperatingIncomeAsReported != null && r.reconciledDepreciation != null ? r.totalOperatingIncomeAsReported + r.reconciledDepreciation : null);
      const put = (item, ours, v, unit) => putS("Yahoo", item, ours, v, unit);
      for (const [c, x] of Object.entries(H)) {
        if (c === "LTM") continue;
        const r = ya.find((r) => dayDiff(iso(r.date), x.date) <= 7);
        if (!r) continue;
        put(`${c} 매출`, IS[c]?.rev ?? null, r.totalRevenue, 1e6);
        put(`${c} 영업이익`, IS[c]?.op ?? null, r.totalOperatingIncomeAsReported, 1e6);
        put(`${c} 감가상각비`, IS[c]?.da ?? null, r.reconciledDepreciation, 1e6);
        put(`${c} EBITDA`, x.ebitda, yEbitda(r), 2e6); // 두 백만원 값의 합 → ±1백만
        put(`${c} 순이익(연결)`, x.ni, r.netIncomeIncludingNoncontrollingInterests, 1e6);
        put(`${c} 순이익(지배)`, IS[c]?.niParent ?? null, r.netIncomeCommonStockholders ?? r.netIncome, 1e6);
        put(`${c} EPS`, x.eps, r.dilutedEPS, 1);
        put(`${c} 비지배지분`, x.nci, r.minorityInterest, 1e6);
        put(`${c} 총차입금`, x.debt, r.totalDebt, 1e6);
      }
    } catch (e) {
      review.push({ item: "외부 소스 조회 실패", note: `Yahoo: ${String(e).slice(0, 80)}` });
      hardErrors.push(`외부 소스 조회 실패 — Yahoo: ${String(e).slice(0, 80)}`);
    }

    // 항목별 판정 — 통과는 모든 소스와 일치할 때만, 원인 확인은 숫자로 성립한 소스만
    for (const [item, it] of items) {
      const names = Object.keys(it.src);
      const matched = [], explained = [], causes = {}, off = [];
      for (const n of names) {
        const s = it.src[n];
        if (sameAt(it.ours, s.v, s.unit)) { matched.push(n); continue; }
        const why = s.cause?.(it.ours, s.v) ?? null;
        if (why) { explained.push(n); causes[n] = why; }
        off.push(`${n} ${s.v} (${(((it.ours - s.v) / Math.abs(s.v || 1)) * 100).toFixed(2)}%)${why ? ` [원인 확인: ${why}]` : ""}`);
      }
      review.push({
        item, ours: it.ours, sources: Object.fromEntries(names.map((n) => [n, it.src[n].v])), matched, explained,
        ...(explained.length ? { causes } : {}),
        verdict: matched.length === names.length ? `${names.length}곳 모두 일치` : `${matched.length}/${names.length}곳 일치 — 불일치: ${off.join(", ")}`,
      });
    }
  }
  return { sym, checks, review, hardErrors };
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
      console.log(`${s.padEnd(7)} ${r.skipped ? `건너뜀: ${r.skipped}` : r.error ? `오류: ${r.error}` : `실패 ${f} · 검증불가 ${n} · 통과 ${p} · 외부 전부일치 ${r.review.filter((x) => x.matched && !/불일치/.test(x.verdict)).length} · 외부 불일치 ${r.review.filter((x) => /불일치/.test(x.verdict ?? "")).length} · 기타검토 ${r.review.filter((x) => !x.matched).length} · 조회실패 ${r.hardErrors?.length ?? 0}${MARKET === "us" ? ` · 매출 ③ 오류 ${r.revErrors?.length ?? 0}` : ""}`}`);
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
const hardList = results.flatMap((r) => (r.hardErrors ?? []).map((e) => ({ sym: r.sym, e })));
if (hardList.length || badSkips.length) {
  console.log("\n── 조회 실패·부당 건너뜀 (종료코드 1) ──");
  for (const x of hardList) console.log(`  ${x.sym} ${x.e}`);
  for (const r of badSkips) console.log(`  ${r.sym} 건너뜀: ${r.skipped}`);
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
// ── 매출(revenue.md §0·§6) — 외부 대조 분류와 ③ 오류는 검토 목록에 묻히지 않게 따로 낸다
const isRevCheck = (c) => /매출(?!총이익|원가)|순수익|PSR/.test(c.name);
const revFails = fails.filter(isRevCheck);
const revErrs = results.flatMap((r) => (r.revErrors ?? []).map((e) => ({ sym: r.sym, ...e })));
const revCls = { "①": 0, "②": 0, 외부단독이탈: 0, "③": 0 };
for (const x of reviews) for (const v of Object.values(x.revenueClass ?? {})) revCls[v]++;
if (MARKET === "us") {
  console.log(`\n── 매출 외부 대조 분류 — ① 일치 ${revCls["①"]} · ② 정의 차이 ${revCls["②"]} · 외부 단독 이탈 ${revCls.외부단독이탈} · ③ 오류 ${revErrs.length}건 ──`);
  for (const x of reviews.filter((y) => Object.values(y.revenueClass ?? {}).includes("외부단독이탈"))) console.log(`  [외부 단독 이탈] ${x.sym} ${x.item}: ${x.verdict}`);
  for (const e of revErrs) console.log(`  [③ 오류] ${e.sym} ${e.item} — ${e.source} ${e.other} vs 앱 ${e.ours} (차 ${e.ours - e.other}) · ${e.note}`);
  console.log(`매출 검사 실패 ${revFails.length} · 매출 ③ 오류 ${revErrs.length}건${METRIC === "revenue" ? " (매출 닫기 모드 — 종료코드 기준)" : ""}`);
}
console.log(`\n실패 ${fails.length} · 오류 ${errors.length}(조회 실패 ${hardList.length}건) · 부당 건너뜀 ${badSkips.length} · 통과 0건 종목 ${empty.length} · 누락 ${missing.length}${MARKET === "us" ? ` · 매출 ③ 오류 ${revErrs.length}건` : ""} · 결과 ${decodeURIComponent(out.pathname)}`);
const infraBad = errors.length || badSkips.length || empty.length || missing.length;
process.exit(METRIC === "revenue" ? (revFails.length || revErrs.length || infraBad ? 1 : 0) : (fails.length || infraBad ? 1 : 0));
