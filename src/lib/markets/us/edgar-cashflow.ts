import "server-only";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import type { FinancialStatement, FinancialLineItem, FinancialPeriod } from "../types";
import { recentQuarters, singleQuarter } from "./edgar-series";

/**
 * 미국 상세 현금흐름표 — SEC EDGAR companyfacts 를 정규화 라인으로 재분류.
 * 컬럼: 최근 8개 사업연도 + 최근 12개월(LTM, 누적법). 한글 표준 라벨.
 * "기타" 라인은 (구간 합계 − 매핑된 라인 합)으로 자동 계산 → 총계 정합.
 */

const ANNUAL_FORMS = ["10-K", "10-K/A", "20-F", "20-F/A"];
const INTERIM_FORMS = ["10-Q", "10-Q/A"];

function days(a: string, b: string) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}
function shiftYear(iso: string, n: number) {
  const [y, m, d] = iso.split("-");
  return `${Number(y) + n}-${m}-${d}`;
}
function entriesOf(facts: CompanyFacts, concept: string): FactUnitEntry[] {
  return facts.facts["us-gaap"]?.[concept]?.units?.["USD"] ?? [];
}
function firstConcept(facts: CompanyFacts, concepts: string[]): FactUnitEntry[] {
  for (const c of concepts) {
    const e = entriesOf(facts, c);
    if (e.length) return e;
  }
  return [];
}

/** 사업연도별 duration 값. */
function annualByYear(entries: FactUnitEntry[]): Map<number, number> {
  const m = new Map<number, { val: number; end: string }>();
  for (const e of entries) {
    if (e.fp !== "FY" || !e.start || !ANNUAL_FORMS.includes(e.form)) continue;
    const y = Number(e.end.slice(0, 4));
    const prev = m.get(y);
    if (!prev || e.end > prev.end) m.set(y, { val: e.val, end: e.end });
  }
  return new Map([...m].map(([y, v]) => [y, v.val]));
}

/** 흐름 TTM = 최근 FY + 당기누적 − 전년동기누적. */
function ttmOf(entries: FactUnitEntry[]): number | null {
  const annuals = entries
    .filter((e) => e.fp === "FY" && e.start && ANNUAL_FORMS.includes(e.form))
    .sort((a, b) => b.end.localeCompare(a.end));
  const fy = annuals[0];
  if (!fy?.start) return null;
  const interims = entries.filter((e) => e.start && INTERIM_FORMS.includes(e.form));
  const cur = interims
    .filter((e) => Math.abs(days(fy.end, e.start!)) <= 12 && e.end > fy.end)
    .sort((a, b) => b.end.localeCompare(a.end))[0];
  if (!cur?.start) return fy.val;
  const wS = shiftYear(cur.start, -1);
  const wE = shiftYear(cur.end, -1);
  const prior = interims
    .filter(
      (e) =>
        e.start &&
        Math.abs(days(wS, e.start)) <= 12 &&
        Math.abs(days(wE, e.end)) <= 12,
    )
    .sort((a, b) => Math.abs(days(wE, a.end)) - Math.abs(days(wE, b.end)))[0];
  if (!prior) return fy.val;
  return fy.val + cur.val - prior.val;
}

interface Line {
  label: string;
  concepts?: string[];
  depth: number;
  kind?: "item" | "subtotal" | "total";
  /** 부호 반전: EDGAR 가 자산 증가(현금 유출)를 양수로 보고 → 현금영향 부호로 */
  negate?: boolean;
  /** 여러 개념 합산 (각 [concept, negate]) */
  combine?: [string, boolean][];
  /** (구간 총계 − 이 앞의 형제 라인 합)으로 계산되는 잔여 라인 */
  plug?: boolean;
}

interface Block {
  title: string;
  total: { label: string; concepts: string[] };
  lines: Line[];
}

const BLOCKS: Block[] = [
  {
    title: "영업활동 현금흐름",
    total: {
      label: "영업활동으로 인한 현금흐름",
      concepts: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
    },
    lines: [
      { label: "당기순이익", concepts: ["NetIncomeLoss", "ProfitLoss"], depth: 1 },
      {
        label: "감가상각비·무형자산상각비",
        concepts: ["DepreciationDepletionAndAmortization", "DepreciationAmortizationAndAccretionNet", "DepreciationAndAmortization"],
        depth: 1,
      },
      { label: "주식보상비용", concepts: ["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"], depth: 1 },
      {
        label: "기타 비현금 조정",
        depth: 1,
        combine: [
          ["OtherNoncashIncomeExpense", false],
          ["DeferredIncomeTaxExpenseBenefit", false],
          ["DeferredIncomeTaxesAndTaxCredits", false],
          ["IncreaseDecreaseInOtherOperatingAssets", true],
          ["IncreaseDecreaseInOtherOperatingLiabilities", false],
          ["IncreaseDecreaseInOtherReceivables", true],
        ],
      },
      { label: "운전자본 변동", depth: 1, kind: "subtotal" },
      { label: "매출채권 증감", concepts: ["IncreaseDecreaseInAccountsReceivable"], depth: 2, negate: true },
      { label: "재고자산 증감", concepts: ["IncreaseDecreaseInInventories"], depth: 2, negate: true },
      { label: "매입채무 증감", concepts: ["IncreaseDecreaseInAccountsPayable", "IncreaseDecreaseInAccountsPayableTrade"], depth: 2 },
      { label: "기타 영업활동", depth: 1, plug: true },
    ],
  },
  {
    title: "투자활동 현금흐름",
    total: {
      label: "투자활동으로 인한 현금흐름",
      concepts: ["NetCashProvidedByUsedInInvestingActivities", "NetCashProvidedByUsedInInvestingActivitiesContinuingOperations"],
    },
    lines: [
      { label: "유형자산 취득", concepts: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"], depth: 1, negate: true },
      {
        label: "투자자산 처분·만기",
        depth: 1,
        combine: [
          ["ProceedsFromSaleOfAvailableForSaleSecuritiesDebt", false],
          ["ProceedsFromMaturitiesPrepaymentsAndCallsOfAvailableForSaleSecurities", false],
          ["ProceedsFromSaleMaturityAndCollectionsOfInvestments", false],
        ],
      },
      {
        label: "투자자산 취득",
        depth: 1,
        negate: true,
        combine: [
          ["PaymentsToAcquireAvailableForSaleSecuritiesDebt", false],
          ["PaymentsToAcquireInvestments", false],
        ],
      },
      { label: "사업 인수 (순현금)", concepts: ["PaymentsToAcquireBusinessesNetOfCashAcquired"], depth: 1, negate: true },
      { label: "기타 투자활동", depth: 1, plug: true },
    ],
  },
  {
    title: "재무활동 현금흐름",
    total: {
      label: "재무활동으로 인한 현금흐름",
      concepts: ["NetCashProvidedByUsedInFinancingActivities", "NetCashProvidedByUsedInFinancingActivitiesContinuingOperations"],
    },
    lines: [
      { label: "배당금 지급", concepts: ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"], depth: 1, negate: true },
      { label: "자기주식 취득", concepts: ["PaymentsForRepurchaseOfCommonStock"], depth: 1, negate: true },
      { label: "장기차입금 조달", concepts: ["ProceedsFromIssuanceOfLongTermDebt"], depth: 1 },
      { label: "장기차입금 상환", concepts: ["RepaymentsOfLongTermDebt"], depth: 1, negate: true },
      {
        label: "단기차입금 순증감",
        depth: 1,
        combine: [
          ["ProceedsFromRepaymentsOfShortTermDebtMaturingInThreeMonthsOrLess", false],
          ["ProceedsFromRepaymentsOfShortTermDebtMaturingInMoreThanThreeMonths", false],
          ["ProceedsFromRepaymentsOfCommercialPaper", false],
          ["ProceedsFromRepaymentsOfShortTermDebt", false],
        ],
      },
      { label: "기타 재무활동", depth: 1, plug: true },
    ],
  },
];

const FX = ["EffectOfExchangeRateOnCashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "EffectOfExchangeRateOnCashAndCashEquivalents"];
const NET_CHANGE = [
  "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect",
  "CashAndCashEquivalentsPeriodIncreaseDecrease",
];
const TAX_PAID = ["IncomeTaxesPaidNet", "IncomeTaxesPaid"];
const INT_PAID = ["InterestPaidNet", "InterestPaid"];

const LTM = "현재/LTM";
const fyKey = (y: number) => `${y}Y`;

export function buildUsCashFlow(
  facts: CompanyFacts,
  mode: "annual" | "quarter" = "annual",
): FinancialStatement {
  const opEntries = firstConcept(facts, BLOCKS[0].total.concepts);

  let periods: FinancialPeriod[];
  let valOf: (concepts: string[]) => Record<string, number | null>;

  if (mode === "quarter") {
    const chron = [...recentQuarters(opEntries, 6)].reverse(); // 6개 (0번은 prev 전용)
    periods = chron.slice(-5).map((q) => ({
      label: q.label,
      fiscalYear: Number(q.label.slice(0, 4)),
      fiscalQuarter: Number(q.label.slice(-1)) || null,
      endDate: q.end,
    }));
    valOf = (concepts) => {
      const e = firstConcept(facts, concepts);
      const out: Record<string, number | null> = {};
      chron.forEach((q, i) => {
        if (i > 0) out[q.label] = singleQuarter(e, q, chron[i - 1]);
      });
      return out;
    };
  } else {
    const years = [...annualByYear(opEntries).keys()].sort((a, b) => a - b).slice(-5);
    const opAnnualEnds = new Map<number, string>();
    for (const e of opEntries)
      if (e.fp === "FY" && e.start && ANNUAL_FORMS.includes(e.form))
        opAnnualEnds.set(Number(e.end.slice(0, 4)), e.end);
    periods = years.map((y) => ({
      label: fyKey(y),
      fiscalYear: y,
      fiscalQuarter: null,
      endDate: opAnnualEnds.get(y) ?? `${y}-12-31`,
    }));
    periods.push({
      label: LTM,
      fiscalYear: (years[years.length - 1] ?? new Date().getFullYear()) + 1,
      fiscalQuarter: null,
      endDate: new Date().toISOString().slice(0, 10),
    });
    valOf = (concepts) => {
      const entries = firstConcept(facts, concepts);
      const ann = annualByYear(entries);
      const out: Record<string, number | null> = {};
      for (const y of years) out[fyKey(y)] = ann.get(y) ?? null;
      out[LTM] = ttmOf(entries);
      return out;
    };
  }
  const labels = periods.map((p) => p.label);
  const blank = (): Record<string, number | null> =>
    Object.fromEntries(labels.map((l) => [l, null]));
  const combineVals = (parts: [string, boolean][]): Record<string, number | null> => {
    const out: Record<string, number | null> = {};
    for (const lbl of labels) out[lbl] = null;
    for (const [concept, neg] of parts) {
      const v = valOf([concept]);
      for (const lbl of labels) {
        const x = v[lbl];
        if (x == null) continue;
        out[lbl] = (out[lbl] ?? 0) + (neg ? -x : x);
      }
    }
    return out;
  };
  const applyNegate = (v: Record<string, number | null>): Record<string, number | null> => {
    const out: Record<string, number | null> = {};
    for (const lbl of labels) out[lbl] = v[lbl] == null ? null : -(v[lbl] as number);
    return out;
  };

  const items: FinancialLineItem[] = [];

  for (const block of BLOCKS) {
    const totalVals = valOf(block.total.concepts);
    // 매핑된 형제 라인(플러그 제외, subtotal 제외) 합 — 플러그 계산용
    const resolved: Record<string, Record<string, number | null>> = {};
    for (const line of block.lines) {
      if (line.kind === "subtotal" || line.plug) continue;
      let v: Record<string, number | null>;
      if (line.combine) v = combineVals(line.combine);
      else v = valOf(line.concepts ?? []);
      if (line.negate) v = applyNegate(v);
      resolved[line.label] = v;
    }

    for (const line of block.lines) {
      let values: Record<string, number | null>;
      if (line.kind === "subtotal") {
        // 다음 depth 라인들 합 (운전자본 변동)
        const kids = block.lines.filter(
          (l) => l.depth === line.depth + 1 && !l.plug,
        );
        values = {};
        for (const lbl of labels) {
          let s: number | null = null;
          for (const k of kids) {
            const x = resolved[k.label]?.[lbl];
            if (x != null) s = (s ?? 0) + x;
          }
          values[lbl] = s;
        }
      } else if (line.plug) {
        values = {};
        for (const lbl of labels) {
          const tot = totalVals[lbl];
          if (tot == null) {
            values[lbl] = null;
            continue;
          }
          let mapped = 0;
          for (const l of block.lines) {
            if (l.kind === "subtotal" || l.plug) continue;
            if (l.depth !== 1) continue; // depth1 형제만
            mapped += resolved[l.label]?.[lbl] ?? 0;
          }
          // depth2 (운전자본 하위)는 subtotal 로 depth1 에 이미 반영 안 됨 → 별도 가산
          for (const l of block.lines) {
            if (l.depth === 2 && !l.plug) mapped += resolved[l.label]?.[lbl] ?? 0;
          }
          values[lbl] = Math.round(tot - mapped);
        }
      } else {
        values = resolved[line.label];
      }
      items.push({
        accountName: line.label,
        accountId: `cf:${block.title}:${line.label}`,
        depth: line.depth,
        isSubtotal: line.kind === "subtotal",
        isHighlight: false,
        values,
      });
    }
    items.push({
      accountName: block.total.label,
      accountId: `cf:total:${block.title}`,
      depth: 0,
      isSubtotal: true,
      isHighlight: true,
      values: totalVals,
    });
  }

  // 순증감 · 환율효과(= 순증감 − 3개 구간 합, 미보고 시 잔여)
  const netChange = valOf(NET_CHANGE);
  const fxReported = valOf(FX);
  const sect = (i: number) => {
    const it = items.find((x) => x.accountId === `cf:total:${BLOCKS[i].title}`);
    return it?.values ?? {};
  };
  const fx: Record<string, number | null> = {};
  for (const lbl of labels) {
    if (fxReported[lbl] != null) {
      fx[lbl] = fxReported[lbl];
      continue;
    }
    const nc = netChange[lbl];
    const s0 = sect(0)[lbl];
    const s1 = sect(1)[lbl];
    const s2 = sect(2)[lbl];
    fx[lbl] =
      nc != null && s0 != null && s1 != null && s2 != null
        ? Math.round(nc - s0 - s1 - s2)
        : null;
  }
  items.push({
    accountName: "환율변동 효과",
    accountId: "cf:fx",
    depth: 0,
    isSubtotal: false,
    isHighlight: false,
    values: fx,
  });
  items.push({
    accountName: "현금및현금성자산 순증감",
    accountId: "cf:netchange",
    depth: 0,
    isSubtotal: true,
    isHighlight: true,
    values: netChange,
  });
  // ── 주석 항목 ──
  items.push({ accountName: "", accountId: "cf:sp", depth: 0, isSubtotal: false, isHighlight: false, values: blank() });
  items.push({ accountName: "[ 주석 항목 ]", accountId: "cf:note", depth: 0, isSubtotal: true, isHighlight: false, values: blank() });

  const capex = valOf(["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"]);
  const opCf = sect(0);
  const fcf: Record<string, number | null> = {};
  for (const l of labels)
    if (opCf[l] != null && capex[l] != null) fcf[l] = Math.round(opCf[l]! - Math.abs(capex[l]!));
  items.push({ accountName: "자본적지출 (CapEx)", accountId: "cf:note:capex", depth: 1, isSubtotal: false, isHighlight: false, values: capex });
  items.push({ accountName: "잉여현금흐름 (FCF)", accountId: "cf:note:fcf", depth: 1, isSubtotal: false, isHighlight: false, values: fcf });

  const tax = valOf(TAX_PAID);
  const intp = valOf(INT_PAID);
  if (labels.some((l) => tax[l] != null))
    items.push({
      accountName: "법인세 납부액",
      accountId: "cf:taxpaid",
      depth: 1,
      isSubtotal: false,
      isHighlight: false,
      values: tax,
    });
  if (labels.some((l) => intp[l] != null))
    items.push({
      accountName: "이자 지급액",
      accountId: "cf:intpaid",
      depth: 1,
      isSubtotal: false,
      isHighlight: false,
      values: intp,
    });

  return {
    symbol: "",
    market: "us",
    periodType: "annual",
    unit: "USD",
    currency: "USD",
    consolidation: "consolidated",
    periods,
    sections: [{ title: "현금흐름표", items }],
    source: "SEC EDGAR · 표준화 재분류",
  };
}
