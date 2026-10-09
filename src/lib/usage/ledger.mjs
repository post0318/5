// 외부 서비스 사용량 장부(2026-10-06) — 서비스별·하루(KST)별 실제 네트워크 요청 수를 센다. 설정은 config.mjs.
//
// 세는 곳: 전역 fetch 를 한 겹 감싼다(installUsageFetch). 앱은 src/instrumentation.ts 가 서버 기동 때(Next 가 fetch 에 데이터 캐시를
// 씌우기 전) 감싸므로 **Next 캐시 적중은 여기까지 오지 않는다** — 여기서 센 것 = 실제 네트워크 요청. 1호기 배치(run-ts·run-script 컨테이너)는
// NODE_OPTIONS=--import scripts/lib/usage-preload.mjs 로 같은 함수를 먼저 실행한다.
// 캐시 적중(별도 집계): http.ts 가 Next 데이터 캐시 적중·SEC 디스크 캐시를, dart-cache.ts 가 DART 디스크 캐시를 recordUsage(…, "hit") 로 넣는다.
//
// 저장: ${USAGE_DIR}/YYYYMMDD/{역할}-{호스트}-{pid}-{시작}.json — 프로세스마다 자기 파일 하나만 쓰고(임시 이름 → rename, 원자적),
// 읽는 쪽이 폴더 안 파일을 합친다(여러 프로세스가 같은 파일을 고치지 않으므로 잠금이 필요 없다). DB 에는 쓰지 않는다.
// USAGE_DIR 이 없으면(Vercel·Cloud Run·로컬 기본) 아무것도 하지 않는다.
//
// 상한: 그날 전체(모든 프로세스) 요청 수가 dailyCap 이상이면 **배치 역할**의 요청만 막는다(UsageLimitError). 배치 역할 =
// USAGE_ROLE=batch 프로세스, 또는 앱 안에서 /api/cron/* 라우트가 처리 중인 요청. 화면 요청은 막지 않는다.
// USAGE_ENFORCE=0 이면 세기만 한다(비상용).

import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { USAGE_SERVICES, USAGE_WARN_RATIO } from "./config.mjs";

const G = /** @type {any} */ (globalThis);
const KEY = Symbol.for("macro.usage.ledger");
const FLUSH_MS = 10_000;
const OTHERS_TTL_MS = 15_000;
const KEEP_DAYS = 62;

/**
 * @typedef {{ net: number, hit: number, blocked: number, batch: number }} Count
 * @typedef {{ installed: boolean, days: Map<string, Map<string, Count>>, shard: string, timer: any, others: { day: string, at: number, totals: Map<string, Count> } | null, caps: { at: number, over: Record<string, number> } | null, warned: Set<string>, probe: AsyncLocalStorage<{ net: boolean }>, cleaned: boolean }} State
 */

/** @returns {State} 프로세스당 하나(Next 가 모듈을 라우트마다 따로 묶어도 같은 상태를 쓰게 globalThis 에 둔다) */
function st() {
  if (!G[KEY]) {
    const role = process.env.USAGE_ROLE === "batch" ? "batch" : "app";
    G[KEY] = {
      installed: false,
      days: new Map(),
      shard: `${role}-${os.hostname().replace(/[^A-Za-z0-9_.-]/g, "_")}-${process.pid}-${Date.now()}`,
      timer: null,
      others: null,
      caps: null,
      warned: new Set(),
      probe: new AsyncLocalStorage(),
      cleaned: false,
    };
  }
  return G[KEY];
}

export function usageDir() {
  return process.env.USAGE_DIR || null;
}

/** KST 날짜 YYYYMMDD */
export function kstDay(d = new Date()) {
  return new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
}

/** @param {string | URL | Request} input @returns {string | null} 장부 대상 서비스 id */
export function usageServiceOf(input) {
  let u;
  try {
    u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  } catch {
    return null;
  }
  const h = u.hostname.toLowerCase();
  for (const s of USAGE_SERVICES) if (s.match(h, u.pathname)) return s.id;
  return null;
}

/** @param {Map<string, Count>} m @param {string} svc */
function cnt(m, svc) {
  let c = m.get(svc);
  if (!c) m.set(svc, (c = { net: 0, hit: 0, blocked: 0, batch: 0 }));
  return c;
}

function schedule() {
  const s = st();
  if (s.timer) return;
  s.timer = setTimeout(() => {
    s.timer = null;
    flushUsage();
  }, FLUSH_MS);
  s.timer.unref?.();
}

/**
 * @param {string} svc
 * @param {"net" | "hit" | "blocked"} kind
 * @param {boolean} [batch] net 이 배치 역할 요청이었는지
 */
export function recordUsage(svc, kind, batch = false) {
  if (!usageDir()) return;
  const s = st();
  const day = kstDay();
  let m = s.days.get(day);
  if (!m) s.days.set(day, (m = new Map()));
  const c = cnt(m, svc);
  c[kind]++;
  if (kind === "net" && batch) c.batch++;
  schedule();
}

/** 메모리 집계를 자기 파일에 쓴다(동기 — 종료 직전에도 부른다). 지난 날짜는 쓰고 나서 메모리에서 뺀다 */
export function flushUsage() {
  const dir = usageDir();
  if (!dir) return;
  const s = st();
  const today = kstDay();
  for (const [day, m] of s.days) {
    if (m.size === 0) continue;
    try {
      const d = path.join(dir, day);
      fs.mkdirSync(d, { recursive: true });
      const f = path.join(d, `${s.shard}.json`);
      const tmp = path.join(d, `.${s.shard}.${Math.random().toString(36).slice(2)}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify({ shard: s.shard, pid: process.pid, updated: new Date().toISOString(), counts: Object.fromEntries(m) }));
      fs.renameSync(tmp, f);
    } catch {
      /* 장부 실패는 요청에 영향 없음 */
    }
    if (day !== today) s.days.delete(day);
  }
}

/** @param {string} day @param {string | null} exclude 이 파일 이름은 빼고 @returns {{ totals: Map<string, Count>, shards: number }} */
function readShards(day, exclude) {
  /** @type {Map<string, Count>} */
  const totals = new Map();
  const dir = usageDir();
  let shards = 0;
  if (!dir) return { totals, shards };
  let names = [];
  try {
    names = fs.readdirSync(path.join(dir, day));
  } catch {
    return { totals, shards };
  }
  for (const n of names) {
    if (!n.endsWith(".json") || n.startsWith(".") || n === exclude) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, day, n), "utf8"));
      shards++;
      for (const [svc, c] of Object.entries(j.counts ?? {})) {
        const t = cnt(totals, svc);
        for (const k of /** @type {const} */ (["net", "hit", "blocked", "batch"])) t[k] += Number(c?.[k]) || 0;
      }
    } catch {
      /* 쓰는 중이거나 깨진 파일은 건너뜀(쓰기는 rename 이라 보통 없음) */
    }
  }
  return { totals, shards };
}

/** 서버에서 배포 없이 상한을 덮어쓰기 — ${USAGE_DIR}/limits.json {"dart": 12000, "krx": null} */
function capOverrides() {
  const s = st();
  if (s.caps && Date.now() - s.caps.at < 60_000) return s.caps.over;
  let over = {};
  try {
    const dir = usageDir();
    if (dir) over = JSON.parse(fs.readFileSync(path.join(dir, "limits.json"), "utf8")) ?? {};
  } catch {
    over = {};
  }
  s.caps = { at: Date.now(), over };
  return over;
}

/** @param {string} svc @returns {number | null} */
export function usageCap(svc) {
  const over = /** @type {Record<string, unknown>} */ (capOverrides());
  if (Object.prototype.hasOwnProperty.call(over, svc)) {
    const v = over[svc];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return USAGE_SERVICES.find((x) => x.id === svc)?.dailyCap ?? null;
}

/** 오늘 이 서비스 전체 네트워크 요청 수(다른 프로세스 파일 + 내 메모리) */
function liveNet(svc) {
  const s = st();
  const day = kstDay();
  if (!s.others || s.others.day !== day || Date.now() - s.others.at > OTHERS_TTL_MS) {
    s.others = { day, at: Date.now(), totals: readShards(day, `${s.shard}.json`).totals };
  }
  return (s.others.totals.get(svc)?.net ?? 0) + (s.days.get(day)?.get(svc)?.net ?? 0);
}

export class UsageLimitError extends Error {
  /** @param {string} svc @param {number} used @param {number} cap */
  constructor(svc, used, cap) {
    super(`[사용량 상한] ${svc} 오늘 ${used}/${cap}건 — 배치 요청을 멈춥니다(화면 요청은 계속)`);
    this.name = "UsageLimitError";
    this.service = svc;
  }
}

/** 앱 안에서 지금 요청이 배치(/api/cron/*)인지 — Next 작업 저장소의 라우트로 판정 */
function appRouteIsBatch() {
  try {
    const store = G.fetch?.__nextGetStaticStore?.()?.getStore?.();
    const route = typeof store?.route === "string" ? store.route : "";
    return route.startsWith("/api/cron/");
  } catch {
    return false;
  }
}

export function currentRoleIsBatch() {
  return process.env.USAGE_ROLE === "batch" || appRouteIsBatch();
}

/** 상한 검사 — 배치 역할이고 오늘 전체가 상한 이상이면 던진다 */
function guard(svc, batch) {
  if (!batch || process.env.USAGE_ENFORCE === "0") return;
  const cap = usageCap(svc);
  if (cap == null) return;
  const used = liveNet(svc);
  const s = st();
  if (used >= cap) {
    recordUsage(svc, "blocked");
    if (!s.warned.has(`block:${svc}`)) {
      s.warned.add(`block:${svc}`);
      console.error(`[usage] ${svc} 상한 도달 ${used}/${cap} — 이 프로세스의 배치 요청을 막습니다`);
    }
    throw new UsageLimitError(svc, used, cap);
  }
  if (used >= cap * USAGE_WARN_RATIO && !s.warned.has(`warn:${svc}`)) {
    s.warned.add(`warn:${svc}`);
    console.warn(`[usage] ${svc} 상한의 ${Math.floor((used / cap) * 100)}% (${used}/${cap})`);
  }
}

/** 전역 fetch 를 한 번 감싼다. USAGE_DIR 이 없으면 아무것도 안 한다 */
export function installUsageFetch() {
  if (!usageDir()) return false;
  const s = st();
  if (s.installed || typeof G.fetch !== "function") return s.installed;
  const orig = G.fetch;
  const wrapped = function fetch(/** @type {any} */ input, /** @type {any} */ init) {
    const svc = usageServiceOf(input);
    if (svc) {
      const batch = currentRoleIsBatch();
      try {
        guard(svc, batch);
      } catch (e) {
        return Promise.reject(e);
      }
      recordUsage(svc, "net", batch);
      const p = s.probe.getStore();
      if (p) p.net = true;
    }
    return orig.call(this, input, init);
  };
  G.fetch = wrapped;
  s.installed = true;
  process.on("exit", flushUsage);
  cleanupOld();
  return true;
}

/**
 * Next 데이터 캐시 적중 판별 — fn 안의 fetch 가 실제 네트워크로 나갔는지 함께 돌려준다(장부 fetch 가 Next 캐시 아래에 있으므로
 * 캐시에서 나온 응답이면 net=false).
 * @template T @param {() => Promise<T>} fn @returns {Promise<{ value: T, net: boolean }>}
 */
export async function withNetProbe(fn) {
  const probe = { net: false };
  const value = await st().probe.run(probe, fn);
  return { value, net: probe.net };
}

function cleanupOld() {
  const s = st();
  const dir = usageDir();
  if (s.cleaned || !dir) return;
  s.cleaned = true;
  try {
    const cut = kstDay(new Date(Date.now() - KEEP_DAYS * 864e5));
    for (const n of fs.readdirSync(dir)) if (/^\d{8}$/.test(n) && n < cut) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  } catch {
    /* 없음 */
  }
}

/**
 * 하루 장부 합계(보고·점검용). 내 메모리분을 먼저 파일로 쓴 뒤 읽는다.
 * @param {string} [day] YYYYMMDD(KST), 기본 오늘
 */
export function readUsageDay(day = kstDay()) {
  flushUsage();
  const { totals, shards } = readShards(day, null);
  const services = USAGE_SERVICES.map((x) => {
    const c = totals.get(x.id) ?? { net: 0, hit: 0, blocked: 0, batch: 0 };
    const cap = usageCap(x.id);
    return { id: x.id, label: x.label, basis: x.basis, cap, ...c, pct: cap ? Math.floor((c.net / cap) * 100) : null };
  });
  return { day, dir: usageDir(), shards, services };
}
