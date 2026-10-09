/**
 * 일본 검증기 — EDINET 원자료 조회(검증기 독립 구현, 앱 src/lib/markets/jp/* 와 코드 공유 금지 — docs/verify-jp-design.md §2).
 *
 *  - 그날 서류 목록(documents.json type=2): 재무 서류(有報 120·訂正 130·四半期 140·訂正 150·半期 160·訂正 170, 펀드 제외)만 남겨 디스크에
 *    저장. 확정일(JST 오늘−2일 이전)만 영구 저장, 최근 이틀은 매번 새로 받는다. 상태 ≠ 200·건수 불일치·JSON 아님은 던진다(저장 안 함).
 *  - 서류 zip(type=1 XBRL): docID 불변(정정은 새 docID) → 영구 저장. zip 이 아니면(EDINET 은 HTTP 200 에 JSON 오류를 싣는다) 던진다.
 *  - EDINET 코드 목록(Edinetcode.zip, Shift_JIS CSV): 하루 1회.
 * 저장 위치 = JP_VERIFY_CACHE_DIR(기본 reports/.edinet-cache) — 앱 디스크 캐시(EDINET_CACHE_DIR)와 따로(앱 캐시가 틀려도 같이 틀리지 않게).
 * 요청은 한 줄, 시작 간격 JP_VERIFY_EDINET_GAP_MS(기본 1000ms). 오류 문구의 Subscription-Key 는 가린다.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";

const BASE = "https://api.edinet-fsa.go.jp/api/v2";
const CODELIST = "https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip";
export const FIN_TYPES = new Set(["120", "130", "140", "150", "160", "170"]);
const KEEP = ["docID", "edinetCode", "secCode", "filerName", "docTypeCode", "docDescription", "submitDateTime", "periodStart", "periodEnd", "parentDocID", "withdrawalStatus", "xbrlFlag"];

let cfg = { key: null, root: "reports/.edinet-cache", gap: 1000 };
export const edinetStats = { requests: 0, hit: 0, miss: 0, bytes: 0 };
export function configureEdinet(o) {
  cfg = { ...cfg, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) };
}
export const redact = (s) => String(s).replace(/Subscription-Key=[^&\s"']*/gi, "Subscription-Key=***");

const jstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
export const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const isFinal = (d) => d <= addDays(jstToday(), -2);

let chain = Promise.resolve();
let last = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, timeoutMs) {
  for (let attempt = 0; ; attempt++) {
    await (chain = chain.then(async () => {
      const w = last + cfg.gap - Date.now();
      if (w > 0) await sleep(w);
      last = Date.now();
    }));
    edinetStats.requests++;
    let err;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) {
        const b = Buffer.from(await r.arrayBuffer());
        edinetStats.bytes += b.length;
        return b;
      }
      err = new Error(`EDINET HTTP ${r.status} ${redact(url)}`);
      if (!(r.status === 429 || r.status >= 500)) throw err;
    } catch (e) {
      if (e === err) throw e;
      err = e instanceof Error && /^EDINET HTTP/.test(e.message) ? e : new Error(`EDINET 요청 오류 ${redact(url)} — ${redact(e?.message ?? e)}`);
    }
    if (attempt >= 2) throw err;
    await sleep(3000 * (attempt + 1));
  }
}
function writeAtomic(f, data) {
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, f);
}

const memoList = new Map();
/** 그날(JST) 재무 서류 목록 — 확정일은 디스크 영구, 최근 이틀은 새로 */
export async function dayList(date) {
  if (memoList.has(date)) return memoList.get(date);
  const f = join(cfg.root, "list", date.slice(0, 4), `${date}.json`);
  if (isFinal(date) && existsSync(f)) {
    try {
      const v = JSON.parse(readFileSync(f, "utf8"));
      if (Array.isArray(v.docs) && v.date === date) {
        edinetStats.hit++;
        memoList.set(date, v.docs);
        return v.docs;
      }
    } catch { /* 깨진 파일 — 아래에서 다시 받는다 */ }
  }
  if (!cfg.key) throw new Error("EDINET_API_KEY 없음");
  edinetStats.miss++;
  const buf = await get(`${BASE}/documents.json?date=${date}&type=2&Subscription-Key=${cfg.key}`, 90_000);
  let j;
  try { j = JSON.parse(buf.toString("utf8")); } catch { throw new Error(`EDINET 목록 JSON 아님 ${date} (${buf.length}B)`); }
  const st = j?.metadata?.status;
  if (st !== "200") throw new Error(`EDINET 목록 상태 ${st ?? "없음"} ${j?.metadata?.message ?? ""} (${date})`);
  if (!Array.isArray(j.results)) throw new Error(`EDINET 목록 results 없음 (${date})`);
  const cnt = j.metadata?.resultset?.count;
  if (cnt != null && cnt !== j.results.length) throw new Error(`EDINET 목록 건수 불일치 ${j.results.length}/${cnt} (${date})`);
  const docs = j.results
    .filter((r) => FIN_TYPES.has(String(r.docTypeCode ?? "")) && !r.fundCode)
    .map((r) => Object.fromEntries(KEEP.filter((k) => r[k] != null && r[k] !== "").map((k) => [k, String(r[k])])));
  if (isFinal(date)) writeAtomic(f, JSON.stringify({ date, total: j.results.length, docs }));
  memoList.set(date, docs);
  return docs;
}

const memoZip = new Map();
/** 서류 XBRL zip(type=1) → PublicDoc 의 .xbrl·.xml 파일 { 이름: 문자열 } */
export async function docFiles(docID) {
  if (!/^S[0-9A-Z]{7}$/.test(docID)) throw new Error(`잘못된 docID ${docID}`);
  if (memoZip.has(docID)) return memoZip.get(docID);
  const f = join(cfg.root, "doc", docID.slice(0, 4), `${docID}.zip`);
  let buf = null;
  if (existsSync(f) && statSync(f).size > 100) {
    buf = readFileSync(f);
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) buf = null;
    else edinetStats.hit++;
  }
  if (!buf) {
    if (!cfg.key) throw new Error("EDINET_API_KEY 없음");
    edinetStats.miss++;
    buf = await get(`${BASE}/documents/${docID}?type=1&Subscription-Key=${cfg.key}`, 180_000);
    if (buf.length < 100 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      let why = `${buf.length}B`;
      try { const m = JSON.parse(buf.toString("utf8")).metadata; why = `상태 ${m?.status} ${m?.message ?? ""}`; } catch { /* JSON 도 아님 */ }
      throw new Error(`EDINET 서류 zip 아님 ${docID} — ${why}`);
    }
    writeAtomic(f, buf);
  }
  const files = unzipSync(new Uint8Array(buf), { filter: (x) => /(^|\/)PublicDoc\/[^/]+\.(xbrl|xml|xsd)$/.test(x.name) });
  const dec = new TextDecoder("utf-8");
  const out = Object.fromEntries(Object.entries(files).map(([n, b]) => [n.split("/").pop(), dec.decode(b)]));
  memoZip.set(docID, out);
  if (memoZip.size > 40) memoZip.delete(memoZip.keys().next().value);
  return out;
}

/** 따옴표 칸(주소의 쉼표) 지원 CSV 한 줄 */
function csvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

let codeList = null;
/** EDINET 코드 목록 — 証券コード(5자리) → { edinetCode, name, fyEnd("3月31日"), consolidated } */
export async function edinetCodes() {
  if (codeList) return codeList;
  const f = join(cfg.root, "codelist", `${jstToday()}.zip`);
  let buf = existsSync(f) ? readFileSync(f) : null;
  if (!buf) {
    buf = await get(CODELIST, 120_000);
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error(`EDINET 코드 목록 zip 아님 (${buf.length}B)`);
    writeAtomic(f, buf);
  }
  const files = unzipSync(new Uint8Array(buf));
  const csvName = Object.keys(files).find((n) => /\.csv$/i.test(n));
  if (!csvName) throw new Error("EDINET 코드 목록에 CSV 없음");
  const text = new TextDecoder("shift_jis").decode(files[csvName]);
  const rows = text.split(/\r?\n/).map(csvLine);
  const head = rows.findIndex((r) => r.includes("ＥＤＩＮＥＴコード"));
  if (head < 0) throw new Error("EDINET 코드 목록 머리줄 없음");
  const h = rows[head];
  const col = (n) => h.indexOf(n);
  const [cE, cSec, cName, cFy, cCons] = [col("ＥＤＩＮＥＴコード"), col("証券コード"), col("提出者名"), col("決算日"), col("連結の有無")];
  if ([cE, cSec, cName, cFy].some((c) => c < 0)) throw new Error("EDINET 코드 목록 칸 이름 변경");
  const bySec = new Map();
  for (const r of rows.slice(head + 1)) {
    const sec = r[cSec];
    if (!sec) continue;
    bySec.set(sec, { edinetCode: r[cE], name: r[cName], fyEnd: r[cFy], consolidated: cCons >= 0 ? r[cCons] === "有" : null });
  }
  codeList = bySec;
  return bySec;
}
/** 티커(4자 — 영숫자 포함, 예 285A) → EDINET 코드 행. 証券コード = 티커 + "0" */
export async function resolveTicker(sym) {
  const m = await edinetCodes();
  return m.get(`${sym}0`) ?? null;
}
