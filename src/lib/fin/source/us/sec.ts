import "server-only";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchJson, fetchText } from "../../../markets/http";
import { withFetchScope } from "../../../markets/fetch-health";
import { Gap, type FormType, type Prov, type RawFact } from "../../types";

/**
 * 0층 원천 어댑터 — SEC EDGAR(architecture.md §1). **외부 호출은 여기서만.** 판독(판본·기간·환율)은 하지 않는다.
 *
 * 기존 코드에서 옮긴 것: `markets/us/edgar.ts` 의 티커→CIK(CIK_OVERRIDE 포함)·submissions·companyfacts 조회,
 * `edgar-gapfill.ts` 의 인스턴스 문맥·단위 파서(차원·decimals 를 버리지 않도록 확장), `edgar-is-structure.ts` 의
 * index.json 로 _cal/_pre/_lab(없으면 .xsd 내장) 파일 찾기. HTTP·일시 오류 기록은 `markets/http.ts`·`fetch-health.ts`
 * 를 그대로 import 해 쓴다(백오프·범위 기록 동일).
 *
 * 추가한 것:
 *  - SEC 요청 **순차·간격**(기본 150ms) — 배치·그림자 비교가 SEC 에 몰리지 않게.
 *  - 선택적 디스크 캐시(`FIN_SEC_CACHE_DIR`) — 스크립트 실행 전용. Archives(불변)는 영구, companyfacts·submissions 는 12시간.
 *    Next fetch 캐시가 없는 스크립트 실행에서 같은 원본을 다시 받지 않게 한다. 설정 안 하면 쓰지 않는다.
 */

const UA = process.env.SEC_USER_AGENT ?? "global-market-research (personal use) contact@example.com";
const H = { "user-agent": UA, "accept-encoding": "gzip, deflate" };
const GAP_MS = Number(process.env.FIN_SEC_GAP_MS ?? 150);

// ── 순차·간격 ──
let chain: Promise<unknown> = Promise.resolve();
let lastAt = 0;
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = lastAt + GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      lastAt = Date.now();
    }
  });
  chain = run.catch(() => undefined);
  return run;
}

// ── 디스크 캐시(스크립트 전용) ──
const CACHE_DIR = process.env.FIN_SEC_CACHE_DIR || null;
const cachePath = (url: string) => (CACHE_DIR ? join(CACHE_DIR, createHash("sha1").update(url).digest("hex")) : null);
function cacheGet(url: string, ttlMs: number | null): string | null {
  const p = cachePath(url);
  if (!p) return null;
  try {
    if (ttlMs != null && Date.now() - statSync(p).mtimeMs > ttlMs) return null;
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
function cachePut(url: string, body: string): void {
  const p = cachePath(url);
  if (!p) return;
  try {
    mkdirSync(CACHE_DIR!, { recursive: true });
    writeFileSync(p, body);
  } catch {
    /* 캐시 실패는 무시 */
  }
}
const isArchive = (url: string) => /\/Archives\/edgar\//.test(url);
const TTL_API = 1000 * 60 * 60 * 12;

async function secText(url: string, timeoutMs = 30_000): Promise<string> {
  const ttl = isArchive(url) ? null : TTL_API;
  const hit = cacheGet(url, ttl);
  if (hit != null) return hit;
  const body = await serial(() => fetchText(url, { headers: H, revalidate: isArchive(url) ? 60 * 60 * 24 : false, timeoutMs }));
  cachePut(url, body);
  return body;
}
async function secJson<T>(url: string, timeoutMs = 30_000): Promise<T> {
  const ttl = isArchive(url) ? null : TTL_API;
  const hit = cacheGet(url, ttl);
  if (hit != null) return JSON.parse(hit) as T;
  const body = await serial(() => fetchJson<T>(url, { headers: H, revalidate: false, timeoutMs }));
  cachePut(url, JSON.stringify(body));
  return body;
}

export function cik10(cik: number | string): string {
  return String(cik).replace(/\D/g, "").padStart(10, "0");
}

// ── 티커 → CIK ──
interface TickerRow { cik_str: number; ticker: string; title: string }
let tickerMap: Map<string, TickerRow> | null = null;
/** company_tickers.json 이 잘못된 엔티티로 매핑하는 티커(markets/us/edgar.ts 와 같은 목록) */
const CIK_OVERRIDE: Record<string, number> = { XOM: 34088 };

export async function resolveCik(symbol: string): Promise<{ cik: string; title: string }> {
  const sym = symbol.toUpperCase();
  if (!tickerMap) {
    const data = await secJson<Record<string, TickerRow>>("https://www.sec.gov/files/company_tickers.json");
    tickerMap = new Map(Object.values(data).map((r) => [r.ticker.toUpperCase(), r]));
  }
  const row = tickerMap.get(sym);
  const o = CIK_OVERRIDE[sym];
  if (o != null) return { cik: cik10(o), title: row?.title ?? sym };
  if (!row) throw new Error(`EDGAR 티커 없음: ${symbol}`);
  return { cik: cik10(row.cik_str), title: row.title };
}

// ── submissions ──
export interface FilingRef { accn: string; form: string; filed: string; reportDate: string; doc: string }
export interface Submissions { name: string; sic: number | null; tickers: string[]; fiscalYearEnd: string; recent: FilingRef[] }

export async function getSubmissions(cik: string): Promise<Submissions> {
  const s = await secJson<{
    name: string; sic: string; tickers: string[]; fiscalYearEnd: string;
    filings: { recent: { accessionNumber: string[]; form: string[]; filingDate: string[]; reportDate: string[]; primaryDocument: string[] } };
  }>(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const r = s.filings.recent;
  const recent: FilingRef[] = r.accessionNumber.map((accn, i) => ({
    accn, form: r.form[i], filed: r.filingDate[i], reportDate: r.reportDate?.[i] ?? "", doc: r.primaryDocument[i],
  }));
  return { name: s.name, sic: s.sic ? Number(s.sic) : null, tickers: s.tickers ?? [], fiscalYearEnd: s.fiscalYearEnd, recent };
}

// ── companyfacts ──
interface CfEntry { start?: string; end: string; val: number; accn: string; fy?: number; fp?: string; form: string; filed: string }
type CfNs = Record<string, { label?: string; units: Record<string, CfEntry[]> }>;
interface CfRaw { entityName: string; facts: Record<string, CfNs> }

/**
 * companyfacts 색인 — 개념별로 필요할 때만 RawFact 로 바꾼다(대형사 원본은 수십 MB — 전부 객체화하지 않는다).
 * `extra` 는 companyfacts 에 없는 공시를 인스턴스로 채운 사실(gapfill).
 */
export class FactIndex {
  private memo = new Map<string, RawFact[]>();
  private extra = new Map<string, RawFact[]>();
  constructor(private raw: CfRaw) {}

  entityName(): string { return this.raw.entityName; }
  namespaces(): string[] { return Object.keys(this.raw.facts ?? {}); }
  has(qname: string): boolean {
    const [ns, name] = splitQ(qname);
    return Boolean(this.raw.facts?.[ns]?.[name]) || this.extra.has(qname);
  }
  label(qname: string): string | null {
    const [ns, name] = splitQ(qname);
    return this.raw.facts?.[ns]?.[name]?.label ?? null;
  }
  /** 개념의 모든 사실(모든 단위). qname = "us-gaap:Revenues" */
  get(qname: string): RawFact[] {
    const hit = this.memo.get(qname);
    if (hit) return hit;
    const [ns, name] = splitQ(qname);
    const node = this.raw.facts?.[ns]?.[name];
    const out: RawFact[] = [];
    if (node)
      for (const [unit, arr] of Object.entries(node.units ?? {}))
        for (const e of arr) {
          if (e.val == null || !e.end) continue;
          out.push({
            concept: qname, start: e.start ?? null, end: e.end, val: e.val, unit, dims: {}, decimals: null,
            prov: { accn: e.accn ?? null, form: e.form as FormType, filed: e.filed ?? null, source: "sec-cf" },
          });
        }
    const add = this.extra.get(qname);
    if (add) out.push(...add);
    this.memo.set(qname, out);
    return out;
  }
  /** 모든 사실을 차례로(companyfacts 전 개념 + 보완 사실) — 1층 열 판본 색인용. companyfacts 사실은 호출마다 새 객체 */
  forEach(fn: (f: RawFact) => void): void {
    for (const [ns, node] of Object.entries(this.raw.facts ?? {}))
      for (const [name, c] of Object.entries(node))
        for (const [unit, arr] of Object.entries(c.units ?? {}))
          for (const e of arr) {
            if (e.val == null || !e.end) continue;
            fn({
              concept: `${ns}:${name}`, start: e.start ?? null, end: e.end, val: e.val, unit, dims: {}, decimals: null,
              prov: { accn: e.accn ?? null, form: e.form as FormType, filed: e.filed ?? null, source: "sec-cf" },
            });
          }
    for (const arr of this.extra.values()) for (const f of arr) fn(f);
  }
  /** 재무 사실(us-gaap·ifrs-full)의 가장 늦은 제출일 — 표지(dei)·srt 몇 건만 들어온 공시는 재무가 빠진 것이라 세지 않는다(TSM 2025 20-F) */
  maxFiled(): string {
    let max = "";
    for (const [nsName, ns] of Object.entries(this.raw.facts ?? {}))
      if (FIN_NS.has(nsName)) for (const c of Object.values(ns))
        for (const arr of Object.values(c.units ?? {})) for (const e of arr) if (e.filed > max) max = e.filed;
    for (const arr of this.extra.values()) for (const f of arr) if ((f.prov.filed ?? "") > max) max = f.prov.filed!;
    return max;
  }
  /** companyfacts 에 재무 사실(us-gaap·ifrs-full)이 있는 공시 accn 집합 */
  accns(): Set<string> {
    const s = new Set<string>();
    for (const [nsName, ns] of Object.entries(this.raw.facts ?? {}))
      if (FIN_NS.has(nsName)) for (const c of Object.values(ns)) for (const arr of Object.values(c.units ?? {})) for (const e of arr) s.add(e.accn);
    for (const arr of this.extra.values()) for (const f of arr) if (f.prov.accn) s.add(f.prov.accn);
    return s;
  }
  /** 인스턴스에서 읽은 차원 없는 사실을 보탠다(같은 accn 이 이미 있으면 건너뜀) */
  addFacts(facts: RawFact[]): void {
    for (const f of facts) {
      if (Object.keys(f.dims).length) continue;
      const arr = this.extra.get(f.concept) ?? [];
      arr.push(f);
      this.extra.set(f.concept, arr);
      this.memo.delete(f.concept);
    }
  }
}

/** 재무제표 본체 네임스페이스 — companyfacts 누락 판정 기준 */
const FIN_NS = new Set(["us-gaap", "ifrs-full"]);

export function splitQ(qname: string): [string, string] {
  const i = qname.indexOf(":");
  return i < 0 ? ["us-gaap", qname] : [qname.slice(0, i), qname.slice(i + 1)];
}

export async function getCompanyFacts(cik: string): Promise<FactIndex> {
  const raw = await secJson<CfRaw>(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, 60_000);
  return new FactIndex(raw);
}

// ── 공시 원본(Archives) ──
const archBase = (cik: string, accn: string) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accn.replace(/-/g, "")}`;

export interface FilingFiles { names: string[]; base: string }
export async function filingFiles(cik: string, accn: string): Promise<FilingFiles> {
  const base = archBase(cik, accn);
  const idx = await secJson<{ directory: { item: { name: string }[] } }>(`${base}/index.json`);
  return { names: idx.directory.item.map((i) => i.name), base };
}

/** 링크베이스 원문 — _pre/_cal/_lab, 없으면 .xsd 내장(MSFT·ORCL 2026~). 없으면 null */
export async function linkbaseText(ff: FilingFiles, kind: "pre" | "cal" | "lab"): Promise<string | null> {
  const name = ff.names.find((n) => new RegExp(`_${kind}\\.xml$`, "i").test(n)) ?? ff.names.find((n) => /\.xsd$/i.test(n));
  if (!name) return null;
  return secText(`${ff.base}/${name}`);
}

/** 인스턴스 원문 — iXBRL 추출본(_htm.xml) 또는 옛 형식 인스턴스 */
export async function instanceText(ff: FilingFiles): Promise<string | null> {
  const name =
    ff.names.find((n) => /_htm\.xml$/i.test(n)) ??
    ff.names.find((n) => /\.xml$/i.test(n) && !/_(cal|def|lab|pre)\.xml$/i.test(n) && !/^(FilingSummary|MetaLinks|R\d+)\b/i.test(n));
  if (!name) return null;
  return secText(`${ff.base}/${name}`, 60_000);
}

// ── 인스턴스 파서(edgar-gapfill.ts 에서 옮겨 차원·decimals 보존) ──
const local = (q: string) => q.split(":").pop() ?? q;
interface Ctx { start: string | null; end: string | null; dims: Record<string, string> }

function parseContexts(xml: string): Map<string, Ctx> {
  const out = new Map<string, Ctx>();
  for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
    const b = m[2];
    const start = /<(?:xbrli:)?startDate>\s*([^<\s]+)/.exec(b)?.[1] ?? null;
    const end = /<(?:xbrli:)?endDate>\s*([^<\s]+)/.exec(b)?.[1] ?? /<(?:xbrli:)?instant>\s*([^<\s]+)/.exec(b)?.[1] ?? null;
    // explicitMember·typedMember 모두(edgar-gapfill.ts 와 같은 이유 — typedMember 를 놓치면 차원 값이 "차원 없음"으로 섞인다)
    const dims: Record<string, string> = {};
    for (const d of b.matchAll(/dimension="([^"]+)"[^>]*>([^<]*)</g)) dims[local(d[1])] = local(d[2].trim());
    out.set(m[1], { start, end, dims });
  }
  return out;
}
function parseUnits(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  const measures = (s: string) => [...s.matchAll(/<(?:xbrli:)?measure>([^<]+)</g)].map((x) => local(x[1].trim()));
  for (const m of xml.matchAll(/<(?:xbrli:)?unit\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?unit>/g)) {
    const b = m[2];
    const num = /unitNumerator>([\s\S]*?)<\/(?:xbrli:)?unitNumerator/.exec(b);
    const den = /unitDenominator>([\s\S]*?)<\/(?:xbrli:)?unitDenominator/.exec(b);
    out.set(m[1], num && den ? `${measures(num[1]).join("*")}/${measures(den[1]).join("*")}` : measures(b).join("*"));
  }
  return out;
}

/**
 * 인스턴스의 숫자 사실. `want` 가 있으면 그 개념(qname)만. 같은 개념·단위·기간·차원이 문맥 ID 만 달리 반복되면 하나만.
 */
export function parseInstance(xml: string, prov: Omit<Prov, "source" | "dims">, want?: (qname: string) => boolean): RawFact[] {
  const ctxs = parseContexts(xml);
  const units = parseUnits(xml);
  const out: RawFact[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<([A-Za-z][\w.-]*):([A-Za-z0-9_]+)\b([^>]*?)>\s*(-?[\d.eE+]+)\s*<\/\1:\2>/g)) {
    const [, ns, name, attrs, raw] = m;
    const qname = `${ns}:${name}`;
    if (want && !want(qname)) continue;
    const unitRef = /\bunitRef="([^"]+)"/.exec(attrs)?.[1];
    const cref = /\bcontextRef="([^"]+)"/.exec(attrs)?.[1];
    if (!unitRef || !cref) continue;
    const ctx = ctxs.get(cref);
    const val = Number(raw);
    if (!ctx?.end || !Number.isFinite(val)) continue;
    const unit = units.get(unitRef) ?? unitRef;
    const dstr = /\bdecimals="([^"]+)"/.exec(attrs)?.[1];
    const decimals = dstr == null || dstr === "INF" ? null : Number(dstr);
    const k = `${qname}|${unit}|${ctx.start ?? ""}|${ctx.end}|${JSON.stringify(ctx.dims)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      concept: qname, start: ctx.start, end: ctx.end, val, unit, dims: ctx.dims, decimals: Number.isFinite(decimals) ? decimals : null,
      prov: { ...prov, source: "sec-inst", ...(Object.keys(ctx.dims).length ? { dims: ctx.dims } : {}) },
    });
  }
  return out;
}

const PERIODIC = /^(10-[QK]|20-F|40-F)(\/A)?$/;

/**
 * companyfacts 누락 공시 보완(edgar-gapfill.ts 와 같은 판정) — 목록에 있는데 companyfacts 에 없는 최신 정기공시(최대 3건)의
 * 인스턴스를 읽어 보탠다. 못 읽으면 Gap.STALE.
 */
export async function fillMissingFilings(cik: string, idx: FactIndex, sub: Submissions): Promise<{ gaps: number; warnings: string[]; filled: string[] }> {
  const periodic = sub.recent.filter((f) => PERIODIC.test(f.form));
  const maxFiled = idx.maxFiled();
  const have = idx.accns();
  const missing = maxFiled ? periodic.filter((f) => f.filed > maxFiled && !have.has(f.accn)).slice(0, 3) : [];
  let gaps = 0;
  const warnings: string[] = [];
  const filled: string[] = [];
  for (const f of [...missing].reverse()) {
    try {
      const ff = await filingFiles(cik, f.accn);
      const xml = await instanceText(ff);
      if (!xml) throw new Error("인스턴스 없음");
      idx.addFacts(parseInstance(xml, { accn: f.accn, form: f.form as FormType, filed: f.filed }));
      filled.push(f.accn);
    } catch (e) {
      gaps |= Gap.STALE;
      warnings.push(`최신 공시 ${f.form} ${f.accn} 판독 실패: ${(e as Error).message}`);
    }
  }
  return { gaps, warnings, filled };
}

/** fetch-health 범위 — 이 조립에서 난 SEC 일시 오류만 */
export { withFetchScope };
