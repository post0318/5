/**
 * 재무 지표 리팩터(`docs/metrics/architecture.md`·`docs/metrics/revenue.md`) 전후 비교용
 * 베이스라인 스냅샷 도구. 앱 API 응답을 그대로 저장해두고, 리팩터 전/후 두 스냅샷을 셀 단위로
 * 비교해 "예상한 변경" 목록 밖의 변화만 걸러낸다 — 매출 지표를 새 파이프라인으로 옮길 때 의도치
 * 않은 화면 값 변화(회귀)를 잡기 위한 것.
 *
 * **지표 전환 표준 절차(2026-09-26 상시화)** — 지표를 fin 으로 옮길 때마다: ① 착수 전 --save=.omc/snapshots/<지표>-before
 *  ② 전환 후 --save=.omc/snapshots/<지표>-after ③ --diff 로 "예상한 변경"(scripts/metrics/gen-expected.mjs 로 만든
 *  scripts/metrics/expected/<지표>.json) 밖의 변화가 0 인지 확인 ④ 골든셋(scripts/metrics/golden.mjs check)으로 닫힌 지표 무변화 확인.
 *
 * ── 대상 종목 ─────────────────────────────────────────────────────────
 *  기본값 = 유니버스(미국, `/api/cron/universe-symbols?market=us`) + 아래 고정 추가 목록.
 *  추가 목록은 revenue.md 의 알려진 정의 차이·확인된 결함(R1~R8, D1~D7)에 실제 등장한 종목들
 *  (은행·증권·보험·리츠·20-F·재작성 사례 등 유형별 대표) — 유니버스에 없어도 회귀 여부를 봐야 함.
 *    NVO, SAP, GS, MS, JPM, TRV, AFL, MET, PSA, GM, F, DE, DELL, GE, WDC, SHW
 *  `--symbols=A,B,C` 로 완전히 덮어쓸 수 있다.
 *
 * ── 대상 엔드포인트 (종목당) ──────────────────────────────────────────
 *  - GET /api/markets/us/{sym}/highlights
 *  - GET /api/markets/us/{sym}/financials?view={is|bs|cf|analysis|summary}&period={annual|quarter}  (10건)
 *  - GET /api/markets/us/{sym}/ttm
 *  - GET /api/markets/us/{sym}/consensus
 *  - GET /api/markets/us/{sym}/overview
 *  - GET /api/cron/verify-row?market=us&symbol={sym}  (x-app-token 인증 — 유니버스 "행" 데이터는
 *    이걸로 충분하다, 별도 유니버스 목록 API 스냅샷은 안 뜬다)
 *
 * ── 사용법 ────────────────────────────────────────────────────────────
 *  저장(리팩터 전):
 *    node scripts/metrics/baseline-snapshot.mjs --save=snapshots/before
 *  저장(리팩터 후 — 같은 대상 종목으로 다시):
 *    node scripts/metrics/baseline-snapshot.mjs --save=snapshots/after
 *  비교:
 *    node scripts/metrics/baseline-snapshot.mjs --diff=snapshots/before,snapshots/after \
 *      --expected=scripts/metrics/expected/revenue.json
 *
 *  옵션:
 *    --symbols=AAPL,WMT     대상 종목 직접 지정(기본값 목록을 덮어씀)
 *    --base=http://...      기본 http://localhost:3000
 *    --force                이미 저장된 파일도 다시 받는다(기본은 이어받기 — 존재하면 건너뜀)
 *    --out=path.json        --diff 결과를 JSON 으로도 저장
 *
 * ── 저장 구조 ─────────────────────────────────────────────────────────
 *    {dir}/{SYMBOL}/highlights.json
 *    {dir}/{SYMBOL}/financials-{view}-{period}.json   (예: financials-is-annual.json)
 *    {dir}/{SYMBOL}/ttm.json
 *    {dir}/{SYMBOL}/consensus.json
 *    {dir}/{SYMBOL}/overview.json
 *    {dir}/{SYMBOL}/verify-row.json
 *    {dir}/{SYMBOL}/_meta.json   종목별 요청 성공/실패 기록(이어받기 판단용)
 *
 *  요청은 **순차**(종목 단위)로 보낸다 — 서버 부하를 걱정할 필요 없는 로컬 개발 서버 대상이지만,
 *  실패 시 어디까지 받았는지 파일 존재 여부로 알 수 있게 하기 위함이다. 이미 성공적으로 받은
 *  파일은 `--force` 없이는 다시 받지 않는다(중단 후 재개 가능).
 *
 * ── --diff 비교 방식 ──────────────────────────────────────────────────
 *  두 디렉터리의 같은 {심볼}/{엔드포인트}.json 을 재귀적으로 깊이 비교해 값이 다른 리프(leaf)
 *  경로를 전부 뽑는다. `--expected` 파일(JSON 배열)에 있는 항목과 매치되면 "예상된 변경"으로
 *  걸러내고, 나머지만 "예상 밖 변경"으로 출력한다.
 *
 *  --expected 파일 형식 (배열, 각 항목의 필드는 전부 선택):
 *    [
 *      { "symbol": "WMT", "endpoint": "highlights", "pathPrefix": "revenue",
 *        "note": "매출 파이프라인 교체로 값이 바뀔 것으로 예상됨" },
 *      { "symbol": "*", "endpoint": "financials-is-annual", "pathPrefix": "rows" }
 *    ]
 *  `symbol`/`endpoint` 생략 또는 "*" 는 전체 매치. `pathPrefix` 생략은 그 심볼+엔드포인트 전체를
 *  예상된 변경으로 처리(주의해서 사용).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

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
const KNOWN = new Set(["save", "diff", "expected", "symbols", "base", "force", "out"]);
for (const k of Object.keys(args)) if (!KNOWN.has(k)) die(`알 수 없는 옵션 --${k}`);
if (!args.save && !args.diff) die("--save=<dir> 또는 --diff=<dirA>,<dirB> 중 하나가 필요");
if (args.save && args.diff) die("--save 와 --diff 는 동시에 쓰지 않는다");

const BASE = String(args.base ?? "http://localhost:3000").replace(/\/$/, "");
const MARKET = "us";

const EXTRA_SYMBOLS = [
  "NVO", "SAP", "GS", "MS", "JPM", "TRV", "AFL", "MET", "PSA",
  "GM", "F", "DE", "DELL", "GE", "WDC", "SHW",
];

const VIEWS = ["is", "bs", "cf", "analysis", "summary"];
const PERIODS = ["annual", "quarter"];

function loadEnvLocal() {
  const env = { ...process.env };
  try {
    const raw = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
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

async function getJson(url, headers = {}) {
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000), cache: "no-store", headers });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`JSON 파싱 실패: ${text.slice(0, 200)}`);
  }
}

function endpointsFor(sym) {
  const list = [{ name: "highlights", url: `${BASE}/api/markets/${MARKET}/${sym}/highlights` }];
  for (const view of VIEWS) {
    for (const period of PERIODS) {
      list.push({
        name: `financials-${view}-${period}`,
        url: `${BASE}/api/markets/${MARKET}/${sym}/financials?view=${view}&period=${period}`,
      });
    }
  }
  list.push({ name: "ttm", url: `${BASE}/api/markets/${MARKET}/${sym}/ttm` });
  list.push({ name: "consensus", url: `${BASE}/api/markets/${MARKET}/${sym}/consensus` });
  list.push({ name: "overview", url: `${BASE}/api/markets/${MARKET}/${sym}/overview` });
  list.push({
    name: "verify-row",
    url: `${BASE}/api/cron/verify-row?market=${MARKET}&symbol=${sym}`,
    headers: AUTH,
  });
  return list;
}

async function symbolList() {
  if (args.symbols) return String(args.symbols).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const r = await fetch(`${BASE}/api/cron/universe-symbols?market=${MARKET}`, { headers: AUTH });
  if (!r.ok) throw new Error(`유니버스 목록 조회 실패 HTTP ${r.status} ${(await r.text()).slice(0, 80)}`);
  const universe = (await r.json()).items.map((i) => String(i.symbol).toUpperCase());
  const merged = new Set([...universe, ...EXTRA_SYMBOLS]);
  return [...merged].sort();
}

// ── --save ───────────────────────────────────────────────────────────
async function runSave() {
  const dir = String(args.save);
  const symbols = await symbolList();
  console.log(`대상 ${symbols.length}종목 → ${dir}`);
  for (const sym of symbols) {
    const symDir = path.join(dir, sym);
    mkdirSync(symDir, { recursive: true });
    const metaPath = path.join(symDir, "_meta.json");
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {};
    for (const ep of endpointsFor(sym)) {
      const filePath = path.join(symDir, `${ep.name}.json`);
      if (!args.force && meta[ep.name] === "ok" && existsSync(filePath)) continue;
      try {
        const data = await getJson(ep.url, ep.headers ?? {});
        writeFileSync(filePath, JSON.stringify(data, null, 1));
        meta[ep.name] = "ok";
        console.log(`  ${sym} ${ep.name} 저장`);
      } catch (e) {
        meta[ep.name] = `error: ${e.message}`.slice(0, 300);
        console.log(`  ${sym} ${ep.name} 실패 — ${e.message}`);
      }
      writeFileSync(metaPath, JSON.stringify(meta, null, 1));
    }
  }
  console.log("완료.");
}

// ── --diff ───────────────────────────────────────────────────────────
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** a·b 를 재귀 비교해 값이 다른 리프 경로만 뽑는다. */
function deepDiff(a, b, prefix = "", out = []) {
  if (a === b) return out;
  const aIsObj = isPlainObject(a);
  const bIsObj = isPlainObject(b);
  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  if (aIsObj && bIsObj) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) deepDiff(a[k], b[k], prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  if (aIsArr && bIsArr) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) deepDiff(a[i], b[i], `${prefix}[${i}]`, out);
    return out;
  }
  // 타입이 다르거나(object vs array 포함) 원시값이 다름 — 리프로 기록
  const numA = typeof a === "number" && typeof b === "number";
  if (numA && Number.isFinite(a) && Number.isFinite(b) && a === b) return out;
  out.push({ path: prefix || "(root)", a, b });
  return out;
}

function loadExpected(file) {
  if (!file) return [];
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(raw)) die("--expected 파일은 JSON 배열이어야 함");
  return raw;
}

function isExpected(rules, symbol, endpoint, diffPath) {
  return rules.some((r) => {
    const symOk = !r.symbol || r.symbol === "*" || r.symbol === symbol;
    const epOk = !r.endpoint || r.endpoint === "*" || r.endpoint === endpoint;
    const pathOk = r.pathPrefix == null || diffPath.startsWith(r.pathPrefix);
    return symOk && epOk && pathOk;
  });
}

function runDiff() {
  const [dirA, dirB] = String(args.diff).split(",").map((s) => s.trim());
  if (!dirA || !dirB) die("--diff=<dirA>,<dirB> 형식이어야 함");
  const rules = loadExpected(args.expected);
  const symbols = readdirSync(dirA).filter((f) => existsSync(path.join(dirA, f, "_meta.json")));
  const unexpected = [];
  const expectedHit = [];
  for (const sym of symbols) {
    const dirASym = path.join(dirA, sym);
    const dirBSym = path.join(dirB, sym);
    if (!existsSync(dirBSym)) {
      unexpected.push({ symbol: sym, endpoint: "(all)", path: "(missing in B)", a: "존재", b: "없음" });
      continue;
    }
    const files = readdirSync(dirASym).filter((f) => f.endsWith(".json") && f !== "_meta.json");
    for (const f of files) {
      const endpoint = f.replace(/\.json$/, "");
      const fileA = path.join(dirASym, f);
      const fileB = path.join(dirBSym, f);
      if (!existsSync(fileB)) {
        unexpected.push({ symbol: sym, endpoint, path: "(missing in B)", a: "존재", b: "없음" });
        continue;
      }
      let a, b;
      try {
        a = JSON.parse(readFileSync(fileA, "utf8"));
        b = JSON.parse(readFileSync(fileB, "utf8"));
      } catch (e) {
        unexpected.push({ symbol: sym, endpoint, path: "(parse)", a: e.message, b: null });
        continue;
      }
      for (const d of deepDiff(a, b)) {
        const rec = { symbol: sym, endpoint, ...d };
        if (isExpected(rules, sym, endpoint, d.path)) expectedHit.push(rec);
        else unexpected.push(rec);
      }
    }
  }
  console.log(`대상 종목 ${symbols.length}개, 예상된 변경 ${expectedHit.length}건, 예상 밖 변경 ${unexpected.length}건`);
  if (unexpected.length) {
    console.log("\n=== 예상 밖 변경 ===");
    for (const u of unexpected) {
      console.log(`  ${u.symbol} ${u.endpoint} ${u.path}: ${JSON.stringify(u.a)} → ${JSON.stringify(u.b)}`);
    }
  }
  if (args.out) {
    writeFileSync(String(args.out), JSON.stringify({ expectedHit, unexpected }, null, 1));
    console.log(`\n결과 저장: ${args.out}`);
  }
  if (unexpected.length) process.exitCode = 1;
}

if (args.save) await runSave();
else runDiff();
