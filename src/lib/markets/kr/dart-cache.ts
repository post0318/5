import "server-only";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchJson } from "../http";

/**
 * **앱 DART 디스크 캐시**(오너 결정 2026-10-05 — SEC_CACHE_DIR 와 같은 방식). `DART_CACHE_DIR` 가 있을 때만 켜진다(없으면 기존 동작 —
 * Next 데이터 캐시만). 오라클 운영 = /opt/macro/dart-cache(배포·배치가 같이 쓴다).
 *
 * 배치: <DART_CACHE_DIR>/<종류>/<요청 열쇠>/<판본>.(json|bin) — 요청 하나에 판본 파일 하나.
 *  - 판본 = 그 보고서의 **최신 접수번호**. 회사의 정기공시 목록(list.json, Next 데이터 캐시 30분)에서 (사업연도·보고서 코드) → 최신 접수번호를
 *    정한다 — 정정 공시가 나오면 30분 안에 판본이 바뀌어 새로 받는다. 목록에 보고서가 없으면 판본 "none"(그때의 "013 자료 없음"도 저장 —
 *    보고서가 생기면 판본이 달라져 무효). 12월 결산이 아닌 회사는 판본을 정하지 않는다(디스크 캐시 안 씀).
 *  - 접수번호로 직접 받는 자료(XBRL 원본)는 판본 = 접수번호(바뀌지 않음).
 *  - 새 판본을 쓰면 같은 요청의 옛 판본 파일은 즉시 지운다. 읽을 때 파일 시각을 갱신(오래 안 쓴 것 판정).
 *  - 프로세스당 첫 사용 때 1회 정리: 90일 넘게 안 쓴 파일 삭제, 전체가 DART_CACHE_MAX_GB(기본 2) 넘으면 오래 안 쓴 것부터.
 *  - 조회 실패·빈 응답·깨진 JSON·비정상 상태(000·013 외)는 저장하지 않는다(markets/http.ts usableBody 원칙). 디스크를 놓쳐 새로 받을 때는 Next 데이터
 *    캐시를 건너뛴다(no-store) — 정정 전 판본이 6시간 캐시에 남아 새 판본 이름으로 저장되지 않게.
 * 검증기 캐시(scripts/verify-kr/cache.mjs, reports/.dart-cache)와 코드를 나누지 않는다(검증 독립성) — 같은 규칙을 각자 구현.
 */

const BASE = "https://opendart.fss.or.kr/api";
const IDLE_MS = 90 * 864e5;

/** 이 프로세스의 디스크 캐시 통계 — 측정·로그용 */
export const dartCacheStats = { hit: 0, miss: 0, write: 0, deleted: 0, requests: 0 };

function root(): string | null {
  return process.env.DART_CACHE_DIR || null;
}
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
const dirOf = (r: string, ns: string, key: string) => path.join(r, safe(ns), safe(key));
const isEnoent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";

/** DART 네트워크 요청 1건 기록(DART_CACHE_LOG=1 이면 콘솔) — 캐시 전후 요청 수 측정용 */
export function noteDartRequest(what: string): void {
  dartCacheStats.requests++;
  if (process.env.DART_CACHE_LOG === "1") console.info(`[dart-request] ${what}`);
}

// ── 정리(프로세스당 1회) ──
let cleaned: Promise<void> | null = null;
async function cleanup(r: string): Promise<void> {
  const files: { p: string; size: number; t: number }[] = [];
  const walk = async (d: string) => {
    let names: string[];
    try {
      names = await readdir(d);
    } catch (e) {
      if (isEnoent(e)) return;
      throw e;
    }
    for (const n of names) {
      const p = path.join(d, n);
      const s = await stat(p);
      if (s.isDirectory()) await walk(p);
      else files.push({ p, size: s.size, t: s.mtimeMs });
    }
  };
  await walk(r);
  const now = Date.now();
  let total = 0;
  const keep: typeof files = [];
  for (const f of files) {
    if (now - f.t > IDLE_MS) {
      await rm(f.p, { force: true });
      dartCacheStats.deleted++;
    } else {
      keep.push(f);
      total += f.size;
    }
  }
  const cap = Number(process.env.DART_CACHE_MAX_GB ?? 2) * 1024 ** 3;
  keep.sort((a, b) => a.t - b.t);
  for (const f of keep) {
    if (total <= cap) break;
    await rm(f.p, { force: true });
    total -= f.size;
    dartCacheStats.deleted++;
  }
}
function ensureCleaned(r: string): Promise<void> {
  // 정리 실패는 캐시 조회 결과와 무관 — 기록만 하고 다음 프로세스가 다시 시도
  cleaned ??= cleanup(r).catch((e) => console.warn(`[dart-cache] 정리 실패: ${e instanceof Error ? e.message : String(e)}`));
  return cleaned;
}

// ── 판본(정기공시 목록) ──
interface ListRow {
  rcept_no: string;
  report_nm: string;
}
const RE_PERIODIC = /(사업|반기|분기)보고서\s*\((\d{4})\.(\d{2})\)/;
const listMemo = new Map<string, { at: number; p: Promise<{ fyMonth: number; latest: Map<string, string> }> }>();
/** 회사 정기공시 → (사업연도|보고서 코드) → 최신 접수번호. 30분(Next 데이터 캐시 + 프로세스 메모) */
export function dartPeriodicLatest(corp: string): Promise<{ fyMonth: number; latest: Map<string, string> }> {
  const hit = listMemo.get(corp);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.p;
  const p = (async () => {
    const k = process.env.DART_API_KEY;
    if (!k) throw new Error("DART_API_KEY 미설정");
    const cy = new Date().getFullYear();
    const end = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
    const rows: ListRow[] = [];
    for (let page = 1; page <= 10; page++) {
      noteDartRequest(`list.json ${corp} p${page}`);
      const j = await fetchJson<{ status: string; message?: string; total_page?: number; list?: ListRow[] }>(
        `${BASE}/list.json?crtfc_key=${k}&corp_code=${corp}&bgn_de=${cy - 8}0101&end_de=${end}&pblntf_ty=A&page_count=100&page_no=${page}`,
        { revalidate: 60 * 30 },
      );
      if (j.status === "013") break;
      if (j.status !== "000") throw new Error(`DART 정기공시 목록 조회 실패 — 상태 ${j.status} ${j.message ?? ""} (${corp})`);
      rows.push(...(j.list ?? []));
      if (page >= Number(j.total_page ?? 1)) break;
    }
    const parsed = rows.map((r) => ({ r, m: RE_PERIODIC.exec(r.report_nm ?? "") })).filter((x) => x.m);
    const months = parsed.filter((x) => x.m![1] === "사업").map((x) => Number(x.m![3]));
    const freq = (v: number) => months.filter((x) => x === v).length;
    const fyMonth = months.length ? [...months].sort((a, b) => freq(b) - freq(a))[0] : 12;
    const latest = new Map<string, string>();
    for (const { r, m } of parsed) {
      const kind = m![1], mm = Number(m![3]);
      const code = kind === "사업" ? "11011" : ({ 3: "11013", 6: "11012", 9: "11014" } as Record<number, string>)[mm];
      if (!code) continue;
      const kk = `${m![2]}|${code}`;
      if (!latest.has(kk) || latest.get(kk)! < r.rcept_no) latest.set(kk, r.rcept_no);
    }
    return { fyMonth, latest };
  })();
  listMemo.set(corp, { at: Date.now(), p });
  // 실패한 목록은 메모에 남기지 않는다(다음 요청이 다시 받는다) — 호출자에게는 그대로 던진다
  p.then(
    () => undefined,
    () => listMemo.delete(corp),
  );
  return p;
}

/**
 * 회사 정기공시 판본 열쇠(최신 접수번호들) — 메모리 재무 캐시(dart-facts.ts factsCache)·Next 데이터 캐시 열쇠에 넣어 정정 공시가 나오면(목록 30분)
 * 즉시 무효가 되게 한다(감사 2차 운영 참고 — 예전엔 6시간 동안 정정 전 값이 남았다). 목록 조회 실패는 던진다
 */
export async function dartVersionKey(corp: string): Promise<string> {
  const L = await dartPeriodicLatest(corp);
  const top = [...L.latest.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 12).map(([k, v]) => `${k}=${v}`).join(",");
  return createHash("sha1").update(top).digest("hex").slice(0, 12);
}

// ── 읽기·쓰기 ──
async function readVer(dir: string, file: string): Promise<Buffer | null> {
  const f = path.join(dir, file);
  try {
    const b = await readFile(f);
    const now = new Date();
    await utimes(f, now, now);
    return b;
  } catch (e) {
    if (isEnoent(e)) return null;
    throw e;
  }
}
async function writeVer(dir: string, file: string, data: Buffer | string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, file), data);
    dartCacheStats.write++;
    for (const n of await readdir(dir)) {
      if (n === file) continue;
      await rm(path.join(dir, n), { force: true });
      dartCacheStats.deleted++;
    }
  } catch (e) {
    // 디스크 쓰기 실패는 받은 자료에 영향 없음 — 기록만(다음 요청이 다시 받는다)
    console.warn(`[dart-cache] 쓰기 실패 ${dir}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 보고서 하나(corp·사업연도·보고서 코드)에 매인 DART JSON 요청 — 디스크 캐시(판본 = 최신 접수번호). url 에는 crtfc_key 가 들어 있다(열쇠엔 쓰지 않음).
 * 응답 상태가 000·013 일 때만 저장. 그 밖의 상태는 저장하지 않고 그대로 돌려준다(호출자가 실패로 처리).
 */
export async function dartReportJson<T extends { status: string }>(
  ns: string,
  ref: { corp: string; year: number; reprt: string; extra?: string },
  url: string,
  revalidate: number,
): Promise<T> {
  const r = root();
  const L = await dartPeriodicLatest(ref.corp);
  const ver = L.latest.get(`${ref.year}|${ref.reprt}`) ?? "none";
  // Next 데이터 캐시 열쇠(URL)에 판본을 넣는다 — 정정 공시가 나오면 새 URL 이라 6시간 캐시를 건너뛴다(DART 는 모르는 인자를 무시, 실측)
  const vurl = `${url}&_v=${ver}`;
  if (!r || L.fyMonth !== 12) {
    noteDartRequest(`${ns} ${ref.corp} ${ref.year} ${ref.reprt} ${ref.extra ?? ""}`);
    return fetchJson<T>(L.fyMonth !== 12 ? url : vurl, { revalidate });
  }
  await ensureCleaned(r);
  const dir = dirOf(r, ns, `${ref.corp}_${ref.year}_${ref.reprt}${ref.extra ? `_${ref.extra}` : ""}`);
  const file = `${safe(ver)}.json`;
  const hit = await readVer(dir, file);
  if (hit) {
    dartCacheStats.hit++;
    return JSON.parse(hit.toString("utf8")) as T;
  }
  dartCacheStats.miss++;
  noteDartRequest(`${ns} ${ref.corp} ${ref.year} ${ref.reprt} ${ref.extra ?? ""}`);
  const j = await fetchJson<T>(vurl, { revalidate, noStore: true });
  if (j && (j.status === "000" || j.status === "013")) await writeVer(dir, file, JSON.stringify(j));
  return j;
}

/** 접수번호로 받는 원본(XBRL zip 등) — 판본 = 접수번호. fetcher 가 돌려준 바이트가 비었거나 너무 작으면 저장 안 함(호출자 검사 그대로) */
export async function dartRceptBinary(ns: string, rcept: string, fetcher: () => Promise<Uint8Array>): Promise<Uint8Array> {
  const r = root();
  if (!r) {
    noteDartRequest(`${ns} ${rcept}`);
    return fetcher();
  }
  await ensureCleaned(r);
  const dir = dirOf(r, ns, createHash("sha1").update(rcept).digest("hex").slice(0, 2) + "_" + rcept);
  const hit = await readVer(dir, `${safe(rcept)}.bin`);
  if (hit) {
    dartCacheStats.hit++;
    return new Uint8Array(hit);
  }
  dartCacheStats.miss++;
  noteDartRequest(`${ns} ${rcept}`);
  const b = await fetcher();
  if (b.length >= 100 && b[0] === 0x50 && b[1] === 0x4b) await writeVer(dir, `${safe(rcept)}.bin`, Buffer.from(b));
  return b;
}
