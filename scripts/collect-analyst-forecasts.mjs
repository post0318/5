/**
 * StockAnalysis.com — 개별 애널리스트 투자의견 수집기.
 *
 * Yahoo `upgradeDowngradeHistory`(증권사 단위)로는 애널리스트 개인명·정확도를
 * 알 수 없어(유료 데이터) 오너 지시로 추가(2026-09). 종목당 최신 8건(무료로
 * 받을 수 있는 소스 상한, 실측)을 모아 DB 에 스냅샷으로 저장한다.
 *
 * ⚠️ 접근 근거 (다른 수집기들과 달리 깨끗한 편):
 *    - robots.txt 가 `/stocks/*​/forecast/` 를 막지 않는다(Disallow 는 `/e/`,`/p/` 뿐).
 *    - ToS 에 크롤링·자동화 금지 조항이 없다. 콘텐츠 제한은 "republish in full"
 *      금지 하나뿐이고, "you can use snippets of the content as long as you do not
 *      modify the content and clearly state where you got it from" 이라고 명시.
 *      → 종목당 8행·하루 1회·출처 명시(화면에 "출처: StockAnalysis.com") 로 준수.
 *    - 원문 본문·차트·전체 목록은 저장하지 않는다.
 *    - 배포본(Vercel)에는 이 코드가 없다 — 로컬/GitHub Actions 전용.
 *
 * 페이지는 SvelteKit 이라 HTML 파싱 대신 데이터 엔드포인트를 직접 쓴다:
 *   GET /stocks/{ticker}/ratings/__data.json?x-sveltekit-invalidated=001
 * 응답은 devalue 평탄화 배열이라 아래 unflatten 으로 되살린다.
 *
 * ── 실행 ────────────────────────────────────────────────────────────
 *   node scripts/collect-analyst-forecasts.mjs
 *   node scripts/collect-analyst-forecasts.mjs --symbols=NFLX,AAPL --dry-run
 *   node scripts/collect-analyst-forecasts.mjs --limit=50 --delay=2000
 */

import { readFileSync } from "node:fs";

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
const ENV = loadEnvLocal();
const ARGS = process.argv.slice(2);
const arg = (name) => ARGS.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const DRY_RUN = ARGS.includes("--dry-run");
const ONLY = (arg("symbols") || "")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const LIMIT = Number(arg("limit")) || 0;
/** 종목당 저장 행 수. 소스가 주는 최대치(8건, 실측). */
const MAX_ROWS = 8;
// 저빈도 원칙 — 종목당 1요청, 기본 2초 간격.
const DELAY_MS = Number(arg("delay")) || 2000;

const APP_URL = (ENV.APP_URL || "https://5-topaz-five.vercel.app").replace(/\/$/, "");
const IMPORT_URL = (ENV.ANALYST_FORECAST_IMPORT_URL || `${APP_URL}/api/cron/analyst-forecasts`).trim();
const CRON_SECRET = (ENV.CRON_SECRET || "").trim();
const APP_PASSWORD = (ENV.APP_PASSWORD || "").trim();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * devalue 평탄화 배열 → 원래 객체. arr[0] 이 루트이고, 모든 값이 배열 인덱스로
 * 치환돼 있다. 음수는 devalue 예약 상수(-1 undefined, -3 NaN, ...).
 */
function unflatten(arr) {
  const seen = new Map();
  const CONST = { "-1": undefined, "-2": undefined, "-3": NaN, "-4": Infinity, "-5": -Infinity, "-6": -0 };
  function walk(i) {
    if (typeof i !== "number") return i;
    if (i < 0) return CONST[String(i)];
    if (seen.has(i)) return seen.get(i);
    const v = arr[i];
    if (v === null || typeof v !== "object") {
      seen.set(i, v);
      return v;
    }
    if (Array.isArray(v)) {
      const out = [];
      seen.set(i, out);
      for (const k of v) out.push(walk(k));
      return out;
    }
    const out = {};
    seen.set(i, out);
    for (const [k, idx] of Object.entries(v)) out[k] = walk(idx);
    return out;
  }
  return walk(0);
}

async function fetchForecast(symbol) {
  // StockAnalysis 는 소문자 티커 경로를 쓰고, BRK.B 같은 점 표기는 하이픈이다.
  const slug = symbol.toLowerCase().replace(/\./g, "-");
  // /ratings/ 가 /forecast/ 보다 많이 준다 — 실측: forecast 5건, ratings 8건
  // (NFLX·AAPL·NVDA·KO 동일). ?p=2·?range=all 로도 8건이 상한이고 그 이상은
  // Pro 유료 구간이라 무료로 받을 수 있는 최대치가 8건이다.
  const url = `https://stockanalysis.com/stocks/${encodeURIComponent(slug)}/ratings/__data.json?x-sveltekit-invalidated=001`;
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const node = (json.nodes ?? []).find((n) => n?.type === "data" && Array.isArray(n.data));
  if (!node) throw new Error("data 노드 없음");
  const root = unflatten(node.data);
  const ratings = Array.isArray(root?.ratings) ? root.ratings : [];
  return ratings
    .filter((r) => r?.date && r?.firm)
    .slice(0, MAX_ROWS)
    .map((r) => ({
      date: String(r.date).slice(0, 10),
      analyst: r.analyst ?? "",
      analystSlug: r.slug ?? null,
      firm: r.firm,
      rating: r.rating_new ?? "",
      // 등급 변경이 없으면 소스가 빈 문자열을 준다.
      ratingOld: r.rating_old || null,
      action: r.action_rt ?? "",
      priceTarget: typeof r.pt_now === "number" ? r.pt_now : null,
      priceTargetOld: typeof r.pt_old === "number" ? r.pt_old : null,
      currency: r.curr ?? "USD",
      // 정확도 지표. stock_* 는 "이 애널리스트가 이 종목을 얼마나 맞혔나"라
      // Top Analysts(Pro 전용)의 종목별 점수와 성격이 같다.
      score: num(r.scores?.score),
      stars: num(r.scores?.stars),
      successRate: num(r.scores?.success_rate),
      avgReturn: num(r.scores?.avg_return),
      analystRank: num(r.scores?.analyst_rank),
      rankedExperts: num(r.scores?.number_of_ranked_experts),
      totalRatings: num(r.scores?.total),
      stockSuccessRate: num(r.scores?.stock_success_rate),
      stockAvgReturn: num(r.scores?.stock_avg_return),
    }));
}

async function listUsSymbols() {
  if (ONLY.length > 0) return ONLY;
  const res = await fetch(`${APP_URL}/api/universe?market=us&active=1`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`유니버스 조회 실패 HTTP ${res.status}`);
  const body = await res.json();
  const symbols = (body.items ?? [])
    .map((it) => String(it.symbol || "").trim().toUpperCase())
    .filter(Boolean);
  return [...new Set(symbols)];
}

const headers = { "Content-Type": "application/json" };
if (CRON_SECRET) headers.Authorization = "Bearer " + CRON_SECRET;
else if (APP_PASSWORD) headers["x-app-token"] = APP_PASSWORD;

const symbols = await listUsSymbols();
const targets = LIMIT > 0 ? symbols.slice(0, LIMIT) : symbols;
console.log(`대상 ${targets.length}개 종목 (전체 ${symbols.length})`);

let ok = 0;
let empty = 0;
let failed = 0;
for (const [i, symbol] of targets.entries()) {
  if (i > 0) await sleep(DELAY_MS);
  let items;
  try {
    items = await fetchForecast(symbol);
  } catch (err) {
    console.error(`✗ ${symbol} 수집 실패: ${err.message}`);
    failed++;
    continue;
  }
  if (items.length === 0) {
    console.log(`· ${symbol} 애널리스트 의견 없음`);
    empty++;
    continue;
  }
  if (DRY_RUN) {
    console.log(`[dry-run] ${symbol} ${items.length}건`);
    for (const it of items) {
      const pt = it.priceTargetOld != null ? `${it.priceTargetOld}→${it.priceTarget}` : it.priceTarget;
      console.log(`    ${it.date}  ${it.analyst} (${it.firm})  ${it.rating}/${it.action}  PT ${pt}  ★${it.stars ?? "-"}`);
    }
    ok++;
    continue;
  }
  const up = await fetch(IMPORT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ symbol, market: "us", items }),
  });
  const text = await up.text();
  if (!up.ok) {
    console.error(`✗ ${symbol} 전송 실패 HTTP ${up.status}: ${text.slice(0, 200)}`);
    failed++;
    continue;
  }
  console.log(`✔ ${symbol} ${items.length}건 전송`);
  ok++;
}

console.log(`\n완료 — 성공 ${ok} · 의견없음 ${empty} · 실패 ${failed}`);
