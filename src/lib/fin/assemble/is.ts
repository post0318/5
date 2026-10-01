import "server-only";
import { Gap, type AssembledIs, type CogsTerm, type Column, type LineRole, type OpexLines, type Prov, type SgaHint, type StmtLine } from "../types";
import { asPartRead, canonical, REVENUE_ALIAS_CONCEPTS, type CellValue, type ColumnSpec, type FilingStructure, type Part, type PartRead, type UsReader } from "../read";

/**
 * 2층 — 손익계산서 조립(architecture.md §1·§2). **한 열 = 한 기준**: 그 열 원천 공시의 본표 표시 구조(_pre) 순서대로 줄을
 * 세우고, 계산 구조(_cal)로 부모·가중치를 붙이고, 줄마다 1층 `value()` 로 값을 받는다(판본·기간·환율은 1층이 이미 정함).
 * 구조로 역할(role)을 붙이고 항등식(부모 = Σ 가중치 × 자식)을 검사한다. 어느 줄을 지표로 쓸지는 3층이 정한다.
 *
 * 파생 열(Q4D·누적 차 Q·LTM)의 구조 = 첫 구성 공시(Q4D 는 10-K, LTM 은 당기 10-Q). 구조를 못 읽으면 기본 개념 목록으로
 * 줄을 세우고 Gap.LINKBASE(원본 표현이 아님을 표시).
 */

const ROLE: Record<string, LineRole> = {
  "us-gaap:Revenues": "revenue.total",
  "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax": "revenue",
  "us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax": "revenue",
  "us-gaap:RevenuesNetOfInterestExpense": "revenue.net",
  // 매출원가(cogs)는 개념 이름으로 붙이지 않는다 — 본표 계산 구조로 찾는다(identifyCogs, docs/metrics/cogs.md §1)
  "us-gaap:GrossProfit": "gross",
  "us-gaap:OperatingIncomeLoss": "opinc",
  "us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest": "pretax",
  "us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments": "pretax",
  "us-gaap:IncomeTaxExpenseBenefit": "tax",
  "us-gaap:ProfitLoss": "ni",
  "us-gaap:NetIncomeLoss": "ni.parent",
};

/**
 * 총수익 안의 비영업 수익 — 총수익(revenue.total) 바로 아래 줄 중 이 이름(네임스페이스 무관)이면 revenue.nonop.
 * CVX(cvx:EquityMethodInvestmentIncome·cvx:NonoperatingIncome 등) — edgar-revenue-dims.ts NONOP_CONCEPT 와 같은 목록.
 */
const NONOP_CONCEPT = /^(EquityMethodInvestmentIncome|IncomeFromEquityAffiliates|IncomeLossFromEquityMethodInvestments|EquityInEarningsOfAffiliates|NonoperatingIncome|OtherIncome|OtherNonoperatingIncome|OtherNonoperatingIncomeExpense|IncomeLossFromEquityMethodInvestmentsNetOfDividendsOrDistributions)$/;
/** 총수익을 제품·서비스 차원으로 나눈 비영업 멤버(XOM) — edgar-revenue-dims.ts NONOP_MEMBER 와 같음(전체 일치만) */
const NONOP_MEMBER = /EquityAffiliate|EquityMethod|EquityCompan|^(OtherRevenueMember|OtherIncomeMember)$/i;
export const SYN_NONOP_DIMS = "syn:RevenuesNonoperatingMembers";

/**
 * 매출원가 후보 개념(IFRS 는 canonical 로 us-gaap 이름) — 매출총이익 식이 없는 본표에서만 쓰는 보조 조건(라벨과 함께).
 * 개념 이름만으로는 고르지 않는다: MCD 10-Q 는 가맹점 임차비용 줄을 CostOfGoodsAndServicesSold 로, CAT·BE 는 주석 조각을 같은
 * 개념으로 태깅했다(cogs.md §5).
 */
const COST_CONCEPT = new Set([
  "us-gaap:CostOfRevenue", "us-gaap:CostOfGoodsAndServicesSold", "us-gaap:CostOfGoodsSold",
  "us-gaap:CostOfGoodsAndServiceExcludingDepreciationDepletionAndAmortization",
]);
/** 원가 라벨 — 그 열 원천 공시 자체의 라벨로 판정("Cost of sales"·"Cost of revenues"·"Cost of goods sold"…) */
const COST_LABEL = /\bcosts? of (net )?(revenues?|sales|goods|products|equipment)\b/i;
const REVENUE_CANON = new Set(REVENUE_ALIAS_CONCEPTS);

type Sums = Map<string, { to: string; w: number }[]>;

/**
 * 매출원가 줄 판정(오너 결정 2026-09-26, cogs.md §1) — 역할 "cogs"(한 줄·소계) 또는 "cogs.part"(소계 없는 여러 줄)를 붙인다.
 *  1. 매출총이익(gross) 줄의 계산식에서 **빼는 항**. 식의 더하는 항에 매출 줄이 없으면(TSM 2018 이전 — 매출총이익 = 조정 전
 *     매출총이익 ± 관계기업 미실현이익) 더하는 소계 항의 식으로 내려가 매출이 있는 식의 빼는 항을 쓴다. 빼는 항이 여러 줄이면
 *     그 항들을 정확히 합하는 본표 소계 줄(AMD 2023·2024 10-K 매출원가 소계)을, 없으면 각 항을 cogs.part 로.
 *  2. 매출총이익 식이 없으면(소계 없는 본표 — AMZN·CAT·UBER 등) 원가 개념이면서 **그 공시 자체 라벨**이 원가(cost of revenue/
 *     sales/goods)인 줄. 다른 후보의 식 안 항은 빼고 하나만 남을 때만.
 */
function identifyCogs(lines: StmtLine[], sums: Sums, ownLabel: (l: StmtLine) => string | null): { by: AssembledIs["cogsBy"]; why?: string } {
  const at = new Map(lines.map((l, i) => [l.id, i] as const));
  const isRev = (id: string) => REVENUE_CANON.has(canonical(id)) || !!lines[at.get(id) ?? -1]?.role?.startsWith("revenue");
  const gross = lines.find((l) => l.role === "gross");
  if (gross && sums.get(gross.id)?.length) {
    let id = gross.id;
    let neg: { to: string; w: number }[] | null = null;
    for (let d = 0; d < 3; d++) {
      const ts = sums.get(id) ?? [];
      const pos = ts.filter((t) => t.w > 0);
      if (pos.some((t) => isRev(t.to))) { neg = ts.filter((t) => t.w < 0); break; }
      const sub = pos.find((t) => sums.get(t.to)?.length);
      if (!sub) break;
      id = sub.to;
    }
    if (neg?.length) {
      const key = (xs: string[]) => [...xs].sort().join("|");
      const want = key(neg.map((t) => t.to));
      const subtotal = neg.length > 1 ? lines.find((l) => { const f = sums.get(l.id); return !!f?.length && f.every((t) => t.w > 0) && key(f.map((t) => t.to)) === want; }) : undefined;
      if (neg.length === 1 && at.has(neg[0].to)) { lines[at.get(neg[0].to)!].role = "cogs"; return { by: "gp" }; }
      if (subtotal) { subtotal.role = "cogs"; return { by: "gp" }; }
      if (neg.every((t) => at.has(t.to))) { for (const t of neg) lines[at.get(t.to)!].role = "cogs.part"; return { by: "gp" }; }
      return { by: null, why: `매출총이익 식의 원가 항이 본표 줄에 없음(${neg.filter((t) => !at.has(t.to)).map((t) => t.to).join(",")})` };
    }
  }
  const cands = lines.filter((l) => COST_CONCEPT.has(canonical(l.id)) && COST_LABEL.test(ownLabel(l) ?? ""));
  const inner = new Set(cands.flatMap((c) => (sums.get(c.id) ?? []).map((t) => t.to)));
  const top = cands.filter((c) => !inner.has(c.id));
  if (top.length === 1) { top[0].role = "cogs"; return { by: "label" }; }
  if (top.length > 1) return { by: null, why: `원가 라벨 줄이 여럿(${top.map((c) => c.id).join(",")})` };
  return { by: null, why: gross ? "매출총이익 식 없음 · 원가 라벨 줄 없음" : "본표에 매출원가 줄 없음" };
}

/**
 * 판관비·연구개발비 성격 개념(docs/metrics/sga.md §1) — 표준 네임스페이스(us-gaap·ifrs-full)는 **개념 이름**으로, 회사 고유 개념은 그 공시 자체
 * 라벨로 판정한다. 오너 결정(2026-09-28): 판관비 = 본표 판관비 성격 줄 전부의 합 — 판매·마케팅·광고·일반관리·기타 판관비(MCD "Other", KO
 * "Other operating charges" 는 개념이 OtherSellingGeneralAndAdministrativeExpense).
 */
const SGA_LOCAL = new Set([
  "SellingGeneralAndAdministrativeExpense", "GeneralAndAdministrativeExpense", "SellingAndMarketingExpense", "SellingExpense",
  "MarketingExpense", "MarketingAndAdvertisingExpense", "AdvertisingExpense", "OtherSellingGeneralAndAdministrativeExpense",
  // IFRS
  "SalesAndMarketingExpense", "DistributionCosts", "AdministrativeExpense",
]);
const RND_LOCAL = new Set([
  "ResearchAndDevelopmentExpense", "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost", "ResearchAndDevelopmentExpenseSoftwareExcludingAcquiredInProcessCost",
]);
/** 회사 고유 개념의 라벨 판정 — 판관비(판매·일반관리 계열 이름으로 시작), 연구개발비("research" 포함, 취득 IPR&D 제외) */
const SGA_OWN_LABEL = /^(total )?((selling|sales),? general,? (and|&) administrative|general (and|&) administrative|(selling|sales|marketing) (and|&) (marketing|selling|sales))\b/i;
const RND_OWN_LABEL = /research/i;
const RND_OWN_EXCL = /in[- ]?process|acquired/i;
const STD_NS = new Set(["us-gaap", "ifrs-full"]);

type OpexPick = { id: string; sign: 1 | -1 }[];
/**
 * 판관비·연구개발비 줄 판정 — 본표 계산 구조의 영업이익 식(없으면 세전이익 식)을 뿌리에서 내려가며 판관비·연구개발비 성격 줄을 모은다
 * (그 줄 아래로는 내려가지 않음 — 소계면 소계). 매출·매출총이익 식(매출·원가 줄)과 skip 이 참인 줄(원가 줄·유형 D 원가 구성 항)은
 * 들어가지 않는다. sign = 뿌리 식에서 빼는 비용이면 +1.
 *
 * 계산 구조가 뿌리와 끊긴 본표(PLTR 2023 이전 10-Q — 영업비용 합계 식이 영업이익 식에 매달리지 않음): 표시 순서상 영업이익 줄(없으면
 * 뿌리) 앞의 줄 중 뿌리에서 닿지 않은 판관비·연구개발비 성격 줄도 모은다. 부호는 그 줄이 속한 식의 꼭대기(영업비용 합계)까지의
 * 가중치 곱 — 꼭대기는 비용 합계로 본다(비용 개념은 차변 양수).
 */
function pickSgaRnd(
  sums: Sums, ids: string[], rootId: string, labelOf: (id: string) => string | null,
  hint: SgaHint | undefined, skip: (id: string) => boolean,
): { sga: OpexPick; rnd: OpexPick } {
  const sga: OpexPick = [], rnd: OpexPick = [];
  const present = new Set(ids);
  const natureOf = (id: string): "sga" | "rnd" | null => {
    if (hint?.sga?.includes(id)) return "sga";
    if (hint?.rnd?.includes(id)) return "rnd";
    const ns = id.slice(0, id.indexOf(":")), local = id.slice(id.indexOf(":") + 1);
    if (STD_NS.has(ns)) return SGA_LOCAL.has(local) ? "sga" : RND_LOCAL.has(local) ? "rnd" : null;
    const lab = (labelOf(id) ?? "").trim();
    if (SGA_OWN_LABEL.test(lab)) return "sga";
    if (RND_OWN_LABEL.test(lab) && !RND_OWN_EXCL.test(lab)) return "rnd";
    return null;
  };
  const blocked = (id: string) => {
    const role = ROLE[canonical(id)];
    return role === "gross" || !!role?.startsWith("revenue") || REVENUE_CANON.has(canonical(id)) || skip(id);
  };
  const reached = new Set<string>();
  const add = (id: string, expenseSign: 1 | -1) => {
    const n = natureOf(id);
    if (!n) return false;
    (n === "sga" ? sga : rnd).push({ id, sign: expenseSign });
    return true;
  };
  const walk = (id: string, w: number, depth: number) => {
    if (depth > 8) return;
    for (const t of sums.get(id) ?? []) {
      if (!present.has(t.to) || reached.has(t.to)) continue;
      reached.add(t.to);
      const ww = w * (t.w < 0 ? -1 : 1);
      if (blocked(t.to)) continue;
      if (add(t.to, ww < 0 ? 1 : -1)) continue;
      if (sums.get(t.to)?.length) walk(t.to, ww, depth + 1);
    }
  };
  walk(rootId, 1, 0);
  // 뿌리에서 닿지 않은 줄 — 표시 순서상 영업이익(없으면 뿌리) 앞. 이미 모은 줄·막힌 줄의 식 아래는 제외
  const parentOf = new Map<string, { to: string; w: number }>();
  for (const [par, ts] of sums) for (const t of ts) if (!parentOf.has(t.to)) parentOf.set(t.to, { to: par, w: t.w });
  const opIdx = ids.findIndex((id) => ROLE[canonical(id)] === "opinc");
  const end = opIdx >= 0 ? opIdx : ids.indexOf(rootId);
  const taken = new Set([...sga, ...rnd].map((x) => x.id));
  for (const id of ids.slice(0, end < 0 ? ids.length : end)) {
    if (reached.has(id) || taken.has(id) || blocked(id) || !natureOf(id)) continue;
    let w = 1, cur = id, ok = true;
    for (let d = 0; d < 8; d++) {
      const pp = parentOf.get(cur);
      if (!pp) break;
      if (taken.has(pp.to) || blocked(pp.to) || natureOf(pp.to)) { ok = false; break; }
      w *= pp.w < 0 ? -1 : 1;
      cur = pp.to;
    }
    if (ok && add(id, w > 0 ? 1 : -1)) taken.add(id);
  }
  return { sga, rnd };
}

/** 뿌리 줄 — 영업이익 소계(계산식 있음), 없으면 세전이익(계산식 있음) */
function opexRoot(ids: string[], sums: Sums): string | null {
  const find = (r: LineRole) => ids.find((id) => ROLE[canonical(id)] === r && (sums.get(id)?.length ?? 0) > 0);
  return find("opinc") ?? find("pretax") ?? null;
}

/**
 * 한 열의 판관비·연구개발비 줄(역할 sga·sga.part·rnd·rnd.part 를 붙인다).
 * 파생 열(Q4·누적 차·LTM — 구성 공시가 둘 이상)은 구성 공시마다 **그 공시 자체 본표**로 같은 판정을 한다(한 열 = 한 기준, 매출원가
 * cogs.md §1-3 과 같은 원칙):
 *  - 줄 구성(개념 목록)이 같으면 줄 값 그대로(1층이 줄마다 파생).
 *  - 다르면 **합 동일성**(cogs.md §1 유형 D 와 같은 기준): 두 줄 구성이 모두 공시된 같은 기간의 합이 반올림 단위 안에서 같으면(개념 이름만
 *    바뀜 — NFLX Marketing → Sales and marketing) 구성 공시마다 그 공시 자체 줄의 합으로 파생값을 만든다(cell). 합이 다르거나 비교할
 *    기간이 없으면 mix(빈칸 + "기준 혼합" 사유).
 */
async function identifySgaRnd(
  reader: UsReader, col: ColumnSpec, sp: Part, lines: StmtLine[], sums: Sums, ownLabel: (l: StmtLine) => string | null,
  hint: SgaHint | undefined, cogsConcepts: Set<string>,
): Promise<OpexLines> {
  const at = new Map(lines.map((l) => [l.id, l] as const));
  const root = opexRoot(lines.map((l) => l.id), sums);
  const out: OpexLines = { root, sga: [], rnd: [], sgaSub: [], rndSub: [] };
  if (!root) { out.why = "본표에 영업이익·세전이익 계산식 없음"; return out; }
  const skip = (id: string) => cogsConcepts.has(id) || at.get(id)?.role === "cogs" || at.get(id)?.role === "cogs.part";
  const labelOf = (id: string) => (at.has(id) ? ownLabel(at.get(id)!) : null);
  const got = pickSgaRnd(sums, lines.map((l) => l.id), root, labelOf, hint, skip);
  const key = (xs: OpexPick) => xs.map((x) => x.id).sort().join("|");
  for (const kind of ["sga", "rnd"] as const) {
    const ps = got[kind];
    if (ps.length === 1) { at.get(ps[0].id)!.role = kind; out[kind] = ps; continue; }
    if (!ps.length) continue;
    const want = key(ps);
    const subtotal = lines.find((l) => { const f = sums.get(l.id); return !!f?.length && f.every((t) => t.w > 0) && key(f.map((t) => ({ id: t.to, sign: 1 }))) === want; });
    for (const p of ps) at.get(p.id)!.role = `${kind}.part`;
    const sign = ps[0].sign;
    if (subtotal && ps.every((p) => p.sign === sign)) { subtotal.role = kind; out[kind] = [{ id: subtotal.id, sign }]; }
    else out[kind] = ps;
    out[kind === "sga" ? "sgaSub" : "rndSub"] = ps.map((p) => p.id);
  }
  if (col.yahoo) return out;
  // 파생 열 — 구성 공시마다 그 공시 본표로 같은 판정
  const parts = col.segments.flatMap((s) => s.parts);
  const accns = [...new Set(parts.map((p) => p.accn).filter((x): x is string => !!x && x !== sp.accn))];
  const byAccn = new Map<string, { sga: OpexPick; rnd: OpexPick }>([[sp.accn ?? "", got]]);
  const diff: Partial<Record<"sga" | "rnd", string[]>> = {};
  for (const oa of accns) {
    const o = await reader.structure(oa, true);
    const ids = o.shape?.lines.map((l) => l.id) ?? [];
    const oroot = o.shape ? opexRoot(ids, o.sums as Sums) : null;
    const why = !o.shape ? `구성 공시 ${oa} 본표 구조 판독 실패` : !oroot ? `구성 공시 ${oa} 본표에 영업이익·세전이익 계산식 없음` : null;
    const oLabel = (id: string) => {
      const m = o.labels?.get(id);
      return m ? ([...m.entries()].find(([r]) => /terseLabel$/i.test(r))?.[1] ?? m.get("http://www.xbrl.org/2003/role/label") ?? [...m.values()][0]) : null;
    };
    const og = why ? null : pickSgaRnd(o.sums as Sums, ids, oroot!, oLabel, hint, (id) => cogsConcepts.has(id));
    if (og) byAccn.set(oa, og);
    for (const kind of ["sga", "rnd"] as const) {
      if (out.mix?.[kind]) continue;
      if (why) { if (got[kind].length) (out.mix ??= {})[kind] = why; continue; }
      if (key(og![kind]) === key(got[kind])) continue;
      if (!got[kind].length || !og![kind].length) { (out.mix ??= {})[kind] = `${sp.accn} ${key(got[kind]) || "줄 없음"} ≠ ${oa} ${key(og![kind]) || "줄 없음"}`; continue; }
      const eq = sameTotal(reader, got[kind], og![kind]);
      if (eq !== true) (out.mix ??= {})[kind] = `${sp.accn} ${key(got[kind])} ≠ ${oa} ${key(og![kind])} — ${eq}`;
      else (diff[kind] ??= []).push(`${key(got[kind])} ↔ ${key(og![kind])}`);
    }
  }
  // 합 동일 — 구성 공시마다 그 공시 자체 줄의 합으로 파생값
  for (const kind of ["sga", "rnd"] as const) {
    if (out.mix?.[kind] || !diff[kind]) continue;
    const get = async (p: Part): Promise<PartRead | null | "gap"> => {
      const picks = byAccn.get(p.accn ?? "")?.[kind];
      if (!picks?.length) return null;
      const r: PartRead = { val: 0, leaves: [] };
      for (const x of picks) {
        const v = await reader.partValue(x.id, p);
        if (v === "gap") return "gap";
        if (v == null) return null;
        r.val += x.sign * v.val;
        r.leaves.push({ rv: v, op: x.sign });
      }
      return r;
    };
    const cell = await reader.value(`syn:${kind}`, col, get);
    (out.cell ??= {})[kind] = { v: cell.v, ...(cell.inputs ? { inputs: cell.inputs } : {}), note: `구성 공시마다 줄 개념 다름 — 합 동일(${[...new Set(diff[kind])].join("; ")})` };
    // 하위 줄은 비운다(구성 공시마다 줄이 달라 줄 단위 파생값이 없다)
    out[kind === "sga" ? "sgaSub" : "rndSub"] = [];
  }
  return out;
}

/**
 * 두 줄 구성(A·B)이 같은 합인가 — 두 구성이 모두 공시된 같은 기간(각 구성의 최신 공시)의 합을 비교(반올림 단위 × 줄 수 허용).
 * true 또는 사유 문자열. 무차원·보고 통화 사실만(1층 facts — 판본 규칙이 아니라 비교 증거라 모든 공시를 본다)
 */
function sameTotal(reader: UsReader, A: OpexPick, B: OpexPick): true | string {
  const cur = reader.profile.reportingCurrency;
  const sums = (xs: OpexPick): Map<string, { v: number; filed: string }> => {
    const by = new Map<string, { n: number; v: number; filed: string }>();
    for (const x of xs)
      for (const f of reader.facts(x.id)) {
        if (f.unit !== cur || Object.keys(f.dims).length || !f.start || !f.prov.accn) continue;
        const k = `${f.start}|${f.end}|${f.prov.accn}`;
        const e = by.get(k) ?? { n: 0, v: 0, filed: f.prov.filed ?? "" };
        by.set(k, { n: e.n + 1, v: e.v + x.sign * f.val, filed: e.filed });
      }
    const out = new Map<string, { v: number; filed: string }>();
    for (const [k, e] of by) {
      if (e.n !== xs.length) continue;
      const per = k.split("|").slice(0, 2).join("|");
      const prev = out.get(per);
      if (!prev || e.filed > prev.filed) out.set(per, { v: e.v, filed: e.filed });
    }
    return out;
  };
  const a = sums(A), b = sums(B);
  let n = 0;
  for (const [per, x] of a) {
    const y = b.get(per);
    if (!y) continue;
    n++;
    const tol = Math.max(roundingUnit([x.v]), roundingUnit([y.v])) * (A.length + B.length);
    if (Math.abs(x.v - y.v) > tol) return `합 다름(${per.replace("|", "~")} ${x.v} ≠ ${y.v})`;
  }
  return n ? true : "두 구성이 함께 공시된 기간 없음 — 합 동일성 확인 불가";
}

/** 구조를 못 읽었을 때의 기본 줄(원본 표현 아님 — Gap.LINKBASE) */
const FALLBACK = [
  "us-gaap:Revenues", "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", "us-gaap:RevenuesNetOfInterestExpense",
  "us-gaap:InterestIncomeExpenseNet", "us-gaap:NoninterestIncome", "ifrs-full:Revenue", "ifrs-full:RevenueFromContractsWithCustomers",
  "us-gaap:CostOfRevenue", "us-gaap:GrossProfit", "us-gaap:OperatingIncomeLoss",
  "us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
  "us-gaap:IncomeTaxExpenseBenefit", "us-gaap:ProfitLoss", "us-gaap:NetIncomeLoss",
];

const provOf = (p: Part): Prov => ({ accn: p.accn, form: p.form, filed: p.filed, source: "sec-cf" });

/**
 * Q4D 매출 줄 — 9개월 누적 부분이 구조 기준 개념으로 없으면 1층의 개념 대체 판단(reader.revenueAliasNine — 같은 줄이라는
 * 증거 공시가 있을 때만)에 맡긴다. 대체 여부·후보 개념은 1층이 정한다(architecture.md §1).
 */
function q4RevenueFallback(reader: UsReader, qname: string, fyPart: Part, ninePart: Part) {
  return async (p: Part): Promise<PartRead | null | "gap"> => {
    const direct = await reader.partValue(qname, p);
    if (direct === "gap") return "gap";
    if (direct !== null) return asPartRead(direct);
    if (p !== ninePart) return null; // 사업연도 부분은 폴백 대상 아님 — 구조 기준 개념 그대로
    return asPartRead(await reader.revenueAliasNine(qname, fyPart, ninePart));
  };
}

function structureAccn(col: ColumnSpec): Part {
  const parts = col.segments.flatMap((s) => s.parts);
  if (col.kind === "LTM" && !col.yahoo) {
    // 당기 누적(가장 늦은 공시)의 구조
    return parts.reduce((b, p) => ((p.filed ?? "") > (b.filed ?? "") ? p : b), parts[0]);
  }
  return parts[0];
}

/** 반올림 단위 — 값들이 모두 나누어떨어지는 가장 큰 10의 거듭제곱(최대 1e6) */
function roundingUnit(vals: number[]): number {
  let u = 1;
  while (u < 1e6 && vals.every((v) => Math.round(Math.abs(v)) % (u * 10) === 0)) u *= 10;
  return u;
}

function labelOf(id: string, preferred: string | undefined, labels: FilingStructure["labels"], reader: UsReader): string {
  const m = labels?.get(id);
  if (m) {
    if (preferred && m.get(preferred)) return m.get(preferred)!;
    const terse = [...m.entries()].find(([r]) => /terseLabel$/i.test(r))?.[1];
    return terse ?? m.get("http://www.xbrl.org/2003/role/label") ?? [...m.values()][0];
  }
  return reader.idx.label(id) ?? id.split(":").pop() ?? id;
}

export interface AssembledStatements {
  annual: AssembledIs[];
  quarterly: AssembledIs[];
  /** 줄 id → 라벨(최근 공시 기준) */
  labels: Map<string, string>;
}

/** 영업이익 태그가 없는 회사 — 총수익 차원 분리(XOM 형)를 시도할 대상(edgar-revenue-dims.ts 와 같은 판정) */
function noOpIncomeTag(reader: UsReader): boolean {
  return !["us-gaap:OperatingIncomeLoss", "ifrs-full:ProfitLossFromOperatingActivities"].some((c) => reader.facts(c).some((f) => f.end >= "2020-01-01"));
}

async function assembleColumn(
  reader: UsReader,
  col: ColumnSpec,
  labelSrc: FilingStructure,
  labelsOut: Map<string, string>,
  opts: { dimSplit: boolean; cogsTerms?: CogsTerm[]; sgaHint?: SgaHint },
): Promise<AssembledIs> {
  const sp = structureAccn(col);
  const st = sp.accn ? await reader.structure(sp.accn) : { shape: null, parents: new Map(), sums: new Map(), labels: null, gaps: Gap.LINKBASE };
  let gaps = col.gaps | st.gaps;
  const shapeLines = st.shape?.lines ?? FALLBACK.filter((c) => reader.facts(c).length).map((id) => ({ id, depth: 0, preferredLabel: undefined as string | undefined }));
  if (!st.shape) gaps |= Gap.LINKBASE;

  const lines: StmtLine[] = [];
  const raws: (number | null)[] = [];
  const pos = new Map<string, number>();
  const q4Parts = col.kind === "Q4D" ? col.segments.flatMap((s) => s.parts) : null;
  for (const l of shapeLines) {
    const cell: CellValue =
      q4Parts && q4Parts.length === 2 && REVENUE_ALIAS_CONCEPTS.includes(canonical(l.id))
        ? await reader.value(l.id, col, q4RevenueFallback(reader, l.id, q4Parts[0], q4Parts[1]))
        : await reader.value(l.id, col);
    gaps |= cell.gaps;
    pos.set(l.id, lines.length);
    const label = labelOf(l.id, l.preferredLabel, labelSrc.labels, reader);
    if (!labelsOut.has(l.id)) labelsOut.set(l.id, label);
    lines.push({ id: l.id, label, parent: null, w: 0, role: null, v: cell.v, ...(cell.why ? { why: cell.why } : {}), ...(cell.inputs ? { inputs: cell.inputs } : {}), ...(cell.note ? { note: cell.note } : {}) });
    raws.push(cell.raw);
  }
  // 계산 부모·가중치
  for (const ln of lines) {
    const par = st.parents.get(ln.id);
    if (!par) continue;
    const pi = pos.get(par.parent);
    if (pi == null) continue;
    ln.parent = pi;
    ln.w = par.w < 0 ? -1 : 1;
  }
  // 역할 — 표준 개념(IFRS 는 대응 개념)으로, 같은 역할은 표시 순서상 첫 줄만
  const taken = new Set<LineRole>();
  for (const ln of lines) {
    const r = ROLE[canonical(ln.id)];
    if (r && !taken.has(r)) { ln.role = r; taken.add(r); }
  }
  // 표준 매출 개념이 하나도 없는 본표(회사 고유 태그 — XOM 2018 이전 xom:TotalRevenuesAndOtherIncome) — 계산 구조로 찾는다:
  // 자식이 "영업 매출 줄 1개(표시 순서상 앞) + 지분법·기타수익 줄"인 합계 줄 = 총수익
  if (!lines.some((l) => l.role?.startsWith("revenue")))
    for (let i = 0; i < lines.length; i++) {
      const kids = lines.map((k, j) => ({ k, j })).filter(({ k }) => k.parent === i);
      const non = kids.filter(({ k }) => NONOP_CONCEPT.test(k.id.split(":").pop() ?? ""));
      const ops = kids.filter(({ k }) => !NONOP_CONCEPT.test(k.id.split(":").pop() ?? ""));
      if (non.length && ops.length === 1 && ops[0].j < i && !lines[i].role && !ops[0].k.role) {
        lines[i].role = "revenue.total";
        ops[0].k.role = "revenue";
        break;
      }
    }
  const totalIdx = lines.findIndex((l) => l.role === "revenue.total");
  if (totalIdx >= 0)
    for (const ln of lines)
      if (ln.parent === totalIdx && !ln.role && NONOP_CONCEPT.test(ln.id.split(":").pop() ?? "")) ln.role = "revenue.nonop";
  // XOM 형 — 총수익 한 줄을 제품·서비스 차원으로 나눠 비영업 멤버를 공시(차원이라 본표 줄로는 안 보임)
  // 구성 공시마다: 차원 멤버 합, 그 공시가 차원 대신 본표 줄(고객계약 매출)로 나눴으면 총수익 − 고객계약 매출(같은 정의).
  // 값을 못 구한 열도 줄은 남긴다(v null) — 3층이 총수익으로 조용히 대체하지 않게.
  if (opts.dimSplit && totalIdx >= 0 && !lines.some((l) => l.role === "revenue.nonop" || l.role === "revenue")) {
    const totalId = lines[totalIdx].id;
    const nonopOf = async (p: Part): Promise<PartRead | null | "gap"> => {
      const d = await reader.dimSum(totalId, "ProductOrServiceAxis", (m) => NONOP_MEMBER.test(m), p);
      if (d !== null) return d;
      const t = await reader.partValue(totalId, p);
      const c = await reader.partValue("us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", p);
      return t && t !== "gap" && c && c !== "gap" ? { val: t.val - c.val, leaves: [{ rv: t, op: 1 }, { rv: c, op: -1 }] } : null;
    };
    const cell = await reader.value(totalId, col, nonopOf);
    gaps |= cell.gaps;
    {
      if (!labelsOut.has(SYN_NONOP_DIMS)) labelsOut.set(SYN_NONOP_DIMS, "(총수익 중 지분법·기타수익 — 제품·서비스 차원 멤버 또는 총수익 − 고객계약 매출)");
      lines.splice(totalIdx + 1, 0, { id: SYN_NONOP_DIMS, label: labelsOut.get(SYN_NONOP_DIMS)!, parent: totalIdx, w: 1, role: "revenue.nonop", v: cell.v, ...(cell.why ? { why: cell.why } : {}), ...(cell.inputs ? { inputs: cell.inputs } : {}) });
      raws.splice(totalIdx + 1, 0, null); // 차원 멤버는 본표 계산 구조 밖 — 항등식에 넣지 않는다
      for (const ln of lines) if (ln.parent != null && ln.parent > totalIdx && ln.id !== SYN_NONOP_DIMS) ln.parent += 1;
    }
  }

  // 매출원가 줄 — 본표 계산 구조(매출총이익 식)로, 없으면 그 공시 자체 라벨로(identifyCogs)
  const own = sp.accn && st.shape ? await reader.structure(sp.accn, true) : null;
  const ownLabel = (l: StmtLine): string | null => {
    const m = own?.labels?.get(l.id);
    if (!m) return null;
    const pl = st.shape?.lines.find((x) => x.id === l.id)?.preferredLabel;
    return (pl && m.get(pl)) || ([...m.entries()].find(([r]) => /terseLabel$/i.test(r))?.[1] ?? m.get("http://www.xbrl.org/2003/role/label") ?? [...m.values()][0]);
  };
  const cogsId: { by: AssembledIs["cogsBy"]; why?: string } = st.shape ? identifyCogs(lines, st.sums as Sums, ownLabel) : { by: null, why: "본표 구조 판독 실패(Gap.LINKBASE)" };
  // 파생 열(Q4·누적 차·LTM)의 구성 공시가 구조 기준 공시와 다른 개념으로 원가 줄을 달았으면(LRCX 10-K 는 구조조정 포함 매출원가
  // 소계, 10-Q 는 그 소계 없이 "Cost of goods sold" 회사 고유 개념이 매출총이익 식의 원가 항) — 그 구성 공시 **자체 본표의 매출총이익
  // 식 원가 항**(한 줄, 식의 더하는 항이 매출일 때만)을 읽는다. 각 공시의 본표 매출원가끼리 빼는 것이라 오너 결정(본표 원가 = 매출총이익
  // 식의 빼는 항)과 같은 기준이다. 읽은 사실은 파생값 입력에 그대로 남는다(개념이 달라 f: 참조).
  const cogsLine = lines.find((l) => l.role === "cogs");
  if (cogsLine && cogsLine.v == null && col.segments.some((sg) => sg.parts.length > 1)) {
    const faceCogsOf = async (p: Part): Promise<PartRead | null | "gap"> => {
      const d = await reader.partValue(cogsLine.id, p);
      if (d === "gap") return "gap";
      if (d) return asPartRead(d);
      if (!p.accn) return null;
      const ps = await reader.structure(p.accn);
      const gpId = ps.shape?.lines.find((x) => ROLE[canonical(x.id)] === "gross")?.id;
      const ts = gpId ? (ps.sums.get(gpId) ?? []) : [];
      const neg = ts.filter((t) => t.w < 0);
      if (neg.length !== 1 || !ts.some((t) => t.w > 0 && REVENUE_CANON.has(canonical(t.to)))) return null;
      return asPartRead(await reader.partValue(neg[0].to, p));
    };
    const cv = await reader.value(cogsLine.id, col, faceCogsOf);
    if (cv.v != null) {
      const i = lines.indexOf(cogsLine);
      lines[i] = { ...cogsLine, v: cv.v, ...(cv.why ? { why: cv.why } : {}), ...(cv.inputs ? { inputs: cv.inputs } : {}) };
      raws[i] = cv.raw;
    }
  }

  // 판관비·연구개발비 줄 — 본표 영업이익 식(없으면 세전이익 식)의 판관비·연구개발비 성격 줄(identifySgaRnd, docs/metrics/sga.md §1).
  // 유형 D 매출원가 구성 항 개념은 판관비로 세지 않는다(원가와 겹치지 않게)
  const cogsConcepts = new Set((opts.cogsTerms ?? []).flatMap((t) => t.concepts.flatMap((c) => ([] as string[]).concat(c))).map((id) => DIM_TERM.exec(id)?.[1] ?? id));
  const opx = st.shape ? await identifySgaRnd(reader, col, sp, lines, st.sums as Sums, ownLabel, opts.sgaHint, cogsConcepts) : undefined;

  // 항등식 — 계산 구조의 합계식마다 부모 = Σ 가중치 × 항(원통화 값, 공시 반올림 단위 × 항 수 허용). 값 없는 항은 0.
  // 표시 부모(ln.parent)가 아니라 합계식 전체(st.sums)로 판정한다 — 한 줄이 둘 이상 식의 항일 수 있다(AMD 매출원가 세부 줄).
  // 불성립 식은 다음 중 하나면 "판정 불완전(partial)" — 식 자체를 믿을 수 없어 값 섞임의 증거가 아니다(3층은 매출을 비우지 않고
  // "항등식 미검증"으로 표시, 검증기가 SEC 직접 대조를 강제):
  //  ① 값 없는 항(그 열 공시에 그 줄이 없음 — WDC 10-K 분기 요약표) ② 표시 줄에 없는 항(ORCL 2020 10-K — 부문 조정 항이 같은 역할에 섞임)
  //  ③ 둘 이상 식의 항인 줄(TSLA 2018 — 매출 합계와 자동차 매출 합계 양쪽에 고객계약 매출이 걸림: 본표 칸은 차원 값인데 무차원 값을 읽음)
  //  ④ 열 안에 어느 식에도 속하지 않는 값 있는 줄(계산 구조가 표시 구조를 다 덮지 않음)
  //  ⑤ 파생 열(Q4·누적 차·LTM)의 다른 구성 공시에서 그 식의 항 구성이 다름(SBUX 2021Q4 — 10-Q 에서는 처분손익이 영업이익 밖)
  const at = new Map(lines.map((l, i) => [l.id, i] as const));
  const sums = new Map<string, { to: string; w: number }[]>([...(st.sums as Map<string, { to: string; w: number }[]>)].filter(([p]) => at.has(p) && !p.startsWith("syn:")));
  // 부모 줄이 식을 이루는가(항 중 값 있는 줄이 하나라도 있어야 검사가 성립)
  const termsValued = (i: number) => (sums.get(lines[i].id) ?? []).some((t) => at.has(t.to) && raws[at.get(t.to)!] != null);
  const termOf = new Map<string, number>(); // 줄 → 값 있는 부모 식 수
  for (const [p, ts] of sums) if (raws[at.get(p)!] != null) for (const t of ts) termOf.set(t.to, (termOf.get(t.to) ?? 0) + 1);
  // 어느 식에도 속하지 않는 값 있는 줄(계산 구조가 없으면 값 있는 줄 전부) — 3층은 매출 줄이 여기 있으면 "항등식 미검증"
  const uncovered = lines.map((l, i) => i).filter((i) => raws[i] != null && !lines[i].id.startsWith("syn:") && !(sums.has(lines[i].id) && termsValued(i)) && !termOf.has(lines[i].id));
  const orphans = sums.size ? uncovered.map((i) => lines[i].id) : [];
  const partsAll = col.segments.flatMap((s) => s.parts);
  const otherAccns = [...new Set(partsAll.map((p) => p.accn).filter((x): x is string => !!x && x !== sp.accn))];
  const fails: string[] = [];
  const failAt: number[] = [];
  const failPartial: boolean[] = [];
  const failTerms: number[][] = [];
  for (const [p, ts] of sums) {
    const i = at.get(p)!;
    if (raws[i] == null) continue;
    const inLines = ts.filter((t) => at.has(t.to));
    const valued = inLines.filter((t) => raws[at.get(t.to)!] != null);
    if (!valued.length) continue;
    const sum = valued.reduce((s, t) => s + (t.w < 0 ? -1 : 1) * (raws[at.get(t.to)!] as number), 0);
    const unit = roundingUnit([raws[i] as number, ...valued.map((t) => raws[at.get(t.to)!] as number)]);
    const tol = unit * (valued.length + 1) * partsAll.length;
    if (Math.abs((raws[i] as number) - sum) <= tol) continue;
    const why: string[] = [];
    if (inLines.length > valued.length) why.push(`값 없는 항 ${inLines.length - valued.length}개`);
    if (ts.length > inLines.length) why.push(`표시 줄에 없는 항 ${ts.length - inLines.length}개(${ts.filter((t) => !at.has(t.to)).map((t) => t.to).join(",")})`);
    const multi = inLines.filter((t) => (termOf.get(t.to) ?? 0) > 1).map((t) => t.to);
    if (multi.length) why.push(`둘 이상 식의 항 ${multi.join(",")}`);
    if (orphans.length) why.push(`식 밖 값 있는 줄 ${orphans.length}개(${orphans.slice(0, 3).join(",")}${orphans.length > 3 ? "…" : ""})`);
    for (const oa of otherAccns) {
      const o = await reader.structure(oa);
      const ot = o.sums.get(p);
      const key = (xs: { to: string; w: number }[]) => xs.map((t) => `${t.to}${t.w < 0 ? "-" : "+"}`).sort().join("|");
      if (!ot || key(ot) !== key(ts)) { why.push(`구성 공시 ${oa} 의 식 항 구성이 다름`); break; }
    }
    fails.push(`${p}: ${raws[i]} ≠ Σ ${sum}${why.length ? ` (판정 불완전 — ${why.join("; ")})` : ""}`);
    failAt.push(i);
    failPartial.push(why.length > 0);
    failTerms.push(inLines.map((t) => at.get(t.to)!));
  }
  if (fails.length) gaps |= Gap.IDENTITY;

  // 유형 D 매출원가 구성 항 — 항등식 밖(3층 cogs.ts 가 합한다)
  let cogsTerms: AssembledIs["cogsTerms"];
  if (opts.cogsTerms) {
    const r = await readCogsTerms(reader, col, opts.cogsTerms);
    cogsTerms = r.out;
    gaps |= r.gaps;
  }

  const parts = partsAll;
  const column: Column = {
    key: col.key, kind: col.kind, fy: col.fy, fq: col.fq, start: col.start, end: col.end,
    src: parts.length === 1 && !col.yahoo ? provOf(parts[0]) : col.yahoo ? { accn: null, form: "YAHOO-Q", filed: null, source: "yahoo" } : parts.map(provOf),
    gaps,
  };
  if (col.yahoo) {
    const w = reader.yahooWindow(col);
    if (w) { column.start = w.start; column.end = w.end; }
  }
  return {
    col: column, lines, identity: { ok: fails.length === 0, fails, at: failAt, partial: failPartial, terms: failTerms, uncovered },
    cogsBy: cogsId.by, ...(cogsId.why ? { cogsWhy: cogsId.why } : {}), faceShape: !!st.shape,
    ...(cogsTerms ? { cogsTerms } : {}),
    ...(opx ? { opx } : {}),
  };
}

/** 차원 줄 후보 "개념[축=멤버]"(축·멤버는 네임스페이스 없는 이름 — 1층 사실 dims 와 같은 표기) */
const DIM_TERM = /^([^[]+)\[([^=\]]+)=([^\]]+)\]$/;

/**
 * 유형 D 매출원가 구성 항(metrics/cogs-rules.ts)의 열 값 — 구성 공시마다 **그 공시 본표(_pre)에 있는** 첫 후보 개념을 읽는다(후보가
 * 배열이면 그 줄들의 합, "개념[축=멤버]" 는 차원 값). 열 구조 공시의 줄 id 로만 찾으면 파생 열(Q4 = 10-K − 9개월, LTM)에서 10-K 와
 * 10-Q 의 개념 이름이 다른 회사(MCD 직영점 비용·가맹점 임차, DAL 부대사업)가 빈칸이 된다. optional 항은 본표에 없거나 값이 없으면 0.
 *
 * 파생 열의 기준 혼합 판정(리드 결정 2026-09-27 — "한 열 = 한 기준", 기준은 **합 동일성**):
 *  ① 후보 합 동일성 — 열 안에서 후보가 바뀌었으면(MCD 3줄 ↔ 1줄, ORCL·HLT 개명, DAL 부대사업 분할) 두 후보가 모두 공시된 같은 기간의
 *     합을 비교한다. 하나라도 반올림 단위 밖으로 다르면 재분류(DAL 2026 10-Q — 일부가 기타로 이동) → 혼합. 같거나 비교할 기간이 없으면 유지.
 *  ② 재작성 혼합 — 구성 공시 p 의 기간을 다른 구성 공시 r 의 시점(r 제출일 이전)에 공시한 가장 최근 공시 q 가 있으면 q 기준 항 합과
 *     비교한다(LTM 의 전년 동기 누적을 최신 10-Q 가 재작성해 사업연도(10-K)와 기준이 달라진 경우 — DAL·MAR 2026 10-Q).
 *  혼합이면 v null + mix 사유(3층이 빈칸 + "구성 공시 간 원가 항목 재분류 — 기준 혼합"). 그림자 채우기(다른 기준 값으로 대체)는 하지 않는다.
 */
async function readCogsTerms(reader: UsReader, col: ColumnSpec, terms: CogsTerm[]): Promise<{ out: NonNullable<AssembledIs["cogsTerms"]>; gaps: number }> {
  const out: NonNullable<AssembledIs["cogsTerms"]> = [];
  let gaps = 0;
  const cur = reader.profile.reportingCurrency;
  const parts = col.segments.flatMap((sg) => sg.parts);
  const ids = (alt: string | string[]) => ([] as string[]).concat(alt);
  const base = (id: string) => DIM_TERM.exec(id)?.[1] ?? id;
  const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 3 * 864e5; // 1층 period.near 와 같은 ±3일(1층 모듈은 import 금지 — S4)
  /** 공시 p 기준 항 값 — 그 공시 본표에 있는 첫 후보(alt = 후보 키, 본표에 없는 optional 항은 alt null) */
  const readAt = async (t: CogsTerm, p: Part): Promise<{ alt: string | null; r: PartRead | null | "gap" }> => {
    if (!p.accn) return { alt: null, r: null };
    const face = new Set((await reader.structure(p.accn)).shape?.lines.map((l) => l.id) ?? []);
    for (const alt of t.concepts) {
      const xs = ids(alt);
      if (!xs.every((id) => face.has(base(id)))) continue;
      const r: PartRead = { val: 0, leaves: [] };
      for (const id of xs) {
        const m = DIM_TERM.exec(id);
        const x = m ? await reader.dimSum(m[1], m[2], (v) => v === m[3], p) : asPartRead(await reader.partValue(id, p));
        if (x === "gap") return { alt: xs.join("+"), r: "gap" };
        if (x == null) {
          if (t.optional) continue;
          return { alt: xs.join("+"), r: null };
        }
        r.val += x.val;
        r.leaves.push(...x.leaves);
      }
      return { alt: xs.join("+"), r };
    }
    return { alt: null, r: t.optional ? { val: 0, leaves: [] } : null };
  };
  /** 반올림 허용 — 두 값 각자의 공시 단위 중 큰 쪽 × 항 줄 수 */
  const tolOf = (a: number, b: number, n: number) => Math.max(roundingUnit([a]), roundingUnit([b])) * Math.max(n, 1);
  /** 무차원 후보의 기간별 합(공시별) — 후보의 모든 줄이 같은 공시·기간에 있을 때만 */
  const altSums = (alt: string): Map<string, number> => {
    const xs = alt.split("+");
    if (xs.some((id) => DIM_TERM.test(id))) return new Map();
    const by = new Map<string, { n: number; v: number }>();
    for (const id of xs)
      for (const f of reader.facts(id)) {
        if (f.unit !== cur || Object.keys(f.dims).length || !f.start || !f.prov.accn) continue;
        const k = `${f.start}|${f.end}|${f.prov.accn}`;
        const e = by.get(k) ?? { n: 0, v: 0 };
        by.set(k, { n: e.n + 1, v: e.v + f.val });
      }
    const out = new Map<string, number>(); // "start|end|accn" → 그 공시의 후보 합
    for (const [k, e] of by) if (e.n === xs.length) out.set(k, e.v);
    return out;
  };

  for (const [k, t] of terms.entries()) {
    const used = new Set<string>();
    const chosen = new Set<string>(); // 구성 공시마다 고른 후보 — 둘 이상이면 열 안에서 개념이 바뀐 것
    const at = new Map<Part, number>(); // 구성 공시별 읽은 값(② 비교용)
    const get = async (p: Part): Promise<PartRead | null | "gap"> => {
      const { alt, r } = await readAt(t, p);
      if (alt) chosen.add(alt);
      if (r && r !== "gap") {
        at.set(p, r.val);
        for (const l of r.leaves) if (l.rv.prov.concept) used.add(l.rv.prov.concept);
      }
      return r;
    };
    // 가상 개념 이름 — 읽은 사실이 모두 "다른 사실"로 잡혀 입력이 늘 남는다(단일 공시 열도 f: 참조, derived.ts 가 칸 참조로 압축)
    const cell = await reader.value(`syn:cogs.term:${t.group ?? k}`, col, get);
    gaps |= cell.gaps;
    let mix: string | undefined;
    // ① 후보 합 동일성
    if (cell.v != null && chosen.size > 1) {
      const alts = [...chosen], sums = alts.map(altSums);
      for (let i = 0; i < alts.length && !mix; i++)
        for (let j = i + 1; j < alts.length && !mix; j++) {
          const pi = new Map([...sums[i]].map(([kk, v]) => [kk.split("|").slice(0, 2).join("|"), v]));
          for (const [kk, v] of sums[j]) {
            const per = kk.split("|").slice(0, 2).join("|"), w = pi.get(per);
            if (w == null) continue;
            if (Math.abs(v - w) > tolOf(v, w, alts[i].split("+").length + alts[j].split("+").length))
              mix = `${t.group ?? k}: ${alts[i]} ${w} ≠ ${alts[j]} ${v}(${per.replace("|", "~")})`;
          }
        }
    }
    // ② 재작성 혼합
    if (cell.v != null && !mix && new Set(parts.map((p) => p.accn)).size > 1) {
      const reporters = ["us-gaap:Revenues", "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", "us-gaap:OperatingIncomeLoss", "us-gaap:CostsAndExpenses", ...t.concepts.flatMap(ids).map(base)];
      const facts = reporters.flatMap((c) => reader.facts(c));
      for (const p of parts) {
        if (mix || !at.has(p)) continue;
        for (const r of parts) {
          if (mix || r.accn === p.accn || !r.filed) continue;
          const q = facts
            .filter((f) => f.prov.accn && f.prov.accn !== p.accn && f.prov.filed && f.prov.filed <= r.filed! && f.start && near(f.start, p.start) && near(f.end, p.end))
            .sort((x, y) => (y.prov.filed ?? "").localeCompare(x.prov.filed ?? ""))[0];
          if (!q) continue;
          const qr = await readAt(t, { start: p.start, end: p.end, accn: q.prov.accn, form: q.prov.form, filed: q.prov.filed, sign: 1 });
          if (!qr.r || qr.r === "gap") continue;
          const v = at.get(p)!;
          if (Math.abs(v - qr.r.val) > tolOf(v, qr.r.val, ids(t.concepts[0]).length))
            mix = `${t.group ?? k}: ${p.start}~${p.end} ${p.accn} ${v} ≠ ${q.prov.accn} ${qr.r.val}(재작성)`;
        }
      }
    }
    out.push({
      group: t.group ?? String(k), sign: t.sign, v: mix ? null : cell.v, inputs: mix ? [] : (cell.inputs ?? []),
      concepts: [...used].map(base), alts: [...chosen], ...(mix ? { mix } : {}),
    });
  }
  return { out, gaps };
}

/** 연간·분기(+Q4D)·LTM 열을 조립한다. LTM 은 연간·분기 목록 끝에 각각 붙는다(같은 값). */
/** cogsTerms = 유형 D 매출원가 구성 규칙 항(3층 metrics/cogs-rules.ts — 호출부 index.ts 가 넘긴다, 2층은 3층을 import 하지 않음) */
/** sgaHint = 판관비·연구개발비 회사별 지정(3층 metrics/sga-rules.ts — 같은 방식으로 index.ts 가 넘긴다) */
export async function assembleIncomeStatements(reader: UsReader, n: { annual: number; quarterly: number } = { annual: 10, quarterly: 20 }, cogsTerms?: CogsTerm[], sgaHint?: SgaHint): Promise<AssembledStatements> {
  const annualCols = await reader.annualCols(n.annual);
  const allQ = await reader.quarterCols(1000);
  const quarterCols = allQ.slice(-n.quarterly);
  const ltm = await reader.ltmCol(allQ);
  const labels = new Map<string, string>();
  const dimSplit = noOpIncomeTag(reader);
  const lastA = annualCols[annualCols.length - 1];
  const lastQ = quarterCols[quarterCols.length - 1];
  const labA = lastA ? await reader.structure(structureAccn(lastA).accn ?? "", true) : { shape: null, parents: new Map(), sums: new Map(), labels: null, gaps: 0 };
  const labQ = lastQ && structureAccn(lastQ).accn ? await reader.structure(structureAccn(lastQ).accn!, true) : labA;
  const annual: AssembledIs[] = [];
  for (const c of annualCols) annual.push(await assembleColumn(reader, c, labA, labels, { dimSplit, cogsTerms, sgaHint }));
  const quarterly: AssembledIs[] = [];
  for (const c of quarterCols) quarterly.push(await assembleColumn(reader, c, labQ, labels, { dimSplit, cogsTerms, sgaHint }));
  if (ltm) {
    const l = await assembleColumn(reader, ltm, labQ.labels ? labQ : labA, labels, { dimSplit, cogsTerms, sgaHint });
    annual.push(l);
    quarterly.push(l);
  }
  return { annual, quarterly, labels };
}
