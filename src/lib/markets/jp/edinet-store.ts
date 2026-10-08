import "server-only";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { FetchError } from "../http";

/**
 * **EDINET 원자료 디스크 저장소**(오너 결정 2026-10-08 — "스냅샷·EDINET 자료 등을 디스크캐시와 DB 저장, 미국·한국처럼 뻘짓하지 말고",
 * "DB 용량 반드시 고려"). 원본은 디스크, DB(jp_docs — src/lib/db/jp-docs.ts)는 재무 보고서 색인만. `EDINET_CACHE_DIR` 가 있을 때만
 * 디스크를 쓴다(없으면 매번 새로 받음 — 검사는 같음). 2호기 = /home/ubuntu/edinet-cache.
 *
 * 배치:
 *  - <root>/list/YYYY/YYYY-MM-DD.json   그날 documents.json(type=2) 목록(아래 LIST_FIELDS 만, null 칸은 뺌). **확정일(JST 오늘−2일 이전)만** 저장하고
 *    영구 보관(정리 대상 아님). 최근 이틀은 디스크에 두지 않고 매번 새로 받는다(프로세스 메모 10분). 휴일의 "0건"도 상태 200 이면 정상 목록으로 저장.
 *  - <root>/doc/<docID 앞 4자>/<docID>/type<N>.zip   서류 본문(type=1 XBRL·type=5 CSV). docID 는 바뀌지 않는다(정정은 새 docID) → 영구.
 *    읽을 때 파일 시각을 갱신(오래 안 쓴 것 판정).
 *  - 프로세스당 첫 사용 때 1회 정리(doc 만): 400일 넘게 안 쓴 파일 삭제, 전체가 EDINET_CACHE_MAX_GB(기본 8) 넘으면 오래 안 쓴 것부터.
 *    목록(list)은 지우지 않는다. .tmp 는 건너뛰되 1시간 넘은 것(죽은 프로세스가 남긴 것)은 지운다.
 * 쓰기 = 같은 폴더 임시 이름(.{이름}.{pid}.{난수}.tmp) → rename(앱·배치가 같은 폴더를 쓰므로 잘린 파일을 읽지 않게 — dart-cache.ts 와 같은 규칙).
 * 읽은 캐시가 깨졌으면(JSON 파싱 실패·zip 이 PK 로 시작 안 함·100B 미만) 지우고 다시 받는다.
 * 저장하지 않는 것: HTTP 오류, metadata.status ≠ "200"(EDINET 은 HTTP 200 에 JSON 오류를 싣기도 한다 — 범위 밖 날짜는 status "404"),
 * 건수 불일치, zip 자리에 온 JSON·HTML. 모두 FetchError 로 던진다(호출자가 조회 실패로 처리).
 *
 * 요청 예절: 이 프로세스의 EDINET 요청은 한 줄로 세우고 시작 간격 EDINET_MIN_GAP_MS(기본 1000ms). Next 데이터 캐시는 쓰지 않는다(cache "no-store" —
 * 열쇠가 든 URL 이 캐시 로그에 남지 않게, 2MB 넘는 zip 저장 실패 방지). 오류·로그 문구의 URL 은 Subscription-Key 를 가린다(redactEdinet).
 */

const BASE = "https://api.edinet-fsa.go.jp/api/v2";
const IDLE_MS = 400 * 864e5;
const TMP_STALE_MS = 3600e3;
const RECENT_MEMO_MS = 10 * 60_000;

/** 이 프로세스의 EDINET 저장소 통계 — 측정·로그용 */
export const edinetCacheStats = { hit: 0, miss: 0, write: 0, deleted: 0, requests: 0, bytes: 0 };

/** documents.json 목록 한 줄(저장하는 칸만) */
export interface EdinetDoc {
  docID: string;
  edinetCode: string | null;
  secCode: string | null;
  filerName: string | null;
  docTypeCode: string | null;
  docDescription: string | null;
  submitDateTime: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  parentDocID: string | null;
  withdrawalStatus: string | null;
  xbrlFlag: string | null;
  csvFlag: string | null;
  fundCode: string | null;
  ordinanceCode: string | null;
  formCode: string | null;
}
export const LIST_FIELDS = [
  "docID", "edinetCode", "secCode", "filerName", "docTypeCode", "docDescription", "submitDateTime", "periodStart", "periodEnd",
  "parentDocID", "withdrawalStatus", "xbrlFlag", "csvFlag", "fundCode", "ordinanceCode", "formCode",
] as const satisfies readonly (keyof EdinetDoc)[];

export function edinetCacheRoot(): string | null {
  return process.env.EDINET_CACHE_DIR || null;
}
/** 오류·로그 문구에서 Subscription-Key 값을 가린다 */
export function redactEdinet(s: string): string {
  return s.replace(/Subscription-Key=[^&\s"']*/gi, "Subscription-Key=***");
}
function apiKey(): string {
  const k = process.env.EDINET_API_KEY;
  if (!k) throw new FetchError("EDINET_API_KEY 미설정", { status: 501 });
  return k;
}

// ── 날짜(JST) ──
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** JST 오늘(YYYY-MM-DD) */
export function jstToday(): string {
  return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
}
/** YYYY-MM-DD 에 n일 더하기(UTC 달력 계산 — 시간대 무관) */
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
}
/** 확정일 — JST 오늘−2일 이전. 그날 목록은 더 바뀌지 않는다고 보고 디스크에 영구 저장 */
export function isFinalDate(date: string): boolean {
  return date <= addDays(jstToday(), -2);
}
/** JST 오늘부터 과거로 days 일(최신순) */
export function recentDates(days: number): string[] {
  const t = jstToday();
  return Array.from({ length: Math.max(0, days) }, (_, i) => addDays(t, -i));
}

// ── 요청 줄 세우기 ──
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let chain: Promise<void> = Promise.resolve();
let last = 0;
function slot(): Promise<void> {
  const gap = Number(process.env.EDINET_MIN_GAP_MS ?? 1000);
  const p = chain.then(async () => {
    const w = last + gap - Date.now();
    if (w > 0) await sleep(w);
    last = Date.now();
  });
  chain = p;
  return p;
}
const retryable = (s: number) => s === 429 || s === 408 || s >= 500;

/** EDINET 요청 1건(줄 세움·재시도 2회·no-store). url 에는 열쇠가 들어 있다 — 오류 문구는 가린다 */
async function edinetFetch(url: string, timeoutMs: number): Promise<{ buf: Buffer; type: string }> {
  const shown = redactEdinet(url);
  for (let attempt = 0; ; attempt++) {
    await slot();
    edinetCacheStats.requests++;
    if (process.env.EDINET_CACHE_LOG === "1") console.info(`[edinet-request] ${shown}`);
    let failure: FetchError;
    try {
      const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        edinetCacheStats.bytes += buf.length;
        return { buf, type: res.headers.get("content-type") ?? "" };
      }
      failure = new FetchError(`EDINET 요청 실패 ${res.status} — ${shown}`, { status: res.status });
      if (!retryable(res.status)) throw failure;
    } catch (e) {
      if (e instanceof FetchError) throw e;
      const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      failure = new FetchError(`EDINET ${timeout ? "시간 초과" : "요청 오류"} — ${shown}`, {
        status: timeout ? 504 : undefined,
        cause: e instanceof Error ? redactEdinet(e.message) : undefined,
      });
    }
    if (attempt >= 2) throw failure;
    await sleep(3000 * (attempt + 1));
  }
}

// ── 파일 ──
const isEnoent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
const isTmp = (n: string) => n.startsWith(".") && n.endsWith(".tmp");
const validZip = (b: Buffer) => b.length >= 100 && b[0] === 0x50 && b[1] === 0x4b;

/** 캐시 파일 읽기 — 없으면 null, 깨졌으면 지우고 null(미스) */
async function readCached<T>(f: string, parse: (b: Buffer) => T | null, touch: boolean): Promise<T | null> {
  let b: Buffer;
  try {
    b = await readFile(f);
  } catch (e) {
    if (isEnoent(e)) return null;
    throw e;
  }
  const v = parse(b);
  if (v == null) {
    console.warn(`[edinet-store] 깨진 캐시 파일 — 지우고 다시 받음: ${f} (${b.length}B)`);
    await rm(f, { force: true });
    edinetCacheStats.deleted++;
    return null;
  }
  if (touch) {
    const now = new Date();
    await utimes(f, now, now);
  }
  return v;
}
async function writeAtomic(f: string, data: Buffer | string): Promise<void> {
  const dir = path.dirname(f);
  try {
    await mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(f)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      await writeFile(tmp, data);
      await rename(tmp, f);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    edinetCacheStats.write++;
  } catch (e) {
    // 디스크 쓰기 실패는 받은 자료에 영향 없음 — 기록만(다음 요청이 다시 받는다)
    console.warn(`[edinet-store] 쓰기 실패 ${f}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── 정리(프로세스당 1회, doc 만) ──
let cleaned: Promise<void> | null = null;
async function cleanup(r: string): Promise<void> {
  const files: { p: string; size: number; t: number }[] = [];
  const walk = async (d: string, evictable: boolean) => {
    let names: string[];
    try {
      names = await readdir(d);
    } catch (e) {
      if (isEnoent(e)) return;
      throw e;
    }
    for (const n of names) {
      const p = path.join(d, n);
      let s;
      try {
        s = await stat(p);
      } catch (e) {
        // readdir 과 stat 사이에 다른 프로세스가 지운 파일 — 건너뛴다
        if (isEnoent(e)) continue;
        throw e;
      }
      if (s.isDirectory()) await walk(p, evictable);
      else if (isTmp(n)) {
        if (Date.now() - s.mtimeMs > TMP_STALE_MS) await rm(p, { force: true });
      } else if (evictable) files.push({ p, size: s.size, t: s.mtimeMs });
    }
  };
  await walk(path.join(r, "list"), false);
  await walk(path.join(r, "doc"), true);
  const now = Date.now();
  let total = 0;
  const keep: typeof files = [];
  for (const f of files) {
    if (now - f.t > IDLE_MS) {
      await rm(f.p, { force: true });
      edinetCacheStats.deleted++;
    } else {
      keep.push(f);
      total += f.size;
    }
  }
  const cap = Number(process.env.EDINET_CACHE_MAX_GB ?? 8) * 1024 ** 3;
  keep.sort((a, b) => a.t - b.t);
  for (const f of keep) {
    if (total <= cap) break;
    await rm(f.p, { force: true });
    total -= f.size;
    edinetCacheStats.deleted++;
  }
}
function ensureCleaned(r: string): Promise<void> {
  // 정리 실패는 조회 결과와 무관 — 기록만 하고 다음 프로세스가 다시 시도
  cleaned ??= cleanup(r).catch((e) => console.warn(`[edinet-store] 정리 실패: ${e instanceof Error ? e.message : String(e)}`));
  return cleaned;
}

// ── 그날 목록 ──
interface ListResponse {
  metadata?: { status?: string; message?: string; resultset?: { count?: number } };
  results?: Record<string, unknown>[];
}
function trim(r: Record<string, unknown>): EdinetDoc {
  const o = {} as Record<string, string | null>;
  for (const k of LIST_FIELDS) {
    const v = r[k];
    o[k] = v == null || v === "" ? null : String(v);
  }
  return o as unknown as EdinetDoc;
}
/** 저장 꼴(null 칸 생략) ↔ EdinetDoc */
function compact(d: EdinetDoc): Record<string, string> {
  const o: Record<string, string> = {};
  for (const k of LIST_FIELDS) if (d[k] != null) o[k] = d[k]!;
  return o;
}
function parseListFile(b: Buffer): EdinetDoc[] | null {
  try {
    const j = JSON.parse(b.toString("utf8")) as unknown;
    if (!Array.isArray(j)) return null;
    return j.map((r) => trim(r as Record<string, unknown>));
  } catch { // silent-ok: 깨진 파일 = 미스 — readCached 가 경고를 남기고 지운 뒤 다시 받는다
    return null;
  }
}

const recentMemo = new Map<string, { at: number; docs: EdinetDoc[] }>();
const inflight = new Map<string, Promise<unknown>>();
function once<T>(k: string, fn: () => Promise<T>): Promise<T> {
  let p = inflight.get(k) as Promise<T> | undefined;
  if (!p) {
    p = fn().finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}

/** documents.json?type=2 을 새로 받아 검사 — 상태 200·건수 일치가 아니면 FetchError(저장 안 함) */
async function fetchDayList(date: string): Promise<EdinetDoc[]> {
  const { buf } = await edinetFetch(`${BASE}/documents.json?date=${date}&type=2&Subscription-Key=${apiKey()}`, 60_000);
  let j: ListResponse;
  try {
    j = JSON.parse(buf.toString("utf8")) as ListResponse;
  } catch {
    throw new FetchError(`EDINET 목록 응답이 JSON 아님(${date}, ${buf.length}B)`, { status: 502 });
  }
  const st = j.metadata?.status;
  if (st !== "200") {
    throw new FetchError(`EDINET 목록 상태 ${st ?? "없음"} ${j.metadata?.message ?? ""} (${date})`, { status: Number(st) || 502 });
  }
  if (!Array.isArray(j.results)) throw new FetchError(`EDINET 목록에 results 없음(${date})`, { status: 502 });
  const count = j.metadata?.resultset?.count;
  if (count != null && count !== j.results.length) {
    throw new FetchError(`EDINET 목록 건수 불일치 ${j.results.length}/${count} (${date})`, { status: 502 });
  }
  return j.results.map(trim);
}

/**
 * 그날(JST, YYYY-MM-DD) 제출 서류 목록. 확정일은 디스크 영구 캐시, 최근 이틀은 새로 받는다(프로세스 메모 10분).
 * EDINET 보관 범위 밖 날짜·미래 날짜는 FetchError(status 404).
 */
export async function edinetDayList(date: string): Promise<EdinetDoc[]> {
  if (!DATE_RE.test(date)) throw new FetchError(`잘못된 날짜 ${date}`, { status: 400 });
  return once(`list:${date}`, async () => {
    const r = edinetCacheRoot();
    const final = isFinalDate(date);
    if (!final) {
      const m = recentMemo.get(date);
      if (m && Date.now() - m.at < RECENT_MEMO_MS) return m.docs;
      edinetCacheStats.miss++;
      const docs = await fetchDayList(date);
      recentMemo.set(date, { at: Date.now(), docs });
      return docs;
    }
    if (!r) {
      edinetCacheStats.miss++;
      return fetchDayList(date);
    }
    await ensureCleaned(r);
    const f = path.join(r, "list", date.slice(0, 4), `${date}.json`);
    const hit = await readCached(f, parseListFile, false);
    if (hit) {
      edinetCacheStats.hit++;
      return hit;
    }
    edinetCacheStats.miss++;
    const docs = await fetchDayList(date);
    await writeAtomic(f, JSON.stringify(docs.map(compact)));
    return docs;
  });
}

/** 확정일 목록이 디스크에 있는지(배치 진행 확인용 — 받지 않는다) */
export async function hasDayListOnDisk(date: string): Promise<boolean> {
  const r = edinetCacheRoot();
  if (!r || !isFinalDate(date)) return false;
  try {
    await stat(path.join(r, "list", date.slice(0, 4), `${date}.json`));
    return true;
  } catch (e) {
    if (isEnoent(e)) return false;
    throw e;
  }
}

// ── 서류 본문 zip ──
const DOCID_RE = /^S[0-9A-Z]{7}$/;
/**
 * 서류 본문 zip(type 1 = XBRL, 5 = CSV) — 디스크 영구 캐시(docID 불변). zip 이 아니면(EDINET 은 200 에 JSON 오류를 싣기도 한다) FetchError, 저장 안 함.
 */
export async function edinetDocZip(docID: string, type: 1 | 5): Promise<Uint8Array> {
  if (!DOCID_RE.test(docID)) throw new FetchError(`잘못된 docID ${docID}`, { status: 400 });
  return once(`doc:${docID}:${type}`, async () => {
    const r = edinetCacheRoot();
    const f = r ? path.join(r, "doc", docID.slice(0, 4), docID, `type${type}.zip`) : null;
    if (r && f) {
      await ensureCleaned(r);
      const hit = await readCached(f, (b) => (validZip(b) ? b : null), true);
      if (hit) {
        edinetCacheStats.hit++;
        return new Uint8Array(hit.buffer, hit.byteOffset, hit.byteLength);
      }
    }
    edinetCacheStats.miss++;
    const { buf } = await edinetFetch(`${BASE}/documents/${docID}?type=${type}&Subscription-Key=${apiKey()}`, 180_000);
    if (!validZip(buf)) {
      // EDINET 은 없는 서류·보관 기간 지난 서류를 HTTP 200 + JSON(metadata.status 404 등)으로 돌려준다 — 그 상태를 그대로 오류로
      let meta: { status?: string; message?: string } | undefined;
      try {
        meta = (JSON.parse(buf.toString("utf8")) as { metadata?: { status?: string; message?: string } }).metadata;
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e; // JSON 도 아님(HTML 등) — 아래에서 크기만 적어 실패로
      }
      const why = meta ? `상태 ${meta.status ?? "?"} ${meta.message ?? ""}`.trim() : `${buf.length}B`;
      throw new FetchError(`EDINET 서류 zip 아님 — ${why} (${docID} type${type})`, { status: Number(meta?.status) || 502 });
    }
    if (f) await writeAtomic(f, buf);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  });
}
