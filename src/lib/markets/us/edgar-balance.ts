import "server-only";
import { STI_TAGS, SYN_STI_FACE } from "./edgar-bs-structure";
import { unavailableNote } from "./sec-unavailable";
import { yahooLtm } from "./edgar-yahoo-quarters";
import type { CompanyFacts } from "./edgar";
import type { FinancialStatement, FinancialLineItem, FinancialPeriod } from "../types";
import {
  ANNUAL_FORMS,
  annualEnds,
  firstConcept,
  instantByYear,
  instantOn,
  provenAbsentAt,
  recentInstantQuarters,
  fiscalYearOf } from "./edgar-series";
import { revQuarterCols, revQuarterLabel } from "./fin-revenue";
import { buildEvResolver } from "./edgar-ev";
import { isFinancialCompany } from "./edgar-financial";

/**
 * 미국 상세 재무상태표 — SEC EDGAR companyfacts 정규화 재분류 (블룸버그 B/S 근사).
 * 컬럼: 최근 5개 사업연도말 + 현재/LTM(최근 분기말). 분기 모드는 최근 5분기말.
 * "기타" 라인은 (구간 총계 − 매핑 라인)으로 자동 정합.
 */

const LTM = "현재/LTM";
const fyKey = (y: number) => `${y}Y`;

const A_TOTAL = ["Assets"];
const A_CUR = ["AssetsCurrent"];
const L_TOTAL = ["Liabilities"];
const L_CUR = ["LiabilitiesCurrent"];
const EQ = ["StockholdersEquity"];
const LE_TOTAL = ["LiabilitiesAndStockholdersEquity"];

interface Line {
  label: string;
  concepts?: string[];
  combine?: string[]; // 합산
  /**
   * concepts/combine 결과가 없는 기(period)의 **다른 정의** 값(제한현금 포함 현금·매입채무+미지급비용·미분류 장기부채 등 —
   * AXP·XOM 등). 그림자 채우기 금지(2026-09-27): 이 값은 본 줄 이름으로 보이지 않고 fallbackLabel 의 별도 줄로 보인다.
   */
  fallback?: string[];
  /** fallback 값의 별도 줄 이름 */
  fallbackLabel?: string;
  depth: number;
  kind?: "item" | "subtotal" | "total";
  plugOf?: string; // 이 구간 총계 개념군의 키 → (총계 − 앞선 depth1 형제합)
  highlight?: boolean;
}

const BLOCKS: { title: string; lines: Line[] }[] = [
  {
    title: "자산",
    lines: [
      {
        label: "현금·현금성자산",
        // 중단사업 현금 포함 태그(2026-10-01 MDLZ — 2023~ 이 태그만 써서 제한현금 포함 총액 별도 줄로 빠졌다: 1,884 → 1,810 = 야후·SA·블룸버그)
        concepts: ["CashAndCashEquivalentsAtCarryingValue", "CashAndCashEquivalentsAtCarryingValueIncludingDiscontinuedOperations"],
        // 제한현금 포함 총액 하나로만 공시하는 회사(AXP 등) — 별도 줄
        fallback: ["CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
        fallbackLabel: "현금·현금성자산 (제한현금 포함 총액)",
        depth: 1,
      },
      {
        label: "단기 투자자산",
        concepts: STI_TAGS, // 본표 판독(SYN_STI_FACE)이 없는 칸만 — 아래 resolved 단계에서 판독값으로 덮는다
        depth: 1,
      },
      { label: "매출채권", concepts: ["AccountsReceivableNetCurrent", "ReceivablesNetCurrent"], depth: 1 },
      { label: "재고자산", concepts: ["InventoryNet", "AirlineRelatedInventoryNet", "EnergyRelatedInventory", "RetailRelatedInventoryMerchandise", "OtherInventoryNetOfReserves"], depth: 1 },
      { label: "기타 유동자산", depth: 1, plugOf: "cur" },
      { label: "유동자산 총계", depth: 0, kind: "subtotal", concepts: A_CUR },
      {
        label: "유형자산 (순)",
        concepts: [
          "PropertyPlantAndEquipmentNet",
          "PropertyPlantAndEquipmentExcludingLessorAssetUnderOperatingLeaseAfterAccumulatedDepreciation",
          "PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization",
        ],
        depth: 1,
      },
      {
        label: "사용권자산 (리스)",
        concepts: [
          "OperatingLeaseRightOfUseAsset",
          "OperatingLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization",
        ],
        depth: 1,
      },
      { label: "장기 투자자산", concepts: ["MarketableSecuritiesNoncurrent", "LongTermInvestments", "LongTermInvestmentsAndReceivablesNet"], depth: 1 },
      { label: "기타 비유동자산", depth: 1, plugOf: "noncur" },
      { label: "비유동자산 총계", depth: 0, kind: "subtotal", plugOf: "noncurTotal" },
      { label: "자산 총계", depth: 0, kind: "total", highlight: true, concepts: A_TOTAL },
    ],
  },
  {
    title: "부채",
    lines: [
      {
        label: "매입채무",
        concepts: ["AccountsPayableCurrent", "AccountsPayableTradeCurrent"],
        // 유동/비유동 미분류 회사(AXP 등) 또는 매입채무·미지급비용 통합 태깅 회사(XOM 등) — 별도 줄
        fallback: ["AccountsPayableCurrentAndNoncurrent", "AccountsPayableAndAccruedLiabilitiesCurrent"],
        fallbackLabel: "매입채무·미지급비용 (통합 공시)",
        depth: 1,
      },
      {
        label: "단기부채",
        combine: [
          "CommercialPaper",
          "ShortTermBorrowings",
          "LongTermDebtCurrent",
          "FinanceLeaseLiabilityCurrent",
          "OperatingLeaseLiabilityCurrent",
        ],
        depth: 1,
      },
      { label: "기타 유동부채", depth: 1, plugOf: "lcur" },
      { label: "유동부채 총계", depth: 0, kind: "subtotal", concepts: L_CUR },
      {
        label: "장기부채",
        combine: [
          "LongTermDebtNoncurrent",
          "FinanceLeaseLiabilityNoncurrent",
          "OperatingLeaseLiabilityNoncurrent",
        ],
        // 유동/비유동 분리 없이 미분류 총액(LongTermDebt) 하나로만 공시하는 회사(AXP 등) — 별도 줄
        fallback: ["LongTermDebt"],
        fallbackLabel: "장기부채 (유동성 포함 미분류 총액)",
        depth: 1,
      },
      { label: "기타 장기부채", depth: 1, plugOf: "lnoncur" },
      { label: "비유동부채 총계", depth: 0, kind: "subtotal", plugOf: "lnoncurTotal" },
      { label: "부채 총계", depth: 0, kind: "total", highlight: true, concepts: L_TOTAL },
    ],
  },
  {
    title: "자본",
    lines: [
      {
        label: "자본금·주식발행초과금",
        combine: [
          "CommonStocksIncludingAdditionalPaidInCapital",
          "CommonStockValue",
          "AdditionalPaidInCapitalCommonStock",
          "AdditionalPaidInCapital",
        ],
        depth: 1,
      },
      { label: "이익잉여금(결손금)", concepts: ["RetainedEarningsAccumulatedDeficit"], depth: 1 },
      { label: "기타포괄손익누계액", concepts: ["AccumulatedOtherComprehensiveIncomeLossNetOfTax"], depth: 1 },
      { label: "자기주식", concepts: ["TreasuryStockCommonValue", "TreasuryStockValue"], depth: 1 },
      { label: "기타 (자본)", depth: 1, plugOf: "eq" },
      { label: "자본 총계", depth: 0, kind: "total", highlight: true, concepts: EQ },
      { label: "부채와 자본 총계", depth: 0, kind: "total", highlight: true, concepts: LE_TOTAL },
    ],
  },
];

/**
 * 금융회사(은행·카드사) 재무상태표 — 제조업 유동/비유동 분류가 안 맞아 별도 구성.
 * AXP 등은 카드회원 대출·채권(Card Member loans/receivables)을 세그먼트 차원으로만
 * 태깅해(companyfacts 무차원 API로 조회 불가 — highlights 의 "총대출채권"과 동일한
 * 구조적 한계) 단일 "투자·대출채권 등 (순액)" 플러그 행으로 묶는다(자산총계 − 나머지).
 * 부채 쪽은 예금·매입채무·단기·장기차입금이 대부분의 회사에서 개별 태깅되므로
 * "기타부채"만 플러그.
 */
const FIN_BLOCKS: { title: string; lines: Line[] }[] = [
  {
    title: "자산",
    lines: [
      {
        label: "현금·현금성자산",
        concepts: ["CashAndCashEquivalentsAtCarryingValue"],
        fallback: ["CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
        fallbackLabel: "현금·현금성자산 (제한현금 포함 총액)",
        depth: 1,
      },
      {
        label: "유형자산 (순)",
        concepts: [
          "PropertyPlantAndEquipmentNet",
          "PropertyPlantAndEquipmentExcludingLessorAssetUnderOperatingLeaseAfterAccumulatedDepreciation",
        ],
        depth: 1,
      },
      { label: "기타자산", concepts: ["OtherAssets"], depth: 1 },
      { label: "투자·대출채권 등 (순액)", depth: 1, plugOf: "finA" },
      { label: "자산 총계", depth: 0, kind: "total", highlight: true, concepts: A_TOTAL },
    ],
  },
  {
    title: "부채",
    lines: [
      { label: "예수금", concepts: ["Deposits"], depth: 1 },
      {
        label: "매입채무",
        concepts: ["AccountsPayableCurrent"],
        fallback: ["AccountsPayableCurrentAndNoncurrent"],
        fallbackLabel: "매입채무 (유동·비유동 미분류)",
        depth: 1,
      },
      {
        label: "단기차입금",
        combine: ["CommercialPaper", "ShortTermBorrowings", "LongTermDebtCurrent"],
        depth: 1,
      },
      {
        label: "장기부채",
        combine: ["LongTermDebtNoncurrent", "FinanceLeaseLiabilityNoncurrent", "OperatingLeaseLiabilityNoncurrent"],
        fallback: ["LongTermDebt"],
        fallbackLabel: "장기부채 (유동성 포함 미분류 총액)",
        depth: 1,
      },
      { label: "기타부채", depth: 1, plugOf: "finL" },
      { label: "부채 총계", depth: 0, kind: "total", highlight: true, concepts: L_TOTAL },
    ],
  },
];


/**
 * 자본 정정 감지(오너 결정 2026-10-01 (다) — WDC FY2022) — 그 결산일 재무상태표(자산총계를 실은 연간 공시)의 지배주주 자본(base)과 나중 공시가 다시 실은
 * 자본이 다르고, 그 나중 공시가 그 날짜 재무상태표 전체를 다시 싣지 않은 경우(자본변동표 기초 잔액만 — WDC 2024-02 10-Q 지분법 투자 오류 정정 +102).
 * 반올림 재게시(1억 단위 배수)·큰 차이(자본의 5% 초과)는 정정으로 보지 않는다. 재무상태표 화면·재무분석이 같이 쓴다
 */
export function equityRestatement(facts: CompanyFacts, end: string): { base: number; delta: number; filed: string } | null {
  const near = (e: { end: string }) => Math.abs(Date.parse(e.end) - Date.parse(end)) <= 6 * 864e5;
  const assetsFiled = new Set(firstConcept(facts, ["Assets"]).filter((e) => !e.start && near(e) && ANNUAL_FORMS.includes(e.form) && e.filed).map((e) => e.filed!));
  // 정기공시만 — 8-K 재작성본(GE 2021 LDTI 소급)은 재무상태표 표시 기준이 아니다(PBR 분모만 재작성본 우선, edgar-pershare)
  const se = firstConcept(facts, ["StockholdersEquity"]).filter((e) => !e.start && near(e) && /^(10-[KQ]|20-F|40-F)/.test(e.form ?? ""));
  const col = se.filter((e) => e.filed && assetsFiled.has(e.filed));
  if (!col.length || !se.length) return null;
  const pick = (xs: typeof se) => xs.reduce((a, b) => ((b.filed ?? "") > (a.filed ?? "") ? b : a));
  const base = pick(col), latest = pick(se);
  if (latest.val === base.val || (latest.filed ?? "") <= (base.filed ?? "")) return null;
  const delta = latest.val - base.val;
  if (Math.abs(delta) > Math.abs(base.val) * 0.05 || latest.val % 1e8 === 0) return null;
  // 정정을 처음 실은 공시(주석 표시용 — WDC 2024-02-12 10-Q)
  const first = se.filter((e) => e.val === latest.val && (e.filed ?? "") > (base.filed ?? "")).reduce((a, b) => ((b.filed ?? "") < (a.filed ?? "") ? b : a));
  return { base: base.val, delta, filed: `${first.filed ?? ""} ${first.form}` };
}

export function buildUsBalance(
  facts: CompanyFacts,
  mode: "annual" | "quarter" = "annual",
  sic?: string | null,
): FinancialStatement {
  const isFin = isFinancialCompany(facts, sic ?? null);
  const anchor = firstConcept(facts, A_TOTAL);

  let periods: FinancialPeriod[];
  let value: (concepts: string[]) => Record<string, number | null>;
  // LTM 칸이 빈 이유가 "그 재무상태표에 줄이 없음"(없음 증명)이 아니라 "분기 공시에 값이 없음"인 줄 — 합산·차감에서 0 으로 보지 않는다
  const ltmUnknown = new WeakSet<Record<string, number | null>>();
  /** LTM 칸이 비었는데 그 분기 재무상태표에 줄이 아예 없는(없음 증명) 줄 — 사유 "별도 줄 없음" */
  const ltmAbsent = new WeakSet<Record<string, number | null>>();
  /** 합산 줄 중 일부 구성 줄이 분기 재무상태표에 없어 빠진 줄 — 라벨 */
  const ltmPartialAbsent = new WeakMap<Record<string, number | null>, string[]>();
  let ltmDate = "";

  if (mode === "quarter") {
    // 분기 라벨·기말은 손익계산서와 같은 달력 — 재무 5층 구조 매출 지표의 분기 열(Q4 = 사업연도말 포함, fin-revenue.ts)
    const cal = revQuarterCols(facts.revenue, 5).map((c) => ({ label: revQuarterLabel(c), end: c.end, fyStartApprox: c.end }));
    const fallback =
      cal.length === 0
        ? [...recentInstantQuarters(anchor, 5)].reverse().map((end) => ({
            label: end,
            end,
            fyStartApprox: end,
          }))
        : cal;
    periods = fallback.map((q) => ({
      label: q.label,
      fiscalYear: Number(q.label.slice(0, 4)),
      fiscalQuarter: Number(q.label.slice(-1)) || null,
      endDate: q.end,
    }));
    value = (concepts) => {
      const e = firstConcept(facts, concepts);
      const out: Record<string, number | null> = {};
      for (const q of fallback) out[q.label] = instantOn(e, q.end);
      return out;
    };
  } else {
    const years = [...instantByYear(anchor).keys()].sort((a, b) => a - b).slice(-5);
    // 결산일 — 자산총계(시점 값)의 연간 보고서 기준일. annualEnds 는 기간(1년)
    // 값만 보므로 시점 값인 자산총계에선 아무것도 못 찾아 전 연도가 "12-31"로
    // 떨어졌다(1월 결산 WMT 등에서 날짜 기준 조회가 엉뚱한 분기 값을 집음 —
    // 감사 2026-09-23). 연간 보고서의 시점 값에서 연도별 최신 기준일을 뽑는다.
    const ends = new Map<number, string>();
    for (const e of anchor) {
      if (e.start || !ANNUAL_FORMS.includes(e.form)) continue;
      const y = fiscalYearOf(e.end);
      if (!ends.has(y) || e.end > ends.get(y)!) ends.set(y, e.end);
    }
    for (const [y, d] of annualEnds(anchor)) if (!ends.has(y)) ends.set(y, d);
    periods = years.map((y) => ({
      label: fyKey(y),
      fiscalYear: y,
      fiscalQuarter: null,
      endDate: ends.get(y) ?? `${y}-12-31`,
    }));
    // 20-F Yahoo 분기 LTM — LTM 열 = 그 기준일(최신 분기말) 값만, 채우지 못한 줄은 공란(FY말 값으로 대신하지 않음)
    const yl = yahooLtm(facts);
    const latestEnd =
      yl?.through ?? recentInstantQuarters(anchor, 1)[0] ?? new Date().toISOString().slice(0, 10);
    periods.push({ label: LTM, fiscalYear: (years.at(-1) ?? 0) + 1, fiscalQuarter: null, endDate: latestEnd });
    ltmDate = latestEnd;
    // 재무상태표 한 열 = 그 결산일 자산총계를 실은 공시(연간)의 값(2026-10-01 WDC FY2022 — 자본만 2024 10-K 자본변동표 기초 잔액(재작성
    // 12,323)이 들어가고 부채와 자본·부채는 원 공시(26,259·14,038)라 열 안에서 합이 102 어긋났다). 그 공시들에 값이 없는 줄만 다른 공시
    const bsFiled = new Map<string, Set<string>>();
    for (const x of anchor) if (!x.start && ANNUAL_FORMS.includes(x.form) && x.filed) bsFiled.set(x.end, (bsFiled.get(x.end) ?? new Set()).add(x.filed));
    value = (concepts) => {
      const e0 = firstConcept(facts, concepts);
      const e = e0.filter((x) => {
        const fs0 = x.start || !ANNUAL_FORMS.includes(x.form) ? null : bsFiled.get(x.end);
        if (!fs0 || (x.filed && fs0.has(x.filed))) return true;
        return !e0.some((y) => y.end === x.end && !y.start && ANNUAL_FORMS.includes(y.form) && y.filed && fs0.has(y.filed));
      });
      const ann = instantByYear(e);
      const out: Record<string, number | null> = {};
      for (const y of years) out[fyKey(y)] = ann.get(y) ?? null;
      // LTM: 최근 분기말(±6일) 값만 — 그 전 가장 최근 값으로 대신하지 않는다(그림자 채우기 금지, 2026-09-27)
      out[LTM] = instantOn(e, latestEnd);
      if (out[LTM] == null) {
        if (!provenAbsentAt(facts, concepts, latestEnd)) ltmUnknown.add(out);
        // 분기 재무상태표에 이 줄이 따로 없다(다른 줄에 포함) — 연말 값으로 대신하지 않고 사유만
        else if (years.length && out[fyKey(years[years.length - 1])] != null) ltmAbsent.add(out);
      }
      return out;
    };
  }
  const labels = periods.map((p) => p.label);
  const blank = (): Record<string, number | null> => Object.fromEntries(labels.map((l) => [l, null]));

  // 구간 총계 조회 (플러그용)
  const curTotal = value(A_CUR);
  const aTotal = value(A_TOTAL);
  const lcurTotal = value(L_CUR);
  const leTotal = value(LE_TOTAL); // 부채와 자본 총계 (= 자산 총계)
  const eqRaw = value(["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]);
  const lRaw = value(L_TOTAL);
  // 부채 파생용 자본은 비지배지분 포함(2026-10-01 KO — 부채총계 미태깅: 92,763 − 지배주주 자본 24,105 = 68,658 로 비지배지분 1,721 이 부채에
  // 섞였다. 맞는 값 = 92,763 − 비지배지분 포함 자본 25,826 = 66,937 = 야후·StockAnalysis). 포함 자본 태그가 없으면 지배주주 자본 + 비지배지분
  const eqAllRaw = value(["StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]);
  const miRaw = value(["MinorityInterest"]);
  const seOnly = value(["StockholdersEquity"]);
  // 임시자본(메자닌, 2026-10-01) — 부채도 자본도 아닌 상환가능 지분(TSLA·UBER·HLT 상환가능 비지배지분, WDC·BE 전환우선주).
  // 부채와 자본 총계 = 부채 + 임시자본 + 자본 + 비지배지분. 포함 합계 태그 → 지배주주분 + 상환가능 비지배지분
  const tmpAll = value(["TemporaryEquityCarryingAmountIncludingPortionAttributableToNoncontrollingInterests"]);
  const tmpParent = value(["TemporaryEquityCarryingAmountAttributableToParent"]);
  const tmpNci = value(["RedeemableNoncontrollingInterestEquityCarryingAmount", "RedeemableNoncontrollingInterestEquityCommonCarryingAmount"]);
  const tempEq = blank();
  for (const l of labels)
    tempEq[l] = tmpAll[l] ?? (tmpParent[l] != null || tmpNci[l] != null ? (tmpParent[l] ?? 0) + (tmpNci[l] ?? 0) : null);
  // 자기자본·부채총계 한쪽이라도 미태깅이면 (부채와자본총계 or 자산총계) 로 상호 파생
  const eqTotal = blank();
  const lTotal = blank();
  for (const l of labels) {
    const be = leTotal[l] ?? aTotal[l] ?? null;
    // 지배주주 자본 태그가 없고 비지배지분 포함 자본만 있으면 비지배지분을 뺀다(2026-10-01 CAT — StockholdersEquity 를 한 번도 태그하지 않아
    // 자본 총계에 비지배지분 22 가 섞였다: 15,891 → 15,869 = 야후·블룸버그)
    eqTotal[l] = seOnly[l] ?? (eqAllRaw[l] != null ? eqAllRaw[l]! - (miRaw[l] ?? 0) : null) ?? eqRaw[l] ?? (be != null && lRaw[l] != null ? be - lRaw[l]! : null);
    const eqForL = eqAllRaw[l] ?? (eqTotal[l] != null ? eqTotal[l]! + (miRaw[l] ?? 0) : null);
    lTotal[l] = lRaw[l] ?? (be != null && eqForL != null ? be - eqForL - (tempEq[l] ?? 0) : null);
  }
  // 자본 정정(오너 결정 2026-10-01 (다) — WDC FY2022): 나중 공시가 그 결산일 자본만 다시 실었고(자본변동표 기초 잔액, 오류 정정) 그 날짜 재무상태표 전체는
  // 다시 공시되지 않은 경우. 자본은 나중 공시 값(나중 공시 우선), 자산 총계·부채와 자본 총계는 부채 + 자본으로 산출해 항등식을 지킨다. 정정 금액은
  // 비유동자산 잔여(기타 비유동자산)에 들어간다 — WDC 정정 대상이 지분법 투자(비유동자산)라 그 위치가 맞다. 연간 열만(LTM 은 최신 공시 그대로)
  const restated = new Map<string, { delta: number; filed: string }>();
  {
    for (const p of periods) {
      const l = p.label;
      if (l === LTM || seOnly[l] == null || !p.endDate) continue;
      const r = equityRestatement(facts, p.endDate);
      if (!r || r.base !== seOnly[l]) continue;
      const delta = r.delta;
      restated.set(l, { delta, filed: r.filed });
      seOnly[l] = r.base + delta;
      const latest = { val: r.base + delta };
      eqTotal[l] = latest.val;
      if (eqAllRaw[l] != null) eqAllRaw[l] = eqAllRaw[l]! + delta;
      if (aTotal[l] != null) aTotal[l] = aTotal[l]! + delta;
      if (leTotal[l] != null) leTotal[l] = leTotal[l]! + delta;
    }
  }
  const totalOf: Record<string, Record<string, number | null>> = {
    cur: curTotal,
    lcur: lcurTotal,
    eq: eqTotal,
    noncur: (() => {
      const o = blank();
      for (const l of labels) if (aTotal[l] != null && curTotal[l] != null) o[l] = aTotal[l]! - curTotal[l]!;
      return o;
    })(),
    lnoncur: (() => {
      const o = blank();
      for (const l of labels) if (lTotal[l] != null && lcurTotal[l] != null) o[l] = lTotal[l]! - lcurTotal[l]!;
      return o;
    })(),
    noncurTotal: (() => {
      const o = blank();
      for (const l of labels) if (aTotal[l] != null && curTotal[l] != null) o[l] = aTotal[l]! - curTotal[l]!;
      return o;
    })(),
    lnoncurTotal: (() => {
      const o = blank();
      for (const l of labels) if (lTotal[l] != null && lcurTotal[l] != null) o[l] = lTotal[l]! - lcurTotal[l]!;
      return o;
    })(),
    // 금융회사 전용 — 플러그 기준 총계는 그냥 자산/부채 총계 자체.
    finA: aTotal,
    finL: lTotal,
  };

  const items: FinancialLineItem[] = [];
  const plugWhy = new WeakSet<Record<string, number | null>>();
  const blocks = isFin ? [FIN_BLOCKS[0], FIN_BLOCKS[1], BLOCKS[2]] : BLOCKS;
  for (const block of blocks) {
    // 매핑된 depth1 라인 (플러그 제외)
    const resolved: Record<string, Record<string, number | null>> = {};
    /** 다른 정의 값(제한현금 포함 현금 등)의 별도 줄 — 본 줄 이름으로 보이지 않는다(그림자 채우기 금지) */
    const fbRows: Record<string, Record<string, number | null>> = {};
    for (const line of block.lines) {
      if (line.kind === "subtotal" || line.kind === "total" || line.plugOf) continue;
      // LTM 에서만 빈 값(분기 공시에 없음 — 없음 증명 안 됨)은 합산·대체하지 않는다(부분 합·다른 개념 혼합 방지)
      const ltmGap = (v: Record<string, number | null>) => labels.includes(LTM) && v[LTM] == null && ltmUnknown.has(v);
      resolved[line.label] = line.combine
        ? (() => {
            const o = blank();
            let gap = false;
            const dropped: string[] = [];
            for (const c of line.combine) {
              const v = value([c]);
              if (ltmGap(v)) gap = true;
              if (ltmAbsent.has(v)) dropped.push(c);
              for (const l of labels) if (v[l] != null) o[l] = (o[l] ?? 0) + v[l]!;
            }
            if (dropped.length && o[LTM] != null) ltmPartialAbsent.set(o, dropped);
            if (gap) {
              o[LTM] = null;
              ltmUnknown.add(o);
            }
            return o;
          })()
        : value(line.concepts ?? []);
      // 단기 투자자산 = 본표 유동자산의 단기투자 줄 합(edgar-bs-structure SYN_STI_FACE — EV 현금·재무분석 현금비율과 같은 값, 2026-10-01). 태그 목록의
      // AvailableForSaleSecuritiesDebtSecurities 는 장기분까지 포함한 매도가능 채권 총액이라 INTC(32,393)·CAT·KO 에서 유동자산 줄이 부풀었다.
      // 판독값은 날짜마다 그 날짜를 담은 가장 최근 공시(10-Q 비교 열 포함) 하나라 공시 종류가 아니라 기준일로 읽는다. 판독이 없는 칸만 태그 목록
      if (line.label === "단기 투자자산") {
        const face = firstConcept(facts, [SYN_STI_FACE]).filter((e) => !e.start);
        const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 6 * 864e5;
        for (const p of periods) {
          const e = p.endDate ? face.find((x) => near(x.end, p.endDate!)) : undefined;
          if (e) resolved[line.label][p.label] = e.val;
        }
      }
      if (line.fallback) {
        const fb = value(line.fallback);
        const primaryGap = ltmGap(resolved[line.label]);
        const alt = blank();
        for (const l of labels)
          if (resolved[line.label][l] == null && fb[l] != null && !(l === LTM && primaryGap)) alt[l] = fb[l];
        if (labels.some((l) => alt[l] != null)) fbRows[line.label] = alt;
      }
    }

    for (const line of block.lines) {
      let values: Record<string, number | null>;
      if (line.kind === "subtotal" || line.kind === "total") {
        const direct = line.concepts ? value(line.concepts) : null;
        // 태그 미제공 시 파생값으로 보충 (DAL·CAT 등)
        const derived: Record<string, number | null> | null =
          line.label === "부채 총계"
            ? lTotal
            : line.label === "자본 총계"
              ? eqTotal
              : line.label === "부채와 자본 총계"
                ? (() => {
                    const o = blank();
                    for (const l of labels) o[l] = leTotal[l] ?? aTotal[l] ?? null;
                    return o;
                  })()
                : null;
        const plug = line.plugOf ? totalOf[line.plugOf.replace(/Total$/, "")] : null;
        values = blank();
        for (const l of labels)
          values[l] = direct?.[l] ?? derived?.[l] ?? plug?.[l] ?? null;
        // 자본 정정 열 — 자산·자본·부채와 자본 총계는 조정 값(위 restated)
        for (const [l] of restated) {
          if (line.label === "자산 총계" && aTotal[l] != null) values[l] = aTotal[l];
          else if (line.label === "자본 총계") values[l] = eqTotal[l];
          else if (line.label === "부채와 자본 총계") values[l] = leTotal[l] ?? aTotal[l];
          else if (line.label === "비유동자산 총계" && totalOf.noncurTotal[l] != null) values[l] = totalOf.noncurTotal[l];
        }
      } else if (line.plugOf) {
        // (구간 총계 − 직전 소계 이후 ~ 이 라인 이전의 depth1 item 합)
        const tot = totalOf[line.plugOf.replace(/Total$/, "")];
        const idx = block.lines.indexOf(line);
        let bound = -1;
        for (let i = idx - 1; i >= 0; i--)
          if (block.lines[i].kind === "subtotal" || block.lines[i].kind === "total") {
            bound = i;
            break;
          }
        values = blank();
        // 구성 줄이 LTM 에서만 비었으면(분기 공시에 없음) 차감 잔여(기타)도 비운다 — 0 으로 보면 기타가 부푼다(모든 회사)
        for (const l of labels) {
          if (tot[l] == null) continue;
          let mapped = 0;
          let unknown = false;
          for (let i = bound + 1; i < idx; i++) {
            const s = block.lines[i];
            if (s.kind || s.plugOf) continue;
            const r = resolved[s.label];
            const v = r?.[l];
            if (l === LTM && v == null && r && ltmUnknown.has(r) && fbRows[s.label]?.[l] == null) unknown = true;
            // 별도 줄(다른 정의 값)도 구간 합에는 들어간다 — 기타 줄이 그 금액을 떠안지 않게
            mapped += (v ?? 0) + (fbRows[s.label]?.[l] ?? 0);
          }
          values[l] = unknown ? null : Math.round(tot[l]! - mapped);
          if (unknown) plugWhy.add(values);
        }
      } else {
        values = resolved[line.label];
      }
      const notes: Record<string, string> = {};
      if (labels.includes(LTM)) {
        if (values[LTM] == null && plugWhy.has(values)) notes[LTM] = "구성 줄이 분기 재무상태표에 없음 — 잔여 산정 불가";
        else if (values[LTM] == null && ltmUnknown.has(values)) notes[LTM] = `분기 재무상태표에 없음(${ltmDate})`;
        else if (values[LTM] == null && ltmAbsent.has(values) && fbRows[line.label]?.[LTM] == null)
          notes[LTM] = `분기 재무상태표에 별도 줄 없음(${ltmDate} — 다른 줄에 포함, 연말 값으로 대신하지 않음)`;
        else if (values[LTM] != null && ltmPartialAbsent.has(values))
          notes[LTM] = `일부 구성 줄(${ltmPartialAbsent.get(values)!.join(", ")})이 분기 재무상태표에 따로 없음 — 제외(다른 줄에 포함)`;
      }
      // 다른 정의 값을 별도 줄로 옮긴 칸 — 본 줄은 공란 + 사유
      const fbv = fbRows[line.label];
      if (fbv) for (const l of labels) if (fbv[l] != null && values[l] == null) notes[l] = `태그 없음 — 아래 「${line.fallbackLabel}」 줄 참조(다른 정의)`;
      for (const [l, r] of restated) {
        if (line.label === "자본 총계") notes[l] = `자본 정정 반영(+${r.delta / 1e6}백만, ${r.filed} 공시 — 오류 정정) · 나중 공시 우선`;
        else if (["자산 총계", "부채와 자본 총계", "비유동자산 총계"].includes(line.label) || line.plugOf === "noncur")
          notes[l] = `자본 정정(+${r.delta / 1e6}백만)을 반영해 부채 + 자본으로 산출 — 정정된 재무상태표 전체는 공시되지 않음`;
      }
      const ltmNote = Object.keys(notes).length ? { cellNotes: notes } : {};
      items.push({
        accountName: line.label,
        accountId: `bs:${block.title}:${line.label}`,
        depth: line.depth,
        isSubtotal: line.kind === "subtotal" || line.kind === "total",
        isHighlight: Boolean(line.highlight),
        values,
        ...ltmNote,
      });
      // 비지배지분 줄(2026-10-01) — 자본 총계가 지배주주 자본(StockholdersEquity)인 칸에 비지배지분이 있으면 자본 총계 다음에 따로 싣는다.
      // 없으면 부채 + 자본 ≠ 부채와 자본 총계(KO 2022: 66,937 + 24,105 ≠ 92,763 — 차이 1,721 = 비지배지분)
      if (line.label === "자본 총계" && !isFin) {
        const nci = blank();
        for (const l of labels) {
          if (values[l] == null) continue;
          if (seOnly[l] == null) { if (eqAllRaw[l] != null && miRaw[l] != null && values[l] === eqAllRaw[l]! - miRaw[l]!) nci[l] = miRaw[l]; continue; }
          if (values[l] !== seOnly[l]) continue;
          nci[l] = miRaw[l] ?? (eqAllRaw[l] != null ? eqAllRaw[l]! - seOnly[l]! : null);
        }
        if (labels.some((l) => nci[l] != null && nci[l] !== 0))
          items.push({ accountName: "비지배지분", accountId: "bs:자본:비지배지분", depth: 0, isSubtotal: false, isHighlight: false, values: nci });
        // 임시자본 줄 — 표준 태그가 없으면 부채와 자본 − 부채 − 비지배지분 포함 자본(세 값 모두 공시값일 때만, 표기 한 단위(100만) 넘는 차만 —
        // AVGO FY2021 우선주 배당 미지급 27 은 회사 고유 태그라 companyfacts 에 없다)
        const tmp = blank(), tmpNote: Record<string, string> = {};
        for (const l of labels) {
          if (tempEq[l] != null) { tmp[l] = tempEq[l]; continue; }
          const eAll = eqAllRaw[l] ?? (seOnly[l] != null ? seOnly[l]! + (miRaw[l] ?? 0) : null);
          if (leTotal[l] == null || lRaw[l] == null || eAll == null) continue;
          const r = leTotal[l]! - lRaw[l]! - eAll;
          if (Math.abs(r) > 1e6 + 0.5) { tmp[l] = r; tmpNote[l] = "표준 태그 없음 — 부채와 자본 − 부채 − 자본(비지배지분 포함)"; }
        }
        if (labels.some((l) => tmp[l] != null && tmp[l] !== 0))
          items.push({ accountName: "임시자본(상환가능 지분)", accountId: "bs:자본:임시자본", depth: 0, isSubtotal: false, isHighlight: false, values: tmp,
            ...(Object.keys(tmpNote).length ? { cellNotes: tmpNote } : {}) });
      }
      const fb = fbRows[line.label];
      if (fb && line.fallbackLabel)
        items.push({
          accountName: line.fallbackLabel,
          accountId: `bs:${block.title}:${line.label}:alt`,
          depth: line.depth + 1,
          isSubtotal: false,
          isHighlight: false,
          italic: true,
          values: fb,
          cellNotes: Object.fromEntries(
            labels.filter((l) => fb[l] != null).map((l) => [l, `「${line.label}」 태그 없음 — 다른 정의(${line.fallbackLabel}) 값을 별도 줄로 표시`]),
          ),
        });
    }
  }

  // ── 주석 항목 ──
  items.push({ accountName: "", accountId: "bs:sp", depth: 0, isSubtotal: false, isHighlight: false, values: blank() });
  items.push({ accountName: "[ 주석 항목 ]", accountId: "bs:note", depth: 0, isSubtotal: true, isHighlight: false, values: blank() });

  // 총차입금·순차입금 — edgar-ev.ts 와 같은 차입금·현금 규칙(태그 목록·현금 정의)을
  // 쓴다. 이 표는 재무상태표 주석이라 연결 기준 그대로 둔다(금융 자회사 차입금
  // 포함). EV 는 하이라이트·분석 지표에서 금융 자회사분을 뺀다.
  const evRes = buildEvResolver(facts);
  const debt = blank();
  const netDebt = blank();
  const ltDebtN = blank();
  const opLease = blank();
  const bridgeWhy: Record<string, string> = {};
  for (const p of periods) {
    const ylE = p.label === LTM ? yahooLtm(facts) : null;
    const d = p.label === LTM ? (ylE?.through ?? evRes.latestBalanceDate() ?? p.endDate ?? "") : (p.endDate ?? "");
    const br = d ? evRes.bridgeAt(d) : null;
    if (!br) {
      const why = d && !evRes.blocker(d) ? evRes.bridgeReason(d) : null;
      if (why) bridgeWhy[p.label] = why;
      continue;
    }
    // Yahoo 분기 LTM: 차입금·현금이 같은 기준일로 다 채워졌을 때만(edgar-yahoo-quarters.ts evComplete)
    if (ylE && (!ylE.evComplete || br.balanceDate !== ylE.through)) {
      bridgeWhy[p.label] = ylE.evReason ?? "Yahoo 분기 EV 구성요소 불완전";
      continue;
    }
    debt[p.label] = br.debt;
    ltDebtN[p.label] = br.debtNoncurrent ?? null;
    netDebt[p.label] = br.debt - br.cash;
    opLease[p.label] = br.operatingLease;
  }

  const nrow = (label: string, values: Record<string, number | null>, nf?: FinancialLineItem["numberFormat"]): FinancialLineItem => ({
    accountName: label,
    accountId: `bs:note:${label}`,
    depth: 1,
    isSubtotal: false,
    isHighlight: false,
    values,
    numberFormat: nf,
    // 차입금·현금이 그 기준일 공시에 없으면 사유(이전 연말 값으로 대신하지 않음)
    ...(Object.keys(bridgeWhy).some((l) => values[l] == null)
      ? { cellNotes: Object.fromEntries(Object.entries(bridgeWhy).filter(([l]) => values[l] == null)) }
      : {}),
  });
  items.push(nrow("총차입금", debt));
  // 비유동 차입금(운용리스 제외 — 총차입금과 같은 기준, EV 브릿지). 본표 "장기부채" 줄은 운용리스 부채를 포함할 수 있어 기준이 다르다(재무분석 장기차입금 비율의 분자, 2026-10-01)
  items.push(nrow("장기차입금 (운용리스 제외)", ltDebtN));
  items.push(nrow("순차입금", netDebt));
  // 운용리스는 차입금·순차입금에 넣지 않는다(미국 회계기준상 영업부채, 오너 결정
  // 2026-09-23) — 규모는 여기서 따로 보인다. 분기 공시에 없는 회사는 빈칸.
  items.push(nrow("운용리스 부채 (차입금 미포함)", opLease));
  // 신용평가사(S&P·Moody's) 기준 참고치 — 운용리스가 공시된 기간만
  const debtWithOpLease = blank();
  for (const l of labels)
    if (debt[l] != null && opLease[l] != null) debtWithOpLease[l] = debt[l]! + opLease[l]!;
  items.push(nrow("총차입금 (운용리스 포함)", debtWithOpLease));
  // SEC 원본 조회 실패로 공란이 된 값(총차입금 등 — 태그 규칙으로 대체하지 않음, sec-unavailable.ts)
  const unavailable = unavailableNote(facts);
  if (unavailable) items.push({ ...nrow(`※ ${unavailable}`, blank()), italic: true });

  return {
    symbol: "",
    market: "us",
    periodType: "annual",
    unit: "USD",
    currency: "USD",
    consolidation: "consolidated",
    periods,
    sections: [{ title: "재무상태표", items }],
    source: "SEC EDGAR · 표준화 재분류",
  };
}
