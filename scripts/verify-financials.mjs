/**
 * 재무 숫자 검증 체계 2·3층 (오너 지시 2026-09-23 — "검증체계는 구축해라").
 *
 * 1층(단일 계산 모듈 강제)은 eslint.config.mjs 의 no-restricted-syntax 규칙이다.
 * 이 스크립트는 **실행 중인 앱의 API** 를 그대로 호출해, 사용자가 보는 숫자를
 * 기준으로 검사한다(내부 함수를 따로 불러 계산하면 화면과 다른 경로를 검증하게
 * 된다).
 *
 * 2층 — 내부 정합성 (정답 없이도 판정 가능, 결과는 통과·실패·검증불가 3단계.
 *        값이 없어 확인 못 한 것을 "통과"로 치지 않는다):
 *   - 화면 간 동일성: EV/EBITDA·PER·PBR·PSR(하이라이트↔재무분석↔컨센서스↔개요),
 *     EBITDA·EPS(하이라이트↔손익계산서), 차입금·순차입금(하이라이트↔대차대조표 주석)
 *   - 항등식: EV = 시가총액 + 파트너지분 + 차입금 + 우선주·비지배지분 − 현금,
 *     EV/EBITDA = EV ÷ EBITDA, PBR = 시가총액 ÷ 자기자본,
 *     시가총액 ÷ PER ≈ 순이익(= EPS × 주식수 ≈ 순이익, 허용오차 max(2%, 0.005/|EPS|)),
 *     자산 총계 = 부채와 자본 총계
 * 3층 — 외부 대조 (정의 차이가 있어 판정이 아니라 **검토 목록**):
 *   - LTM EBITDA vs Yahoo 분기 재무제표 4개 합(영업이익 + 현금흐름표 감가상각비)
 *     ※ Yahoo 요약값(financialData.ebitda)은 자체 재무제표와도 안 맞아(CL·SUNB) 안 씀
 *   - 총차입금(운용리스 포함) vs Yahoo 분기 대차대조표 totalDebt(리스 포함, 같은 날짜)
 *   - 시가총액 vs Yahoo marketCap
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/verify-financials.mjs --symbols=AAPL,WMT,MCD
 *   node scripts/verify-financials.mjs --universe          # 유니버스(미국) 전체
 *   node scripts/verify-financials.mjs --sp500 --limit=50  # S&P 500 (위키피디아 목록)
 *   옵션: --base=http://localhost:3000 (기본) · --concurrency=2 · --no-external
 * 결과: reports/verify/verify-YYYY-MM-DD.json + 콘솔 요약. 실패가 있으면 종료코드 1.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

// ── 인자·환경 ─────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const BASE = String(args.base ?? "http://localhost:3000").replace(/\/$/, "");
const CONCURRENCY = Number(args.concurrency ?? 2);
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

async function getJson(path, timeoutMs = 240_000) {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

async function symbolList() {
  if (args.symbols) return String(args.symbols).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (args.universe) {
    const headers = env.CRON_SECRET
      ? { authorization: `Bearer ${env.CRON_SECRET}` }
      : { "x-app-token": env.APP_PASSWORD ?? "" };
    const r = await fetch(`${BASE}/api/cron/universe-symbols?market=us`, { headers });
    if (!r.ok) throw new Error(`유니버스 목록 조회 실패 HTTP ${r.status}`);
    return (await r.json()).items.map((i) => i.symbol);
  }
  if (args.sp500) {
    const raw = await (
      await fetch("https://en.wikipedia.org/w/index.php?title=List_of_S%26P_500_companies&action=raw", {
        headers: { "user-agent": "financial-verify-script" },
      })
    ).text();
    const tbl = raw.slice(raw.indexOf("{|"), raw.indexOf("|}", raw.indexOf("{|")));
    const out = [];
    for (const row of tbl.split("\n|-").slice(1)) {
      const m = row.match(/\{\{(?:NyseSymbol|NasdaqSymbol|[A-Za-z]+Symbol)\|([A-Z.\-]+)/i);
      const sector = row.split(/\n\|/)[3] ?? "";
      if (m && !/Financials/.test(sector)) out.push(m[1].replace(".", "-"));
    }
    return args.limit ? out.slice(0, Number(args.limit)) : out;
  }
  throw new Error("--symbols=… | --universe | --sp500 중 하나를 지정하세요");
}

const SEC_UA = env.SEC_USER_AGENT ?? "global-market-research (personal use) contact@example.com";
let cikMap = null;
async function cikOf(sym) {
  if (!cikMap) {
    const j = await (await fetch("https://www.sec.gov/files/company_tickers.json", { headers: { "user-agent": SEC_UA } })).json();
    cikMap = new Map(Object.values(j).map((r) => [r.ticker.toUpperCase().replace(".", "-"), String(r.cik_str).padStart(10, "0")]));
  }
  return cikMap.get(sym.toUpperCase().replace(".", "-")) ?? null;
}

// ── 판정 도우미 ───────────────────────────────────────────────────────
const PASS = "pass", FAIL = "fail", NA = "unverifiable";
const EXACT = 1e-9; // 화면 간 동일성 — 같은 모듈을 거치므로 부동소수 오차만 허용
function same(a, b, tol = EXACT) {
  if (a == null && b == null) return { status: PASS, note: "양쪽 모두 빈칸" };
  if (a == null || b == null) return { status: FAIL, note: `한쪽만 빈칸 (${a} vs ${b})` };
  const d = Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
  return d <= tol ? { status: PASS } : { status: FAIL, note: `${a} vs ${b} (차 ${(d * 100).toFixed(4)}%)` };
}
function needBoth(a, b) {
  return a == null || b == null ? { status: NA, note: "값 없음" } : null;
}

// ── 종목 1개 검증 ─────────────────────────────────────────────────────
async function verifySymbol(sym, yf) {
  const u = `/api/markets/us/${encodeURIComponent(sym)}`;
  const checks = [];
  const add = (layer, name, col, r) => checks.push({ layer, name, col, ...r });
  const identityReview = [];

  const support = await getJson(`${u}/support`).catch(() => null);
  if (support && support.supported === false) return { sym, skipped: "모기지 리츠(지원 제외)", checks };

  const [hl, an, ov, tt, cs, is, bs] = await Promise.all([
    getJson(`${u}/highlights`),
    getJson(`${u}/financials?view=analysis`),
    getJson(`${u}/overview`),
    getJson(`${u}/ttm`),
    getJson(`${u}/consensus`).catch(() => null),
    getJson(`${u}/financials?view=is&period=annual`),
    getJson(`${u}/financials?view=bs&period=annual`),
  ]);
  const h = hl.highlights;
  if (!h) return { sym, skipped: "하이라이트 없음", checks };
  // SEC 원본: 연도별 가중평균 희석주식수·공시 희석 EPS (항등식 검사용)
  let wavgDil = null, wavgBasic = null, epsRepByYear = null, niCommonByYear = null;
  try {
    const cik = await cikOf(sym);
    if (cik) {
      const f = await (await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: { "user-agent": SEC_UA } })).json();
      const annual = (c, unit) => {
        const m = new Map();
        for (const e of f.facts?.["us-gaap"]?.[c]?.units?.[unit] ?? []) {
          if (e.fp !== "FY" || !e.start || !/^10-K/.test(e.form)) continue;
          const d = (Date.parse(e.end) - Date.parse(e.start)) / 864e5;
          if (d < 300 || d > 400) continue;
          const y = Number(e.end.slice(0, 4)), p = m.get(y);
          if (!p || e.end > p.end || (e.end === p.end && e.filed >= p.filed)) m.set(y, e);
        }
        return new Map([...m].map(([y, e]) => [y, e.val]));
      };
      wavgDil = annual("WeightedAverageNumberOfDilutedSharesOutstanding", "shares");
      wavgBasic = annual("WeightedAverageNumberOfSharesOutstandingBasic", "shares");
      epsRepByYear = annual("EarningsPerShareDiluted", "USD/shares");
      // EPS 분자 — 보통주 귀속 순이익(우선주 배당 차감 후) 우선
      niCommonByYear = annual("NetIncomeLossAvailableToCommonStockholdersDiluted", "USD");
    }
  } catch { /* SEC 실패 시 항등식은 검증불가 */ }
  const bank = !h.rows.some((r) => r.key === "ev"); // 은행 하이라이트는 EV 브릿지가 없다

  // 하이라이트 열 → 라벨("2025Y"·"LTM")별 값
  const H = {};
  h.columns.forEach((c, i) => {
    if (c.kind === "estimate") return;
    const lab = c.kind === "ltm" ? "LTM" : c.label;
    const row = (k) => h.rows.find((r) => r.key === k)?.values[i] ?? null;
    const val = (k) => h.valuationRows.find((r) => r.key === k)?.values[i] ?? null;
    H[lab] = {
      mc: row("mktcap"), op: row("opunits"), cash: row("cash"), debt: row("debt"), pn: row("pref_nci"),
      ev: row("ev"), ebitda: row("ebitda"), ni: row("ni"), eps: row("eps"),
      per: val("per"), pbr: val("pbr"), psr: val("psr"), evx: val("ev_ebitda"),
    };
  });
  const rowOf = (stmt, name) => stmt?.sections?.[0]?.items?.find((x) => x.accountName === name)?.values ?? {};
  const lab = (k) => (k === "현재/LTM" ? "LTM" : k);
  const A = {}, IS = {}, BS = {};
  for (const [name, key] of [["EV/EBITDA", "evx"], ["PER", "per"], ["PBR", "pbr"], ["PSR", "psr"]])
    for (const [k, v] of Object.entries(rowOf(an, name))) (A[lab(k)] ??= {})[key] = v;
  for (const [name, key] of [["EBITDA", "ebitda"], ["희석 EPS", "eps"], ["당기순이익", "ni"]])
    for (const [k, v] of Object.entries(rowOf(is, name))) (IS[lab(k)] ??= {})[key] = v;
  for (const [name, key] of [["총차입금", "debt"], ["순차입금", "nd"], ["자산 총계", "assets"], ["부채와 자본 총계", "le"]])
    for (const [k, v] of Object.entries(rowOf(bs, name))) (BS[lab(k)] ??= {})[key] = v;
  const C = {};
  for (const r of cs?.rows ?? []) if (!r.isEstimate) C[`${r.fy}Y`] = r;

  const cols = Object.keys(H);
  for (const c of cols) {
    const x = H[c];
    // ── 2층: 화면 간 동일성
    if (!bank) add(2, "EV/EBITDA 하이라이트=재무분석", c, same(A[c]?.evx ?? null, x.evx));
    add(2, "PER 하이라이트=재무분석", c, same(A[c]?.per ?? null, x.per));
    add(2, "PBR 하이라이트=재무분석", c, same(A[c]?.pbr ?? null, x.pbr));
    add(2, "PSR 하이라이트=재무분석", c, same(A[c]?.psr ?? null, x.psr));
    if (c !== "LTM" && C[c]) {
      if (!bank) add(2, "EV/EBITDA 컨센서스=하이라이트", c, same(C[c].evEbitda ?? null, x.evx));
      add(2, "PER 컨센서스=하이라이트", c, same(C[c].per ?? null, x.per));
      add(2, "PBR 컨센서스=하이라이트", c, same(C[c].pbr ?? null, x.pbr));
    }
    add(2, "순이익 하이라이트=손익계산서", c, same(IS[c]?.ni ?? null, x.ni));
    if (c !== "LTM" && C[c]) add(2, "순이익 컨센서스=하이라이트", c, same(C[c].netIncome ?? null, x.ni));
    if (!bank) {
      add(2, "EBITDA 하이라이트=손익계산서", c, same(IS[c]?.ebitda ?? null, x.ebitda));
      if (x.debt != null && BS[c]) {
        add(2, "차입금 하이라이트=대차대조표 주석", c, same(BS[c].debt ?? null, x.debt));
        add(2, "순차입금 하이라이트=대차대조표 주석", c, same(BS[c].nd ?? null, x.debt - (x.cash == null ? 0 : -x.cash)));
      }
    }
    // ── 2층: 항등식
    if (!bank && x.ev != null) {
      const sum = (x.mc ?? 0) + (x.op ?? 0) + (x.debt ?? 0) + (x.pn ?? 0) + (x.cash ?? 0); // cash 행은 음수로 표시
      add(2, "EV = 시총+파트너지분+차입금+우선주·NCI−현금", c, same(x.ev, sum, 1e-9));
      if (x.ebitda != null && x.ebitda > 0) add(2, "EV/EBITDA = EV÷EBITDA", c, same(x.evx, x.ev / x.ebitda));
    }
    // EPS × 가중평균 희석주식수 ≈ 순이익 — 회사 공시 자체의 정합성(단위 오류 등, MCD 사례).
    // 기말 주식수가 아니라 EPS 의 분모인 가중평균을 쓴다(합병·증자 연도에 기말과 크게 다름).
    if (c !== "LTM") {
      const y = Number(c.slice(0, 4));
      const epsRep = epsRepByYear?.get(y) ?? null;
      // 적자 연도는 희석 EPS 도 기본 주식수로 계산된다(잠재주식이 손실을 희석하므로 반희석 제외)
      const w = epsRep != null && epsRep < 0 ? (wavgBasic?.get(y) ?? wavgDil?.get(y) ?? null) : (wavgDil?.get(y) ?? null);
      const ni = niCommonByYear?.get(y) ?? x.ni;
      if (w != null && epsRep != null && ni != null && epsRep !== 0) {
        const tol = Math.max(0.02, 0.005 / Math.abs(epsRep));
        let r = same(epsRep * w, ni, tol);
        // 공시 단위 오류(주식수를 천·백만 단위로 태깅 — MCD) 는 앱이 보정한다(edgar-shares fixScale)
        if (r.status === FAIL)
          for (const k of [1e3, 1e6])
            if (same(epsRep * w * k, ni, tol).status === PASS)
              r = { status: PASS, note: `공시 주식수 단위 오류(×${k}) — 앱에서 보정` };
        // 앱 EPS 가 공시 EPS 와 같다면(분할 보정 포함) 어긋남은 회사 공시 자체의 계산(우선주
        // 조정 등 — AT&T 2022)이라 앱이 고칠 대상이 아니다 → 실패가 아니라 검토 목록으로.
        const appMatchesFiling =
          x.eps != null && [1, 2, 3, 4, 5, 10, 20].some((k) => Math.abs(x.eps * k - epsRep) <= 1e-6 * Math.abs(epsRep) || Math.abs(x.eps - epsRep * k) <= 1e-6 * Math.abs(x.eps));
        if (r.status === FAIL && appMatchesFiling) {
          identityReview.push({ item: `${c} 공시 EPS×주식수≠순이익 (앱 EPS=공시 EPS)`, note: r.note });
          r = { status: NA, note: "공시 자체 불일치 — 검토 목록" };
        }
        add(2, "공시 EPS × 가중평균 희석주식수 ≈ 순이익", c, r.status === FAIL ? { ...r, note: `${r.note} · 허용 ${(tol * 100).toFixed(1)}%` } : r);
      } else add(2, "공시 EPS × 가중평균 희석주식수 ≈ 순이익", c, { status: NA, note: "공시 EPS·가중평균 주식수 없음(클래스별 공시 등)" });
    }
    if (BS[c]) {
      const miss = needBoth(BS[c].assets, BS[c].le);
      // 공시 자체의 반올림(수십만 달러) 차이는 허용
      add(2, "자산 총계 = 부채와 자본 총계", c, miss ?? same(BS[c].assets, BS[c].le, 5e-4));
    }
  }

  // 개요 멀티플(브라우저 계산과 같은 식) vs 하이라이트 LTM
  if (!bank && tt?.ttm?.snapshot && ov?.quote?.last && H.LTM) {
    const sn = tt.ttm.snapshot, px = ov.quote.last, co = ov.consensus;
    const opu = sn.isReit && co?.impliedSharesOutstanding > co?.sharesOutstanding * 1.005
      ? co.impliedSharesOutstanding - co.sharesOutstanding : 0;
    const ev = sn.evBlocker || sn.evNetDebt == null ? null
      : px * sn.evShares + (opu ? opu * px - (sn.evOpNciBook ?? 0) : 0) + sn.evNetDebt;
    const eb = tt.ttm.opIncome != null ? tt.ttm.opIncome + (tt.ttm.daTtm ?? 0) : null;
    add(2, "EV/EBITDA 개요=하이라이트", "LTM", same(ev != null && eb > 0 ? ev / eb : null, H.LTM.evx));
    // 개요 PER(TTM)·PBR·PSR — multiples.ts 미국 경로와 같은 식
    const mcO = sn.evShares ? px * sn.evShares : null;
    const pos = (n, d) => (n != null && d != null && d > 0 ? n / d : null);
    add(2, "PER(LTM) 개요=하이라이트", "LTM", same(pos(px, tt.ttm.eps), H.LTM.per));
    add(2, "PBR 개요=하이라이트", "LTM", same(pos(mcO, sn.equity), H.LTM.pbr));
    add(2, "PSR 개요=하이라이트", "LTM", same(pos(mcO, tt.ttm.revenue), H.LTM.psr));
  }

  // ── 3층: 외부 대조 (검토 목록)
  const review = [];
  if (EXTERNAL && yf && !bank) {
    try {
      const q = await yf.fundamentalsTimeSeries(sym, { period1: new Date(Date.now() - 500 * 864e5), type: "quarterly", module: "all" });
      const last4 = q.filter((r) => r.totalOperatingIncomeAsReported != null).slice(-4);
      if (last4.length === 4 && H.LTM?.ebitda != null) {
        const y = last4.reduce((s, r) => s + r.totalOperatingIncomeAsReported + (r.reconciledDepreciation ?? 0), 0);
        review.push({ item: "LTM EBITDA vs Yahoo 분기합(영업이익+현금흐름 감가상각)", ours: H.LTM.ebitda, yahoo: y, gapPct: (H.LTM.ebitda - y) / Math.abs(y) * 100 });
      }
      const bsq = q.filter((r) => r.totalDebt != null).at(-1);
      const withLease = rowOf(bs, "총차입금 (운용리스 포함)")["현재/LTM"];
      if (bsq && withLease != null)
        review.push({ item: `총차입금(리스 포함) vs Yahoo totalDebt @${new Date(bsq.date).toISOString().slice(0, 10)}`, ours: withLease, yahoo: bsq.totalDebt, gapPct: (withLease - bsq.totalDebt) / bsq.totalDebt * 100 });
      const qs = await yf.quoteSummary(sym, { modules: ["price"] });
      if (qs.price?.marketCap && H.LTM?.mc)
        review.push({ item: "시가총액 vs Yahoo", ours: H.LTM.mc, yahoo: qs.price.marketCap, gapPct: (H.LTM.mc - qs.price.marketCap) / qs.price.marketCap * 100 });
    } catch (e) {
      review.push({ item: "Yahoo 조회 실패", note: String(e).slice(0, 80) });
    }
  }
  review.push(...identityReview);
  return { sym, checks, review: review.filter((r) => r.gapPct == null || Math.abs(r.gapPct) > 5), reviewAll: review };
}

// ── 실행 ─────────────────────────────────────────────────────────────
const syms = await symbolList();
let yf = null;
if (EXTERNAL) {
  const req = createRequire(new URL("../package.json", import.meta.url));
  const mod = await import(new URL(`file:///${req.resolve("yahoo-finance2").replace(/\\/g, "/")}`).href);
  const YF = mod.default?.default ?? mod.default ?? mod;
  yf = new YF({ suppressNotices: ["yahooSurvey"], validation: { logErrors: false } });
}
console.log(`검증 대상 ${syms.length}종목 · ${BASE} · 외부대조 ${EXTERNAL ? "켬" : "끔"}`);
const results = [];
let idx = 0;
function savePartial() {
  try {
    mkdirSync(new URL("../reports/verify/", import.meta.url), { recursive: true });
    writeFileSync(new URL("../reports/verify/partial.json", import.meta.url), JSON.stringify({ base: BASE, total: syms.length, results }));
  } catch { /* 중간 저장 실패는 무시 */ }
}
async function worker() {
  while (idx < syms.length) {
    const s = syms[idx++];
    try {
      const r = await verifySymbol(s, yf);
      results.push(r);
      if (results.length % 10 === 0) savePartial();
      const f = r.checks.filter((c) => c.status === FAIL).length;
      const n = r.checks.filter((c) => c.status === NA).length;
      console.log(`${s.padEnd(6)} ${r.skipped ? "건너뜀: " + r.skipped : `실패 ${f} · 검증불가 ${n} · 통과 ${r.checks.length - f - n} · 외부검토 ${r.review.length}`}`);
    } catch (e) {
      results.push({ sym: s, error: String(e).slice(0, 120), checks: [] });
      console.log(`${s.padEnd(6)} 오류: ${String(e).slice(0, 100)}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const all = results.flatMap((r) => r.checks.map((c) => ({ sym: r.sym, ...c })));
const fails = all.filter((c) => c.status === FAIL);
const byName = {};
for (const c of all) {
  const b = (byName[c.name] ??= { pass: 0, fail: 0, unverifiable: 0 });
  b[c.status]++;
}
console.log("\n── 검사 항목별 ──");
for (const [n, b] of Object.entries(byName)) console.log(`  ${n.padEnd(44)} 통과 ${b.pass} · 실패 ${b.fail} · 검증불가 ${b.unverifiable}`);
if (fails.length) {
  console.log("\n── 실패 상세 ──");
  for (const f of fails.slice(0, 60)) console.log(`  ${f.sym} ${f.col} ${f.name}: ${f.note ?? ""}`);
}
const reviews = results.flatMap((r) => (r.review ?? []).map((x) => ({ sym: r.sym, ...x })));
if (reviews.length) {
  console.log("\n── 외부 대조 검토 목록 (|차이| > 5%) ──");
  for (const x of reviews.slice(0, 60))
    console.log(`  ${x.sym} ${x.item}: ${x.gapPct != null ? x.gapPct.toFixed(1) + "%" : x.note}`);
}
const errors = results.filter((r) => r.error);
mkdirSync(new URL("../reports/verify/", import.meta.url), { recursive: true });
const out = new URL(`../reports/verify/verify-${new Date().toISOString().slice(0, 10)}.json`, import.meta.url);
writeFileSync(out, JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2));
console.log(`\n실패 ${fails.length} · 오류 ${errors.length} · 결과 파일 ${out.pathname}`);
process.exit(fails.length || errors.length ? 1 : 0);
