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
 * 판 3(2026-10-09): 리스부채 주석 — 표시 문장("リース負債は…に含めて表示")·IAS 7 재무활동 부채 변동표 행·전기/당기 두 칸 표(leaseNotes).
 * 판 4(2026-10-09): 현금흐름표의 시점(instant) 개념에 기초·기말 이름표가 없으면 기말 잔액(第一三共 CashAndCashEquivalentsIfDifferentFromBSBalanceIFRS
 *   "現金及び現金同等物の期末残高" — 기간 값으로 찾아 줄이 통째로 빠졌다).
 */

export const JP_PARSE_VERSION = 4;

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
  /** 리스부채 주석(판 3) — 본표에 리스부채 줄이 없을 때 판정용(leaseNotes) */
  lease?: JpLeaseNote;
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
/**
 * 리스부채 주석(IFRS — 본표에 リース負債 줄이 없는 회사). 금액은 백만엔 표를 엔으로.
 *  - rows: リース負債 뒤에 숫자가 오는 표가 있는 문단 이름, sums: 리스부채 행이 든 표의 合計(행 뒤 첫 合計, 백만엔) — 그 合計가 본표 차입금 줄(들)의
 *    합과 정확히 같으면 리스부채는 그 차입금 줄에 포함(jp-ev.ts — 소니 2024 長期借入債務 내역 表, 소프트뱅크 有利子負債 내역). 문단 이름은 안 본다
 *    (キリン·JT NotesBondsAndBorrowings 는 기타 금융부채까지 합친 표, 第一三共는 한 문단에 차입금 표·기타 금융부채 표가 따로)
 *  - incl: "リース負債は…「X」に含めて表示" 류 문장(주어 リース負債 → 동사 含め·含まれ 사이 200자 안) — X 가 차입금 줄인지는 jp-ev.ts 가 본표 이름표로 판정
 *  - amt: 당기말·전기말 장부금액 — 판독 규칙은 leaseNotes() 주석. 확인 안 되면 null + why
 */
export interface JpLeaseNote {
  tb: string[];
  rows: string[];
  sums: Record<string, number[]>;
  incl: string[];
  /** 당기말·전기말 장부금액(엔) — 날짜는 표 머리에서(변동표 사슬만이면 null = 서류의 당기말·전기말) */
  amt: { cur: number; curDate: string | null; prior: number | null; priorDate: string | null } | null;
  how: string | null;
  why: string | null;
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

  // 현금흐름표 시점 개념(기초·기말 이름표 없음) = 기말 잔액 — 사실이 시점 열쇠뿐인 줄
  {
    const st = stmts.cf;
    for (const l of st?.lines ?? []) {
      if (l.ab || l.ps) continue;
      const pks = Object.keys(facts[l.k] ?? {});
      if (pks.length && pks.every((pk) => pk.startsWith("I"))) l.ps = "e";
    }
  }

  const ex = parseExtras(inst, dei("FilerNameInJapaneseDEI"));

  return {
    v: JP_PARSE_VERSION,
    docID,
    sum: ex.sum,
    shares: ex.shares,
    lease: ex.lease,
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

/** 경영지표 주당 지표·발행주식·자기주식(판 2)·리스부채 주석(판 3) — 차원 문맥도 본다(개별 NonConsolidatedMember·자기주식 표 행 RowN) */
function parseExtras(
  inst: string,
  filer: string | null,
): { sum: Record<string, Record<string, number | null>>; shares: JpDocShares | null; lease: JpLeaseNote } {
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
  const tbs: { n: string; t: string }[] = [];
  const tbRe = /<([\w-]+):(Notes[\w]*TextBlock)\b([^>]*?\bcontextRef="([^"]+)"[^>]*)>([\s\S]*?)<\/\1:\2>/g;
  for (const m of inst.matchAll(tbRe)) {
    const c = ctx.get(m[4]);
    if (!c || c.mem.length) continue;
    const t = decodeXml(decodeXml(m[5]).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")).normalize("NFKC").replace(/\s+/g, " ");
    if (t.includes("リース負債")) tbs.push({ n: m[2], t });
  }
  return { sum, shares, lease: leaseNotes(tbs) };
}

/** 표 구역 머리(① 流動負債 · ② 非流動負債 — NFKC 뒤 "1 流動負債")로 부분 값 판정 */
const secPart = (sec: string): "c" | "nc" | undefined => {
  const h = [...sec.matchAll(/(?:^|\s)(?:\d|\(\d\)|\d\.)\s*(非流動|流動)負債/g)].at(-1);
  return h ? (h[1] === "非流動" ? "nc" : "c") : undefined;
};
const tbShort = (n: string) => n.replace(/^Notes|ConsolidatedFinancialStatements|IFRSTextBlock|TextBlock/g, "");

/**
 * 리스부채 주석 판독(JpLeaseNote) — tbs = "リース負債" 가 나오는 연결 주석 문단(NFKC 정규화 — 전각 숫자·괄호·"－" → 반각).
 * 금액 후보(백만엔 표만, 세금·금융비용·담보·회계정책·새 기준·부문 문단 제외):
 *  - 변동표 행: 숫자 4개 이상이고 기초 + 변동 = 기말(백만엔 반올림 — 0 아닌 칸 수의 절반 안). 두 행이 이어지면(한 행의 기말 = 다른 행의 기초) [전기말, 당기말] — 표 순서 무관
 *  - 만기 분석 행: 그 앞 날짜 뒤 머리의 첫 칸이 帳簿価額 → 첫 숫자 = 그 날짜 장부금액
 *  - 두 칸 표 행: 숫자 정확히 둘, 머리의 마지막 날짜 둘에 차례로(당기·전기 순서 표도 날짜로 맞춘다). (流動)·(非流動) 이름표나 流動·非流動 구역·
 *    OtherCurrent/NonCurrent 문단이면 부분 값
 * 날짜마다: 합계 후보(두 칸 합계·만기 분석·변동표)가 모두 같아야 하고, 다른 문단에서 한 번 더 나오거나(합계 후보 둘 이상·리스부채 뒤 숫자)
 * 변동표 사슬이거나 流動 + 非流動 합이 그 값과 반올림(±1) 안일 때만 확인. 합계 후보가 없으면 流動 + 非流動 한 쌍의 합.
 */
export function leaseNotes(tbs: { n: string; t: string }[]): JpLeaseNote {
  const out: JpLeaseNote = { tb: tbs.map((x) => x.n), rows: [], sums: {}, incl: [], amt: null, how: null, why: null };
  // 표시 문장 — 주어 "リース負債は/を/については" 뒤 200자 안의 "に含め·に含まれ"
  for (const { t } of tbs) {
    for (const m of t.matchAll(/リース負債(?:は|を|については)([^。]{0,200}?)に(?:含め|含まれ)/g)) out.incl.push(m[1].trim().slice(-160));
  }
  const NOT_AMT = /IncomeTax|DeferredTax|FinanceIncome|FinanceCost|FinancialIncome|FinancialCost|Pledged|SignificantAccountingPolicies|NewAccountingStandards|Segment|SubsequentEvent/;
  const DASH = /^[-‐―—]$/;
  const num = (s: string) => (DASH.test(s) ? 0 : (/^[△(]/.test(s) ? -1 : 1) * Number(s.replace(/[△,()\s]/g, "")));
  const DATE = /(\d{4})年(\d{1,2})月(\d{1,2})日/g;
  const iso = (m: RegExpMatchArray) => `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  type Cand = { kind: "T" | "P" | "M"; tb: string; date: string; v: number; part?: "c" | "nc" };
  const cands: Cand[] = [];
  const pool = new Map<string, Set<number>>(); // 문단 → リース負債 뒤 숫자(절댓값, 백만엔)
  const chains: { tb: string; open: number; close: number }[] = [];
  for (const { n, t } of tbs) {
    if (NOT_AMT.test(n)) continue;
    const unitM = /単位\s*[:]?\s*(百万円|千円|円)/.exec(t);
    if (!(unitM ? unitM[1] === "百万円" : /百万円/.test(t))) continue;
    const ps = pool.get(n) ?? new Set<number>();
    pool.set(n, ps);
    // 숫자 칸: 1,234 · △1,234 · (1,234)(음수) · "－"(0). 이름표 괄호((流動)·(注記26))는 숫자만 든 괄호가 아닌 것
    const rowRe = /リース負債((?:\s?\((?![\d,]+\))[^()]{0,16}\))*)((?:\s(?:△\s?\d[\d,]*|\(\d[\d,]*\)|\d[\d,]*|[-‐―—])(?=\s|$))+)/g;
    for (const m of t.matchAll(rowRe)) {
      const label = m[1];
      if (/利息|金利|費用/.test(label)) continue;
      const toks = m[2].trim().split(/\s(?=△|\(|\d|[-‐―—])/).map((s) => s.trim());
      const vals = toks.map(num);
      if (vals.some((v) => !Number.isFinite(v))) continue;
      vals.slice(0, 6).forEach((v) => v && ps.add(Math.abs(v)));
      if (!out.rows.includes(n)) out.rows.push(n);
      // 이 행이 든 표의 合計(행 뒤 첫 合計, 500자 안) — 리스부채 행을 포함한 내역 표의 합계
      const tot = /合計((?:\s(?:△\s?\d[\d,]*|\d[\d,]*)(?=\s|$)){1,2})/.exec(t.slice(m.index! + m[0].length, m.index! + m[0].length + 500));
      if (tot) (out.sums[n] ??= []).push(...tot[1].trim().split(/\s(?=△|\d)/).map(num).filter((v) => !(out.sums[n] ?? []).includes(v)));
      const before = t.slice(Math.max(0, m.index! - 600), m.index!);
      if (vals.length >= 4 && !DASH.test(toks[0]) && !DASH.test(toks.at(-1)!) && Math.abs(vals.slice(0, -1).reduce((a, b) => a + b, 0) - vals.at(-1)!) <= Math.floor(vals.filter((v) => v !== 0).length / 2)) {
        chains.push({ tb: n, open: vals[0], close: vals.at(-1)! });
        continue;
      }
      if (vals.length >= 3) {
        const w = before.slice(-300);
        const d = [...w.matchAll(DATE)].at(-1);
        if (!d || vals[0] <= 0 || /自\s?$/.test(w.slice(0, d.index!))) continue;
        // 표 머리 = 마지막 "単位" 뒤(날짜가 머리 앞 "前連結会計年度末(…) (単位…) 帳簿価額 …" 이든 행 앞 "帳簿価額 … 当連結会計年度末(…)" 이든)
        const iu = w.lastIndexOf("単位");
        const head = iu >= 0 ? w.slice(iu) : w.slice(d.index! + d[0].length);
        const ib = head.indexOf("帳簿価額");
        const ic = head.search(/契約上|1年以内|1年未満/);
        if (ib >= 0 && (ic < 0 || ib < ic)) cands.push({ kind: "M", tb: n, date: iso(d), v: vals[0] });
        continue;
      }
      if (vals.length === 2 && vals[0] >= 0 && vals[1] >= 0) {
        const ds = [...before.matchAll(DATE)];
        if (ds.length < 2 || /自/.test(before.slice(Math.max(0, ds.at(-2)!.index! - 4)))) continue;
        const d1 = iso(ds.at(-2)!), d2 = iso(ds.at(-1)!);
        if (d1 === d2) continue;
        const sec = before.slice(-400);
        const part: "c" | "nc" | undefined =
          /非流動/.test(label) || /NonCurrent/.test(n) ? "nc"
          : /1年(以)?内(返済|償還)?(予定)?の?\s?$/.test(t.slice(Math.max(0, m.index! - 14), m.index!)) ? "c"
          : /流動/.test(label) || /Current/.test(n.replace(/NonCurrent/g, "")) ? "c"
          : secPart(sec);
        cands.push({ kind: part ? "P" : "T", tb: n, date: d1, v: vals[0], part });
        cands.push({ kind: part ? "P" : "T", tb: n, date: d2, v: vals[1], part });
      }
    }
  }
  let chain: [number, number] | null = null;
  for (const a of chains) for (const b of chains) if (a !== b && a.close === b.open && a.close !== b.close) chain ??= [a.close, b.close];
  const dates = [...new Set(cands.map((c) => c.date))].sort();
  const decide = (d: string | null, chainV: number | null): { v: number | null; how: string; why: string | null } => {
    const tot = cands.filter((c) => c.date === d && c.kind !== "P");
    const pc = cands.filter((c) => c.date === d && c.part === "c"), pn = cands.filter((c) => c.date === d && c.part === "nc");
    const psum = pc.length === 1 && pn.length === 1 ? pc[0].v + pn[0].v : null;
    const tv = [...new Set([...tot.map((c) => c.v), ...(chainV != null ? [chainV] : [])])];
    if (tv.length > 1) return { v: null, how: "", why: `리스부채 주석 후보 불일치(${d}: ${tv.join("·")}백만엔)` };
    if (tv.length === 1) {
      const v = tv[0];
      const srcs = new Set(tot.map((c) => c.tb));
      const elsewhere = [...pool].some(([tb, s]) => !srcs.has(tb) && s.has(v));
      const ok = chainV != null || srcs.size >= 2 || (psum != null && Math.abs(psum - v) <= 1) || elsewhere;
      if (!ok) return { v: null, how: "", why: `리스부채 ${v}백만엔(${[...srcs].map(tbShort).join("·")})이 다른 주석에서 확인 안 됨` };
      const by = [...(chainV != null ? ["재무활동 부채 변동표"] : []), ...[...srcs].map(tbShort)];
      return { v, how: `${by.join("·")}${psum != null ? ` · 流動+非流動 ${psum}` : ""}${!(chainV != null || srcs.size >= 2) && elsewhere ? " · 다른 주석 같은 값" : ""}`, why: null };
    }
    if (psum != null) return { v: psum, how: `流動 ${pc[0].v} + 非流動 ${pn[0].v}(${[...new Set([pc[0].tb, pn[0].tb])].map(tbShort).join("·")})`, why: null };
    return { v: null, how: "", why: cands.length || chains.length ? `${d ?? "기준일"} 리스부채 장부금액 판독 없음` : "리스부채 장부금액 표 없음" };
  };
  const curD = dates.at(-1) ?? null;
  const priD = dates.length >= 2 ? dates.at(-2)! : null;
  const c1 = decide(curD, chain ? chain[1] : null);
  const c0 = decide(priD, chain ? chain[0] : null);
  if (c1.v != null) {
    out.amt = { cur: c1.v * 1e6, curDate: curD, prior: c0.v != null ? c0.v * 1e6 : null, priorDate: priD };
    out.how = c1.how;
  } else out.why = c1.why;
  return out;
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
