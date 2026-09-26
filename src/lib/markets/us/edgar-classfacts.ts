import "server-only";
import { fiscalYearOf } from "./edgar-series";
import { fetchJson, fetchText, isFetchFailure } from "../http";
import { checkBackoff, noteFetchFailure, noteFetchSuccess } from "../fetch-health";
import type { CompanyFacts } from "./edgar";

/**
 * 듀얼클래스 종목(Visa 등) 보정 — SEC companyfacts 는 undimensioned(차원 없는) 값만
 * 돌려주는데, Visa 는 EPS·가중평균주식수를 전부 `StatementClassOfStockAxis` 클래스
 * 차원에만 태깅한다 → companyfacts 에서 EPS·주식수가 통째로 비어버린다.
 *
 * 여기서는 10-K 파일링의 XBRL 인스턴스 문서(`*_htm.xml`)를 직접 받아
 * **Class A(상장 클래스)** 차원의 희석/기본 EPS 와 가중평균주식수를 연도별로 뽑는다.
 * Visa 의 "Class A 희석 가중평균주식수" 는 이미 B·C 를 전환 반영한 as-converted 총계라
 * 순이익 ÷ 이 값 = 공시 희석 EPS 와 일치한다(검증됨).
 *
 * 결과는 Mongo(`us_class_facts`)에 캐시하고 cron 이 분기 1회 갱신한다.
 */

const UA =
  process.env.SEC_USER_AGENT ??
  "global-market-research (personal use) contact@example.com";
const SEC_HEADERS = { "user-agent": UA, "accept-encoding": "gzip, deflate" };

export interface ClassAYear {
  /** 회계연도 종료 연도 (FY2025 → 2025) */
  fy: number;
  endDate: string;
  epsDiluted: number | null;
  epsBasic: number | null;
  /** 희석 가중평균주식수 (Class A, as-converted) — EPS 분모용 */
  dilShares: number | null;
  basicShares: number | null;
  /** 기말 유통주식수 (전 클래스 발행 주수 단순 합 — 전환비율 미반영) */
  sharesOutstanding: number | null;
  /**
   * 기말 보통주 전환 기준(as-converted) 주식수 — 클래스 A + 각 클래스 × 전환비율, 우선주 제외. 결산일 시가총액·
   * PBR·PSR 분모. 없으면(옛 캐시 포함) undefined/null.
   */
  sharesAsConverted?: number | null;
  /** 출처 10-K accession */
  sourceAccn: string;
}
export type ClassAFacts = Map<number, ClassAYear>;

/**
 * companyfacts 에 EPS·주식수 지표가 통째로 없어 클래스별 태깅 보정이 필요한가?
 * (Visa 형태. META 처럼 undimensioned EPS 를 정상 태깅하는 듀얼클래스는 false.)
 */
export function needsClassAFacts(facts: CompanyFacts): boolean {
  const g = facts.facts["us-gaap"] ?? {};
  const has = (node?: { units?: Record<string, unknown[]> }) =>
    !!node && Object.values(node.units ?? {}).some((a) => Array.isArray(a) && a.length > 0);
  const hasEps = [
    "EarningsPerShareDiluted",
    "EarningsPerShareBasic",
    "EarningsPerShareBasicAndDiluted",
    "IncomeLossFromContinuingOperationsPerDilutedShare",
    "IncomeLossFromContinuingOperationsPerBasicShare",
  ].some((t) => has(g[t]));
  // us-gaap 재무를 보고하는데(순이익 존재) EPS 만 통째로 없다 = 클래스별 태깅(Visa)
  const hasUsGaapNi = has(g["NetIncomeLoss"]) || has(g["ProfitLoss"]);
  return hasUsGaapNi && !hasEps;
}

// ── XBRL 인스턴스 파싱 ────────────────────────────────────────────────

interface Ctx {
  start?: string;
  end?: string;
  /** 차원 [축 로컬명, 멤버 로컬명] */
  dims: [string, string][];
}

const local = (qname: string) => qname.split(":").pop() ?? qname;

function parseContexts(xml: string): Map<string, Ctx> {
  const out = new Map<string, Ctx>();
  const re = /<context id="([^"]+)">([\s\S]*?)<\/context>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const body = m[2];
    const start = /<startDate>([^<]+)<\/startDate>/.exec(body)?.[1];
    const end =
      /<endDate>([^<]+)<\/endDate>/.exec(body)?.[1] ??
      /<instant>([^<]+)<\/instant>/.exec(body)?.[1];
    const dims: [string, string][] = [];
    const dre = /dimension="([^"]+)">([^<]+)</g;
    let d: RegExpExecArray | null;
    while ((d = dre.exec(body))) dims.push([local(d[1]), local(d[2])]);
    out.set(m[1], { start, end, dims });
  }
  return out;
}

const isClassA = (member: string) => {
  const s = member.replace(/Member$/, "").toLowerCase();
  return s === "commonclassa" || s === "commonstockclassa" || s.endsWith("classa");
};

/** 연간(330~400일) duration 인가 */
function isAnnual(ctx: Ctx): boolean {
  if (!ctx.start || !ctx.end) return false;
  const dur = (Date.parse(ctx.end) - Date.parse(ctx.start)) / 86_400_000;
  return dur >= 330 && dur <= 400;
}

interface Fact {
  fy: number;
  end: string;
  val: number;
}

function facts(xml: string, ctxs: Map<string, Ctx>, tag: string): Fact[] {
  const re = new RegExp(`<us-gaap:${tag}\\b([^>]*)>([^<]+)</us-gaap:${tag}>`, "g");
  const out: Fact[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const cref = /contextRef="([^"]+)"/.exec(m[1])?.[1];
    if (!cref) continue;
    const ctx = ctxs.get(cref);
    if (!ctx || !ctx.end || !isAnnual(ctx)) continue;
    // 차원 없음(undimensioned) 또는 StatementClassOfStockAxis=ClassA 단독만 채택
    const classDims = ctx.dims.filter(([axis]) => axis === "StatementClassOfStockAxis");
    if (ctx.dims.length === 0) {
      // undimensioned — 폴백용
    } else if (
      ctx.dims.length === 1 &&
      classDims.length === 1 &&
      isClassA(classDims[0][1])
    ) {
      // Class A 단독
    } else {
      continue;
    }
    const val = Number(m[2].trim());
    if (!Number.isFinite(val)) continue;
    out.push({ fy: fiscalYearOf(ctx.end), end: ctx.end, val });
  }
  return out;
}

const EPS_DIL_TAGS = ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"];
const EPS_BASIC_TAGS = ["EarningsPerShareBasic", "EarningsPerShareBasicAndDiluted"];
const DIL_SHARE_TAGS = ["WeightedAverageNumberOfDilutedSharesOutstanding"];
const BASIC_SHARE_TAGS = ["WeightedAverageNumberOfSharesOutstandingBasic"];

/**
 * 기말 유통주식수 (instant) — 전 클래스 합.
 * Visa 는 `StatementEquityComponentsAxis=CommonStockIncludingAdditionalPaidInCapital`
 * 차원에 전 클래스 합계를 태깅한다. 없으면 클래스별 `CommonStockSharesOutstanding`
 * 집계 멤버(A / B / B1AndB2 / C)를 합산.
 */
function instantSharesOutstanding(
  xml: string,
  ctxs: Map<string, Ctx>,
): Map<number, { end: string; val: number }> {
  const re = /<us-gaap:CommonStockSharesOutstanding\b([^>]*)>([^<]+)<\/us-gaap:CommonStockSharesOutstanding>/g;
  // fy → { total?: number; classSum: Map<memberLocal, val>; end }
  const acc = new Map<number, { end: string; total?: number; parts: Map<string, number> }>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const cref = /contextRef="([^"]+)"/.exec(m[1])?.[1];
    if (!cref) continue;
    const ctx = ctxs.get(cref);
    if (!ctx || !ctx.end || ctx.start) continue; // instant 만
    const val = Number(m[2].trim());
    if (!Number.isFinite(val)) continue;
    const fy = fiscalYearOf(ctx.end);
    const cur = acc.get(fy) ?? { end: ctx.end, parts: new Map<string, number>() };
    const equityDim = ctx.dims.find(([axis]) => axis === "StatementEquityComponentsAxis");
    const classDim = ctx.dims.find(([axis]) => axis === "StatementClassOfStockAxis");
    if (
      ctx.dims.length === 1 &&
      equityDim &&
      /CommonStockIncludingAdditionalPaidInCapital/i.test(equityDim[1])
    ) {
      cur.total = val;
    } else if (ctx.dims.length === 1 && classDim) {
      const mem = classDim[1].replace(/Member$/, "");
      if (/^Common(Stock)?Class([ABC]|B1AndB2|B[12])$/i.test(mem)) cur.parts.set(mem, val);
    }
    acc.set(fy, cur);
  }
  const out = new Map<number, { end: string; val: number }>();
  for (const [fy, a] of acc) {
    let total = a.total ?? null;
    if (total == null && a.parts.size) {
      // 집계 멤버만 합산 (B1AndB2 있으면 B1·B2 제외)
      const keys = [...a.parts.keys()];
      const hasB1AndB2 = keys.some((k) => /B1AndB2$/i.test(k));
      let sum = 0;
      for (const [k, v] of a.parts) {
        if (hasB1AndB2 && /B[12]$/i.test(k)) continue;
        sum += v;
      }
      total = sum > 0 ? sum : null;
    }
    if (total != null) out.set(fy, { end: a.end, val: total });
  }
  return out;
}

/**
 * 기말 **보통주 전환 기준(as-converted) 주식수** — Visa 형(클래스 B·C 가 A 로 전환되는 구조).
 * 전 클래스 발행 주수를 단순 합산하면 B(1주 = A 1.5~1.6주)·C(1주 = A 4주)가 과소 반영된다(V FY2021 19.32억 주 vs
 * 전환 기준 21.16억 주). 10-K 의 클래스별 as-converted 주식수 공시값(Visa `v:SharesOutstandingAsConvertedBasis`,
 * 백만 주 단위)을 보통주 클래스만 합산한다 — 인포맥스(FactSet) 결산일 주식수와 반올림 안에서 일치(FY2022~2025:
 * 2,068·2,022·1,966·1,918 vs 2,068.45·2,022.94·1,965.99·1,917.45, FY2021 2,116 vs 2,114.59). 우선주 전환분(시리즈
 * A·B·C)은 EV 브릿지가 우선주 장부가로 이미 더하므로 뺀다(인포맥스도 제외). 공시값이 없으면 클래스별 유통주식수 ×
 * 전환비율(`*ConversionRate`, 상장 클래스 A = 1)로 계산하고, 전환비율이 없는 클래스가 있으면 확정 불가로 null.
 */
/** 주식 단위(measure = shares, 나눗셈 없음) unit id — as-converted 합산을 주식 단위 값으로만 한정 */
function sharesUnitIds(xml: string): Set<string> {
  const out = new Set<string>();
  for (const m of xml.matchAll(/<(?:[\w-]+:)?unit\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?unit>/g))
    if (!/divide/i.test(m[2]) && /<(?:[\w-]+:)?measure>\s*(?:[\w-]+:)?shares\s*</i.test(m[2])) out.add(m[1]);
  return out;
}

function asConvertedCommon(xml: string, ctxs: Map<string, Ctx>): Map<number, number> {
  const shareUnits = sharesUnitIds(xml);
  const isCommon = (m: string) => /^Common/i.test(m) && !/Preferred|Series|Participating/i.test(m);
  const byDate = new Map<string, { conv: Map<string, number>; raw: Map<string, number>; rate: Map<string, number> }>();
  const slot = (d: string) => {
    let x = byDate.get(d);
    if (!x) byDate.set(d, (x = { conv: new Map(), raw: new Map(), rate: new Map() }));
    return x;
  };
  for (const m of xml.matchAll(/<([a-z0-9-]+):(\w+)\b([^>]*)>([^<]+)</g)) {
    const [, , tag, attrs, text] = m;
    const target = /AsConverted/i.test(tag) && !/WeightedAverage/i.test(tag) ? "conv"
      : tag === "CommonStockSharesOutstanding" ? "raw"
      : /^CommonStockConversionRate$/i.test(tag) ? "rate" : null;
    if (!target) continue;
    // /AsConverted/ 태그에 비율·금액(pure·USD) 값이 섞일 수 있다 — 주식 단위 값만 합산(독립 감사 2026-09-25)
    if (target !== "rate" && !shareUnits.has(/unitRef="([^"]+)"/.exec(attrs)?.[1] ?? "")) continue;
    const ctx = ctxs.get(/contextRef="([^"]+)"/.exec(attrs)?.[1] ?? "");
    if (!ctx?.end || ctx.start || ctx.dims.length !== 1 || ctx.dims[0][0] !== "StatementClassOfStockAxis") continue;
    const member = ctx.dims[0][1].replace(/Member$/, "");
    if (!isCommon(member)) continue;
    const v = Number(text.trim());
    if (!Number.isFinite(v)) continue;
    slot(ctx.end)[target].set(member, v);
  }
  // 집계 멤버(B1AndB2)는 구성 멤버(B1·B2)가 있으면 뺀다
  const leaves = (mm: Map<string, number>) =>
    [...mm].filter(([k]) => { const first = k.split(/And/i)[0]; return first === k || !mm.has(first); });
  const out = new Map<number, number>();
  for (const [end, x] of byDate) {
    let total: number | null = null;
    if (x.conv.size) total = leaves(x.conv).reduce((s, [, v]) => s + v, 0);
    else if (x.raw.size) {
      total = 0;
      for (const [k, v] of leaves(x.raw)) {
        const rate = isClassA(k) ? 1 : x.rate.get(k);
        if (rate == null || !(rate > 0)) { total = null; break; }
        total += v * rate;
      }
      // 전환비율 공시가 하나도 없으면 전환 구조가 아닌 복수 클래스 — 전환 기준 값이 아니다
      if (!x.rate.size) total = null;
    }
    if (total != null && total > 0) out.set(fiscalYearOf(end), total);
  }
  return out;
}

function pick(xml: string, ctxs: Map<string, Ctx>, tags: string[]): Map<number, number> {
  // 태그 우선순위대로, 없는 연도만 다음 태그로 보충
  const out = new Map<number, number>();
  for (const t of tags)
    for (const f of facts(xml, ctxs, t)) if (!out.has(f.fy)) out.set(f.fy, f.val);
  return out;
}

/** 단일 10-K 인스턴스에서 연도별 Class A EPS·주식수 추출 */
function parseInstance(xml: string, accn: string): ClassAYear[] {
  const ctxs = parseContexts(xml);
  const epsD = pick(xml, ctxs, EPS_DIL_TAGS);
  const epsB = pick(xml, ctxs, EPS_BASIC_TAGS);
  const shD = pick(xml, ctxs, DIL_SHARE_TAGS);
  const shB = pick(xml, ctxs, BASIC_SHARE_TAGS);
  const endByFy = new Map<number, string>();
  for (const t of [...EPS_DIL_TAGS, ...DIL_SHARE_TAGS])
    for (const f of facts(xml, ctxs, t)) if (!endByFy.has(f.fy)) endByFy.set(f.fy, f.end);
  const shOut = instantSharesOutstanding(xml, ctxs);
  const shConv = asConvertedCommon(xml, ctxs);
  const years = new Set([
    ...epsD.keys(),
    ...epsB.keys(),
    ...shD.keys(),
    ...shB.keys(),
    ...shOut.keys(),
  ]);
  const out: ClassAYear[] = [];
  for (const fy of years) {
    out.push({
      fy,
      endDate: endByFy.get(fy) ?? shOut.get(fy)?.end ?? `${fy}-12-31`,
      epsDiluted: epsD.get(fy) ?? null,
      epsBasic: epsB.get(fy) ?? null,
      dilShares: shD.get(fy) ?? null,
      basicShares: shB.get(fy) ?? null,
      sharesOutstanding: shOut.get(fy)?.val ?? null,
      sharesAsConverted: shConv.get(fy) ?? null,
      sourceAccn: accn,
    });
  }
  return out;
}

// ── 파일링 목록 → 인스턴스 URL ───────────────────────────────────────

interface SubmissionsRecent {
  filings: {
    recent: {
      accessionNumber: string[];
      form: string[];
      filingDate: string[];
      primaryDocument: string[];
    };
  };
}

interface FilingIndex {
  directory: { item: { name: string }[] };
}

export async function instanceUrl(cik: number, accnNoDash: string, primaryDoc: string): Promise<string | null> {
  const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${accnNoDash}`;
  const stem = primaryDoc.replace(/\.html?$/i, "");
  // 최신 파일링: `{stem}_htm.xml`
  const guess = `${base}/${stem}_htm.xml`;
  // HEAD 도 일시 오류(429·403·5xx·네트워크)는 기록한다 — index.json 폴백이 성공해도 SEC 가 막히고 있다는 신호(fetch-health.ts)
  if (checkBackoff(guess) === 0) {
    try {
      const head = await fetch(guess, { method: "HEAD", headers: SEC_HEADERS });
      if (head.ok) {
        noteFetchSuccess(guess);
        return guess;
      }
      noteFetchFailure(guess, head.status);
    } catch {
      noteFetchFailure(guess, undefined);
    }
  }
  // index.json 으로 인스턴스 파일 탐색 (구버전 등)
  try {
    const idx = await fetchJson<FilingIndex>(`${base}/index.json`, {
      headers: SEC_HEADERS,
      revalidate: 60 * 60 * 24,
    });
    const xmls = idx.directory.item
      .map((i) => i.name)
      .filter(
        (n) =>
          n.endsWith(".xml") &&
          !/_(cal|def|lab|pre)\.xml$/i.test(n) &&
          !/^(FilingSummary|MetaLinks|R\d+)\b/i.test(n),
      );
    const htm = xmls.find((n) => /_htm\.xml$/i.test(n));
    const dated = xmls.find((n) => /-\d{8}\.xml$/i.test(n));
    const chosen = htm ?? dated ?? xmls[0];
    return chosen ? `${base}/${chosen}` : null;
  } catch (e) {
    // 목록(index.json) 조회 실패는 "인스턴스 없음"이 아니다 — 호출부가 공란·재시도로 처리하도록 올린다(sec-unavailable.ts)
    if (isFetchFailure(e)) throw e;
    return null;
  }
}

/**
 * cik(10자리 문자열 또는 숫자)의 최근 10-K 몇 건에서 Class A EPS·주식수 시계열 추출.
 * 각 10-K 는 3개 회계연도를 담으므로 4건이면 ~6년 + 중복검증.
 */
export async function fetchClassAFacts(cik: string | number, maxFilings = 4): Promise<ClassAFacts> {
  const cikNum = Number(String(cik).replace(/\D/g, ""));
  const cik10 = String(cikNum).padStart(10, "0");
  const sub = await fetchJson<SubmissionsRecent>(
    `https://data.sec.gov/submissions/CIK${cik10}.json`,
    { headers: SEC_HEADERS, revalidate: 60 * 60 * 6 },
  );
  const r = sub.filings.recent;
  const tenKs: { accn: string; doc: string }[] = [];
  for (let i = 0; i < r.accessionNumber.length && tenKs.length < maxFilings; i++) {
    if (r.form[i] === "10-K" || r.form[i] === "10-K/A")
      tenKs.push({ accn: r.accessionNumber[i], doc: r.primaryDocument[i] });
  }

  const merged: ClassAFacts = new Map();
  // 최신 파일링부터 → 먼저 채운 연도(재작성 반영본)를 유지
  for (const { accn, doc } of tenKs) {
    try {
      const url = await instanceUrl(cikNum, accn.replace(/-/g, ""), doc);
      if (!url) continue;
      const xml = await fetchText(url, { headers: SEC_HEADERS, revalidate: false, timeoutMs: 25_000 });
      for (const y of parseInstance(xml, accn)) {
        const prev = merged.get(y.fy);
        if (!prev) {
          merged.set(y.fy, y);
        } else {
          // 결측 필드만 보충
          merged.set(y.fy, {
            ...prev,
            epsDiluted: prev.epsDiluted ?? y.epsDiluted,
            epsBasic: prev.epsBasic ?? y.epsBasic,
            dilShares: prev.dilShares ?? y.dilShares,
            basicShares: prev.basicShares ?? y.basicShares,
            sharesOutstanding: prev.sharesOutstanding ?? y.sharesOutstanding,
            sharesAsConverted: prev.sharesAsConverted ?? y.sharesAsConverted,
          });
        }
      }
    } catch (e) {
      // 조회 실패는 일부 연도만 채운 결과를 만들지 않게 올린다(부분 결과가 DB 에 백필되면 굳는다 — class-facts-loader.ts)
      if (isFetchFailure(e)) throw e;
      /* 파싱 실패 1건은 무시 */
    }
  }
  return merged;
}

// ── 조회 헬퍼 (빌더에서 사용) ────────────────────────────────────────

export function classAEps(
  cf: ClassAFacts | null | undefined,
  year: number,
  kind: "diluted" | "basic",
): number | null {
  const y = cf?.get(year);
  if (!y) return null;
  return kind === "diluted" ? y.epsDiluted : y.epsBasic;
}

export function classAShares(
  cf: ClassAFacts | null | undefined,
  year: number,
): number | null {
  const y = cf?.get(year);
  return y ? (y.dilShares ?? y.basicShares) : null;
}

export function classALatest(cf: ClassAFacts | null | undefined): ClassAYear | null {
  if (!cf || cf.size === 0) return null;
  return [...cf.values()].sort((a, b) => b.fy - a.fy)[0];
}

/** 회계연도 기말 유통주식수 (전 클래스 as-converted 합) — 시총·PBR·PSR 분모용. */
export function classAOutstanding(
  cf: ClassAFacts | null | undefined,
  year: number,
): number | null {
  return cf?.get(year)?.sharesOutstanding ?? null;
}

/**
 * 회계연도 기말 보통주 전환 기준(as-converted) 주식수 — 결산일 시가총액·PBR·PSR 분모(edgar-shares.ts).
 * `undefined` = 이 필드가 생기기 전 캐시(재조회 필요), `null` = 공시로 확정 못 함.
 */
export function classAsConverted(cf: ClassAFacts | null | undefined, year: number): number | null {
  return cf?.get(year)?.sharesAsConverted ?? null;
}

/** 가장 최근 회계연도 기말 유통주식수. */
export function classAOutstandingLatest(cf: ClassAFacts | null | undefined): number | null {
  const y = classALatest(cf);
  return y?.sharesOutstanding ?? null;
}
