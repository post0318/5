import "server-only";
import { Gap, type AssembledIs, type Column, type LineRole, type Prov, type StmtLine } from "../types";
import { canonical, type CellValue, type ColumnSpec, type FilingStructure, type Part, type UsReader } from "../read";

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
  "us-gaap:CostOfRevenue": "cogs",
  "us-gaap:CostOfGoodsAndServicesSold": "cogs",
  "us-gaap:CostOfGoodsSold": "cogs",
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
 * Q4D 매출 줄 폴백 — 9개월 누적 공시가 사업연도(10-K) 공시와 다른 매출 개념으로 재태깅된 회사(CEG: 10-K
 * "Operating revenues" = RevenueFromContractWithCustomerIncludingAssessedTax, 같은 줄의 10-Q 태그는
 * us-gaap:Revenues) 는 사업연도 부분만 값이 잡히고 9개월 부분이 항상 "gap"이라 Q4 매출이 통째로 빈칸이 됐다.
 * 정상 개념으로 못 읽으면(9개월 부분만), 사업연도 값을 정확히 같은 금액으로 공시한 다른 매출 계열 개념이
 * **어느 정기공시에서든**(판본 무관 — GOOG: 최신 10-K 는 옛 개념이 아예 사라지고 새 개념으로만 재태깅해
 * 같은 공시 안에서는 두 개념이 공존하지 않는다. 옛 10-K(2024-01-31·2025-02-05)에 그 옛 개념·같은 금액이
 * 남아 있는 것을 증거로 삼는다) 있었는지 확인해(같은 줄이라는 근거, 증거 공시 accn 은 경고로 남긴다) 그
 * 개념으로 9개월 값을 대신 읽는다 — 값이 우연히 같은 다른 지표를 섞지 않도록 매출 계열 개념끼리만 비교한다.
 */
const REVENUE_ALIAS_CONCEPTS = [
  "us-gaap:Revenues",
  "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax",
  "us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax",
  "us-gaap:RevenuesNetOfInterestExpense",
];

function q4RevenueFallback(reader: UsReader, qname: string, fyPart: Part, ninePart: Part) {
  return async (p: Part): Promise<number | null | "gap"> => {
    const direct = await reader.partValue(qname, p);
    if (direct === "gap") return "gap";
    if (direct !== null) return direct.val;
    if (p !== ninePart) return null; // 사업연도 부분은 폴백 대상 아님 — 구조 기준 개념 그대로
    const fyDirect = await reader.partValue(qname, fyPart);
    if (fyDirect === null || fyDirect === "gap") return null;
    for (const alt of REVENUE_ALIAS_CONCEPTS) {
      if (alt === qname) continue;
      // 같은 줄이라는 증거(1층 — reader.aliasEvidenceAccn) 없으면 대체하지 않는다: 기존대로 공란
      const evidenceAccn = reader.aliasEvidenceAccn(alt, fyPart.start, fyPart.end, fyDirect.val);
      if (!evidenceAccn) continue;
      const altNine = await reader.partValue(alt, ninePart);
      if (altNine === null || altNine === "gap") continue;
      reader.warnings.push(
        `Q4 매출 폴백: ${qname}(9개월 부분 없음) → ${alt} 대체(사업연도 값 증거 공시 ${evidenceAccn}, 9개월 원본 ${ninePart.accn ?? "?"})`,
      );
      return altNine.val;
    }
    return null;
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
  opts: { dimSplit: boolean },
): Promise<AssembledIs> {
  const sp = structureAccn(col);
  const st = sp.accn ? await reader.structure(sp.accn) : { shape: null, parents: new Map(), labels: null, gaps: Gap.LINKBASE };
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
    lines.push({ id: l.id, label, parent: null, w: 0, role: null, v: cell.v, ...(cell.why ? { why: cell.why } : {}) });
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
    const nonopOf = async (p: Part): Promise<number | null | "gap"> => {
      const d = await reader.dimSum(totalId, "ProductOrServiceAxis", (m) => NONOP_MEMBER.test(m), p);
      if (d !== null) return d;
      const t = await reader.partValue(totalId, p);
      const c = await reader.partValue("us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", p);
      return t && t !== "gap" && c && c !== "gap" ? t.val - c.val : null;
    };
    const cell = await reader.value(totalId, col, nonopOf);
    gaps |= cell.gaps;
    {
      if (!labelsOut.has(SYN_NONOP_DIMS)) labelsOut.set(SYN_NONOP_DIMS, "(총수익 중 지분법·기타수익 — 제품·서비스 차원 멤버 또는 총수익 − 고객계약 매출)");
      lines.splice(totalIdx + 1, 0, { id: SYN_NONOP_DIMS, label: labelsOut.get(SYN_NONOP_DIMS)!, parent: totalIdx, w: 1, role: "revenue.nonop", v: cell.v, ...(cell.why ? { why: cell.why } : {}) });
      raws.splice(totalIdx + 1, 0, null); // 차원 멤버는 본표 계산 구조 밖 — 항등식에 넣지 않는다
      for (const ln of lines) if (ln.parent != null && ln.parent > totalIdx && ln.id !== SYN_NONOP_DIMS) ln.parent += 1;
    }
  }

  // 항등식 — 부모 = Σ 가중치 × 자식(원통화 값, 공시 반올림 단위 × 항 수 허용). 자식 값이 없으면 0
  const fails: string[] = [];
  lines.forEach((ln, i) => {
    if (raws[i] == null || ln.id.startsWith("syn:")) return;
    const kids = lines.map((k, j) => ({ k, j })).filter(({ k, j }) => k.parent === i && raws[j] != null && !k.id.startsWith("syn:"));
    if (!kids.length) return;
    const sum = kids.reduce((s, { k, j }) => s + k.w * (raws[j] as number), 0);
    const unit = roundingUnit([raws[i] as number, ...kids.map(({ j }) => raws[j] as number)]);
    const tol = unit * (kids.length + 1) * (col.segments.flatMap((s) => s.parts).length);
    if (Math.abs((raws[i] as number) - sum) > tol) fails.push(`${ln.id}: ${raws[i]} ≠ Σ ${sum}`);
  });
  if (fails.length) gaps |= Gap.IDENTITY;

  const parts = col.segments.flatMap((s) => s.parts);
  const column: Column = {
    key: col.key, kind: col.kind, fy: col.fy, fq: col.fq, start: col.start, end: col.end,
    src: parts.length === 1 && !col.yahoo ? provOf(parts[0]) : col.yahoo ? { accn: null, form: "YAHOO-Q", filed: null, source: "yahoo" } : parts.map(provOf),
    gaps,
  };
  if (col.yahoo) {
    const w = reader.yahooWindow(col);
    if (w) { column.start = w.start; column.end = w.end; }
  }
  return { col: column, lines, identity: { ok: fails.length === 0, fails } };
}

/** 연간·분기(+Q4D)·LTM 열을 조립한다. LTM 은 연간·분기 목록 끝에 각각 붙는다(같은 값). */
export async function assembleIncomeStatements(reader: UsReader, n: { annual: number; quarterly: number } = { annual: 10, quarterly: 20 }): Promise<AssembledStatements> {
  const annualCols = reader.annualCols(n.annual);
  const allQ = reader.quarterCols(1000);
  const quarterCols = allQ.slice(-n.quarterly);
  const ltm = reader.ltmCol(allQ);
  const labels = new Map<string, string>();
  const dimSplit = noOpIncomeTag(reader);
  const lastA = annualCols[annualCols.length - 1];
  const lastQ = quarterCols[quarterCols.length - 1];
  const labA = lastA ? await reader.structure(structureAccn(lastA).accn ?? "", true) : { shape: null, parents: new Map(), labels: null, gaps: 0 };
  const labQ = lastQ && structureAccn(lastQ).accn ? await reader.structure(structureAccn(lastQ).accn!, true) : labA;
  const annual: AssembledIs[] = [];
  for (const c of annualCols) annual.push(await assembleColumn(reader, c, labA, labels, { dimSplit }));
  const quarterly: AssembledIs[] = [];
  for (const c of quarterCols) quarterly.push(await assembleColumn(reader, c, labQ, labels, { dimSplit }));
  if (ltm) {
    const l = await assembleColumn(reader, ltm, labQ.labels ? labQ : labA, labels, { dimSplit });
    annual.push(l);
    quarterly.push(l);
  }
  return { annual, quarterly, labels };
}
