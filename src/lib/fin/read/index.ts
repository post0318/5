import "server-only";
import {
  FactIndex, fillMissingFilings, filingFiles, getCompanyFacts, getSubmissions, instanceText, linkbaseText, parseInstance,
  resolveCik, withFetchScope, type Submissions,
} from "../source/us/sec";
import { currentQuoteShares, yahooQuarters, type YahooFundamentalsRow } from "../source/us/market";
import { Gap, type CompanyProfile, type DerivedInput, type FormType, type Prov, type RawFact, type ReadValue, type ReadWhy } from "../types";
import { dropRoundedRetags, latest, isPeriodic } from "./vintage";
import { addDays, buildCalendar, days, durKind, fiscalYearOf, isStaleAnnual, near, shiftYear, type FiscalYear } from "./period";
import { fxAvgRef, makeFx, reportingCurrency, type Fx } from "./fx";
import { canonical } from "./ifrs";
import { companyType, filerKind } from "./profile";
import { adrRatioOf } from "./adr";
import { calcParents, parseCalculation, parseLabels, parsePresentation, pickIncomeStatement, type StatementShape } from "./linkbase";
import { YAHOO_FIELD, yahooLtmOf } from "./ltm-yahoo";

/**
 * 1층 판독 엔진 — 미국(SEC). 판본·기간·분기화·Q4·LTM·IFRS·환율·ADR 을 **여기서만** 정한다(architecture.md §1).
 * 2층(assemble)은 `ColumnSpec`(열 정의)와 `value()`(그 열의 한 개념 값)만 받는다.
 *
 * 열 정의:
 *  - FY  = 사업연도 기간(start·end)의 **최신 판본** 공시 1건
 *  - Q   = 3개월 기간의 최신 판본 1건. 3개월 값이 없으면 누적 차(6M − Q1, 9M − 6M)를 각 최신 판본으로(파생 표시)
 *  - Q4D = 사업연도(최신 판본) − 9개월 누적(최신 판본)
 *  - LTM = 최근 사업연도 + 당기 누적 − 전년 동기 누적(전부 최신 판본). 20-F·40-F 는 Yahoo 분기 최근 4개(ltm-yahoo.ts)
 * 열의 판본(원천 공시)은 매출·순이익 기준 개념(ANCHOR) 중 그 기간을 담은 가장 늦은 정기공시로 정한다 — 한 열 = 한 공시.
 */

const ANCHOR = [
  "us-gaap:Revenues", "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", "us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax",
  "us-gaap:RevenuesNetOfInterestExpense", "us-gaap:InterestAndDividendIncomeOperating", "us-gaap:NoninterestIncome",
  "ifrs-full:Revenue", "ifrs-full:RevenueFromContractsWithCustomers",
  "us-gaap:NetIncomeLoss", "us-gaap:ProfitLoss", "ifrs-full:ProfitLoss", "ifrs-full:ProfitLossAttributableToOwnersOfParent",
];
const REVENUE_ANCHOR = new Set(ANCHOR.slice(0, 8));
/** Q4D 매출 개념 대체(revenueAliasNine)의 후보 — 매출 계열 개념끼리만 */
export const REVENUE_ALIAS_CONCEPTS = [
  "us-gaap:Revenues",
  "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax",
  "us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax",
  "us-gaap:RevenuesNetOfInterestExpense",
];
const ANNUAL_FORM = /^(10-K|20-F|40-F)(\/A)?$/;
const INTERIM_FORM = /^10-Q(\/A)?$/;
const PERIODIC_FORM = /^(10-[QK]|20-F|40-F)(\/A)?$/;
/** companyfacts 에 들어 있는 네임스페이스 — 나머지(회사 고유·srt)는 인스턴스에서 읽는다 */
const CF_NS = new Set(["us-gaap", "ifrs-full", "dei", "srt"]);

/** 열 구성 공시 하나(기간·판본·부호). role = 파생값 입력의 구성 역할(fy·9m·ytd·ytd-prior·q·cum·cum-prev) */
export interface Part { start: string; end: string; accn: string | null; form: FormType; filed: string | null; sign: 1 | -1; role?: string }
/**
 * 구성 공시 하나에서 읽은 값 — val = Σ op × leaves 값. leaves = 실제로 읽은 사실(개념·기간·단위·accn 을 담은 출처 — 차원 합·개념
 * 대체·두 개념의 차이면 여러 개). 파생값 입력(DerivedInput)의 원천.
 */
export interface PartRead { val: number; leaves: { rv: ReadValue; op: 1 | -1 }[] }
export interface Segment { start: string; end: string; parts: Part[] }
export interface ColumnSpec {
  key: string;
  kind: "FY" | "Q" | "Q4D" | "LTM";
  fy: number;
  fq: 0 | 1 | 2 | 3 | 4;
  start: string;
  end: string;
  /** 열 = Σ 구간, 구간 = Σ(부호 × 구성 공시 값) → 구간마다 그 구간 평균 환율로 USD */
  segments: Segment[];
  /** 20-F·40-F LTM — Yahoo 분기(구성 공시 대신) */
  yahoo?: { fyStart: string; fyEnd: string; fyAccn: string | null };
  gaps: number;
}
export interface CellValue {
  v: number | null;
  /** 원통화 값(환산 전) — 항등식 검사용 */
  raw: number | null;
  why?: ReadWhy;
  /** 파생 값(구성 사실 2개 이상 또는 환산)의 입력 — 값 = Σ op × 사실 × 환율 */
  inputs?: DerivedInput[];
  gaps: number;
}
export interface FilingStructure {
  shape: StatementShape | null;
  parents: Map<string, { parent: string; w: number }>;
  /** 계산 구조 합계식 — 부모 → 모든 항(가중치). 항등식은 이것으로 판정(linkbase.calcParents) */
  sums: Map<string, { to: string; w: number }[]>;
  labels: Map<string, Map<string, string>> | null;
  gaps: number;
}

export class UsReader {
  readonly calendar: FiscalYear[];
  private anchorFacts: RawFact[];
  private factMemo = new Map<string, RawFact[]>();
  private structMemo = new Map<string, Promise<FilingStructure>>();
  private instMemo = new Map<string, Promise<RawFact[] | null>>();

  private constructor(
    readonly profile: CompanyProfile,
    readonly idx: FactIndex,
    readonly sub: Submissions,
    readonly fx: Fx | null,
    readonly yahoo: { quarterly: YahooFundamentalsRow[]; annual: YahooFundamentalsRow[] } | null,
    public gaps: number,
    readonly warnings: string[],
    /** Yahoo 분기 조회 시각(ISO) — 20-F·40-F LTM 입력의 asOf */
    readonly yahooAt: string | null = null,
  ) {
    this.anchorFacts = ANCHOR.flatMap((c) => this.facts(c)).filter((f) => f.start);
    const annual = uniq(this.anchorFacts.filter((f) => ANNUAL_FORM.test(f.prov.form) && durKind(f.start, f.end) === "FY").map((f) => ({ start: f.start!, end: f.end })));
    const interim = uniq(this.anchorFacts.filter((f) => INTERIM_FORM.test(f.prov.form)).map((f) => ({ start: f.start!, end: f.end })));
    this.calendar = buildCalendar(annual, interim);
  }

  static async open(symbol: string): Promise<UsReader> {
    const warnings: string[] = [];
    let gaps = 0;
    const { result, failures } = await withFetchScope(async () => {
      const { cik } = await resolveCik(symbol);
      const [sub, idx] = await Promise.all([getSubmissions(cik), getCompanyFacts(cik)]);
      const fill = await fillMissingFilings(cik, idx, sub);
      gaps |= fill.gaps;
      warnings.push(...fill.warnings);
      return { cik, sub, idx };
    });
    if (failures.length) warnings.push(...failures.map((f) => `SEC 조회 일시 오류: ${f}`));
    const { cik, sub, idx } = result;
    const filer = filerKind(sub);
    const cur = reportingCurrency(idx);
    let fx: Fx | null = null;
    try {
      fx = await makeFx(cur);
    } catch {
      gaps |= Gap.FX;
      warnings.push(`환율 조회 실패(${cur})`);
    }
    let yahoo: UsReader["yahoo"] = null;
    let yahooAt: string | null = null;
    let quoteShares: number | null = null;
    if (filer !== "domestic") {
      try {
        yahoo = await yahooQuarters(symbol);
        yahooAt = new Date().toISOString();
      } catch {
        gaps |= Gap.YAHOO;
        warnings.push("Yahoo 분기 조회 실패(LTM)");
      }
      quoteShares = await currentQuoteShares(symbol).catch(() => null);
    }
    const profile: CompanyProfile = {
      market: "us", symbol: symbol.toUpperCase(), cik, sic: sub.sic, type: companyType(sub.sic, idx), filer,
      adrRatio: adrRatioOf(filer !== "domestic", idx, quoteShares), reportingCurrency: cur,
    };
    return new UsReader(profile, idx, sub, fx, yahoo, gaps, warnings, yahooAt);
  }

  /** 개념의 사실 — 차원 없는 정기공시 값, 반올림 재태깅 제거 후 */
  facts(qname: string): RawFact[] {
    const hit = this.factMemo.get(qname);
    if (hit) return hit;
    const out = dropRoundedRetags(this.idx.get(qname).filter((f) => isPeriodic(f) && !Object.keys(f.dims).length));
    this.factMemo.set(qname, out);
    return out;
  }

  /**
   * 어느 정기공시에서든(판본 무관) 이 기간(±3일)의 값을 정확히 targetVal 로 공시한 적이 있으면 그 공시 accn —
   * 2층 Q4D 매출 폴백(assemble/is.ts q4RevenueFallback)의 "다른 개념도 같은 줄" 증거. 여러 판본에 있으면 가장
   * 늦게 제출된 것.
   */
  aliasEvidenceAccn(concept: string, start: string, end: string, targetVal: number): string | null {
    const cands = this.facts(concept).filter((f) => near(f.start, start) && near(f.end, end) && f.val === targetVal);
    const best = cands.reduce<RawFact | null>((b, f) => (!b || (f.prov.filed ?? "") > (b.prov.filed ?? "") ? f : b), null);
    return best?.prov.accn ?? null;
  }

  /**
   * Q4D 매출 9개월 부분의 개념 대체(판본·개념 판단 = 1층 몫, 2층 assemble/is.ts 는 호출만) — 9개월 누적 공시가 사업연도
   * 공시와 다른 매출 개념으로 태깅된 회사(CEG: 10-K "Operating revenues" = RevenueFromContractWithCustomerIncludingAssessedTax,
   * 같은 줄의 10-Q 태그는 us-gaap:Revenues. GOOG: 최신 10-K 는 옛 개념이 사라지고 새 개념으로만 재태깅). 사업연도 값을
   * 정확히 같은 금액으로 공시한 다른 매출 계열 개념이 **어느 정기공시에서든** 있었으면(같은 줄이라는 증거 —
   * aliasEvidenceAccn) 그 개념의 9개월 값을 쓴다. 증거가 없으면 null(대체하지 않음 — 공란). 매출 계열 개념끼리만 비교한다.
   */
  async revenueAliasNine(qname: string, fyPart: Part, ninePart: Part): Promise<ReadValue | null> {
    const fyDirect = await this.partValue(qname, fyPart);
    if (fyDirect === null || fyDirect === "gap") return null;
    for (const alt of REVENUE_ALIAS_CONCEPTS) {
      if (alt === qname) continue;
      const evidenceAccn = this.aliasEvidenceAccn(alt, fyPart.start, fyPart.end, fyDirect.val);
      if (!evidenceAccn) continue;
      const altNine = await this.partValue(alt, ninePart);
      if (altNine === null || altNine === "gap") continue;
      this.warnings.push(`Q4 매출 폴백: ${qname}(9개월 부분 없음) → ${alt} 대체(사업연도 값 증거 공시 ${evidenceAccn}, 9개월 원본 ${ninePart.accn ?? "?"})`);
      return altNine;
    }
    return null;
  }

  /**
   * 기간(start·end ±3일)의 최신 판본 원천 공시 — 매출 개념 우선, 없을 때만 순이익 개념. 순이익은 자본변동표에도 분기별로
   * 실려(3분기 10-Q 에 1·2분기 순이익) 그것까지 판본 후보로 보면 1분기 열의 원천이 손익계산서에 1분기가 없는 3분기 10-Q 가
   * 된다(WDC 실측).
   */
  private sourceOf(start: string, end: string): Part | null {
    const hit = this.anchorFacts.filter((x) => near(x.start, start) && near(x.end, end));
    const rev = hit.filter((x) => REVENUE_ANCHOR.has(x.concept));
    const f = latest(rev.length ? rev : hit);
    return f ? { start: f.start!, end: f.end, accn: f.prov.accn, form: f.prov.form, filed: f.prov.filed, sign: 1, role: "fy" } : null;
  }

  // ── 열 정의 ──

  annualCols(n = 10): ColumnSpec[] {
    const out: ColumnSpec[] = [];
    for (const y of this.calendar) {
      if (!y.end) continue;
      const p = this.sourceOf(y.start, y.end);
      if (!p) continue;
      out.push({ key: `FY${y.fy}`, kind: "FY", fy: y.fy, fq: 0, start: y.start, end: y.end, segments: [{ start: y.start, end: y.end, parts: [p] }], gaps: 0 });
    }
    return out.slice(-n);
  }

  quarterCols(n = 20): ColumnSpec[] {
    const out: ColumnSpec[] = [];
    for (const y of this.calendar) {
      const bounds = [y.start, ...y.qEnds];
      for (let q = 1; q <= 4; q++) {
        const qs = q === 1 ? y.start : bounds[q - 1] ? addDays(bounds[q - 1]!, 1) : null;
        const qe = q === 4 ? y.end : bounds[q];
        if (!qs || !qe) continue;
        const key = `${y.fy}Q${q}`;
        if (q === 4) {
          // Q4 = 사업연도(최신 판본) − 9개월 누적(최신 판본)
          const fy = this.sourceOf(y.start, y.end!);
          const nine = y.qEnds[2] ? this.sourceOf(y.start, y.qEnds[2]) : null;
          if (!fy || !nine) continue;
          out.push({ key, kind: "Q4D", fy: y.fy, fq: 4, start: qs, end: qe, segments: [{ start: qs, end: qe, parts: [fy, { ...nine, sign: -1, role: "9m" }] }], gaps: 0 });
          continue;
        }
        const direct = this.sourceOf(qs, qe);
        if (direct && durKind(direct.start, direct.end) === "Q") {
          out.push({ key, kind: "Q", fy: y.fy, fq: q as 1 | 2 | 3, start: qs, end: qe, segments: [{ start: qs, end: qe, parts: [{ ...direct, role: "q" }] }], gaps: 0 });
          continue;
        }
        // 3개월 값이 없으면 누적 차(각 최신 판본)
        const cum = this.sourceOf(y.start, qe);
        const prev = this.sourceOf(y.start, bounds[q - 1]!);
        if (!cum || !prev) continue;
        out.push({ key, kind: "Q", fy: y.fy, fq: q as 1 | 2 | 3, start: qs, end: qe, segments: [{ start: qs, end: qe, parts: [{ ...cum, role: "cum" }, { ...prev, sign: -1, role: "cum-prev" }] }], gaps: 0 });
      }
    }
    return out.slice(-n);
  }

  /**
   * LTM — 최근 사업연도 + 당기 누적 − 전년 동기 누적(markets/us/edgar-series.ts ttmOf 와 같은 창). 최근 사업연도 종료가
   * 550일을 넘으면(태그 중단) 없음. 외화 10-Q 제출사는 최근 4개 분기를 분기 평균 환율로(인포맥스 방식 — edgar-foreign.ts).
   */
  ltmCol(quarters: ColumnSpec[]): ColumnSpec | null {
    const fyY = [...this.calendar].reverse().find((y) => y.end);
    if (!fyY?.end) return null;
    const fyPart = this.sourceOf(fyY.start, fyY.end);
    if (!fyPart || isStaleAnnual(fyY.end)) return null;
    const base = { key: "LTM", kind: "LTM" as const, fy: fyY.fy, fq: 0 as const, gaps: 0 };
    if (this.profile.filer !== "domestic") {
      // 20-F·40-F — Yahoo 분기(값은 value() 에서 항목별로)
      return { ...base, start: fyY.start, end: fyY.end, segments: [{ start: fyY.start, end: fyY.end, parts: [fyPart] }], yahoo: { fyStart: fyY.start, fyEnd: fyY.end, fyAccn: fyPart.accn } };
    }
    // 당기 누적: 사업연도 끝 다음날 시작, 가장 늦은 끝
    const cur = latest(this.anchorFacts.filter((f) => INTERIM_FORM.test(f.prov.form) && near(f.start, addDays(fyY.end!, 1), 12) && f.end > fyY.end!)
      .filter((f, _, all) => f.end === all.reduce((m, x) => (x.end > m ? x.end : m), "")));
    if (!cur?.start) return { ...base, start: fyY.start, end: fyY.end, segments: [{ start: fyY.start, end: fyY.end, parts: [fyPart] }] };
    const wS = shiftYear(cur.start, -1), wE = shiftYear(cur.end, -1);
    const priorF = this.anchorFacts.filter((f) => near(f.start, wS, 12) && near(f.end, wE, 12));
    const prior = latest(priorF);
    if (!prior?.start) return { ...base, start: fyY.start, end: fyY.end, segments: [{ start: fyY.start, end: fyY.end, parts: [fyPart] }], gaps: Gap.BASIS_SHIFT };
    const start = addDays(shiftYear(cur.end, -1), 1);
    const curPart: Part = { start: cur.start, end: cur.end, accn: cur.prov.accn, form: cur.prov.form, filed: cur.prov.filed, sign: 1, role: "ytd" };
    const priorPart: Part = { start: prior.start, end: prior.end, accn: prior.prov.accn, form: prior.prov.form, filed: prior.prov.filed, sign: -1, role: "ytd-prior" };
    if (this.profile.reportingCurrency !== "USD") {
      const last4 = quarters.filter((q) => q.end <= cur.end).slice(-4);
      if (last4.length === 4 && near(last4[3].end, cur.end) && near(addDays(shiftYear(cur.end, -1), 1), last4[0].start, 12))
        return { ...base, start: last4[0].start, end: cur.end, segments: last4.flatMap((q) => q.segments) };
    }
    return { ...base, start, end: cur.end, segments: [{ start, end: cur.end, parts: [fyPart, curPart, priorPart] }] };
  }

  // ── 값 ──

  /** 한 공시·기간의 개념 값(원통화) — 실제로 읽은 사실의 개념·기간·단위·accn 을 출처에 담는다. 회사 고유 개념은 인스턴스에서 */
  async partValue(qname: string, p: Part): Promise<ReadValue | null | "gap"> {
    const [ns] = qname.split(":");
    if (CF_NS.has(ns)) {
      // 보고 통화 단위만 — 20-F 의 USD "편의 환산" 태그(단일 환율)는 쓰지 않는다(edgar-foreign.ts 와 같은 규칙)
      const all = this.facts(qname).filter((f) => near(f.start, p.start) && near(f.end, p.end) && f.unit === this.profile.reportingCurrency);
      const same = all.find((f) => f.prov.accn === p.accn);
      if (same) return readValueOf(same);
      // 이 공시 값이 반올림 재태깅으로 버려졌으면 앞선 정밀값(원래 이 공시에 있었음)
      const dropped = this.idx.get(qname).some((f) => f.prov.accn === p.accn && near(f.start, p.start) && near(f.end, p.end));
      if (dropped) {
        const l = latest(all);
        if (l) return readValueOf(l);
      }
      // companyfacts 에 없으면 그 공시에 없는 값(인스턴스로 보완된 공시는 idx 에 이미 들어 있다)
      return null;
    }
    if (!p.accn) return null;
    const inst = await this.instance(p.accn, p.form, p.filed);
    if (!inst) return "gap";
    const f = inst.find((x) => x.concept === qname && !Object.keys(x.dims).length && near(x.start, p.start) && near(x.end, p.end) && x.unit === this.profile.reportingCurrency);
    return f ? readValueOf(f) : null;
  }

  /**
   * 파생값 입력 참조(`f:` SEC 사실) 되읽기 — 자기 검사(derived.ts)가 입력이 값을 재현하는지 원천에서 다시 확인한다. 표준 개념은
   * companyfacts(보완 공시 포함), 회사 고유 개념·차원 값은 그 공시 인스턴스. 보고 통화 단위만. 못 찾으면 null.
   */
  async readRef(ref: string): Promise<number | null> {
    const m = /^f:([^|]+)\|([^|]+)\|([^|]*)\|([^|]+)(?:\|(.+))?$/.exec(ref);
    if (!m) return null;
    const [, accn, concept, start, end, dimStr] = m;
    const dims: Record<string, string> = {};
    for (const kv of dimStr ? dimStr.split(",") : []) {
      const [a, b] = kv.split("=");
      dims[a] = b;
    }
    const match = (f: RawFact) =>
      f.concept === concept && f.prov.accn === accn && (f.start ?? "") === start && f.end === end && f.unit === this.profile.reportingCurrency &&
      Object.keys(f.dims).length === Object.keys(dims).length && Object.entries(dims).every(([a, b]) => f.dims[a] === b);
    if (CF_NS.has(concept.split(":")[0]) && !dimStr) {
      const f = this.idx.get(concept).find(match);
      if (f) return f.val;
    }
    const inst = await this.instance(accn, "10-K", null);
    return inst?.find(match)?.val ?? null;
  }

  /** 인스턴스 사실(공시 단위 캐시). 실패 시 null */
  instance(accn: string, form: FormType, filed: string | null): Promise<RawFact[] | null> {
    let p = this.instMemo.get(accn);
    if (!p) {
      p = (async () => {
        try {
          const xml = await instanceText(await filingFiles(this.profile.cik, accn));
          return xml ? parseInstance(xml, { accn, form, filed }) : null;
        } catch {
          return null;
        }
      })();
      this.instMemo.set(accn, p);
    }
    return p;
  }

  /** 차원 값(인스턴스) — 개념·축·멤버 조건에 맞는 값의 합(원통화). 없으면 null */
  async dimSum(qname: string, axis: string, member: (m: string) => boolean, p: Part): Promise<PartRead | null | "gap"> {
    if (!p.accn) return null;
    const inst = await this.instance(p.accn, p.form, p.filed);
    if (!inst) return "gap";
    let out: PartRead | null = null;
    for (const f of inst) {
      if (f.concept !== qname || f.unit !== this.profile.reportingCurrency || !near(f.start, p.start) || !near(f.end, p.end)) continue;
      const ks = Object.keys(f.dims);
      if (ks.length !== 1 || ks[0] !== axis || !member(f.dims[axis])) continue;
      out ??= { val: 0, leaves: [] };
      out.val += f.val;
      out.leaves.push({ rv: readValueOf(f), op: 1 });
    }
    return out;
  }

  /**
   * 열의 한 개념 값 — 구간마다 Σ(부호 × 공시 값)을 그 구간 평균 환율로 USD 환산해 더한다.
   * 파생 열의 구성 공시 중 하나라도 그 개념이 없으면 null + BASIS_SHIFT(기준이 섞인 값을 만들지 않는다).
   * `get` 을 주면 개념 대신 그 함수로 공시 값을 얻는다(차원 합 등).
   */
  async value(qname: string, col: ColumnSpec, get?: (p: Part) => Promise<PartRead | null | "gap">): Promise<CellValue> {
    if (col.yahoo) return this.yahooValue(qname, col);
    let gaps = 0;
    let total = 0, rawTotal = 0;
    let fxWhy: ReadWhy | undefined;
    const inputs: DerivedInput[] = [];
    let other = false; // 이 줄 개념의 그 공시 값이 아닌 사실(차원 값·개념 대체·앞선 판본 정밀값)을 읽음
    for (const s of col.segments) {
      let sum = 0, present = 0;
      const segIn: DerivedInput[] = [];
      for (const p of s.parts) {
        const r = get ? await get(p) : asPartRead(await this.partValue(qname, p));
        if (r === "gap") { gaps |= Gap.INSTANCE; continue; }
        if (r == null) continue;
        sum += p.sign * r.val;
        present++;
        for (const l of r.leaves) if (l.rv.prov.concept !== qname || l.rv.prov.dims || l.rv.prov.accn !== p.accn) other = true;
        for (const l of r.leaves) segIn.push({ ref: factRef(l.rv.prov), op: (p.sign * l.op) as 1 | -1, ...(p.role ? { role: p.role } : {}) });
      }
      if (present === 0) return { v: null, raw: null, gaps };
      if (present < s.parts.length) return { v: null, raw: null, gaps: gaps | Gap.BASIS_SHIFT };
      const rate = this.fx ? (this.fx.cur === "USD" ? 1 : this.fx.avg(s.start, s.end)) : null;
      if (rate == null) return { v: null, raw: sum, gaps: gaps | Gap.FX };
      const x = this.fx!.cur !== "USD" ? { ref: fxAvgRef(this.fx!.cur, s.start, s.end), v: rate, asOf: this.fx!.asOf } : null;
      if (x) fxWhy = { k: "fx", cur: this.fx!.cur, rate, basis: "avg" };
      for (const i of segIn) inputs.push(x ? { ...i, x } : i);
      total += sum * rate;
      rawTotal += sum;
    }
    const parts = col.segments.flatMap((s) => s.parts);
    const why: ReadWhy | undefined =
      parts.length > 1 ? { k: "derived", parts: parts.map((p) => ({ accn: p.accn ?? "", form: p.form, sign: p.sign })) } : fxWhy;
    // 파생(사실 2개 이상)·환산·다른 사실일 때만 입력을 남긴다 — 그 공시의 이 개념 사실 1개 그대로면 열 출처 = 칸 출처(architecture.md §3.2)
    const derived = inputs.length > 1 || other || inputs.some((i) => i.x);
    return { v: total, raw: rawTotal, why, ...(derived ? { inputs } : {}), gaps };
  }

  private async yahooValue(qname: string, col: ColumnSpec): Promise<CellValue> {
    const field = YAHOO_FIELD[canonical(qname)];
    if (!field) return { v: null, raw: null, gaps: 0 };
    if (!this.yahoo || !this.fx) return { v: null, raw: null, gaps: Gap.YAHOO };
    const fyPart = col.segments[0].parts[0];
    const fyOrig = await this.partValue(qname, fyPart);
    if (fyOrig == null || fyOrig === "gap") return { v: null, raw: null, gaps: 0 };
    const r = yahooLtmOf(this.yahoo, field, fyOrig.val, col.yahoo!.fyEnd, this.fx);
    if (!r.ok) return { v: null, raw: null, gaps: Gap.YAHOO };
    // 입력 = Yahoo 분기(보고 통화) × 그 분기 평균 환율 — 원천을 저장하지 않으므로 값·조회 시각을 같이 남긴다
    const fx = this.fx;
    const asOf = this.yahooAt ?? fx.asOf;
    const inputs: DerivedInput[] = r.terms.map((t) => ({
      ref: `y:${field}|${t.end}`, op: 1, role: "yq", v: t.v, asOf,
      x: { ref: fxAvgRef(fx.cur, t.start, t.end), v: t.rate, asOf: fx.asOf },
    }));
    return { v: r.usd, raw: null, why: { k: "yahoo-q", through: r.through }, inputs, gaps: 0 };
  }

  /** Yahoo LTM 이 성립했을 때의 기간(열 머리글 보정용) */
  yahooWindow(col: ColumnSpec): { start: string; end: string } | null {
    if (!col.yahoo || !this.yahoo || !this.fx) return null;
    const rev = this.facts("us-gaap:Revenues").concat(this.facts("us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax"), this.facts("ifrs-full:Revenue"), this.facts("ifrs-full:RevenueFromContractsWithCustomers"))
      .find((f) => near(f.start, col.yahoo!.fyStart) && near(f.end, col.yahoo!.fyEnd));
    if (!rev) return null;
    const r = yahooLtmOf(this.yahoo, "totalRevenue", rev.val, col.yahoo.fyEnd, this.fx);
    if (!r.ok) return null;
    return { start: r.start, end: r.through };
  }

  // ── 구조 ──

  /** 공시의 손익계산서 표시 구조·계산 부모·(선택) 라벨 */
  structure(accn: string, withLabels = false): Promise<FilingStructure> {
    const key = `${accn}|${withLabels ? 1 : 0}`;
    let p = this.structMemo.get(key);
    if (!p) {
      p = (async (): Promise<FilingStructure> => {
        try {
          const ff = await filingFiles(this.profile.cik, accn);
          const preT = await linkbaseText(ff, "pre");
          const shape = preT ? pickIncomeStatement(parsePresentation(preT)) : null;
          if (!shape) return { shape: null, parents: new Map(), sums: new Map(), labels: null, gaps: Gap.LINKBASE };
          const calT = await linkbaseText(ff, "cal");
          const { parents, sums } = calT ? calcParents(parseCalculation(calT), shape.role, new Set(shape.lines.map((l) => l.id))) : { parents: new Map(), sums: new Map() };
          let labels: FilingStructure["labels"] = null;
          if (withLabels) {
            const labT = await linkbaseText(ff, "lab").catch(() => null);
            labels = labT ? parseLabels(labT) : null;
          }
          return { shape, parents, sums, labels, gaps: calT ? 0 : Gap.LINKBASE };
        } catch {
          return { shape: null, parents: new Map(), sums: new Map(), labels: null, gaps: Gap.LINKBASE };
        }
      })();
      this.structMemo.set(key, p);
    }
    return p;
  }

  /** 최근 정기공시 accn */
  latestPeriodic(): string | null {
    return this.sub.recent.find((f) => /^(10-[QK]|20-F|40-F)(\/A)?$/.test(f.form))?.accn ?? null;
  }
}

function readValueOf(f: RawFact): ReadValue {
  return { val: f.val, unit: f.unit, prov: { ...f.prov, concept: f.concept, start: f.start, end: f.end, unit: f.unit } };
}

export function asPartRead(r: ReadValue | null | "gap"): PartRead | null | "gap" {
  return r === null || r === "gap" ? r : { val: r.val, leaves: [{ rv: r, op: 1 }] };
}

/** SEC 사실 참조 키 `f:{accn}|{개념}|{start}|{end}[|축=멤버,…]`(types.ts DerivedInput) — readRef 가 되읽는다 */
export function factRef(p: Prov): string {
  const dims = p.dims && Object.keys(p.dims).length ? `|${Object.entries(p.dims).map(([a, m]) => `${a}=${m}`).join(",")}` : "";
  return `f:${p.accn ?? ""}|${p.concept ?? ""}|${p.start ?? ""}|${p.end ?? ""}${dims}`;
}

function uniq<T extends { start: string; end: string }>(xs: T[]): T[] {
  const m = new Map<string, T>();
  for (const x of xs) m.set(`${x.start}|${x.end}`, x);
  return [...m.values()];
}

/** 종목의 가장 최근 정기공시 accn — 제출 목록(submissions)만 읽는다(배치 갱신 판정용, UsReader.latestPeriodic 과 같은 규칙) */
export async function latestPeriodicAccn(symbol: string): Promise<string | null> {
  const { cik } = await resolveCik(symbol);
  const sub = await getSubmissions(cik);
  return sub.recent.find((f) => PERIODIC_FORM.test(f.form))?.accn ?? null;
}

export { fiscalYearOf, days, canonical };
export type { Prov };
