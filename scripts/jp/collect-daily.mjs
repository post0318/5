#!/usr/bin/env node
/**
 * 일본 공시 원자료 매일 수집(오너 지시 2026-10-08 — "J-Quants 2년치는 반드시 서버 저장", "TDnet 결산단신 1번 수집", "DB 용량 반드시 고려").
 * 두 출처 모두 지난 자료가 사라진다 — TDnet 공시 목록은 최근 약 31일만, J-Quants 무료판은 "오늘 − 약 12주"에서 끝나는 2년 창. 그래서 매일 받아 쌓는다.
 *
 * 저장(원본은 디스크, DB 는 작은 색인·핵심 숫자만 — 운영 Atlas M0 512MB):
 *  - <JP_CACHE_DIR>/tdnet/list/YYYY/YYYYMMDD.json  그날 공시 목록 전부(시각·코드·회사·제목·PDF·XBRL 파일명) — 지난 날은 확정
 *  - <JP_CACHE_DIR>/tdnet/xbrl/YYYY/MM/<파일>.zip   결산단신(訂正 포함) XBRL — 파일명이 공시 번호라 바뀌지 않음
 *  - <JP_CACHE_DIR>/jquants/summary/YYYY/YYYYMMDD.json  J-Quants fins/summary 그날 공시분 원본(전 종목·전 필드)
 *  - DB jp_tdnet(결산단신 색인 한 건 ≈ 0.3KB) · jp_jq_summary(종목·기간별 핵심 숫자 ≈ 0.5KB) · jp_collect_days(수집한 날 기록)
 * 쓰기 = 같은 폴더 임시 이름 → rename(잘린 파일 방지). 오류 응답·HTML 오류·zip 아닌 파일·빈 목록 오류는 저장하지 않는다(다음 실행이 다시 받음).
 *
 *   node scripts/jp/collect-daily.mjs [--tdnet-days=31] [--jq-from=2024-07-16] [--jq-to=YYYY-MM-DD] [--only=tdnet|jquants] [--dry]
 * 환경: JP_CACHE_DIR(필수), MONGODB_URI(없으면 디스크만), JQUANTS_API_KEY(J-Quants), .env.local 에서도 읽음
 */
import { mkdirSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const env = { ...process.env };
try {
  for (const line of readFileSync(path.join(ROOT, ".env.local"), "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*?)"?\s*$/.exec(line);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
} catch (e) { if (e.code !== "ENOENT") throw e; } // silent-ok: .env.local 은 선택(없으면 환경변수만)

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const [k, v] = a.slice(2).split("="); return [k, v ?? true]; }));
const DIR = env.JP_CACHE_DIR;
if (!DIR) { console.error("JP_CACHE_DIR 미설정"); process.exit(2); }
const DRY = !!args.dry;
const ONLY = args.only ?? null;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (d) => d.toISOString().slice(0, 10);
const kst = () => new Date(Date.now() + 9 * 3600e3); // 일본·한국 같은 시간대
const stats = { tdnetDays: 0, tdnetRows: 0, tdnetZip: 0, tdnetZipSkip: 0, jqDays: 0, jqRows: 0, errors: [] };

function atomicWrite(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}
const isZipFile = (f) => {
  if (!existsSync(f) || statSync(f).size < 100) return false;
  const fd = openSync(f, "r"), b = Buffer.alloc(2);
  try { readSync(fd, b, 0, 2, 0); } finally { closeSync(fd); }
  return b[0] === 0x50 && b[1] === 0x4b;
};
async function get(url, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try { res = await fetch(url, { headers: { "user-agent": UA, ...(opts.headers ?? {}) }, signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) }); }
    catch (e) { if (attempt < 2) { await sleep(3000 * (attempt + 1)); continue; } throw new Error(`${e.name === "TimeoutError" ? "시간 초과" : "네트워크 오류"} ${url.replace(/key=[^&]+/i, "key=***")}`); }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) { await sleep(Number(res.headers.get("retry-after")) * 1000 || 5000 * (attempt + 1)); continue; }
    return res;
  }
}

// ── TDnet ──
const TDNET = "https://www.release.tdnet.info/inbs";
/** 결산단신(訂正 포함)·그 밖에 XBRL 이 붙은 실적 관련 공시만 zip 을 받는다 */
const KESSAN = /決算短信/;
function parseList(html) {
  const rows = [];
  for (const m of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const r = m[1];
    if (!/kjTime/.test(r)) continue;
    const cell = (cls) => (new RegExp(`class="[^"]*${cls}[^"]*"[^>]*>([\\s\\S]*?)</td>`).exec(r)?.[1] ?? "");
    const text = (s) => s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
    const title = cell("kjTitle");
    rows.push({
      time: text(cell("kjTime")), code: text(cell("kjCode")), name: text(cell("kjName")), title: text(title),
      pdf: /href="([^"]+\.pdf)"/.exec(title)?.[1] ?? null, xbrl: /href="([^"]+\.zip)"/.exec(cell("kjXbrl"))?.[1] ?? null,
      place: text(cell("kjPlace")), history: text(cell("kjHistroy")),
    });
  }
  return rows;
}
async function tdnetDay(date) {
  const d8 = date.replace(/-/g, "");
  const listFile = path.join(DIR, "tdnet", "list", date.slice(0, 4), `${d8}.json`);
  const today = ymd(kst());
  // 지난 날의 목록은 확정 — 이미 있으면 다시 받지 않는다(zip 누락분만 확인)
  let rows = null;
  if (date < today && existsSync(listFile)) {
    try { rows = JSON.parse(readFileSync(listFile, "utf8")).rows; } catch { rows = null; } // silent-ok: 깨진 목록 파일은 다시 받는다
  }
  if (!rows) {
    rows = [];
    for (let page = 1; page <= 60; page++) {
      const url = `${TDNET}/I_list_${String(page).padStart(3, "0")}_${d8}.html`;
      const res = await get(url);
      if (res.status === 404) { if (page === 1) return { date, missing: true }; break; } // 목록 보존 기간 밖이거나 공시 없음
      if (!res.ok) throw new Error(`TDnet 목록 HTTP ${res.status} ${url}`);
      const html = await res.text();
      const got = parseList(html);
      rows.push(...got);
      const total = Number(/全(\d+)件/.exec(html)?.[1] ?? 0);
      if (!got.length || rows.length >= total) break;
      await sleep(800);
    }
    if (!DRY) atomicWrite(listFile, JSON.stringify({ date, fetchedAt: new Date().toISOString(), final: date < today, rows }));
  }
  stats.tdnetDays++; stats.tdnetRows += rows.length;
  const picked = rows.filter((r) => r.xbrl && KESSAN.test(r.title));
  for (const r of picked) {
    const f = path.join(DIR, "tdnet", "xbrl", date.slice(0, 4), date.slice(5, 7), r.xbrl);
    if (isZipFile(f)) { stats.tdnetZipSkip++; continue; }
    if (DRY) continue;
    const res = await get(`${TDNET}/${r.xbrl}`, { timeoutMs: 120_000 });
    if (!res.ok) { stats.errors.push(`TDnet zip HTTP ${res.status} ${r.xbrl}`); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100 || buf[0] !== 0x50 || buf[1] !== 0x4b) { stats.errors.push(`TDnet zip 아님 ${r.xbrl}(${buf.length}B)`); continue; }
    atomicWrite(f, buf);
    stats.tdnetZip++;
    await sleep(500);
  }
  return { date, rows, picked };
}

// ── J-Quants ──
const JQ = "https://api.jquants.com/v2";
const JQ_KEEP = ["DiscDate", "DiscTime", "Code", "DiscNo", "DocType", "CurPerType", "CurPerSt", "CurPerEn", "CurFYSt", "CurFYEn",
  "Sales", "OP", "OdP", "NP", "EPS", "DEPS", "TA", "Eq", "EqAR", "BPS", "CFO", "CFI", "CFF", "CashEq", "DivAnn", "ShOutFY", "TrShFY", "AvgSh"];
async function jqDay(date, key) {
  const d8 = date.replace(/-/g, "");
  const file = path.join(DIR, "jquants", "summary", date.slice(0, 4), `${d8}.json`);
  if (existsSync(file)) return { date, skipped: true };
  const all = [];
  let pk = null;
  for (let i = 0; i < 50; i++) {
    const url = `${JQ}/fins/summary?date=${d8}${pk ? `&pagination_key=${encodeURIComponent(pk)}` : ""}`;
    const res = await get(url, { headers: { "x-api-key": key } });
    const body = await res.text();
    let j;
    try { j = JSON.parse(body); } catch { throw new Error(`J-Quants JSON 아님 HTTP ${res.status} ${d8}`); }
    if (res.status === 400 && /subscription covers/i.test(j.message ?? "")) return { date, outOfWindow: j.message };
    if (!res.ok) throw new Error(`J-Quants HTTP ${res.status} ${d8} ${j.message ?? ""}`);
    all.push(...(j.data ?? []));
    pk = j.pagination_key ?? null;
    if (!pk) break;
    await sleep(1200);
  }
  if (!DRY) atomicWrite(file, JSON.stringify({ date, fetchedAt: new Date().toISOString(), data: all }));
  stats.jqDays++; stats.jqRows += all.length;
  return { date, data: all };
}

async function main() {
  const client = env.MONGODB_URI && !DRY ? new MongoClient(env.MONGODB_URI) : null;
  const db = client ? (await client.connect(), client.db()) : null;
  if (db) {
    await db.collection("jp_tdnet").createIndex({ code: 1, date: -1 });
    await db.collection("jp_jq_summary").createIndex({ Code: 1, CurPerEn: -1 });
  }
  const today = kst();

  if (ONLY !== "jquants") {
    const days = Number(args["tdnet-days"] ?? 31);
    for (let i = days; i >= 0; i--) {
      const date = ymd(new Date(today.getTime() - i * 864e5));
      try {
        const r = await tdnetDay(date);
        if (db && r.picked?.length) {
          await db.collection("jp_tdnet").bulkWrite(r.picked.map((x) => ({ updateOne: { filter: { _id: x.xbrl.replace(/\.zip$/, "") }, upsert: true,
            update: { $set: { code: x.code, name: x.name, title: x.title, date, time: x.time, pdf: x.pdf, file: `tdnet/xbrl/${date.slice(0, 4)}/${date.slice(5, 7)}/${x.xbrl}`, place: x.place } } } })));
        }
        if (db && !r.missing) await db.collection("jp_collect_days").updateOne({ _id: `tdnet:${date}` }, { $set: { rows: r.rows?.length ?? 0, kessan: r.picked?.length ?? 0, at: new Date() } }, { upsert: true });
      } catch (e) { stats.errors.push(`TDnet ${date}: ${String(e.message ?? e).slice(0, 160)}`); }
    }
  }

  if (ONLY !== "tdnet") {
    const key = env.JQUANTS_API_KEY;
    if (!key) stats.errors.push("JQUANTS_API_KEY 미설정 — J-Quants 건너뜀");
    else {
      // auto = 디스크에 받아 둔 마지막 날 − 3일부터(창 끝이 날마다 하루씩 늘어난 분만). 받아 둔 게 없으면 800일 전부터(창 밖은 400 으로 건너뜀)
      let from = args["jq-from"] ?? ymd(new Date(today.getTime() - 800 * 864e5));
      if (from === "auto") {
        const base = path.join(DIR, "jquants", "summary");
        const last = existsSync(base) ? readdirSync(base).flatMap((y) => readdirSync(path.join(base, y))).filter((n) => /^\d{8}\.json$/.test(n)).sort().at(-1) : null;
        from = last ? ymd(new Date(Date.parse(`${last.slice(0, 4)}-${last.slice(4, 6)}-${last.slice(6, 8)}`) - 3 * 864e5)) : ymd(new Date(today.getTime() - 800 * 864e5));
      }
      const to = args["jq-to"] ?? ymd(today);
      for (let t = Date.parse(from); t <= Date.parse(to); t += 864e5) {
        const date = ymd(new Date(t));
        const wd = new Date(t).getUTCDay();
        if (wd === 0 || wd === 6) continue; // 공시는 영업일만
        try {
          const r = await jqDay(date, key);
          if (r.outOfWindow) continue; // 무료 창 밖(앞쪽은 이미 사라짐, 뒤쪽은 아직 안 열림)
          if (db && r.data?.length) {
            await db.collection("jp_jq_summary").bulkWrite(r.data.map((x) => ({ updateOne: { filter: { _id: `${x.Code}:${x.DiscNo}` }, upsert: true,
              update: { $set: Object.fromEntries(JQ_KEEP.filter((k) => x[k] != null && x[k] !== "").map((k) => [k, x[k]])) } } })));
          }
          if (db && !r.skipped) await db.collection("jp_collect_days").updateOne({ _id: `jquants:${date}` }, { $set: { rows: r.data?.length ?? 0, at: new Date() } }, { upsert: true });
          if (!r.skipped) await sleep(1200);
        } catch (e) { stats.errors.push(`J-Quants ${date}: ${String(e.message ?? e).slice(0, 160)}`); }
      }
    }
  }
  if (client) await client.close();
  console.log(`끝 — TDnet ${stats.tdnetDays}일 목록 ${stats.tdnetRows}건, 결산단신 zip 새로 ${stats.tdnetZip}(이미 있음 ${stats.tdnetZipSkip}) · J-Quants ${stats.jqDays}일 ${stats.jqRows}건 · 오류 ${stats.errors.length}`);
  for (const e of stats.errors.slice(0, 20)) console.log(`  ! ${e}`);
  process.exitCode = stats.errors.length ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(2); });
