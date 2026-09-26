/**
 * SEC EDGAR 원문 조회 — 독립 기준 전용(앱·검증기 코드와 공유하지 않는다).
 *
 * - 초당 1회 이하(요청 사이 최소 1.1초), User-Agent 는 SEC_USER_AGENT.
 * - 429 를 받으면 65초 기다린 뒤 다시 시도(최대 3회).
 * - 내려받은 것은 전부 scripts/reference/.cache/sec/ 에 저장하고, 다음 실행은 캐시를 먼저 쓴다.
 *   (submissions JSON 만 하루 지나면 새로 받는다 — 새 공시가 올라오므로.)
 */
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = join(HERE, "..", ".cache", "sec");

const MIN_GAP_MS = 1100;
const WAIT_429_MS = 65_000;
let lastRequestAt = 0;
let offline = false;
/** 캐시만 쓰고 SEC 에 요청하지 않는다(--offline) — 캐시에 없으면 오류 */
export function setOffline(v) {
  offline = v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function userAgent() {
  const ua = process.env.SEC_USER_AGENT;
  if (!ua) throw new Error("SEC_USER_AGENT 가 없습니다(.env.local).");
  return ua;
}

function cachePathFor(url) {
  const u = new URL(url);
  const safe = (u.host + u.pathname).replace(/[^A-Za-z0-9._-]+/g, "_");
  return join(CACHE_DIR, safe);
}

/**
 * URL 을 받아 문자열로 돌려준다. maxAgeMs 안의 캐시가 있으면 네트워크를 쓰지 않는다.
 * @param {string} url
 * @param {{ maxAgeMs?: number }} [opt]
 * @returns {Promise<{ text: string; fromCache: boolean; path: string }>}
 */
export async function secFetch(url, opt = {}) {
  const path = cachePathFor(url);
  try {
    const st = await stat(path);
    if (offline || opt.maxAgeMs == null || Date.now() - st.mtimeMs < opt.maxAgeMs) {
      return { text: await readFile(path, "utf8"), fromCache: true, path };
    }
  } catch {
    // 캐시 없음
  }

  if (offline) throw new Error(`오프라인 모드 — 캐시에 없음: ${url}`);
  for (let attempt = 1; attempt <= 4; attempt++) {
    const gap = Date.now() - lastRequestAt;
    if (gap < MIN_GAP_MS) await sleep(MIN_GAP_MS - gap);
    lastRequestAt = Date.now();
    const res = await fetch(url, {
      headers: { "User-Agent": userAgent(), "Accept-Encoding": "gzip, deflate" },
    });
    if (res.status === 429) {
      console.warn(`  [SEC] 429 — ${WAIT_429_MS / 1000}초 대기 후 재시도 (${attempt}/3): ${url}`);
      await sleep(WAIT_429_MS);
      continue;
    }
    if (!res.ok) throw new Error(`SEC ${res.status} ${res.statusText}: ${url}`);
    const text = await res.text();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, "utf8");
    return { text, fromCache: false, path };
  }
  throw new Error(`SEC 429 가 계속됨: ${url}`);
}

const DAY = 24 * 3600 * 1000;

/** 티커 → CIK(10자리 문자열) */
export async function cikForTicker(ticker) {
  const { text } = await secFetch("https://www.sec.gov/files/company_tickers.json", { maxAgeMs: 7 * DAY });
  const rows = Object.values(JSON.parse(text));
  const hit = rows.find((r) => String(r.ticker).toUpperCase() === ticker.toUpperCase());
  if (!hit) throw new Error(`티커를 SEC 목록에서 못 찾음: ${ticker}`);
  return String(hit.cik_str).padStart(10, "0");
}

/**
 * 제출 목록(submissions) — recent 와 과거 목록 파일(files[])을 합쳐 평평한 배열로 돌려준다.
 * 과거 목록 파일은 needOlder 가 true 일 때만 받는다(요청 수 절약).
 */
export async function listFilings(cik, { needOlder = false } = {}) {
  const { text } = await secFetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { maxAgeMs: DAY });
  const sub = JSON.parse(text);
  const out = flatten(sub.filings?.recent);
  if (needOlder) {
    for (const f of sub.filings?.files ?? []) {
      const r = await secFetch(`https://data.sec.gov/submissions/${f.name}`, { maxAgeMs: 30 * DAY });
      out.push(...flatten(JSON.parse(r.text)));
    }
  }
  return { entityName: sub.name, filings: out };
}

function flatten(block) {
  if (!block?.accessionNumber) return [];
  return block.accessionNumber.map((acc, i) => ({
    accession: acc,
    form: block.form[i],
    filingDate: block.filingDate[i],
    reportDate: block.reportDate[i],
    primaryDocument: block.primaryDocument[i],
  }));
}

export function documentUrl(cik, accession, primaryDocument) {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${primaryDocument}`;
}
