import "server-only";
import type { FinancialStatement, FinancialLineItem } from "../types";
import { type KrFacts, seriesOf, sumOf } from "./dart-facts";

/**
 * 한국 상세 현금흐름표 — DART `fnlttSinglAcntAll` 정규화 재분류.
 * `edgar-cashflow.ts` 미러. DART CF 는 유출입 부호 표기가 계정별로 들쭉날쭉해
 * (배당·상환은 양수 표기, 자기주식은 음수 …) 유출 성격 라인은 −|v|, 유입은 +|v| 로 정규화하고
 * "기타" 라인이 구간 총계와의 차이를 흡수한다.
 */

const OUT = (v: number | null) => (v == null ? null : -Math.abs(v));
const IN = (v: number | null) => (v == null ? null : Math.abs(v));

interface Line {
  label: string;
  ids?: string[];
  names?: string[];
  combine?: { ids: string[]; names?: string[] }[];
  depth: number;
  kind?: "item" | "subtotal";
  sign?: "out" | "in" | "raw";
  plug?: boolean;
}
interface Block {
  title: string;
  total: { label: string; ids: string[]; names: string[] };
  lines: Line[];
}

const BLOCKS: Block[] = [
  {
    title: "영업활동 현금흐름",
    total: {
      label: "영업활동으로 인한 현금흐름",
      ids: ["ifrs-full_CashFlowsFromUsedInOperatingActivities"],
      names: ["영업활동현금흐름", "영업활동으로인한현금흐름"],
    },
    lines: [
      { label: "당기순이익", ids: ["ifrs-full_ProfitLoss"], names: ["당기순이익", "분기순이익", "반기순이익"], depth: 1, sign: "raw" },
      {
        label: "조정 (감가상각 등 비현금)",
        ids: ["ifrs-full_AdjustmentsForReconcileProfitLoss"],
        names: ["조정"],
        depth: 1,
        sign: "raw",
      },
      {
        label: "운전자본 변동",
        ids: ["dart_AdjustmentsForAssetsLiabilitiesOfOperatingActivities", "ifrs-full_AdjustmentsForDecreaseIncreaseInWorkingCapital"],
        names: ["영업활동으로 인한 자산부채의 변동", "운전자본의 변동"],
        depth: 1,
        sign: "raw",
      },
      { label: "이자 지급", ids: ["ifrs-full_InterestPaidClassifiedAsOperatingActivities"], names: ["이자의 지급"], depth: 1, sign: "out" },
      { label: "법인세 납부", ids: ["ifrs-full_IncomeTaxesPaidRefundClassifiedAsOperatingActivities"], names: ["법인세 납부액", "법인세납부"], depth: 1, sign: "out" },
      { label: "기타 영업활동", depth: 1, plug: true },
    ],
  },
  {
    title: "투자활동 현금흐름",
    total: {
      label: "투자활동으로 인한 현금흐름",
      ids: ["ifrs-full_CashFlowsFromUsedInInvestingActivities"],
      names: ["투자활동현금흐름", "투자활동으로인한현금흐름"],
    },
    lines: [
      {
        label: "유형자산 취득",
        ids: ["ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities"],
        names: ["유형자산의 취득"],
        depth: 1,
        sign: "out",
      },
      {
        label: "무형자산 취득",
        ids: ["ifrs-full_PurchaseOfIntangibleAssetsClassifiedAsInvestingActivities"],
        names: ["무형자산의 취득"],
        depth: 1,
        sign: "out",
      },
      { label: "기타 투자활동", depth: 1, plug: true },
    ],
  },
  {
    title: "재무활동 현금흐름",
    total: {
      label: "재무활동으로 인한 현금흐름",
      ids: ["ifrs-full_CashFlowsFromUsedInFinancingActivities"],
      names: ["재무활동현금흐름", "재무활동으로인한현금흐름"],
    },
    lines: [
      { label: "배당금 지급", ids: ["ifrs-full_DividendsPaidClassifiedAsFinancingActivities"], names: ["배당금의지급", "배당금지급"], depth: 1, sign: "out" },
      { label: "자기주식 취득", ids: ["ifrs-full_PurchaseOfTreasuryShares"], names: ["자기주식의 취득"], depth: 1, sign: "out" },
      {
        label: "차입금 순증감",
        combine: [
          { ids: ["ifrs-full_CashFlowsFromUsedInIncreaseDecreaseInCurrentBorrowings"], names: ["단기차입금의 순증가(감소)", "단기차입금의순증감"] },
          { ids: ["dart_ProceedsFromLongTermBorrowings"], names: ["장기차입금의 차입"] },
        ],
        depth: 1,
        sign: "raw",
      },
      { label: "기타 재무활동", depth: 1, plug: true },
    ],
  },
];

export function buildKrCashFlow(facts: KrFacts): FinancialStatement {
  const labels = facts.periods.map((p) => p.label);
  const blank = (): Record<string, number | null> => Object.fromEntries(labels.map((l) => [l, null]));
  const applySign = (v: Record<string, number | null>, sign: Line["sign"]) => {
    if (sign === "raw" || !sign) return v;
    const o = blank();
    for (const l of labels) o[l] = sign === "out" ? OUT(v[l]) : IN(v[l]);
    return o;
  };

  const items: FinancialLineItem[] = [];
  const sectionTotals: Record<string, Record<string, number | null>> = {};

  // SK하이닉스 등은 CF 를 "영업에서 창출된 현금" 출발점으로만 축약 공시 (당기순이익→조정 내역은 주석) →
  // 그 경우 영업활동 블록 라인을 교체
  const opStartNi = seriesOf(facts, ["ifrs-full_ProfitLoss"], ["당기순이익", "분기순이익", "반기순이익"], "CF");
  const hasNiLine = labels.some((l) => opStartNi[l] != null);
  const blocks: Block[] = hasNiLine
    ? BLOCKS
    : [
        {
          title: "영업활동 현금흐름",
          total: BLOCKS[0].total,
          lines: [
            {
              label: "영업에서 창출된 현금",
              ids: ["ifrs-full_CashFlowsFromUsedInOperations"],
              names: ["영업으로부터 창출된 현금흐름", "영업에서 창출된 현금흐름", "영업으로부터창출된현금"],
              depth: 1,
              sign: "raw",
            },
            { label: "이자 수취", ids: ["ifrs-full_InterestReceivedClassifiedAsOperatingActivities"], names: ["이자의 수취"], depth: 1, sign: "in" },
            { label: "배당금 수취", ids: ["ifrs-full_DividendsReceivedClassifiedAsOperatingActivities"], names: ["배당금의 수취", "배당금 수입"], depth: 1, sign: "in" },
            { label: "이자 지급", ids: ["ifrs-full_InterestPaidClassifiedAsOperatingActivities"], names: ["이자의 지급"], depth: 1, sign: "out" },
            { label: "법인세 납부", ids: ["ifrs-full_IncomeTaxesPaidRefundClassifiedAsOperatingActivities"], names: ["법인세 납부액", "법인세의 납부", "법인세납부"], depth: 1, sign: "out" },
            { label: "기타 영업활동", depth: 1, plug: true },
          ],
        },
        BLOCKS[1],
        BLOCKS[2],
      ];

  for (const block of blocks) {
    const totalVals = seriesOf(facts, block.total.ids, block.total.names, "CF");
    sectionTotals[block.title] = totalVals;

    const resolved: Record<string, Record<string, number | null>> = {};
    for (const line of block.lines) {
      if (line.kind === "subtotal" || line.plug) continue;
      const raw = line.combine
        ? sumOf(facts, line.combine.map((c) => ({ ids: c.ids, names: c.names })), "CF")
        : seriesOf(facts, line.ids ?? [], line.names ?? [], "CF");
      resolved[line.label] = applySign(raw, line.sign);
    }

    for (const line of block.lines) {
      let values: Record<string, number | null>;
      if (line.plug) {
        values = blank();
        for (const l of labels) {
          const tot = totalVals[l];
          if (tot == null) continue;
          let mapped = 0;
          for (const s of block.lines) {
            if (s.plug || s.kind === "subtotal") continue;
            mapped += resolved[s.label]?.[l] ?? 0;
          }
          values[l] = Math.round(tot - mapped);
        }
      } else {
        values = resolved[line.label];
      }
      items.push({
        accountName: line.label,
        accountId: `cf:${block.title}:${line.label}`,
        depth: line.depth,
        isSubtotal: false,
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

  // 환율효과 + 순증감
  const netChange = seriesOf(
    facts,
    ["ifrs-full_IncreaseDecreaseInCashAndCashEquivalents"],
    ["현금및현금성자산의 증가(감소)", "현금및현금성자산의순증가"],
    "CF",
  );
  const fxReported = seriesOf(
    facts,
    ["ifrs-full_EffectOfExchangeRateChangesOnCashAndCashEquivalents"],
    ["외화환산으로 인한 현금의 변동", "환율변동효과"],
    "CF",
  );
  const fx = blank();
  for (const l of labels) {
    if (fxReported[l] != null) {
      fx[l] = fxReported[l];
      continue;
    }
    const nc = netChange[l];
    const s0 = sectionTotals["영업활동 현금흐름"][l];
    const s1 = sectionTotals["투자활동 현금흐름"][l];
    const s2 = sectionTotals["재무활동 현금흐름"][l];
    fx[l] = nc != null && s0 != null && s1 != null && s2 != null ? Math.round(nc - s0 - s1 - s2) : null;
  }
  items.push({ accountName: "환율변동 효과", accountId: "cf:fx", depth: 0, isSubtotal: false, isHighlight: false, values: fx });
  items.push({
    accountName: "현금및현금성자산 순증감",
    accountId: "cf:netchange",
    depth: 0,
    isSubtotal: true,
    isHighlight: true,
    values: netChange,
  });

  // ── 주석: CapEx / FCF ──
  items.push({ accountName: "", accountId: "cf:sp", depth: 0, isSubtotal: false, isHighlight: false, values: blank() });
  items.push({ accountName: "[ 주석 항목 ]", accountId: "cf:note", depth: 0, isSubtotal: true, isHighlight: false, values: blank() });

  const capex = seriesOf(
    facts,
    ["ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities"],
    ["유형자산의 취득"],
    "CF",
  );
  const capexOut = blank();
  for (const l of labels) capexOut[l] = OUT(capex[l]);
  const opCf = sectionTotals["영업활동 현금흐름"];
  const fcf = blank();
  for (const l of labels)
    if (opCf[l] != null && capex[l] != null) fcf[l] = Math.round(opCf[l]! - Math.abs(capex[l]!));
  items.push({ accountName: "자본적지출 (CapEx)", accountId: "cf:note:capex", depth: 1, isSubtotal: false, isHighlight: false, values: capexOut });
  items.push({ accountName: "잉여현금흐름 (FCF)", accountId: "cf:note:fcf", depth: 1, isSubtotal: false, isHighlight: false, values: fcf });

  return {
    symbol: "",
    market: "kr",
    periodType: facts.mode === "quarter" ? "quarter" : "annual",
    unit: "원",
    currency: "KRW",
    consolidation: facts.fsDiv === "CFS" ? "consolidated" : "separate",
    periods: facts.periods.map((p) => ({
      label: p.label,
      fiscalYear: p.year,
      fiscalQuarter: p.quarter,
      endDate: p.endDate,
    })),
    sections: [{ title: "현금흐름표", items }],
    source: facts.source + " · 표준화 재분류",
  };
}
