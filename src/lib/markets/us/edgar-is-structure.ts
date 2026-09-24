import "server-only";
import { fetchJson, fetchText } from "../http";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import type { RecentFilings } from "./edgar-gapfill";

/**
 * **손익계산서 계산 구조(XBRL calculation linkbase)로 영업이익 산출** — 손익계산서에 영업이익 소계가 없는 회사.
 *
 * 영업이익 태그가 없으면 세전이익 + 이자비용(− 지분법)으로 근사했는데, 영업외 기타손익이 섞였다. 또 DIS 는
 * `OperatingIncomeLoss` 를 **부문 주석에만**(부문 영업이익 합계 — 본사비용·구조조정·손상·인수 무형상각 제외)
 * 달아서 앱이 그걸 회사 영업이익으로 읽었다(검증 2026-09-24: 2023 앱 128.63억 vs 손익계산서 구조 51.00억,
 * Yahoo 도 손익계산서 구조 기준). 오너 결정 2026-09-24 "DIS·FOXA 둘 다 수정".
 *
 * 방법: 10-K·10-Q 의 `_cal.xml` 에서 세전이익 = Σ(가중치 × 하위 줄) 구조를 읽고, 하위 줄 중 **영업외 항목**
 * (이자·지분법·영업외손익·투자손익·환손익·채무소멸손익)의 합을 합성 태그 `NonoperatingItemsInPretaxDerived` 로
 * 넣는다. 영업이익 = 세전이익 − 이 합(edgar-ev.ts). 기간마다 **하위 줄 합 = 세전이익(0.5%)** 을 확인한 기간만
 * 쓴다 — 구조가 바뀐 옛 연도는 그 해를 담은 10-K 의 구조로, 그래도 안 맞으면 기존 근사로 남는다.
 * 구조에 영업이익 소계가 있으면(대부분 회사) 아무것도 안 한다.
 *
 * 구조조정·손상 줄은 **영업 항목**으로 둔다(GAAP) — Yahoo 는 이 줄을 빼서(DIS 2023 89.92억) 손상이 큰 해에
 * 차이가 난다. NVDA Arm 위약금·WMT 소송 합의금을 GAAP 대로 둔 것과 같은 원칙.
 */

export const SYN_NONOP_IN_PRETAX = "NonoperatingItemsInPretaxDerived";
/** DIS 형 — 부문 주석에만 있던 영업이익 태그를 옮겨 두는 이름(화면은 안 씀) */
export const SEGMENT_OP_INCOME = "OperatingIncomeLossSegmentNoteOnly";

/** 세전이익 개념 — edgar-ev.ts 의 영업이익 합성이 읽는 목록과 같아야 한다(짝이 안 맞으면 시계열이 빈다) */
const PRETAX = [
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
];
/**
 * 영업외 항목 — **정확한 개념명 목록**. 부분일치 정규식은 은행·증권의 순수익(`RevenuesNetOfInterestExpense`)·
 * 순이자이익(`InterestIncomeExpenseNet`)과 보험사 투자수익(`NetInvestmentIncome`)까지 영업외로 잡아 영업이익이
 * 음수·절반이 됐다(독립 감사 2026-09-24: GS −364억, JPM −1,099억, TRV 절반).
 */
const NONOP = new Set([
  "InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt", "InterestAndDebtExpense",
  "InterestIncomeExpenseNonoperatingNet", "InvestmentIncomeInterest", "InvestmentIncomeInterestAndDividend",
  "InvestmentIncomeNonoperating", "InterestAndOtherIncome",
  "NonoperatingIncomeExpense", "OtherNonoperatingIncomeExpense", "OtherNonoperatingIncome", "OtherNonoperatingExpense",
  "IncomeLossFromEquityMethodInvestments", "IncomeLossFromEquityMethodInvestmentsNetOfDividendsOrDistributions",
  "GainLossOnInvestments", "GainLossOnSaleOfInvestments", "ForeignCurrencyTransactionGainLossBeforeTax",
  "GainsLossesOnExtinguishmentOfDebt",
]);
/** 이 노드 아래로는 내려가지 않는다 — 매출 구성(보험 투자수익·CVX 형 지분법 매출)은 영업 매출 쪽에서 따로 다룬다 */
const NO_DESCEND = /^Revenues$|^RevenueFromContract|^RevenuesNetOf|^Revenue/;

const UA = process.env.SEC_USER_AGENT ?? "global-market-research (personal use) contact@example.com";
const H = { "user-agent": UA, "accept-encoding": "gzip, deflate" };

interface Arc { concept: string; ns: string; w: number }
/** 세전이익 구조 — 직접 하위 줄(합 검증용)과 하위 트리 전체에서 찾은 영업외 항목(가중치 곱) */
interface Structure { pretax: string; arcs: Arc[]; nonop: Arc[] }

/** calculation linkbase 에서 손익계산서 역할의 "세전이익 ← 하위 줄" 목록. OperatingIncomeLoss 가 트리에 있으면 null. */
function pretaxChildren(cal: string): Structure | null {
  for (const m of cal.matchAll(/<link:calculationLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/link:calculationLink>/g)) {
    const role = m[1].split("/").pop() ?? "";
    if (!/INCOME|OPERATIONS|EARNINGS/i.test(role) || /Detail|Table|Parenth|Tax|Comprehensive|Segment/i.test(role)) continue;
    const loc = new Map<string, string>();
    for (const l of m[2].matchAll(/<link:loc\b([^>]*)\/?>/g)) {
      const href = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1];
      const label = /xlink:label="([^"]+)"/.exec(l[1])?.[1];
      if (href && label) loc.set(label, href);
    }
    const arcs: { from: string; to: string; w: number }[] = [];
    for (const a of m[2].matchAll(/<link:calculationArc\b([^>]*)\/?>/g)) {
      const from = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? "");
      const to = loc.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
      const w = Number(/weight="([^"]+)"/.exec(a[1])?.[1]);
      if (from && to && Number.isFinite(w)) arcs.push({ from, to, w });
    }
    if (arcs.some((a) => /_OperatingIncomeLoss$/.test(a.from) || /_OperatingIncomeLoss$/.test(a.to))) return null;
    const split = (id: string) => { const i = id.indexOf("_"); return { ns: id.slice(0, i), concept: id.slice(i + 1) }; };
    for (const p of PRETAX) {
      const kids = arcs.filter((a) => split(a.from).ns === "us-gaap" && split(a.from).concept === p);
      if (kids.length < 2) continue;
      // 영업외 항목은 하위 트리 전체에서 — XOM 처럼 이자비용이 "비용 합계" 아래에 있는 구조. 영업외 항목에서 멈춘다
      // (영업외 합계 아래 이자를 또 세지 않게)
      const nonop: Arc[] = [];
      const walk = (id: string, w: number, depth: number) => {
        if (depth > 6) return;
        for (const a of arcs.filter((x) => x.from === id)) {
          const c = split(a.to);
          if (c.ns === "us-gaap" && NONOP.has(c.concept)) nonop.push({ ...c, w: w * a.w });
          else if (!NO_DESCEND.test(c.concept)) walk(a.to, w * a.w, depth + 1);
        }
      };
      walk(`us-gaap_${p}`, 1, 0);
      return { pretax: p, arcs: kids.map((a) => ({ ...split(a.to), w: a.w })), nonop };
    }
  }
  return null;
}

interface Filing { accn: string; form: string; filed: string; doc: string }

async function financialSegmentOnly(cik: string, facts: CompanyFacts, recent: RecentFilings): Promise<CompanyFacts> {
  const g = facts.facts["us-gaap"] ?? {};
  if (!g.OperatingIncomeLoss?.units?.USD?.some((e) => e.end >= "2020-01-01")) return facts;
  // 최신 10-K 와 최신 10-Q 모두에서 손익계산서 구조를 읽었고 **어느 손익 역할에도**(손익·포괄손익 결합 보고서 포함)
  // 영업이익이 없을 때만 뗀다 — 못 읽거나 하나라도 있으면 그대로 둔다(재감사: 결합 보고서·모회사 단독 역할 오판 방지)
  for (const form of ["10-K", "10-Q"]) {
    const i = recent.form.findIndex((f) => f === form);
    if (i < 0) { if (form === "10-K") return facts; continue; }
    const cal = await calOf(Number(cik), { accn: recent.accessionNumber[i], form, filed: recent.filingDate[i], doc: recent.primaryDocument[i] }).catch(() => null);
    if (!cal || !pretaxChildren(cal)) return facts;
    for (const m of cal.matchAll(/<link:calculationLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/link:calculationLink>/g)) {
      const role = m[1].split("/").pop() ?? "";
      if (/INCOME|OPERATIONS|EARNINGS/i.test(role) && !/Detail|Table|Parenth/i.test(role) && /#us-gaap_OperatingIncomeLoss"/.test(m[2])) return facts;
    }
  }
  const next: Record<string, unknown> = { ...g, [SEGMENT_OP_INCOME]: g.OperatingIncomeLoss };
  delete next.OperatingIncomeLoss;
  return { ...facts, segmentOpIncomeOnly: true, facts: { ...facts.facts, "us-gaap": next } } as CompanyFacts;
}

async function calOf(cik: number, f: Filing): Promise<string | null> {
  const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${f.accn.replace(/-/g, "")}`;
  const idx = await fetchJson<{ directory: { item: { name: string }[] } }>(`${base}/index.json`, { headers: H, revalidate: 60 * 60 * 24 });
  const name = idx.directory.item.map((i) => i.name).find((n) => /_cal\.xml$/i.test(n));
  return name ? fetchText(`${base}/${name}`, { headers: H, revalidate: 60 * 60 * 24, timeoutMs: 30_000 }) : null;
}

/** 이 회사에 적용할지 — 영업이익 태그가 없거나, 있어도 "매출 − 총비용"과 크게 어긋나면(DIS 형 의심) */
function needsCheck(g: NonNullable<CompanyFacts["facts"]["us-gaap"]>): boolean {
  const oi = g.OperatingIncomeLoss?.units?.USD ?? [];
  if (!oi.some((e) => e.end >= "2020-01-01")) return true;
  const fy = (c: string) => (g[c]?.units?.USD ?? []).filter((e) => e.fp === "FY" && e.start);
  const latest = fy("OperatingIncomeLoss").sort((a, b) => b.end.localeCompare(a.end))[0];
  if (!latest) return false;
  const same = (e: FactUnitEntry) => e.start === latest.start && e.end === latest.end;
  const rev = [...fy("Revenues"), ...fy("RevenueFromContractWithCustomerExcludingAssessedTax")].find(same);
  const cost = fy("CostsAndExpenses").find(same);
  return !!rev && !!cost && Math.abs(latest.val - (rev.val - cost.val)) > 0.02 * Math.abs(rev.val);
}

export async function withIncomeStatementStructure(cik: string, facts: CompanyFacts, recent: RecentFilings | null, sic: number | null): Promise<CompanyFacts> {
  const g = facts.facts["us-gaap"] ?? {};
  if (!recent || sic == null) return facts;
  // 금융·보험·부동산(SIC 6000~6799)은 영업외 분리를 하지 않는다 — 이자·투자수익이 본업 수익이다. 다만 영업이익
  // 태그가 손익계산서 계산 구조에 없으면(MET — 부문 조정이익으로 보이는 값, 2023 57.23억 vs 세전 21.62억) 그 태그만
  // 옮겨 두고 세전이익 기준(edgar-ev.ts financialSector)으로 둔다
  if (sic >= 6000 && sic <= 6799) return financialSegmentOnly(cik, facts, recent);
  if (!needsCheck(g)) return facts;
  const filings: Filing[] = [];
  let k10 = 0, q10 = 0;
  for (let i = 0; i < recent.form.length && (k10 < 3 || q10 < 1); i++) {
    const form = recent.form[i];
    if ((form === "10-K" && k10 < 3) || (form === "10-Q" && q10 < 1 && k10 === 0)) {
      filings.push({ accn: recent.accessionNumber[i], form, filed: recent.filingDate[i], doc: recent.primaryDocument[i] });
      if (form === "10-K") k10++;
      else q10++;
    }
  }
  const structures: Structure[] = [];
  for (const f of filings) {
    const cal = await calOf(Number(cik), f).catch(() => null);
    if (!cal) continue;
    const s = pretaxChildren(cal);
    if (s) structures.push(s);
    else if (f === filings[0]) return facts; // 최신 공시에 영업이익 소계가 있음 — 해당 없음
  }
  if (!structures.length) return facts;

  const key = (e: FactUnitEntry) => `${e.start}|${e.end}`;
  // 같은 기간 값이 여러 개면 가장 최근 제출분(재작성·재분류 반영) — FOXA 2023 영업외손익 −699(원공시) vs 368(재분류)
  const raw = (concept: string, k: string): number | undefined => {
    let best: FactUnitEntry | undefined;
    for (const e of g[concept]?.units?.USD ?? []) if (e.start && key(e) === k && (!best || (e.filed ?? "") > (best.filed ?? ""))) best = e;
    return best?.val;
  };
  // 매출 줄은 해마다 태그가 바뀐다(FOXA 2023 까지 Revenues → 이후 고객계약 매출) — 그 기간에 없으면 동의어로.
  // 대입 결과도 아래 "하위 줄 합 = 세전이익" 검증을 거친다.
  const REV_ALIAS = ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "RevenueFromContractWithCustomerIncludingAssessedTax"];
  const valAt = (concept: string, k: string): number | undefined => {
    const v = raw(concept, k);
    if (v !== undefined || !REV_ALIAS.includes(concept)) return v;
    for (const a of REV_ALIAS) { const x = raw(a, k); if (x !== undefined) return x; }
    return undefined;
  };
  const out: FactUnitEntry[] = [];
  const done = new Set<string>();
  // 기간마다 최신 구조부터 대입 — 하위 줄 합이 세전이익과 0.5% 안에서 맞는 첫 구조를 쓴다
  for (const s of structures) {
    for (const p of g[s.pretax]?.units?.USD ?? []) {
      if (!p.start || done.has(key(p) + "|" + p.form + "|" + p.fp)) continue;
      const k = key(p);
      let sum = 0, nonop = 0, ok = true;
      for (const a of s.arcs) {
        if (a.ns !== "us-gaap") { ok = false; break; } // 회사 확장 태그 값은 companyfacts 에 없음
        const v = valAt(a.concept, k);
        if (v === undefined) continue; // 그 기간엔 없는 줄(0)
        sum += a.w * v;
      }
      for (const a of s.nonop) {
        if (a.ns !== "us-gaap") { ok = false; break; }
        nonop += a.w * (valAt(a.concept, k) ?? 0);
      }
      if (!ok || Math.abs(sum - p.val) > 0.005 * Math.max(Math.abs(p.val), 1)) continue;
      done.add(k + "|" + p.form + "|" + p.fp);
      out.push({ ...p, val: nonop });
    }
  }
  if (!out.length) return facts;
  // DIS 형 — 영업이익 태그가 손익계산서 구조에 없으면 부문 주석 값이므로 옮겨 둔다(모든 화면이 합성값을 쓰게)
  const next: Record<string, unknown> = { ...g, [SYN_NONOP_IN_PRETAX]: { units: { USD: out } } };
  let segmentOnly = false;
  if (g.OperatingIncomeLoss?.units?.USD?.some((e) => e.end >= "2020-01-01")) {
    next[SEGMENT_OP_INCOME] = g.OperatingIncomeLoss;
    delete next.OperatingIncomeLoss;
    segmentOnly = true;
  }
  return { ...facts, opIncomeFromStructure: true, segmentOpIncomeOnly: segmentOnly, facts: { ...facts.facts, "us-gaap": next } } as CompanyFacts;
}
