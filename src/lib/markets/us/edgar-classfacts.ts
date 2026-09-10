import "server-only";
import { fetchJson, fetchText } from "../http";
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
  /** 희석 가중평균주식수 (Class A, as-converted) */
  dilShares: number | null;
  basicShares: number | null;
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
  const dei = facts.facts.dei ?? {};
  const has = (node?: { units?: Record<string, unknown[]> }) =>
    !!node && Object.values(node.units ?? {}).some((a) => Array.isArray(a) && a.length > 0);
  const hasEps =
    has(g["EarningsPerShareDiluted"]) ||
    has(g["EarningsPerShareBasic"]) ||
    has(g["EarningsPerShareBasicAndDiluted"]);
  const hasShares =
    has(g["WeightedAverageNumberOfDilutedSharesOutstanding"]) ||
    has(g["WeightedAverageNumberOfSharesOutstandingBasic"]) ||
    has(g["CommonStockSharesOutstanding"]) ||
    has(dei["EntityCommonStockSharesOutstanding"]);
  return !hasEps && !hasShares;
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
    out.push({ fy: Number(ctx.end.slice(0, 4)), end: ctx.end, val });
  }
  return out;
}

const EPS_DIL_TAGS = ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"];
const EPS_BASIC_TAGS = ["EarningsPerShareBasic", "EarningsPerShareBasicAndDiluted"];
const DIL_SHARE_TAGS = ["WeightedAverageNumberOfDilutedSharesOutstanding"];
const BASIC_SHARE_TAGS = ["WeightedAverageNumberOfSharesOutstandingBasic"];

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
  const years = new Set([...epsD.keys(), ...epsB.keys(), ...shD.keys(), ...shB.keys()]);
  const out: ClassAYear[] = [];
  for (const fy of years) {
    out.push({
      fy,
      endDate: endByFy.get(fy) ?? `${fy}-12-31`,
      epsDiluted: epsD.get(fy) ?? null,
      epsBasic: epsB.get(fy) ?? null,
      dilShares: shD.get(fy) ?? null,
      basicShares: shB.get(fy) ?? null,
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

async function instanceUrl(cik: number, accnNoDash: string, primaryDoc: string): Promise<string | null> {
  const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${accnNoDash}`;
  const stem = primaryDoc.replace(/\.html?$/i, "");
  // 최신 파일링: `{stem}_htm.xml`
  const guess = `${base}/${stem}_htm.xml`;
  try {
    const head = await fetch(guess, { method: "HEAD", headers: SEC_HEADERS });
    if (head.ok) return guess;
  } catch {
    /* fall through */
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
  } catch {
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
          });
        }
      }
    } catch {
      /* 파일링 1건 실패는 무시 */
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
