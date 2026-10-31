/**
 * 일본 검증기 X층 — 외부 대조(docs/verify-common/11-design-app-external.md ③·⑤ 일본, 13-open-decisions.md D1·D2·D10).
 * 검증 스크립트 안에서만 쓴다(오너 결정 D10 (가) 2026-10-14 — 株探·みんかぶ 검증 대조 허용, 야후재팬 = 오너 예외 5 "검증 외부 대조").
 * 앱 코드와 공유 없음(앱 src/lib/markets/jp/* 를 읽지 않는다). 앱 값은 실행 중인 앱 API 응답(verifyJp 가 받은 것)만 쓴다.
 *
 * 소스(계보 — 11 ③-5: 일본 현지 각 사. 株探·みんかぶ 는 같은 운영사(MINKABU THE INFONOID)지만 D2 일본 1곳 기준이라 곳 수는 따지지 않는다)
 *   kabutan  https://kabutan.jp/stock/finance?code={코드}       업績推移(通期)·キャッシュフロー推移·財務【実績】 — 백만엔, 1株益 소수 1자리, 1株配 엔
 *   minkabu  https://minkabu.jp/stock/{코드}/settlement          決算情報·財務情報·キャッシュフロー — 백만엔, 1株益 소수 2자리
 *   yahoojp  https://finance.yahoo.co.jp/quote/{코드}.T/performance  페이지에 박힌 RSC 데이터(연간 Q4 행) — 엔(백만엔 배수), epsActual 소수 2자리
 *   (IFRS·US 기준 회사의 「経常益/経常利益/ordinaryIncome」 칸은 세전이익 — 株探 표 주석 「米国会計基準と国際会計基準では、「経常益」欄の数値は「税引き前利益」」)
 *
 * 캐시(11 ③-4): JP_VERIFY_EXT_CACHE_DIR(기본 ~/verify-ext-cache)/<소스>/<종목>/<열쇠>/<수집 KST 날짜>.{body,meta.json}
 *   열쇠 = 그 종목 최신 有報 접수번호(docID) — 새 有報가 나와야 다시 받는다. 그 有報 제출 7일 뒤가 지나도록 그 전에 받은 것뿐이면 1회 더(사이트 반영 지연).
 *   실패(HTTP ≠ 200·연결 오류)도 저장하고 같은 KST 날짜에는 다시 묻지 않는다. 옛 파일은 지우지 않는다. 원문은 이 로컬 캐시에만 — DB 에는 판정·차이만.
 * 요청 간격(11 ③-6): kabutan.jp 3초 이상(robots Crawl-delay 3), 그 밖 일본 호스트 1.5초 이상, 호스트마다 한 줄.
 *
 * 판정(칸 = 지표 × 사업연도, 소스마다 하나로 분류 — 13 D1·D2):
 *   일치            외부 값 × 표기 단위 = 앱 값(허용 오차 없음)
 *   식으로 원인 확인  차이가 원자료 숫자 식으로 정확히 성립(예: 외부 = 원자료 기본 EPS, 앱 = 희석 EPS). 앱이 오너 결정 정의와 다름이 식으로 드러나면 불일치로 센다
 *   원인 미확인 불일치 그 밖의 차이
 *   정밀도 부족      외부 표기 단위로 앱 값을 반올림(0.5 는 0 에서 먼 쪽)하거나 버려야만 같음 — 검증불가(D1: 허용 오차 금지, 근거로 세지 않음)
 *   외부 값 없음     그 소스에 그 칸이 없음
 *   공통모드         앱과 같은 원천(COMMON_SRC) — 일치로 세지 않는다(지금 실적 칸에는 해당 소스 없음)
 * 칸 상태(X층 검사): 독립 소스 1곳 이상 일치 → 통과(D2 일본 1곳) — 이때 어긋난 다른 소스는 「외부 단독 이탈」 / 일치 없이 불일치 → 실패 /
 *   그 밖 → 검증불가(사유: 식으로 원인 확인·정밀도 부족·외부 값 없음) / 공통모드뿐 → 공통모드.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
export const SRC_NAME = { kabutan: "株探", minkabu: "みんかぶ", yahoojp: "Yahoo!ファイナンス" };
const URL_OF = {
  kabutan: (c) => `https://kabutan.jp/stock/finance?code=${c}`,
  minkabu: (c) => `https://minkabu.jp/stock/${c}/settlement`,
  yahoojp: (c) => `https://finance.yahoo.co.jp/quote/${c}.T/performance`,
};
const GAP_MS = { "kabutan.jp": 3000 };
const DEFAULT_GAP = 1500;
/** 앱과 같은 원천인 소스 — 항목별. 실적 재무 칸은 앱이 EDINET 만 쓰므로 비어 있다(앱 민카부 카드는 analyst_consensus — 이 층 대상 아님) */
const COMMON_SRC = {};

let cfg = { root: join(homedir(), "verify-ext-cache"), offline: false };
export const extStats = { requests: 0, cacheHit: 0, failedStored: 0, byHost: {} };
export function configureJpExt(o) {
  cfg = { ...cfg, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) };
}

const kstDate = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostOf = (u) => new URL(u).host;
const chains = new Map();
const lastAt = new Map();
async function politeFetch(url) {
  const h = hostOf(url);
  const gap = GAP_MS[h] ?? DEFAULT_GAP;
  const prev = chains.get(h) ?? Promise.resolve();
  let release;
  const mine = new Promise((r) => (release = r));
  chains.set(h, prev.then(() => mine));
  await prev;
  try {
    const w = (lastAt.get(h) ?? 0) + gap - Date.now();
    if (w > 0) await sleep(w);
    extStats.requests++;
    extStats.byHost[h] = (extStats.byHost[h] ?? 0) + 1;
    try {
      const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "ja,en;q=0.5" }, signal: AbortSignal.timeout(60_000) });
      const body = Buffer.from(await r.arrayBuffer());
      return { status: r.status, body };
    } catch (e) {
      return { status: 0, body: Buffer.from(String(e?.message ?? e)) };
    } finally {
      lastAt.set(h, Date.now());
    }
  } finally {
    release();
  }
}
function writeAtomic(f, data) {
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, f);
}

/**
 * 원문 받기(캐시 우선). key = 최신 有報 docID, keyAt = 그 서류 제출일(YYYY-MM-DD). → { status, text, from: "cache"|"net", at, file } | { error }
 */
export async function extPage(src, code, key, keyAt) {
  const dir = join(cfg.root, src, code, key);
  const today = kstDate();
  const lagDue = keyAt ? new Date(Date.parse(`${keyAt}T00:00:00Z`) + 7 * 864e5).toISOString().slice(0, 10) : null;
  const metas = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".meta.json")).sort() : [];
  const okMetas = metas.map((f) => ({ f, m: JSON.parse(readFileSync(join(dir, f), "utf8")) })).filter((x) => x.m.status === 200);
  const best = okMetas.at(-1);
  // 성공본이 있고 (사이트 반영 지연 재수집이 필요 없거나 이미 했으면) 그것을 쓴다
  const needLagRefetch = best && lagDue && best.m.day < lagDue && today >= lagDue;
  if (best && !needLagRefetch) {
    extStats.cacheHit++;
    return { status: 200, text: readFileSync(join(dir, best.f.replace(/\.meta\.json$/, ".body")), "utf8"), from: "cache", at: best.m.fetchedAt, file: join(dir, best.f) };
  }
  // 오늘 이미 실패했으면 다시 묻지 않는다(실패도 기억)
  const todayFail = metas.find((f) => f.startsWith(today) && JSON.parse(readFileSync(join(dir, f), "utf8")).status !== 200);
  if (todayFail) {
    const m = JSON.parse(readFileSync(join(dir, todayFail), "utf8"));
    extStats.cacheHit++;
    if (best) return { status: 200, text: readFileSync(join(dir, best.f.replace(/\.meta\.json$/, ".body")), "utf8"), from: "cache", at: best.m.fetchedAt, file: join(dir, best.f), note: `재수집 실패(${m.status}) — 이전 수집본` };
    return { error: `${SRC_NAME[src]} 조회 실패(오늘 ${m.status === 0 ? "연결 오류" : `HTTP ${m.status}`} — 캐시된 실패, 같은 날 재요청 안 함)` };
  }
  if (cfg.offline) {
    if (best) return { status: 200, text: readFileSync(join(dir, best.f.replace(/\.meta\.json$/, ".body")), "utf8"), from: "cache", at: best.m.fetchedAt, file: join(dir, best.f) };
    return { error: `${SRC_NAME[src]} 캐시 없음(오프라인 실행)` };
  }
  const url = URL_OF[src](code);
  const r = await politeFetch(url);
  mkdirSync(dir, { recursive: true });
  const stamp = `${today}T${new Date(Date.now() + 9 * 3600e3).toISOString().slice(11, 19).replace(/:/g, "")}`;
  const meta = { url, status: r.status, day: today, fetchedAt: new Date().toISOString(), bytes: r.body.length, sha256: createHash("sha256").update(r.body).digest("hex"), key, keyAt };
  writeAtomic(join(dir, `${stamp}.body`), r.body);
  writeAtomic(join(dir, `${stamp}.meta.json`), JSON.stringify(meta));
  if (r.status !== 200) {
    extStats.failedStored++;
    const why = `${SRC_NAME[src]} 조회 실패(${r.status === 0 ? `연결 오류 ${r.body.toString().slice(0, 60)}` : `HTTP ${r.status}`})`;
    if (best) return { status: 200, text: readFileSync(join(dir, best.f.replace(/\.meta\.json$/, ".body")), "utf8"), from: "cache", at: best.m.fetchedAt, file: join(dir, best.f), note: `재수집 실패 — 이전 수집본` };
    return { error: why };
  }
  return { status: 200, text: r.body.toString("utf8"), from: "net", at: meta.fetchedAt, file: join(dir, `${stamp}.meta.json`) };
}

// ── 판독 ──
/** HTML → " | " 로 칸을 나눈 평문(스크립트·스타일 제거, 엔티티 풀기, NFKC 안 함 — 원문 표기 유지) */
function plain(html) {
  let t = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ");
  t = t.replace(/<[^>]+>/g, " | ");
  t = t.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");
  t = t.replace(/\s+/g, " ").replace(/(\|\s*)+/g, "| ");
  return t;
}
const NUM_RE = "(-?[\\d,]+(?:\\.\\d+)?|－|-|---)";
/** 숫자 칸 → { v, dec(소수 자릿수) } | null(「－」 등 값 없음). 「52*」 같은 표시 기호는 떼어 낸다 */
function cell(s) {
  const x = String(s ?? "").trim().replace(/[*#]$/, "");
  if (!x || /^(－|-|---|‐)$/.test(x)) return null;
  if (!/^-?[\d,]+(\.\d+)?$/.test(x)) return undefined;
  const dec = x.includes(".") ? x.split(".")[1].length : 0;
  return { v: Number(x.replace(/,/g, "")), dec };
}
const ym = (y, m) => `${y}-${String(m).padStart(2, "0")}`;

/** 株探 → { [YYYY-MM]: { revenue, op, ordinary, ni, eps, dps, ocf, icf, fin(재무CF), cashEnd, assets, equity } } 값 = { v, unit } */
export function parseKabutan(html) {
  const t = plain(html);
  const out = {};
  const put = (k, f, c, unit) => { if (c === undefined) return; (out[k] ??= {})[f] = c == null ? null : { v: c.v * unit, unit, dec: c.dec }; };
  // 업績推移(通期) — 첫 「決算期 | 売上高 | 営業益 | 経常益 | 最終益 | 修正 | 1株益 | 修正 | 1株配 | 発表日」 표, 예상(「予」) 행 제외
  const i0 = t.indexOf("決算期 | 売上高 | 営業益 | 経常益 | 最終益 | 修正 | 1株益 | 修正 | 1株配 | 発表日");
  if (i0 >= 0) {
    const seg = t.slice(i0, t.indexOf("前期比", i0) > 0 ? t.indexOf("前期比", i0) : i0 + 3000);
    for (const m of seg.matchAll(new RegExp(`\\| (?:([^|]{1,10}) \\| )?(\\d{4})\\.(\\d{2}) \\| ${Array(6).fill(NUM_RE).join(" \\| ")} \\| (?=\\d{2}/\\d{2}/\\d{2})`, "g"))) {
      if (/予|旧|新/.test(m[1] ?? "")) continue; // 예상 행(「予」·修正 전후)
      const k = ym(m[2], m[3]);
      put(k, "revenue", cell(m[4]), 1e6); put(k, "op", cell(m[5]), 1e6); put(k, "ordinary", cell(m[6]), 1e6); put(k, "ni", cell(m[7]), 1e6);
      put(k, "eps", cell(m[8]), 1); put(k, "dps", cell(m[9]), 1);
    }
  }
  // キャッシュフロー推移(通期)
  const i1 = t.indexOf("キャッシュフロー(CF＝現金収支)推移");
  if (i1 >= 0) {
    const seg = t.slice(i1, i1 + 2500);
    // 칸: 営業益 | フリーCF | 営業CF | 投資CF | 財務CF | 現金等残高 | 現金比率
    for (const m of seg.matchAll(new RegExp(`\\| (?:([^|]{1,10}) \\| )?(\\d{4})\\.(\\d{2}) \\| ${Array(7).fill(NUM_RE).join(" \\| ")}(?= \\|)`, "g"))) {
      if (/予/.test(m[1] ?? "")) continue;
      const k = ym(m[2], m[3]);
      put(k, "ocf", cell(m[6]), 1e6); put(k, "icf", cell(m[7]), 1e6); put(k, "fin", cell(m[8]), 1e6); put(k, "cashEnd", cell(m[9]), 1e6);
    }
  }
  // 財務【実績】 — 「決算期 | １株 | 純資産 | 自己資本 | 比率 | 総資産 | 自己資本 | 剰余金 | 有利子 | 負債倍率 | 発表日」, 분기 행(26.04-06) 제외
  const i2 = t.indexOf("財務 【実績】 | 決算期");
  if (i2 >= 0) {
    const seg = t.slice(i2, t.indexOf("※単位について", i2) > 0 ? t.indexOf("※単位について", i2) : i2 + 2500);
    // 칸: １株純資産 | 自己資本比率 | 総資産 | 自己資本 | 剰余金 | 有利子負債倍率
    for (const m of seg.matchAll(new RegExp(`\\| (?:([^|]{1,10}) \\| )?(\\d{4})\\.(\\d{2}) \\| ${Array(6).fill(NUM_RE).join(" \\| ")} \\| (?=\\d{2}/\\d{2}/\\d{2})`, "g"))) {
      if (/予/.test(m[1] ?? "")) continue;
      const k = ym(m[2], m[3]);
      put(k, "assets", cell(m[6]), 1e6); put(k, "equity", cell(m[7]), 1e6);
    }
  }
  return out;
}

/** みんかぶ settlement → { [YYYY-MM]: { revenue, op, ordinary, ni, eps, assets, netAssets, ocf, icf, fin(재무CF), cashEnd } } */
export function parseMinkabu(html) {
  const t = plain(html);
  const out = {};
  const put = (k, f, c, unit) => { if (c === undefined) return; (out[k] ??= {})[f] = c == null ? null : { v: c.v * unit, unit, dec: c.dec }; };
  const sect = (head, end) => { const i = t.indexOf(head); if (i < 0) return ""; const j = t.indexOf(end, i + head.length); return t.slice(i, j > 0 ? j : i + 3000); };
  const row = (n) => new RegExp(`\\| ?(\\d{4})年 \\| (\\d{1,2})月期 \\| ${n}`, "g");
  for (const m of sect("決算情報 | 決算期 | (決算発表日)", "単位：百万円").matchAll(row(`\\(\\d{4}/\\d{2}/\\d{2}\\) \\| ${Array(5).fill(NUM_RE).join(" \\| ")}`))) {
    const k = ym(m[1], m[2]);
    put(k, "revenue", cell(m[3]), 1e6); put(k, "op", cell(m[4]), 1e6); put(k, "ordinary", cell(m[5]), 1e6); put(k, "ni", cell(m[6]), 1e6); put(k, "eps", cell(m[7]), 1);
  }
  for (const m of sect("財務情報 | 決算期 | 1株純資産", "単位：百万円").matchAll(row(Array(4).fill(NUM_RE).join(" \\| ")))) {
    const k = ym(m[1], m[2]);
    put(k, "assets", cell(m[4]), 1e6); put(k, "netAssets", cell(m[5]), 1e6);
  }
  for (const m of sect("キャッシュフロー(CF) | 決算期 | 営業CF", "単位：百万円").matchAll(row(Array(5).fill(NUM_RE).join(" \\| ")))) {
    const k = ym(m[1], m[2]);
    put(k, "ocf", cell(m[3]), 1e6); put(k, "icf", cell(m[4]), 1e6); put(k, "fin", cell(m[5]), 1e6); put(k, "cashEnd", cell(m[6]), 1e6);
  }
  return out;
}

/** Yahoo!ファイナンス performance(RSC 데이터) → 연간(fiscalQuarter Q4) { [YYYY-MM]: {...} } — 금액은 엔이지만 백만엔 배수(표기 단위 1e6) */
export function parseYahooJp(html) {
  const t = html.replace(/\\"/g, '"');
  const out = {};
  const AMT = { netSales: "revenue", operatingIncome: "op", ordinaryIncome: "ordinary", netIncome: "ni", assets: "assets", equity: "equity", operatingCashFlow: "ocf", investmentCashFlow: "icf", financialCashFlow: "fin" };
  for (const m of t.matchAll(/\{"fiscalYear":"(\d+)","fiscalQuarter":"(Q\d)","endDate":"(\d{4})-(\d{2})-\d{2}",(.*?)\}/g)) {
    if (m[2] !== "Q4") continue;
    const k = ym(m[3], m[4]);
    if (out[k]) continue; // 같은 연도 행이 페이지에 두 번 실리면 처음 것(같은 데이터)
    const o = (out[k] = {});
    for (const [f, nm] of Object.entries(AMT)) {
      const x = new RegExp(`"${f}":(-?\\d+(?:\\.\\d+)?|null)`).exec(m[5]);
      if (x) o[nm] = x[1] === "null" ? null : { v: Number(x[1]), unit: 1e6, dec: 0 };
    }
    const e = /"epsActual":(-?\d+(?:\.\d+)?|null)/.exec(m[5]);
    if (e) o.eps = e[1] === "null" ? null : { v: Number(e[1]), unit: 1, dec: e[1].includes(".") ? e[1].split(".")[1].length : 0 };
  }
  return out;
}
const PARSE = { kabutan: parseKabutan, minkabu: parseMinkabu, yahoojp: parseYahooJp };

// ── 비교 ──
const decStep = (x) => (x.dec ? 10 ** -x.dec : 1) * x.unit; // 외부 표기 한 단위(원 단위 값)
const roundAway = (a, step) => Math.sign(a) * Math.round(Math.abs(a) / step) * step;
const truncTo = (a, step) => Math.trunc(a / step) * step;
const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)); // 부동소수 표현 오차만(엔 미만 소수 셈)

/**
 * 한 소스 한 칸 분류. app = 앱 값(원 단위), x = { v, unit, dec } | null | undefined, causes = [{ test(extV) → 설명|null, appWrong }]
 * → { cls: "일치"|"원인확인"|"불일치"|"정밀도"|"없음", note }
 */
export function classifyOne(app, x, causes = []) {
  if (x === undefined) return { cls: "없음", note: "외부 칸 없음" };
  if (x === null) return app == null ? { cls: "없음", note: "외부 「－」·앱 빈칸" } : { cls: "없음", note: "외부 「－」(값 없음)" };
  if (app == null) return { cls: "불일치", note: `앱 빈칸 · 외부 ${x.v}` };
  const ext = x.v;
  // 일치: 외부 표기 그대로의 숫자 = 앱(정수 엔 금액은 정확 비교, 주당 값은 소수 표기 자릿수 안 부동소수 표현만)
  if (x.unit === 1 ? close(app, ext) : app === ext) return { cls: "일치", note: "" };
  for (const c of causes) {
    const why = c.test(ext);
    // c.cls = "정밀도" — 두 원자료 식이 회사 공시의 줄마다 백만엔 반올림 때문에 다른 경우(앱 = 소계 합, 외부 = 다른 줄 묶음의 합)처럼 식을 재현해 같아지면
    // 정밀도 부족(D1 — 근거로 세지 않음). 그 밖은 원인 확인, appWrong 이면 앱이 결정 정의와 다름(불일치)
    if (why) return { cls: c.appWrong ? "불일치" : c.cls ?? "원인확인", note: why, appWrong: !!c.appWrong };
  }
  const step = decStep(x);
  if (close(roundAway(app, step), ext)) return { cls: "정밀도", note: `앱 ${app} 를 외부 표기 단위 ${step} 로 반올림해야 같음` };
  if (close(truncTo(app, step), ext)) return { cls: "정밀도", note: `앱 ${app} 를 외부 표기 단위 ${step} 로 버려야 같음` };
  return { cls: "불일치", note: `앱 ${app} vs 외부 ${ext}(차 ${app - ext})` };
}

/** 시험 스위치(심은 오류 재현 전용): JP_VERIFY_TEST_EXT='[{"sym","src":"kabutan","ym":"2026-03","f":"eps","set":295.3}|{…,"drop":true}]' */
function applyTestExt(sym, src, parsed) {
  if (!process.env.JP_VERIFY_TEST_EXT) return;
  for (const t of JSON.parse(process.env.JP_VERIFY_TEST_EXT)) {
    if (t.sym !== sym || t.src !== src) continue;
    const row = (parsed[t.ym] ??= {});
    if (t.drop) delete row[t.f];
    else row[t.f] = { ...(row[t.f] ?? { unit: t.unit ?? 1, dec: 0 }), v: t.set, ...(t.dec != null ? { dec: t.dec } : {}) };
    console.warn(`⚠ 외부 시험 스위치 적용 ${JSON.stringify(t)}`);
  }
}

/** 종목 하나의 세 소스 판독 결과 → { [src]: parsed | { error } } */
export async function jpExtSources(sym, key, keyAt) {
  const out = {};
  for (const src of Object.keys(URL_OF)) {
    const p = await extPage(src, sym, key, keyAt);
    if (p.error) { out[src] = { error: p.error }; continue; }
    try {
      const parsed = PARSE[src](p.text);
      applyTestExt(sym, src, parsed);
      out[src] = { parsed, from: p.from, at: p.at, note: p.note };
      if (!Object.keys(parsed).length) out[src] = { error: `${SRC_NAME[src]} 판독 0행(페이지 형식 변경?) — ${p.file}` };
    } catch (e) {
      out[src] = { error: `${SRC_NAME[src]} 판독 실패 — ${String(e?.message ?? e).slice(0, 80)}` };
    }
  }
  return out;
}

/**
 * 칸 하나(지표 × 사업연도) 판정 → X층 검사 1건 + 검토 행 1건.
 * fields = { kabutan: "eps", minkabu: "eps", yahoojp: "eps" } (그 소스의 판독 칸 이름, 없으면 그 소스 대상 아님)
 */
export function judgeCell({ name, label, ym: k, app, fields, srcs, causes = [], PASS, FAIL, NA, COMMON }) {
  const per = {};
  for (const [src, f] of Object.entries(fields)) {
    const s = srcs[src];
    if (!s || s.error) { per[src] = { cls: "없음", note: s?.error ?? "소스 없음", fetchErr: !!s?.error }; continue; }
    const row = s.parsed[k];
    const x = row ? row[f] : undefined;
    const r = classifyOne(app, x, causes);
    per[src] = { ...r, ext: x?.v ?? null, unit: x?.unit };
    if ((COMMON_SRC[name] ?? []).includes(src) && r.cls === "일치") per[src] = { ...per[src], cls: "공통모드", note: "앱과 같은 원천" };
  }
  const names = Object.keys(per);
  const matched = names.filter((n) => per[n].cls === "일치");
  const bad = names.filter((n) => per[n].cls === "불일치");
  const expl = names.filter((n) => per[n].cls === "원인확인");
  const prec = names.filter((n) => per[n].cls === "정밀도");
  const common = names.filter((n) => per[n].cls === "공통모드");
  const has = names.filter((n) => per[n].cls !== "없음");
  const nm = (n) => SRC_NAME[n];
  const desc = (n) => `${nm(n)} ${per[n].ext ?? "－"}${per[n].note ? ` [${per[n].cls === "정밀도" ? "검증불가(외부 정밀도 부족)" : per[n].cls === "원인확인" ? "원인 확인" : outlier(n) ? "외부 단독 이탈" : per[n].cls === "불일치" ? "원인 미확인 불일치" : per[n].cls}: ${per[n].note}]` : ""}`;
  // 앱이 결정 정의와 다름이 식으로 드러난 곳(appWrong)은 다른 곳이 맞아도 실패로 둔다(앱 결함 — 일치 소스는 같은 결함을 공유하는 공통 원천이 아님이 확인돼야 한다)
  const appWrong = names.filter((n) => per[n].appWrong);
  // 외부 한 곳이 원자료 식으로 원인 확인되면 같은 칸의 다른 곳 원인 미확인 불일치는 그 소스 혼자의 이탈(외부 단독 이탈 — 리드 지시 2026-10-31, D2 일본 1곳 기준:
  // 앱 값이 원자료와 맞고(A층), 외부 1곳이 원자료 정의 식과 정확히 맞으면 나머지 한 곳의 어긋남은 그 사이트 문제). 칸은 독립 일치가 아니므로 통과로 세지 않는다
  const outlier = (n) => per[n].cls === "불일치" && !per[n].appWrong && (matched.length || expl.length);
  let check;
  if (appWrong.length && !matched.length) check = { status: FAIL, app, note: `외부 불일치(앱 정의 결함) — ${has.map(desc).join(" · ")}` };
  else if (matched.length) check = { status: PASS, app, note: `독립 외부 ${matched.map(nm).join("·")} 일치(D2 일본 1곳)${bad.length || prec.length || expl.length ? ` · ${names.filter((n) => !matched.includes(n) && per[n].cls !== "없음").map(desc).join(" · ")}` : ""}` };
  else if (expl.length) check = { status: NA, app, note: `식으로 원인 확인(독립 일치 아님) — ${has.map(desc).join(" · ")}` };
  else if (bad.length) check = { status: FAIL, app, note: `외부 불일치 — ${has.map(desc).join(" · ")}` };
  else if (prec.length) check = { status: NA, app, note: `검증불가(외부 정밀도 부족) — ${has.map(desc).join(" · ")}` };
  else if (common.length) check = { status: COMMON, app, note: `공통모드 원천만 일치 — ${common.map(nm).join("·")}` };
  else check = { status: NA, app, note: `외부 값 없음 — ${names.map((n) => `${nm(n)}: ${per[n].note}`).join(" · ")}` };
  const jpClass = Object.fromEntries(names.map((n) => [nm(n), outlier(n) ? "외부단독이탈" : per[n].cls]));
  const off = names.filter((n) => ["불일치", "원인확인", "정밀도"].includes(per[n].cls));
  const review = {
    item: `${label} ${name}`,
    ours: app,
    sources: Object.fromEntries(has.map((n) => [nm(n), per[n].ext])),
    jpClass,
    // 독립 일치가 없으면 matched 를 비워(null) 「외부 전부일치」에 세지 않는다 — 기타 검토로 간다
    matched: matched.length ? matched.map(nm) : bad.length ? [] : null,
    ...(prec.length ? { precisionNa: Object.fromEntries(prec.map((n) => [nm(n), per[n].note])) } : {}),
    ...(expl.length ? { explained: expl.map(nm), causes: Object.fromEntries(expl.map((n) => [nm(n), per[n].note])) } : {}),
    ...(common.length ? { commonMode: Object.fromEntries(common.map((n) => [nm(n), per[n].note])) } : {}),
    verdict: bad.length ? `${matched.length}/${has.length}곳 일치 — 불일치: ${off.map(desc).join(", ")}`
      : matched.length ? `${matched.length}/${has.length}곳 일치${off.length ? ` — 그 밖: ${off.map(desc).join(", ")}` : has.length === matched.length ? "(모두 일치)" : ""}`
      : expl.length ? `식으로 원인 확인 — ${off.map(desc).join(", ")}`
      : prec.length ? `외부 정밀도 부족 — ${off.map(desc).join(", ")}`
      : common.length ? `공통모드 — 독립 검증 아님 — ${common.map(nm).join("·")}`
      : "외부 값 없음",
  };
  // 그 밖(원인확인·정밀도)만 있고 일치·불일치가 없는 행은 matched=null 이라 「기타검토」. 일치 + 정밀도는 「불일치」 단어가 없어 「외부 전부일치」로 세지 않게 matched 를 유지하되
  // verdict 를 「그 밖」으로 둔다 — 집계에서 전부일치는 off 가 없을 때만이 되도록 matched 를 비운다
  if (matched.length && off.length && !bad.length) review.matched = null;
  return { check, review, per };
}
