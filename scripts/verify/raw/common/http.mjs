/**
 * 원천 요청 공통(설계 10 §3.6): 원천마다 한 줄(간격)·재시도·하루 요청 상한·요청 기록(FetchLog).
 *
 *  - 하루 상한(D18 — KRX·EDINET 은 운영과 같은 키라 상한으로 보호, DART 는 검증 전용 키지만 10-05 사고 뒤 상한 유지):
 *    카운터 = <보관소 루트>/quota/<원천>/YYYYMMDD(KST).json { 도구: 건수 }. 여러 실행·여러 작업트리가 같은 날 합계로 센다.
 *    상한에 닿으면 QuotaStop 을 던지고 그 원천은 그 실행 동안 멈춘다(호출부는 남은 칸을 quota_stop 으로 — 조용히 건너뛰지 않음).
 *  - 조회 실패는 FetchFailed. 옛 사본으로 대신하지 않는다(D16).
 *  - fetchImpl 을 바꿔 끼울 수 있다(시험·오프라인 재현 T2 — 소켓을 막으면 즉시 실패).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class FetchFailed extends Error {
  constructor(source, message, detail = {}) {
    super(message);
    this.name = "FetchFailed";
    this.code = "fetch_failed";
    this.source = source;
    this.detail = detail;
  }
}
export class QuotaStop extends Error {
  constructor(source, kind, message) {
    super(message);
    this.name = "QuotaStop";
    this.code = "quota_stop";
    this.source = source;
    this.kind = kind; // cap | 020
  }
}
export class SourceMaintenance extends Error {
  constructor(source, message) {
    super(message);
    this.name = "SourceMaintenance";
    this.code = "source_maintenance";
    this.source = source;
  }
}

const kstDay = (d = new Date()) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 열쇠 값을 지운 URL(기록용) */
export function redact(url) {
  return String(url).replace(/(crtfc_key|AUTH_KEY|serviceKey|Subscription-Key|apikey)=[^&]+/gi, "$1=***");
}

/**
 * @param {object} o
 * @param {string} o.source 원천 이름(dart·sec·edinet·krx·datago·yahoo·fred)
 * @param {string} o.quotaRoot 카운터 루트(<보관소>/quota)
 * @param {string} o.tool 도구 이름(verify·app·populate)
 * @param {number|null} o.dailyCap 하루 상한(null = 없음)
 * @param {number} o.gapMs 요청 시작 간격
 * @param {(attempt:number, res:Response|null, err:any)=>number|null} o.retry 다시 시도할 대기(ms) 또는 null
 * @param {typeof fetch} [o.fetchImpl]
 */
export function makeRequester({ source, quotaRoot, tool, dailyCap, gapMs, retry, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  let chain = Promise.resolve();
  let last = 0;
  let stopped = null;
  const log = { source, requests: 0, failures: 0, retries: 0, quotaStop: null };

  const qdir = quotaRoot ? join(quotaRoot, source) : null;
  const qfile = () => join(qdir, `${kstDay(now())}.json`);
  function readCount() {
    try {
      return JSON.parse(readFileSync(qfile(), "utf8"));
    } catch (e) {
      if (e?.code === "ENOENT") return {};
      throw e;
    }
  }
  function take() {
    if (stopped) throw stopped;
    if (dailyCap == null || !qdir) return;
    const c = readCount();
    const n = c[tool] ?? 0;
    if (n >= dailyCap) {
      stopped = new QuotaStop(source, "cap", `${source} 하루 요청 상한 도달(${tool} ${n}/${dailyCap}건, ${kstDay(now())} KST) — 남은 요청 중단`);
      log.quotaStop = stopped.message;
      throw stopped;
    }
    c[tool] = n + 1;
    if (!existsSync(qdir)) mkdirSync(qdir, { recursive: true });
    writeFileSync(qfile(), JSON.stringify(c));
  }
  /** 원천이 "전체 중단"을 알릴 때(DART 020) */
  function stop(kind, message) {
    stopped = new QuotaStop(source, kind, message);
    log.quotaStop = message;
    throw stopped;
  }
  async function slot() {
    const p = chain.then(async () => {
      const w = last + gapMs - Date.now();
      if (w > 0) await sleep(w);
      last = Date.now();
    });
    chain = p.catch(() => {}); // silent-ok: 대기열 사슬만 이어 감 — 오류는 바로 아래 await p 가 호출자에게 그대로 던진다
    await p;
  }

  /**
   * 요청 하나. 응답 바이트를 돌려준다. HTTP 2xx 가 아니면 retry 판단 후 FetchFailed.
   * @returns {Promise<{status:number, headers:Headers, buf:Buffer}>}
   */
  async function get(url, { headers = {}, timeoutMs = 60_000, method = "GET", body } = {}) {
    for (let attempt = 0; ; attempt++) {
      if (stopped) throw stopped;
      await slot();
      take();
      log.requests++;
      let res = null, err = null;
      try {
        res = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
        if (res.ok) return { status: res.status, headers: res.headers, buf: Buffer.from(await res.arrayBuffer()) };
      } catch (e) { // silent-ok: 오류를 err 로 넘겨 바로 아래 retry 판단 → 재시도 또는 FetchFailed 로 던짐
        err = e;
      }
      const wait = retry(attempt, res, err);
      if (wait == null) {
        log.failures++;
        throw new FetchFailed(source, `${source} ${redact(url)} → ${res ? `HTTP ${res.status}` : String(err?.message ?? err).slice(0, 120)}`, { status: res?.status ?? null });
      }
      log.retries++;
      await sleep(wait);
    }
  }
  return { get, stop, log, get stopped() { return stopped; } };
}

/** 원천별 기본 재시도(설계 10 §3.6 표) */
export const RETRY = {
  // DART: 재시도 2회(2·4초)
  dart: (a, res) => (a < 2 && (!res || res.status >= 500 || res.status === 429) ? 2000 * (a + 1) : null),
  // SEC: 429 면 65초 대기 후 최대 3회, 403 재시도 안 함, 네트워크 오류 2회(5초)
  sec: (a, res) => (res?.status === 429 ? (a < 3 ? 65_000 : null) : res?.status === 403 ? null : !res && a < 2 ? 5000 : res && res.status >= 500 && a < 2 ? 5000 : null),
  // EDINET: 429·5xx·네트워크 2회(3·6초)
  edinet: (a, res) => (a < 2 && (!res || res.status >= 500 || res.status === 429) ? 3000 * (a + 1) : null),
  // KRX: 네트워크·5xx 2회(1·3초) — 빈 응답 재시도(1·3·9초)는 어댑터가 따로
  krx: (a, res) => (a < 2 && (!res || res.status >= 500) ? [1000, 3000][a] : null),
  datago: (a, res) => (a < 2 && (!res || res.status >= 500) ? 2000 * (a + 1) : null),
  yahoo: (a, res) => (a < 2 && (!res || res.status >= 500 || res.status === 429) ? 3000 * (a + 1) : null),
  fred: (a, res) => (a < 1 && (!res || res.status >= 500) ? 3000 : null),
};
