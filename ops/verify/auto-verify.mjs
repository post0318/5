#!/usr/bin/env node
/**
 * 2호기 신규·변경 종목 자동 검증(오너 지시 2026-10-06 — "그걸 하기 위해 분리한 거잖아, 진행").
 * 매일 DB 복사(macro-db-sync, 05:30) 뒤 macro-auto-verify.timer(06:00 KST)가 2호기 ~/5(kr/verification) 에서 실행한다.
 *
 * 대상(우선순위 순, 같은 종목은 한 번):
 *  (a) 새 종목 — 유니버스(universe_items 전 계정 합집합, active≠false, 한국·미국)에 있는데 검증 결과(verify_results)가 없음
 *  (b) 새 정기보고서 — 한국: DART 정기공시 목록(corp_code 별 list.json) 최신 접수번호 / 미국: SEC submissions 최신 10-K·10-Q·20-F·40-F(정정 포함)
 *      접수번호가 마지막 검증 때 기록과 다름(기록이 없으면 그 공시일이 마지막 검증일 이후일 때). 6-K 는 넣지 않는다(보도자료가 섞여 매일 대상이 됨)
 *  (c) 마지막 검증 실패 — 실패 항목·오류가 있음, 또는 새 검증불가·공통모드 항목이 생김(마지막 실행이 오래된 것부터). 검증불가·공통모드만 있으면
 *      검증기 종료코드가 0 이라 조용히 지나갔다(감사 4차) — 종목별 기준선(verify_state.naBaseline = 새 항목이 없던 마지막 자동 실행의 항목 목록,
 *      「상태|층|이름|열」)과 비교해 기준선에 없는 항목이 생기면 naIncrease 를 남기고 실패와 같이 재실행한다(검증불가 자체를 실패로 세지는 않는다 —
 *      외부 사유도 있다). 건수가 아니라 항목 단위라 하나 풀리고 다른 하나가 생겨도 잡힌다(감사 5차). 해제는 자동 실행이 새 항목 없음을 확인했을
 *      때만 — 수동 --post 로 결과(runAt)가 바뀌어도 재실행 조건은 남는다. 후보 선정 때 지금 결과(수동 포함)를 기준선과 직접 비교하고, 열쇠에 사유(숫자 뺀
 *      앞 80자)를 넣는다(감사 6차). 기준선이 없는 종목은 "na-baseline" 으로 한 번 자동 실행해 그 결과를 기준선으로 삼는다(수동 결과는 기준선이 되지 않음)
 *  (d) 7일 넘게 검증 안 됨 — 오래된 것부터 하루 --stale 개
 *  전체 하루 --max 종목(기본 20). 넘치는 종목은 다음 날로(기록).
 *
 * 실행: 한국 = populate-kr-da.mjs(kr_da_staging, 증분) → verify-financials.mjs --market=kr, 미국 = verify-financials.mjs --market=us
 *  --metric=bscf --cogs-rules=scripts/metrics/cogs-rules.json(전체 모드 — 10-01 마감과 같은 기준, 2026-10-07).
 *  모두 --concurrency=1 --base=http://localhost:3000(2호기 verify-dev) --post(2호기 verify_results). 종목 하나씩 차례로(SEC·DART 순차).
 *
 * DART 하루 예산(--budget, 기본 5,000) = 카운터 파일(reports/.dart-quota/YYYYMMDD.json — 적재·검증기·이 스크립트) 합 + 앱 요청(verify-dev 저널의
 *  [dart-request] 줄 수, DART_CACHE_LOG=1). 한국 종목마다 시작 전 남은 예산이 --kr-reserve(기본 300) 미만이면 그 뒤 한국 종목은 다음 날로 미루고,
 *  자식 프로세스의 도구별 상한(DART_DAILY_CAP_POPULATE·_VERIFY)을 "지금 건수 + 남은 예산 − 앱 몫(--app-reserve, 기본 150)"으로 걸어 넘지 않게 한다.
 *
 * 결과: 2호기 DB verify_state(보호 컬렉션 — 종목별 마지막 실행·공시 접수번호), /var/lib/macro-verify/latest.json(1호기가 읽어 감, 원자적 갱신),
 *  /var/lib/macro-verify/last-run.json(점검 명령 macro-verify-check 가 읽음), 로그 /var/lib/macro-verify/logs/.
 *
 *   node ops/verify/auto-verify.mjs [--dry-run] [--only=new,filing,failed,stale] [--markets=kr,us] [--max=20] [--stale=5] [--symbols=kr:005930,us:AAPL]
 */
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync, createWriteStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { makeDartQuota } from "../../scripts/lib/dart-quota.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = process.env.MACRO_VERIFY_DIR || "/var/lib/macro-verify";
const BASE = "http://localhost:3000";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a); if (!m) throw new Error(`알 수 없는 인자 ${a}`); return [m[1], m[2] ?? true]; }));
const KNOWN = ["dry-run", "only", "markets", "max", "stale", "symbols", "budget", "kr-reserve", "app-reserve"];
for (const k of Object.keys(args)) if (!KNOWN.includes(k)) throw new Error(`알 수 없는 옵션 --${k}`);
const DRY = !!args["dry-run"];
const ONLY = new Set(String(args.only ?? "rerun,new,filing,failed,stale").split(","));
const MARKETS = String(args.markets ?? "kr,us").split(",");
const MAX = Number(args.max ?? 20), STALE_N = Number(args.stale ?? 5);
const BUDGET = Number(args.budget ?? 5000), KR_RESERVE = Number(args["kr-reserve"] ?? 300), APP_RESERVE = Number(args["app-reserve"] ?? 150);
const STALE_MS = 7 * 864e5;

const envFile = path.join(ROOT, ".env.local");
const env = {
  ...Object.fromEntries(readFileSync(envFile, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; })),
  ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v != null && v !== "")),
};
const QUOTA_DIR = env.DART_QUOTA_DIR ? path.resolve(env.DART_QUOTA_DIR) : path.join(ROOT, "reports/.dart-quota");
const kstDay = (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
const commit = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  + (execFileSync("git", ["-C", ROOT, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim() ? "-dirty" : "");
const branch = execFileSync("git", ["-C", ROOT, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();

mkdirSync(path.join(OUT, "logs"), { recursive: true });
const startedAt = new Date().toISOString();
const logPath = path.join(OUT, "logs", `auto-verify-${kstDay()}-${startedAt.slice(11, 16).replace(":", "")}.log`);
const logStream = DRY ? null : createWriteStream(logPath, { flags: "a" });
const log = (...a) => { const s = a.join(" "); console.log(s); logStream?.write(s + "\n"); };
const writeAtomic = (file, obj) => { const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o644 }); chmodSync(tmp, 0o644); renameSync(tmp, file); };

// ── DART 예산 ──────────────────────────────────────────────────────────
const quotaCounts = () => { try { return JSON.parse(readFileSync(path.join(QUOTA_DIR, `${kstDay()}.json`), "utf8")); } catch { return {}; } };
function appDartToday() {
  // verify-dev 저널(오늘 0시 KST 이후)의 [dart-request] 줄 수 — DART_CACHE_LOG=1 이 꺼져 있으면 0 으로 보이므로 확인해 둔다
  try {
    const since = `${kstDay().replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")} 00:00:00`;
    const out = execFileSync("journalctl", ["-u", "verify-dev", "--since", since, "-o", "cat", "--no-pager"], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
    return out.split("\n").filter((l) => l.includes("[dart-request]")).length;
  } catch { return null; }
}
function dartUsage() {
  const q = quotaCounts();
  const tools = Object.values(q).reduce((a, b) => a + b, 0);
  const app = appDartToday();
  return { tools: q, app, total: tools + (app ?? 0), remaining: BUDGET - tools - (app ?? 0) };
}
const usage0 = dartUsage();
const AUTO_QUOTA = makeDartQuota({ tool: "auto", cap: BUDGET, dir: QUOTA_DIR + "/" });

// ── 대상 판정 ──────────────────────────────────────────────────────────
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(env.MONGODB_URI ?? "")) throw new Error("MONGODB_URI 가 2호기 로컬 DB 가 아니다 — 운영 DB 에는 쓰지 않는다");
const cli = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 15_000 });
await cli.connect();
const db = cli.db(env.MONGODB_DB || "market_research");
const stateCol = db.collection("verify_state");

const universe = (await db.collection("universe_items").find({ active: { $ne: false }, market: { $in: MARKETS } }, { projection: { market: 1, symbol: 1 } }).toArray())
  .reduce((m, d) => m.set(`${d.market}:${d.symbol}`, { market: d.market, symbol: d.symbol }), new Map());
const results = new Map((await db.collection("verify_results").find({}, { projection: { market: 1, symbol: 1, runAt: 1, counts: 1, errors: 1, unverifiable: 1, common: 1 } }).toArray()).map((d) => [`${d.market}:${d.symbol}`, d]));
const states = new Map((await stateCol.find({}).toArray()).map((d) => [d._id, d]));
const isFailed = (r) => !!r && ((r.counts?.fail ?? 0) > 0 || (r.errors?.length ?? 0) > 0);
/** 재실행 조건 — 항목 배열(새 형식) 또는 옛 건수 형식 객체({ unverifiable: { before, after } }) 둘 다(옛 기록이 조용히 풀리지 않게) */
const hasNaUp = (st) => (Array.isArray(st?.naIncrease) ? st.naIncrease.length > 0 : !!st?.naIncrease);
/**
 * 검증불가·공통모드 항목 열쇠(상태|층|이름|열|사유) — 사유는 숫자를 지운 앞 80자(감사 6차 ③ — 같은 항목이 다른 사유로 바뀌어도 새 항목으로 잡는다.
 * 금액만 바뀐 것은 같은 항목)
 */
const naNote = (n) => String(n ?? "").replace(/[-−+]?\d[\d,.]*/g, "#").slice(0, 80);
const naItems = (r) => [...(r?.unverifiable ?? []).map((x) => `unverifiable|${x.layer}|${x.name}|${x.col}|${naNote(x.note)}`), ...(r?.common ?? []).map((x) => `common|${x.layer}|${x.name}|${x.col}|${naNote(x.note)}`)].sort();
/** 기준선 판본 — 열쇠 형식이 바뀌면 올린다(옛 판본 기준선은 없는 것으로 본다) */
const NA_BASE_V = 2;
/** 유효한 기준선(항목 배열). 기준선이 없는데 결과에 검증불가·공통모드가 하나도 없으면 빈 기준선. 그 밖엔 null(자동 실행으로 기준선을 만들어야 함) */
const baselineOf = (st, r) => (st?.naBaselineV === NA_BASE_V && Array.isArray(st.naBaseline) ? st.naBaseline : r && !naItems(r).length ? [] : null);

const corpMap = JSON.parse(readFileSync(path.join(ROOT, "src/lib/markets/kr/data/corpcodes.json"), "utf8"));
const corpOf = (s) => { const row = corpMap.find((r) => (r.s ?? r.stock_code) === s); return row ? (row.c ?? row.corp_code) : null; };

/** 한국 최신 정기공시 — corp 별 list.json 1건(최근 120일) */
async function krLatestFiling(sym) {
  const corp = corpOf(sym);
  if (!corp) return { err: "corp_code 없음" };
  const bgn = kstDay(Date.now() - 120 * 864e5);
  AUTO_QUOTA.take();
  const r = await fetch(`https://opendart.fss.or.kr/api/list.json?crtfc_key=${env.DART_API_KEY}&corp_code=${corp}&bgn_de=${bgn}&pblntf_ty=A&page_count=100`, { signal: AbortSignal.timeout(20_000) });
  const t = await r.text();
  AUTO_QUOTA.check(t.slice(0, 300));
  const j = JSON.parse(t);
  if (j.status === "013") return { id: null };
  if (j.status !== "000") return { err: `DART ${j.status}` };
  const top = j.list.map((x) => ({ id: x.rcept_no, date: x.rcept_dt, name: x.report_nm.trim() })).sort((a, b) => b.id.localeCompare(a.id))[0];
  return top ?? { id: null };
}

/** 미국 최신 정기공시 — SEC submissions 1건(순차, 0.2초 간격) */
let secTickers = null;
const SEC_FORMS = new Set(["10-K", "10-Q", "20-F", "40-F", "10-K/A", "10-Q/A", "20-F/A", "40-F/A"]);
const secHeaders = { "user-agent": env.SEC_USER_AGENT, accept: "application/json" };
async function usLatestFiling(sym) {
  if (!secTickers) {
    const j = await (await fetch("https://www.sec.gov/files/company_tickers.json", { headers: secHeaders, signal: AbortSignal.timeout(30_000) })).json();
    secTickers = new Map(Object.values(j).map((x) => [String(x.ticker).toUpperCase(), x.cik_str]));
  }
  const cik = secTickers.get(sym.toUpperCase()) ?? secTickers.get(sym.toUpperCase().replace(/\./g, "-"));
  if (!cik) return { err: "SEC CIK 없음" };
  await new Promise((r) => setTimeout(r, 200));
  const r = await fetch(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`, { headers: secHeaders, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) return { err: `SEC HTTP ${r.status}` };
  const rec = (await r.json()).filings?.recent;
  for (let i = 0; i < (rec?.form?.length ?? 0); i++)
    if (SEC_FORMS.has(rec.form[i])) return { id: rec.accessionNumber[i], date: rec.filingDate[i].replace(/-/g, ""), name: rec.form[i] };
  return { id: null };
}

const now = Date.now();
const cand = []; // { key, market, symbol, reason, sortKey }
const filingNow = new Map();
const notes = [];
const pinned = args.symbols ? new Set(String(args.symbols).split(",")) : null;
for (const [key, u] of universe) {
  if (pinned && !pinned.has(key)) continue;
  const r = results.get(key), st = states.get(key);
  const lastRun = r?.runAt ? Date.parse(r.runAt) : null;
  if (!r) { if (ONLY.has("new")) cand.push({ key, ...u, reason: "new", sortKey: 0 }); continue; }
  // 검증기 종료코드 3 = 게시 전 자료(KRX 전 거래일 등)로 확인 못 한 항목 → 다음 실행(11:00 재실행 회차)에 다시
  if (ONLY.has("rerun") && st?.lastCode === 3 && st.lastRunAt === r.runAt) { cand.push({ key, ...u, reason: "rerun", sortKey: 0.5 }); continue; }
  if (ONLY.has("filing")) {
    let f;
    try { f = u.market === "kr" ? await krLatestFiling(u.symbol) : await usLatestFiling(u.symbol); }
    catch (e) { f = { err: String(e?.message ?? e).slice(0, 120) }; if (e?.name === "DartStopError") throw e; }
    if (f.err) notes.push(`${key} 공시 조회 실패: ${f.err}`);
    else {
      filingNow.set(key, f);
      const changed = f.id && (st?.filingId ? st.filingId !== f.id : lastRun != null && f.date >= kstDay(lastRun));
      if (changed) { cand.push({ key, ...u, reason: "filing", sortKey: 1, filing: f }); continue; }
    }
  }
  if (ONLY.has("failed") && isFailed(r)) { cand.push({ key, ...u, reason: "failed", sortKey: 2 + (lastRun ?? 0) / 1e14 }); continue; }
  if (ONLY.has("failed") && hasNaUp(st)) { cand.push({ key, ...u, reason: "na-up", sortKey: 2 + (lastRun ?? 0) / 1e14 }); continue; }
  // 지금 결과(수동 --post 포함)를 기준선과 직접 비교(감사 6차 ③ — 예전엔 자동 실행 직후에만 비교해 수동 결과의 새 항목이 후보가 안 됐다)
  if (ONLY.has("failed") && r) {
    const b0 = baselineOf(st, r);
    if (b0 && naItems(r).some((k) => !b0.includes(k))) { cand.push({ key, ...u, reason: "na-up", sortKey: 2 + (lastRun ?? 0) / 1e14 }); continue; }
    // 기준선 없음 — 자동 실행 결과로 기준선을 만든다(수동 결과를 그대로 기준선으로 흡수하지 않게)
    if (!b0) { cand.push({ key, ...u, reason: "na-baseline", sortKey: 2.5 + (lastRun ?? 0) / 1e14 }); continue; }
  }
  if (ONLY.has("stale") && lastRun != null && now - lastRun > STALE_MS) cand.push({ key, ...u, reason: "stale", sortKey: 3 + lastRun / 1e14 });
}
cand.sort((a, b) => a.sortKey - b.sortKey);
// 하루 상한은 06:00·11:00 두 회차 합계 — 오늘(KST) 이미 돈 종목(재실행 제외)을 뺀다
const ranToday = [...states.values()].filter((d) => d.lastRunAt && kstDay(Date.parse(d.lastRunAt)) === kstDay() && d.lastReason !== "rerun");
const roomToday = Math.max(0, MAX - ranToday.length);
let staleTaken = ranToday.filter((d) => d.lastReason === "stale").length;
const targets = [], deferred = [];
for (const c of cand) {
  if (c.reason === "stale" && staleTaken >= STALE_N) { deferred.push({ key: c.key, reason: c.reason, why: "하루 오래된 종목 상한" }); continue; }
  if (c.reason !== "rerun" && targets.filter((t) => t.reason !== "rerun").length >= roomToday) { deferred.push({ key: c.key, reason: c.reason, why: "하루 종목 상한" }); continue; }
  if (c.reason === "stale") staleTaken++;
  targets.push(c);
}
log(`자동 검증 ${startedAt} · ${branch}@${commit.slice(0, 7)} · 유니버스 ${universe.size} · 후보 ${cand.length} · 대상 ${targets.length} · 미룸 ${deferred.length}`);
log(`DART 오늘 ${usage0.total}/${BUDGET}(도구 ${JSON.stringify(usage0.tools)}, 앱 ${usage0.app ?? "확인 불가"})`);
for (const t of targets) log(`  대상 ${t.key} — ${t.reason}${t.filing ? ` (${t.filing.name} ${t.filing.id})` : ""}`);
for (const n of notes) log(`  ${n}`);
if (usage0.app == null) notes.push("verify-dev 저널을 읽지 못해 앱 DART 요청을 0 으로 셈");

// ── 실행 ───────────────────────────────────────────────────────────────
function run(cmd, argv, extraEnv, timeoutMs) {
  return new Promise((resolve) => {
    const p = spawn(cmd, argv, { cwd: ROOT, env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const eat = (b) => { const s = b.toString(); logStream?.write(s); tail = (tail + s).slice(-2000); };
    p.stdout.on("data", eat); p.stderr.on("data", eat);
    const timer = setTimeout(() => { p.kill("SIGTERM"); tail += "\n[시간 초과]"; }, timeoutMs);
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, tail }); });
  });
}
async function devUp() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(BASE + "/", { signal: AbortSignal.timeout(20_000) }); if (r.status < 500) return true; } catch { /* 재시도 */ }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return false;
}

const done = [];
let runFailed = 0, budgetStop = false;
if (!DRY && targets.length) {
  if (!(await devUp())) throw new Error("verify-dev(localhost:3000) 응답 없음");
  for (const t of targets) {
    const t0 = Date.now();
    const before = results.get(t.key)?.runAt ?? null;
    const capEnv = {};
    if (t.market === "kr") {
      const u = dartUsage();
      if (budgetStop || u.remaining < KR_RESERVE) {
        budgetStop = true;
        deferred.push({ key: t.key, reason: t.reason, why: `DART 예산(남은 ${u.remaining} < ${KR_RESERVE})` });
        log(`  미룸 ${t.key} — DART 예산 남은 ${u.remaining}`);
        continue;
      }
      const room = Math.max(0, u.remaining - APP_RESERVE);
      capEnv.DART_DAILY_CAP_POPULATE = String((u.tools.populate ?? 0) + room);
      capEnv.DART_DAILY_CAP_VERIFY = String((u.tools.verify ?? 0) + room);
      const p = await run("node", ["scripts/populate-kr-da.mjs", t.symbol], capEnv, 30 * 60e3);
      log(`  ${t.key} 적재 종료코드 ${p.code}`);
      if (p.code !== 0) { runFailed++; done.push({ key: t.key, reason: t.reason, ok: false, step: "populate", code: p.code, tail: p.tail.slice(-300) }); continue; }
    }
    // 미국 = 전체 모드(오너 지시 2026-10-07 — "같아야 검증이 되는 것 아닌가, 자동은 빠진 채 검증되면 무엇이 검증되나"): 10-01 마감 기준과 같은
    // --metric=bscf(매출원가·매출총이익·합성 영업이익·감가상각·판관비·연구개발비 본표 대조 + 재무상태표·현금흐름표 A·D층) + cogs-rules.
    // 한국은 모드 구분이 없다(검증기 --metric 은 미국만)
    const FULL = t.market === "us" ? ["--metric=bscf", "--cogs-rules=scripts/metrics/cogs-rules.json"] : [];
    const v = await run("node", ["scripts/verify-financials.mjs", `--market=${t.market}`, `--symbols=${t.symbol}`, ...FULL, "--concurrency=1", `--base=${BASE}`, "--post"],
      { ...capEnv, GITHUB_SHA: commit }, 40 * 60e3);
    const after = await db.collection("verify_results").findOne({ _id: t.key });
    const posted = after?.runAt && after.runAt !== before;
    // 종료코드 1 = 실패 항목 있음, 3 = 게시 전 자료로 재실행 필요(둘 다 정상 완료), 그 밖(2·null·시간 초과)이거나 결과가 저장되지 않았으면 실행 실패
    const ok = posted && (v.code === 0 || v.code === 1 || v.code === 3);
    if (!ok) runFailed++;
    log(`  ${t.key} 검증 종료코드 ${v.code} · 결과 저장 ${posted ? "됨" : "안 됨"} · ${Math.round((Date.now() - t0) / 1000)}초${after?.counts ? ` · 통과 ${after.counts.pass} 실패 ${after.counts.fail} 검증불가 ${after.counts.unverifiable}` : ""}`);
    // 기준선 = 새 항목이 없던 마지막 자동 실행의 검증불가·공통모드 항목. 기준선이 없으면(처음·옛 판본) 이번 자동 실행 결과가 기준선(기록에 남김) —
    // 수동 결과로 기준선을 만들지 않는다(감사 6차 ③)
    // 기준선 = 후보 선정과 같은 판정(baselineOf — 실행 전 결과가 깨끗하면 빈 기준선). 그래도 없으면 실행 전 결과를 임시 기준선으로 비교만 한다(감사 7차 ③ —
    // 기준선 없는 종목이 새 공시·오래됨으로 돌면 새 항목이 경보 없이 기준선이 됐다). 새 항목이 있으면 기준선을 바꾸지 않고 재실행 대상으로 남긴다
    const st0 = states.get(t.key);
    const prevR = results.get(t.key) ?? null;
    const base = baselineOf(st0, prevR) ?? (prevR ? naItems(prevR) : null);
    const nowItems = posted ? naItems(after) : null;
    const up = posted && base ? nowItems.filter((k) => !base.includes(k)) : [];
    if (posted && !base) log(`  ${t.key} 검증불가·공통모드 기준선 처음 설정 — ${nowItems.length}건(자동 실행 결과)`);
    if (up.length) log(`  ${t.key} 새 검증불가·공통모드 ${up.length}건 — ${up.slice(0, 5).join(" ; ")}(재실행 대상)`);
    done.push({ key: t.key, reason: t.reason, ok, code: v.code, ...(up.length ? { naIncrease: up } : {}), ...(ok ? {} : { tail: v.tail.slice(-300) }) });
    if (posted) {
      const f = filingNow.get(t.key) ?? t.filing;
      await stateCol.updateOne({ _id: t.key }, { $set: { market: t.market, symbol: t.symbol, lastRunAt: after.runAt, lastReason: t.reason, lastCode: v.code, commit,
        naIncrease: up.length ? up : null, naBaseline: up.length ? base : nowItems, naBaselineV: NA_BASE_V, ...(base ? {} : { naBaselineSetAt: after.runAt }), ...(f?.id ? { filingId: f.id, filingDate: f.date, filingName: f.name } : {}) } }, { upsert: true });
    }
  }
}
// 공시 기준선 — 처음 보는 종목은 지금 접수번호를 기록해 둔다(다음부터 "달라졌는지"로 판정)
if (!DRY) for (const [key, f] of filingNow) if (f.id && !states.get(key)?.filingId && !done.some((d) => d.key === key))
  await stateCol.updateOne({ _id: key }, { $setOnInsert: { market: key.split(":")[0], symbol: key.slice(key.indexOf(":") + 1) }, $set: { filingId: f.id, filingDate: f.date, filingName: f.name } }, { upsert: true });

// ── 결과 내보내기 ──────────────────────────────────────────────────────
const usage1 = dartUsage();
const finishedAt = new Date().toISOString();
const runSummary = {
  startedAt, finishedAt, dryRun: DRY, ok: runFailed === 0, commit, branch,
  options: { only: [...ONLY], markets: MARKETS, max: MAX, stale: STALE_N, budget: BUDGET },
  targets: targets.map((t) => ({ key: t.key, reason: t.reason })), done, deferred, runFailed,
  dart: { budget: BUDGET, before: usage0.total, after: usage1.total, used: usage1.total - usage0.total, tools: usage1.tools, app: usage1.app, exceeded: usage1.total > BUDGET },
  notes, log: DRY ? null : logPath,
};
if (!DRY) {
  const universeAll = new Set((await db.collection("universe_items").find({ active: { $ne: false } }, { projection: { market: 1, symbol: 1 } }).toArray()).map((d) => `${d.market}:${d.symbol}`));
  const all = await db.collection("verify_results").find({ market: { $in: ["kr", "us"] } }).toArray();
  const stAll = new Map((await stateCol.find({}).toArray()).map((d) => [d._id, d]));
  writeAtomic(path.join(OUT, "latest.json"), {
    schema: "macro-verify/latest@1",
    generatedAt: finishedAt,
    host: "macro-verify(2호기)",
    code: { branch, commit },
    commit,
    run: { startedAt, finishedAt, ok: runSummary.ok, targets: targets.length, done: done.length, failedRuns: runFailed, deferred: deferred.length, dartUsedToday: usage1.total, dartBudget: BUDGET },
    naIncrease: [...stAll.values()].filter(hasNaUp).map((x) => ({ key: x._id, items: x.naIncrease })),
    // 1호기가 운영 /api/cron/verify-results 로 그대로 넣는 원본(--post 가 보내는 VerifyResultDoc 그대로, _id 만 뺌, base = 2호기 표시)
    results: all.map((d) => ({ ...Object.fromEntries(Object.entries(d).filter(([k]) => k !== "_id")), base: "2호기 verify-dev(http://localhost:3000)" })),
    symbols: all.sort((a, b) => a._id.localeCompare(b._id)).map((d) => ({
      market: d.market,
      symbol: d.symbol,
      inUniverse: universeAll.has(d._id),
      verifiedAt: d.runAt,
      commit: d.commit ?? null,
      result: (d.errors?.length ?? 0) > 0 ? "error" : (d.counts?.fail ?? 0) > 0 ? "fail" : "pass",
      // 기준선에 없던 검증불가·공통모드 항목(결과는 pass 일 수 있음 — 재실행 대상). 기준선 = 새 항목이 없던 마지막 자동 실행
      naIncrease: stAll.get(d._id)?.naIncrease ?? null,
      counts: { pass: d.counts?.pass ?? 0, fail: d.counts?.fail ?? 0, unverifiable: d.counts?.unverifiable ?? 0, common: d.counts?.common ?? 0, extMismatch: d.counts?.extMismatch ?? 0 },
      errors: (d.errors ?? []).slice(0, 3).map((e) => String(e).slice(0, 200)),
      topFails: (d.fails ?? []).slice(0, 5).map((f) => ({ layer: f.layer, name: f.name, col: f.col, note: String(f.note ?? "").slice(0, 160) })),
      lastReason: stAll.get(d._id)?.lastReason ?? null,
      filing: stAll.get(d._id)?.filingId ? { id: stAll.get(d._id).filingId, date: stAll.get(d._id).filingDate, name: stAll.get(d._id).filingName } : null,
    })),
  });
  writeAtomic(path.join(OUT, "last-run.json"), runSummary);
}
log(`끝 — 실행 ${done.length} · 실행 실패 ${runFailed} · 미룸 ${deferred.length} · DART 이번 ${usage1.total - usage0.total}건(오늘 ${usage1.total}/${BUDGET})`);
if (DRY) console.log(JSON.stringify({ targets: runSummary.targets, deferred, notes }, null, 2));
await cli.close();
logStream?.end();
process.exitCode = runFailed ? 1 : 0;
