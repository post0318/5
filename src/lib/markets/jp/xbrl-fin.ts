import "server-only";
import { unzipSync } from "fflate";
import { edinetDocZip, edinetTaxonomyText, readEdinetJson, writeEdinetJson } from "./edinet-store";

/**
 * **EDINET XBRL(type=1) → 본표(本表) 판독**(오너 결정 2026-10-08 — "일본 검증은 미국 기준으로, 페이지 구성도 미국·한국을 따른다").
 *
 * 원칙(미국의 교훈 — 태그 우선순위로 고르면 본표 줄과 주석 태그가 섞여 이중 합산):
 *  - 줄 구조 = 그 서류의 **표시 구조(_pre.xml)** 의 본표 역할(連結貸借対照表·連結損益計算書·連結包括利益計算書·連結キャッシュ・フロー計算書,
 *    IFRS 는 連結財政状態計算書·連結損益計算書 등). 연결 본표가 있으면 연결, 없으면 개별(単体).
 *  - 이름표 = 표시 구조가 지정한 이름표 역할(preferredLabel — 合計·期首残高 등) → 회사 이름표(_lab.xml, 표준 계정의 회사 변경 이름 포함) →
 *    EDINET 공개 분류 이름표(판별 _lab.xml, edinet-store 영구 캐시). 원본 표현 그대로(일본어).
 *  - 값 = 인스턴스(.xbrl)의 사실 — 회사 고유(확장) 계정도 같은 방식으로 읽는다. 연결 본표는 차원 없는 문맥만.
 *    부호는 공시 그대로이고, 표시 구조가 negatedLabel 을 지정한 줄만 표시 부호를 뒤집는다(neg).
 *  - 계산 구조(_cal.xml) 는 같은 역할의 부모 → 자식(가중치)을 그대로 남긴다(검증용 — 합계 = Σ 자식).
 * 결과는 디스크(<EDINET_CACHE_DIR>/jp-fin/v<판>/<docID>.json)에 저장 — 서류 번호는 바뀌지 않는다. 판독 규칙이 바뀌면 JP_PARSE_VERSION 을 올린다.
 * 판 2(2026-10-08): 하이라이트·재무분석용으로 경영지표 주당 지표(EPS·BPS·DPS)·발행주식·자기주식·리스부채 주석(parseExtras)을 함께 읽는다.
 */

export const JP_PARSE_VERSION = 2;

export type JpStmtKind = "bs" | "is" | "ci" | "cf";
/** 값 단위 — m 금액(엔), ps 주당(엔/주), sh 주식수, p 비율 */
export type JpUnit = "m" | "ps" | "sh" | "p";

export interface JpLine {
  /** 개념 열쇠 — 표준 "jppfs_cor:NetSales"·"jpigp_cor:RevenueIFRS", 회사 고유 "ext:SalesOfProductsIFRS" */
  k: string;
  /** 이름표(본표 표시 그대로) */
  l: string;
  /** 들여쓰기 */
  d: number;
  /** 제목 줄(…Abstract — 값 없음) */
  ab?: 1;
  /** 합계 줄(totalLabel 또는 계산 구조의 부모) */
  tot?: 1;
  /** 표시 구조가 negatedLabel — 표시 값 = −공시 값 */
  neg?: 1;
  /** 기초(s)·기말(e) 잔액 줄(periodStart/EndLabel) — 기간 줄이 아니라 시점 값 */
  ps?: "s" | "e";
}
export interface JpStmt {
  /** 표시 구조 역할(rol_… 끝부분) */
  role: string;
  cons: boolean;
  lines: JpLine[];
  /** 계산 구조 [부모, 자식, 가중치] */
  calc: [string, string, number][];
}
export interface JpDocFin {
  v: number;
  docID: string;
  /** AccountingStandardsDEI — "IFRS"·"Japan GAAP"·"US GAAP" */
  std: string | null;
  /** 연결 재무제표 작성 여부(DEI) */
  cons: boolean | null;
  /** TypeOfCurrentPeriodDEI — FY·HY·Q1·Q2·Q3 */
  kind: string | null;
  fyStart: string | null;
  fyEnd: string | null;
  perEnd: string | null;
  stmts: Partial<Record<JpStmtKind, JpStmt>>;
  /** 개념 → 기간 열쇠("D시작_끝"·"I날짜") → 공시 값(본표 줄 개념만) */
  facts: Record<string, Record<string, number>>;
  units: Record<string, JpUnit>;
  /**
   * 경영지표(主要な経営指標等の推移, jpcrp …SummaryOfBusinessResults) 중 주당 지표 — 개념 local 이름 → 기간 열쇠(개별은 "|nc") → 값.
   * null = 공시가 "－"(nil — 무배당·희석 증권 없음 등). 하이라이트·재무분석(jp-ev.ts)의 EPS·BPS·DPS 출처(판 2 부터).
   */
  sum?: Record<string, Record<string, number | null>>;
  /** 기말(반기말) 발행주식수·자기주식(株式の総数等·自己株式等) — 유통주식수 = 발행 − 자기 명의·타인 명의 자기주식(회사 행) */
  shares?: JpDocShares | null;
  /** 주석 문단(TextBlock) 중 "リース負債" 가 나오는 것 — 이름과 (流動)·(非流動) 표의 전기·당기 합계(엔). 본표에 리스부채 줄이 없을 때 판정용 */
  leaseTb?: { n: string; amt?: [number, number] | null }[];
  warn: string[];
}
export interface JpDocShares {
  /** 기준일(당기말·반기말) */
  at: string | null;
  /** 기말 발행주식수(期末現在発行数) */
  issued: number | null;
  /** 제출일 현재 발행주식수(提出日現在発行数) — 기말 뒤 분할·소각 판정 */
  issuedFiling: number | null;
  /** 자기주식 — 회사 자신 행(소유자 이름 = 제출회사)의 자기 명의 + 타인 명의 */
  treasury: number | null;
  /** 판정 근거·실패 사유 */
  how: string;
}

export const pkDur = (start: string, end: string) => `D${start}_${end}`;
export const pkInst = (date: string) => `I${date}`;

// ── XML 도우미(정규식 — 저장소의 다른 XBRL 판독과 같은 방식) ──
const attr = (a: string, name: string): string | null => {
  const m = new RegExp(`\\b${name.replace(/[:.]/g, "\\$&")}="([^"]*)"`).exec(a);
  return m ? m[1] : null;
};
const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

/** 연결 구조 href("…xsd#jppfs_cor_NetSales") → 개념 열쇠 */
export function hrefKey(href: string): string | null {
  const i = href.indexOf("#");
  if (i < 0) return null;
  const frag = href.slice(i + 1);
  const std = /^(jp[a-z]+_cor)_(.+)$/.exec(frag);
  if (std) return `${std[1]}:${std[2]}`;
  const ext = /_E\d{5}-\d{3}_(.+)$/.exec(frag);
  if (ext) return `ext:${ext[1]}`;
  return `ext:${frag}`;
}
/** 인스턴스 이름공간 URI → 열쇠 앞부분(표준 "jppfs_cor"…, 회사 고유 "ext") */
function nsKey(uri: string): string | null {
  const std = /\/(jp[a-z]+_cor)$/.exec(uri);
  if (std) return std[1];
  if (/\/E\d{5}-\d{3}\//.test(uri)) return "ext";
  return null;
}
const localOf = (k: string) => k.slice(k.indexOf(":") + 1);

interface LinkRole {
  locs: Map<string, string>;
  arcs: { from: string; to: string; order: number; pl: string | null; w: number }[];
}
/** 표시·계산 연결 파일 → 역할 URI → 위치표(loc 이름 → 개념)·연결선 */
function parseLinks(xml: string, kind: "presentation" | "calculation"): Map<string, LinkRole> {
  const out = new Map<string, LinkRole>();
  const linkRe = new RegExp(`<(?:link:)?${kind}Link\\b([^>]*)>([\\s\\S]*?)</(?:link:)?${kind}Link>`, "g");
  const arcRe = new RegExp(`<(?:link:)?${kind}Arc\\b([^>]*?)/?>`, "g");
  for (const m of xml.matchAll(linkRe)) {
    const role = attr(m[1], "xlink:role");
    if (!role) continue;
    const r: LinkRole = out.get(role) ?? { locs: new Map(), arcs: [] };
    out.set(role, r);
    for (const l of m[2].matchAll(/<(?:link:)?loc\b([^>]*?)\/?>/g)) {
      const href = attr(l[1], "xlink:href");
      const label = attr(l[1], "xlink:label");
      const k = href ? hrefKey(href) : null;
      if (label && k) r.locs.set(label, k);
    }
    for (const a of m[2].matchAll(arcRe)) {
      const from = attr(a[1], "xlink:from");
      const to = attr(a[1], "xlink:to");
      if (!from || !to) continue;
      // 제외(prohibited)·대체 연결선은 회사 공시에 거의 없다 — 있으면 그대로 두고 우선순위 처리 안 함(경고)
      r.arcs.push({
        from,
        to,
        order: Number(attr(a[1], "order") ?? 0),
        pl: attr(a[1], "preferredLabel"),
        w: Number(attr(a[1], "weight") ?? 1),
      });
    }
  }
  return out;
}

type Labels = Map<string, Map<string, string>>;
const STD_ROLE = "http://www.xbrl.org/2003/role/label";
/** 이름표 연결 파일 → 개념 → 역할 → 문구(ja). verboseLabel·documentation 은 버린다 */
function parseLabels(xml: string, into: Labels = new Map()): Labels {
  for (const m of xml.matchAll(/<(?:link:)?labelLink\b[^>]*>([\s\S]*?)<\/(?:link:)?labelLink>/g)) {
    const body = m[1];
    const locs = new Map<string, string>();
    for (const l of body.matchAll(/<(?:link:)?loc\b([^>]*?)\/?>/g)) {
      const href = attr(l[1], "xlink:href");
      const label = attr(l[1], "xlink:label");
      const k = href ? hrefKey(href) : null;
      if (label && k) locs.set(label, k);
    }
    const res = new Map<string, { role: string; text: string }[]>();
    for (const l of body.matchAll(/<(?:link:)?label\b([^>]*)>([\s\S]*?)<\/(?:link:)?label>/g)) {
      const lang = attr(l[1], "xml:lang");
      if (lang && lang !== "ja") continue;
      const role = attr(l[1], "xlink:role") ?? STD_ROLE;
      if (/verboseLabel|documentation/.test(role)) continue;
      const id = attr(l[1], "xlink:label");
      if (!id) continue;
      const arr = res.get(id) ?? [];
      arr.push({ role, text: decodeXml(l[2]).trim() });
      res.set(id, arr);
    }
    for (const a of body.matchAll(/<(?:link:)?labelArc\b([^>]*?)\/?>/g)) {
      const k = locs.get(attr(a[1], "xlink:from") ?? "");
      const rs = res.get(attr(a[1], "xlink:to") ?? "");
      if (!k || !rs) continue;
      const mm = into.get(k) ?? new Map<string, string>();
      for (const r of rs) if (!mm.has(r.role)) mm.set(r.role, r.text);
      into.set(k, mm);
    }
  }
  return into;
}

// 공개 분류 이름표 — 판별 파일 하나(jppfs 5MB)를 프로세스당 한 번만 판독
const taxMemo = new Map<string, Promise<Labels>>();
function taxonomyLabels(rel: string): Promise<Labels> {
  let p = taxMemo.get(rel);
  if (!p) {
    p = edinetTaxonomyText(rel).then((x) => parseLabels(x));
    p.catch(() => taxMemo.delete(rel)); // 실패는 다음 요청이 다시 시도(호출자에게는 그대로 던짐)
    taxMemo.set(rel, p);
  }
  return p;
}
/** 표시 구조 href 의 표준 분류 판 → 이름표 파일 경로("jppfs/2025-11-01/label/jppfs_2025-11-01_lab.xml") */
function taxRelOf(href: string): string | null {
  const m = /\/taxonomy\/(jppfs|jpigp|jpcrp)\/(\d{4}-\d{2}-\d{2})\//.exec(href);
  return m ? `${m[1]}/${m[2]}/label/${m[1]}_${m[2]}_lab.xml` : null;
}

/** 표시 구조 역할 → 본표 종류(연결 여부). 본표가 아니면 null */
function classifyRole(role: string): { kind: JpStmtKind; cons: boolean } | null {
  const r = role.split("/").pop() ?? "";
  if (!/^rol_/.test(r) || /Notes|ChangesIn|Segment|SummaryOf|BusinessResults/i.test(r)) return null;
  // 옛 IFRS 四半期報告書는 손익·포괄손익이 누적(YearToQuarterEnd)·3개월(QuarterPeriod) 두 본표 — 누적만(반기 열 = 6개월 누적)
  if (/QuarterPeriod/.test(r)) return null;
  const cons = /Consolidated/.test(r);
  if (/CashFlows/.test(r)) return { kind: "cf", cons };
  if (/BalanceSheet|FinancialPosition/.test(r)) return { kind: "bs", cons };
  if (/ComprehensiveIncomeSingleStatement|IncomeAndComprehensiveIncome|ProfitOrLossAndOtherComprehensiveIncome/.test(r)) return { kind: "is", cons };
  if (/ComprehensiveIncome/.test(r)) return { kind: "ci", cons };
  if (/StatementOfIncome|ProfitOrLoss|StatementsOfIncome/.test(r)) return { kind: "is", cons };
  return null;
}

const shortRole = (role: string | null) => (role ?? "").split("/").pop() ?? "";

/** zip 하나 판독(디스크 캐시 없이) */
export async function parseJpDocZip(docID: string, zip: Uint8Array): Promise<JpDocFin> {
  const files = unzipSync(zip, { filter: (f) => /(^|\/)PublicDoc\/[^/]+\.(xbrl|xml)$/.test(f.name) });
  const names = Object.keys(files);
  const pick = (re: RegExp) => names.find((n) => re.test(n));
  const instName = pick(/\.xbrl$/);
  const preName = pick(/_pre\.xml$/);
  if (!instName || !preName) throw new Error(`EDINET XBRL 에 인스턴스·표시 구조 없음(${docID})`);
  const dec = new TextDecoder("utf-8");
  const inst = dec.decode(files[instName]);
  const pre = dec.decode(files[preName]);
  const calName = pick(/_cal\.xml$/);
  const labName = pick(/_lab\.xml$/);
  const cal = calName ? dec.decode(files[calName]) : "";
  const lab = labName ? dec.decode(files[labName]) : "";
  const warn: string[] = [];

  // DEI
  const dei = (n: string) => {
    const m = new RegExp(`<jpdei_cor:${n}\\b[^>]*>([^<]*)<`).exec(inst);
    return m ? m[1].trim() : null;
  };
  const consDei = dei("WhetherConsolidatedFinancialStatementsArePreparedDEI");

  // 본표 역할
  const preLinks = parseLinks(pre, "presentation");
  const calLinks = cal ? parseLinks(cal, "calculation") : new Map<string, LinkRole>();
  const roles = [...preLinks.keys()].map((r) => ({ r, c: classifyRole(r) })).filter((x) => x.c);
  const anyCons = roles.some((x) => x.c!.cons);
  const chosen = new Map<JpStmtKind, string>();
  for (const { r, c } of roles) {
    if (c!.cons !== anyCons) continue;
    if (chosen.has(c!.kind)) {
      warn.push(`본표 역할 중복 ${c!.kind}: ${shortRole(chosen.get(c!.kind)!)} · ${shortRole(r)} — 앞의 것 사용`);
      continue;
    }
    chosen.set(c!.kind, r);
  }

  // 이름표 — 회사 파일 + 표준 분류(필요한 판만)
  const companyLabels = lab ? parseLabels(lab) : new Map<string, Map<string, string>>();
  const taxRels = new Set<string>();
  for (const m of pre.matchAll(/xlink:href="(http:\/\/disclosure\.edinet-fsa\.go\.jp\/taxonomy\/[^"#]+)#/g)) {
    const rel = taxRelOf(m[1]);
    if (rel) taxRels.add(rel);
  }
  const taxLabels = await Promise.all([...taxRels].map((r) => taxonomyLabels(r)));
  const labelOf = (k: string, pl: string | null): string => {
    for (const role of pl ? [pl, STD_ROLE] : [STD_ROLE]) {
      const c = companyLabels.get(k)?.get(role);
      if (c) return c;
      for (const t of taxLabels) {
        const v = t.get(k)?.get(role);
        if (v) return v;
      }
    }
    return localOf(k);
  };

  const stmts: Partial<Record<JpStmtKind, JpStmt>> = {};
  const needed = new Set<string>();
  for (const [kind, role] of chosen) {
    const link = preLinks.get(role)!;
    const children = new Map<string, { to: string; order: number; pl: string | null }[]>();
    const tos = new Set<string>();
    const firstSeen: string[] = [];
    for (const a of link.arcs) {
      const f = link.locs.get(a.from);
      const t = link.locs.get(a.to);
      if (!f || !t) continue;
      if (!children.has(f)) firstSeen.push(f);
      const arr = children.get(f) ?? [];
      arr.push({ to: t, order: a.order, pl: a.pl });
      children.set(f, arr);
      tos.add(t);
    }
    for (const arr of children.values()) arr.sort((x, y) => x.order - y.order);
    const calcArcs: [string, string, number][] = [];
    const calcParents = new Set<string>();
    const cl = calLinks.get(role);
    if (cl)
      for (const a of cl.arcs) {
        const f = cl.locs.get(a.from);
        const t = cl.locs.get(a.to);
        if (f && t) {
          calcArcs.push([f, t, a.w]);
          calcParents.add(f);
        }
      }
    const lines: JpLine[] = [];
    const walk = (k: string, depth: number, pl: string | null, stack: string[]) => {
      if (stack.includes(k)) {
        warn.push(`표시 구조 순환 ${shortRole(role)} ${k}`);
        return;
      }
      const loc = localOf(k);
      const kids = children.get(k) ?? [];
      const next = [...stack, k];
      if (/(Table|Axis|Member|Domain)$/.test(loc)) return;
      if (/(Heading|LineItems)$/.test(loc)) {
        for (const c of kids) walk(c.to, depth, c.pl, next);
        return;
      }
      const prole = shortRole(pl);
      const ln: JpLine = { k, l: labelOf(k, pl), d: depth };
      if (/Abstract$/.test(loc)) ln.ab = 1;
      else {
        needed.add(k);
        if (/totalLabel/i.test(prole) || calcParents.has(k)) ln.tot = 1;
        if (/negated/i.test(prole)) ln.neg = 1;
        if (/periodStart/i.test(prole)) ln.ps = "s";
        else if (/periodEnd/i.test(prole)) ln.ps = "e";
      }
      lines.push(ln);
      for (const c of kids) walk(c.to, depth + 1, c.pl, next);
    };
    for (const root of firstSeen.filter((k) => !tos.has(k))) walk(root, 0, null, []);
    if (!lines.length) {
      warn.push(`본표 줄 없음 ${shortRole(role)}`);
      continue;
    }
    stmts[kind] = { role: shortRole(role), cons: anyCons, lines, calc: calcArcs };
  }

  // 문맥 — 연결 본표(또는 연결 미작성 회사의 개별 본표)는 차원 없는 문맥만
  const ns = new Map<string, string>();
  for (const m of inst.slice(0, 20000).matchAll(/xmlns:([\w.-]+)="([^"]+)"/g)) {
    const k = nsKey(m[2]);
    if (k) ns.set(m[1], k);
  }
  const ctx = new Map<string, string>();
  for (const m of inst.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
    const body = m[2];
    if (/explicitMember|typedMember/.test(body)) continue;
    const inst1 = /<(?:xbrli:)?instant>([^<]+)</.exec(body);
    const st = /<(?:xbrli:)?startDate>([^<]+)</.exec(body);
    const en = /<(?:xbrli:)?endDate>([^<]+)</.exec(body);
    if (inst1) ctx.set(m[1], pkInst(inst1[1].trim()));
    else if (st && en) ctx.set(m[1], pkDur(st[1].trim(), en[1].trim()));
  }
  const unitKind = (u: string): JpUnit | null => {
    if (/PerShare/i.test(u)) return "ps";
    if (/^shares$/i.test(u)) return "sh";
    if (/^pure$/i.test(u)) return "p";
    if (/^JPY$/i.test(u)) return "m";
    return null;
  };
  const facts: Record<string, Record<string, number>> = {};
  const units: Record<string, JpUnit> = {};
  const factRe = /<([\w.-]+):([\w.-]+)\b([^>]*?\bcontextRef="([^"]+)"[^>]*?)(?:\/>|>([^<]*)<\/\1:\2>)/g;
  for (const m of inst.matchAll(factRe)) {
    const p = ns.get(m[1]);
    if (!p) continue;
    const k = `${p}:${m[2]}`;
    if (!needed.has(k)) continue;
    const pk = ctx.get(m[4]);
    if (!pk) continue;
    const a = m[3];
    if (/xsi:nil="true"/.test(a) || m[5] == null) continue;
    const u = attr(a, "unitRef");
    if (!u) continue;
    const uk = unitKind(u);
    if (!uk) {
      warn.push(`엔화 아닌 단위 ${u} — ${k} 제외`);
      continue;
    }
    const v = Number(m[5].trim());
    if (!Number.isFinite(v)) continue;
    const o = (facts[k] ??= {});
    if (o[pk] != null && o[pk] !== v) warn.push(`같은 문맥 다른 값 ${k} ${pk}: ${o[pk]} · ${v}`);
    o[pk] ??= v;
    units[k] ??= uk;
  }

  const ex = parseExtras(inst, dei("FilerNameInJapaneseDEI"));

  return {
    v: JP_PARSE_VERSION,
    docID,
    sum: ex.sum,
    shares: ex.shares,
    leaseTb: ex.leaseTb,
    std: dei("AccountingStandardsDEI"),
    cons: consDei == null ? null : consDei === "true",
    kind: dei("TypeOfCurrentPeriodDEI"),
    fyStart: dei("CurrentFiscalYearStartDateDEI"),
    fyEnd: dei("CurrentFiscalYearEndDateDEI"),
    perEnd: dei("CurrentPeriodEndDateDEI"),
    stmts,
    facts,
    units,
    warn: [...new Set(warn)].slice(0, 30),
  };
}

/** 경영지표 중 읽는 주당 지표(jpcrp_cor) — IFRS 의 "1株当たり親会社所有者帰属持分"(BPS) 태그 이름이 EquityToAssetRatioIFRS… 인 것은 EDINET 분류 그대로 */
const SUM_TAGS = new Set([
  "BasicEarningsLossPerShareIFRSSummaryOfBusinessResults",
  "DilutedEarningsLossPerShareIFRSSummaryOfBusinessResults",
  "BasicEarningsLossPerShareSummaryOfBusinessResults",
  "DilutedEarningsPerShareSummaryOfBusinessResults",
  "EquityToAssetRatioIFRSSummaryOfBusinessResults",
  "NetAssetsPerShareSummaryOfBusinessResults",
  "DividendPaidPerShareSummaryOfBusinessResults",
  "InterimDividendPaidPerShareSummaryOfBusinessResults",
]);
const SHARE_TAGS = new Set([
  "NumberOfIssuedSharesAsOfFiscalYearEndIssuedSharesTotalNumberOfSharesEtc",
  "NumberOfIssuedSharesAsOfFilingDateIssuedSharesTotalNumberOfSharesEtc",
  "NumberOfSharesHeldInOwnNameTreasurySharesEtc",
  "NumberOfSharesHeldInOthersNamesTreasurySharesEtc",
  "NameOfShareholderTreasurySharesEtc",
]);
/** 회사 이름 비교용 — 株式会社·㈱·(株) 와 공백을 지운다 */
const normName = (s: string) => s.replace(/株式会社|㈱|[(（]株[)）]|\s|　/g, "");

/** 경영지표 주당 지표·발행주식·자기주식·리스부채 주석(판 2) — 차원 문맥도 본다(개별 NonConsolidatedMember·자기주식 표 행 RowN) */
function parseExtras(
  inst: string,
  filer: string | null,
): { sum: Record<string, Record<string, number | null>>; shares: JpDocShares | null; leaseTb: { n: string; amt?: [number, number] | null }[] } {
  const ctx = new Map<string, { pk: string; mem: string[] }>();
  for (const m of inst.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
    const body = m[2];
    if (/typedMember/.test(body)) continue;
    const mem = [...body.matchAll(/<(?:xbrldi:)?explicitMember\b[^>]*>([^<]+)</g)].map((x) => x[1].trim().split(":").pop()!);
    const i1 = /<(?:xbrli:)?instant>([^<]+)</.exec(body);
    const st = /<(?:xbrli:)?startDate>([^<]+)</.exec(body);
    const en = /<(?:xbrli:)?endDate>([^<]+)</.exec(body);
    const pk = i1 ? pkInst(i1[1].trim()) : st && en ? pkDur(st[1].trim(), en[1].trim()) : null;
    if (pk) ctx.set(m[1], { pk, mem });
  }
  const sum: Record<string, Record<string, number | null>> = {};
  const sh = new Map<string, Map<string, string | null>>(); // 개념 → 행(""=표 합계) → 값
  let shAt: string | null = null;
  const re = /<jpcrp_cor:([\w.-]+)\b([^>]*?\bcontextRef="([^"]+)"[^>]*?)(?:\/>|>([^<]*)<\/jpcrp_cor:\1>)/g;
  for (const m of inst.matchAll(re)) {
    const name = m[1];
    const isSum = SUM_TAGS.has(name);
    if (!isSum && !SHARE_TAGS.has(name)) continue;
    const c = ctx.get(m[3]);
    if (!c) continue;
    const nil = /xsi:nil="true"/.test(m[2]) || m[4] == null || m[4].trim() === "";
    if (isSum) {
      const nc = c.mem.length === 1 && c.mem[0] === "NonConsolidatedMember";
      if (c.mem.length && !nc) continue;
      const v = nil ? null : Number(m[4]!.trim());
      if (v != null && !Number.isFinite(v)) continue;
      const o = (sum[name] ??= {});
      const k = c.pk + (nc ? "|nc" : "");
      if (!(k in o) || o[k] == null) o[k] = v;
      continue;
    }
    // 주식 표 — 발행주식수는 차원 없는 문맥(보통주 행 OrdinaryShareMember 와 같은 값), 자기주식은 RowN 행 + 합계
    const row = c.mem.length === 0 ? "" : c.mem.length === 1 && /^Row\d+Member$/.test(c.mem[0]) ? c.mem[0] : null;
    if (row == null) continue;
    if (/^NumberOfIssuedShares/.test(name) && row !== "") continue;
    if (/TreasurySharesEtc$/.test(name) && c.pk.startsWith("I")) shAt ??= c.pk.slice(1);
    const mm = sh.get(name) ?? new Map<string, string | null>();
    sh.set(name, mm);
    if (!mm.has(row)) mm.set(row, nil ? null : decodeXml(m[4]!).trim());
  }
  const num = (s: string | null | undefined) => (s == null || s === "" ? null : Number.isFinite(Number(s)) ? Number(s) : null);
  let shares: JpDocShares | null = null;
  const issuedM = sh.get("NumberOfIssuedSharesAsOfFiscalYearEndIssuedSharesTotalNumberOfSharesEtc");
  if (issuedM) {
    const issued = num(issuedM.get(""));
    const issuedFiling = num(sh.get("NumberOfIssuedSharesAsOfFilingDateIssuedSharesTotalNumberOfSharesEtc")?.get(""));
    const names = sh.get("NameOfShareholderTreasurySharesEtc") ?? new Map();
    const own = sh.get("NumberOfSharesHeldInOwnNameTreasurySharesEtc") ?? new Map();
    const oth = sh.get("NumberOfSharesHeldInOthersNamesTreasurySharesEtc") ?? new Map();
    const rows = [...names.keys()].filter((r) => r !== "");
    const me = filer ? normName(filer) : null;
    const mine = rows.filter((r) => me && normName(names.get(r) ?? "") === me);
    let treasury: number | null = null;
    let how: string;
    if (mine.length) {
      treasury = mine.reduce((a, r) => a + (num(own.get(r)) ?? 0) + (num(oth.get(r)) ?? 0), 0);
      how = `自己株式等 표 ${mine.join("·")}(${names.get(mine[0])})`;
    } else if (!rows.length && !own.size) {
      treasury = 0;
      how = "自己株式等 표 없음(자기주식 없음)";
    } else {
      how = `自己株式等 표에서 제출회사 행을 찾지 못함(${rows.map((r) => names.get(r)).slice(0, 3).join("·")})`;
    }
    shares = { at: shAt, issued, issuedFiling, treasury, how };
  }
  // 리스부채 주석 — 본표에 리스부채 줄이 없는 IFRS 회사(차입금 줄에 포함됐는지·따로 몇인지)
  const leaseTb: { n: string; amt?: [number, number] | null }[] = [];
  const tbRe = /<([\w-]+):(Notes[\w]*TextBlock)\b([^>]*?\bcontextRef="([^"]+)"[^>]*)>([\s\S]*?)<\/\1:\2>/g;
  for (const m of inst.matchAll(tbRe)) {
    const c = ctx.get(m[4]);
    if (!c || c.mem.length) continue;
    const t = decodeXml(decodeXml(m[5]).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")).replace(/[\s　 ]+/g, " ");
    if (!t.includes("リース負債")) continue;
    const n = (s: string) => Number(s.replace(/,/g, ""));
    // "リース負債（流動） 67,403 73,894 リース負債（非流動） 174,341 172,480" (전기 · 당기, 백만엔 표)
    const a = /リース負債[（(]流動[)）]\s*([\d,]+)\s+([\d,]+)\s*リース負債[（(]非流動[)）]\s*([\d,]+)\s+([\d,]+)/.exec(t);
    const unit = /百万円/.test(t) ? 1e6 : null;
    leaseTb.push({ n: m[2], amt: a && unit ? [(n(a[1]) + n(a[3])) * unit, (n(a[2]) + n(a[4])) * unit] : null });
  }
  return { sum, shares, leaseTb };
}

const memo = new Map<string, Promise<JpDocFin>>();
/**
 * 서류 하나의 본표 판독 결과 — 디스크(jp-fin/v<판>) → 없으면 XBRL zip(edinet-store 영구 캐시) 판독 후 저장. 프로세스 메모(최근 200건).
 * 조회·판독 실패는 그대로 던진다(호출자가 경고로 남긴다).
 */
export function loadJpDocFin(docID: string): Promise<JpDocFin> {
  let p = memo.get(docID);
  if (p) return p;
  p = (async () => {
    const ns = `jp-fin/v${JP_PARSE_VERSION}`;
    const hit = await readEdinetJson<JpDocFin>(ns, docID);
    if (hit && hit.v === JP_PARSE_VERSION && hit.docID === docID) return hit;
    const parsed = await parseJpDocZip(docID, await edinetDocZip(docID, 1));
    await writeEdinetJson(ns, docID, parsed);
    return parsed;
  })();
  p.catch(() => memo.delete(docID));
  memo.set(docID, p);
  if (memo.size > 200) memo.delete(memo.keys().next().value!);
  return p;
}
