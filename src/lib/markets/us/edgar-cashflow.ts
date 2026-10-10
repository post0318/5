import "server-only";
import { dividendFreeSince, dividendFreeYear, fillBlankReasons } from "./blank-reason";
import { unavailableNote, unavailableOn } from "./sec-unavailable";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import type { FinancialStatement, FinancialLineItem, FinancialPeriod } from "../types";
import { entriesOf, firstConcept, recentQuarters, singleQuarterParts, fiscalYearOf, ltmAnchor, ltmFlowOf, shiftYear, type QuarterCol, type QuarterParts } from "./edgar-series";
import { DA_BASIS_MIX, daBasisMixed, DA_DEPRECIATION, DA_INTANGIBLE, DA_LTM_NO_STRUCT, DA_QUARTER_NO_STRUCT, DA_TOTAL, daStructConcept, daTtmCell, pickDa, pickDaPeriod } from "./edgar-ev";
import { revQuarterLabel } from "./fin-revenue";
import { DEBT_UNREAD as DEBT_UNREAD_NOTE } from "./edgar-cf-debt";
import { isFinancialCompany } from "./edgar-financial";

/**
 * 미국 상세 현금흐름표 — SEC EDGAR companyfacts 를 정규화 라인으로 재분류.
 * 컬럼: 최근 8개 사업연도 + 최근 12개월(LTM, 누적법). 한글 표준 라벨.
 * "기타" 라인은 (구간 합계 − 매핑된 라인 합)으로 자동 계산 → 총계 정합.
 */

const ANNUAL_FORMS = ["10-K", "10-K/A", "20-F", "20-F/A"];

function days(a: string, b: string) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}
/** 온전한 1개 회계연도(약 300~400일)인지 — 90일 분기에도 fp="FY" 붙이는 기업(NVIDIA) 대응. */
function isFullYear(e: FactUnitEntry): boolean {
  return Boolean(e.start) && days(e.start!, e.end) >= 300 && days(e.start!, e.end) <= 400;
}
// 대체 태그 병합 — edgar-series.ts firstConcept 단일 함수(한 결산일 = 한 개념, 2026-09-30 — 예전 지역 사본은 결산일이 같은 다른 개념 값으로
// 기간을 채워 GOOG 주식보상비용 LTM 이 손익 쪽 태그 3개월 값과 섞였다)

/** 사업연도별 duration 값. */
/**
 * 사업연도별 연간 값 — **나중 공시 우선**(오너 결정 2026-09-30 "나중공시우선" — 손익계산서와 같은 원칙. 예전엔 먼저 나온 원 공시 값을 썼다:
 * INTC 2021 영업현금흐름 29,991 → 재작성 29,456, META 2022 CAPEX 31,431 → 31,186 등). 단, 나중 공시 값이 앞선 공시 값의 **부호만 뒤집은**
 * 값이면(AMD 2021 투자·재무활동 −686·−1,895 → 2024 10-K +686·+1,895 — 회사 태깅 오류) 앞선 값을 유지한다.
 */
function annualByYear(entries: FactUnitEntry[]): Map<number, number> {
  const byYear = new Map<number, FactUnitEntry[]>();
  for (const e of entries) {
    if (e.fp !== "FY" || !isFullYear(e) || !ANNUAL_FORMS.includes(e.form)) continue;
    const y = fiscalYearOf(e.end);
    const g = byYear.get(y);
    if (g) g.push(e);
    else byYear.set(y, [e]);
  }
  const out = new Map<number, number>();
  for (const [y, g] of byYear) {
    const end = g.reduce((m, e) => (e.end > m ? e.end : m), "");
    const same = g.filter((e) => e.end === end).sort((a, b) => (b.filed ?? "").localeCompare(a.filed ?? ""));
    const latest = same[0];
    const earlier = same.find((e) => e.val !== latest.val);
    out.set(y, latest.val !== 0 && earlier && earlier.val === -latest.val ? earlier.val : latest.val);
  }
  return out;
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
  /** concepts 로 값이 안 나온 기간을 이 합산으로 보충 */
  fallbackCombine?: [string, boolean][];
  /** (구간 총계 − 이 앞의 형제 라인 합)으로 계산되는 잔여 라인 */
  plug?: boolean;
  /**
   * 운전자본 하위 잔여 줄 — 회사 공시 운전자본 합계(wcCo) − 이름 있는 하위 줄 합(2026-10-08). 합계를 회사 공시 순변동으로 바꾼 뒤(10-02)
   * 하위 세 줄 밖 운전자본(선급·미지급·이연수익 등)이 화면 어디에도 없어 하위 줄 합 ≠ 합계(AAPL FY2021 −4,911 vs 세 줄 −441)
   */
  wcRest?: boolean;
  /** 감가상각비 — edgar-ev.ts pickDa 규칙(합계 태그 최댓값·무형상각 누락 보정) */
  pickDa?: boolean;
  /** 표시용 합계 줄 — 같은 블록의 이 줄들(바로 아래 depth+1) 합. 잔여(기타) 계산에는 넣지 않는다(하위 줄이 이미 들어감) */
  sumOf?: string[];
  /** 하위 줄의 합계를 자기 개념으로 읽는 줄(차입금 조달·상환 합계 — 본표 판독) — 잔여(기타) 계산에서 하위 줄 대신 이 줄을 쓴다 */
  total?: boolean;
}

interface Block {
  title: string;
  total: { label: string; concepts: string[] };
  lines: Line[];
}

/**
 * 금융회사(은행·카드사)는 대손충당금(Provision)이 크고 개별 태깅도 깔끔해서
 * BBG 도 별도 행으로 보여준다 — 그 외 회사는 이 개념이 애초에 없어 자동으로 빈 값.
 */
const FIN_PROVISION_LINE: Line = {
  label: "대손충당금",
  concepts: ["ProvisionForLoanLossesExpensed", "ProvisionForLoanAndLeaseLosses", "ProvisionForLoanLeaseAndOtherLosses"],
  depth: 1,
};

/** 투자·재무활동 줄의 태그 묶음 — 분기 본표에서 빠진 줄(당기·전년 동기 모두 0)을 0 으로 채울 대상(edgar-cf-wc.ts) */
/**
 * 투자자산 처분·취득 줄 — 본표에 회사 고유 태그 줄이 섞인 공시는 그 공시의 같은 성격 본표 줄 전부(표준 + 회사 고유) 합을 합성 개념으로 넣는다
 * (edgar-cf-wc.ts, 2026-10-09 NVDA 2027 회계연도 10-Q: 지분증권 취득·처분이 nvda: 태그라 표준 태그만 더하면 LTM 이 부분값·"기타 투자활동"이 떠안았다).
 * 합성 개념이 있는 기간은 표준 구성 개념을 대신한다(SUPERSEDES)
 */
export const CF_INV_FAMILIES: { derived: string; custom: RegExp; label: string }[] = [
  { derived: "InvestmentProceedsFaceDerived", label: "투자자산 처분·만기", custom: /^ProceedsFrom(?!.*(Business|PropertyPlant|ProductiveAsset|Debt|Stock|Issuance))\w*(Sale|Maturit|Redemption|Collection)\w*(Securities|Investments?)$/ },
  { derived: "InvestmentPurchasesFaceDerived", label: "투자자산 취득", custom: /^(PaymentsToAcquire|PaymentsFor(?!Proceeds)|PurchasesOf|PurchaseOf)(?!.*(Business|PropertyPlant|ProductiveAsset|Intangible))\w*(Securities|Investments?)$/ },
];
/** 그 줄의 표준 구성 개념(합성 개념 제외) */
export function cfInvStdConcepts(label: string): string[] {
  const l = getBlocks(false)[1].lines.find((x) => x.label === label);
  return (l?.combine ?? []).map(([c]) => c).filter((c) => !CF_INV_FAMILIES.some((f) => f.derived === c));
}
export function cfZeroFillGroups(): string[][] {
  return getBlocks(false).slice(1).flatMap((b) => b.lines.filter((l) => l.concepts && !l.plug).map((l) => l.concepts as string[]));
}

function getBlocks(isFin: boolean, debtFace = false): Block[] {
  // 차입금 줄(오너 결정 2026-10-10) — 10-K·10-Q 본표 판독 합성 개념(edgar-cf-wc.ts DEBT_SYN). 본표 판독을 못 한 회사(20-F 등)는 표준 개념 목록
  const D = (face: string, std: string[]) => (debtFace ? [face] : std);
  return [
  {
    title: "영업활동 현금흐름",
    total: {
      label: "영업활동으로 인한 현금흐름",
      concepts: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
    },
    lines: [
      { label: "당기순이익", concepts: ["NetIncomeLoss", "ProfitLoss"], depth: 1 },
      {
        label: "감가·무형상각비", // 모바일 한 줄 표시(오너 지시 2026-10-02)
        // 여러 합계 태그를 동시에 다는 회사(MCD: 일부 항목 4.6억 / 전체 22억)가 있어
        // "앞 태그 우선"이 아니라 하이라이트·분석 지표와 같은 pickDa 규칙을 쓴다.
        pickDa: true,
        depth: 1,
      },
      // 본표 줄이 회사 고유 태그인 회사는 공시 원본 값(edgar-cf-wc.ts SYN_SBC_CF — BE)
      { label: "주식보상비용", concepts: ["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense", "ShareBasedCompensationFaceDerived"], depth: 1 },
      ...(isFin ? [FIN_PROVISION_LINE] : []),
      {
        label: "기타 비현금 조정",
        depth: 1,
        combine: [
          ["OtherNoncashIncomeExpense", false],
          ["OtherOperatingActivitiesCashFlowStatement", false],
          ["DeferredIncomeTaxExpenseBenefit", false],
          ["DeferredIncomeTaxesAndTaxCredits", false],
          ["IncreaseDecreaseInOtherOperatingAssets", true],
          ["IncreaseDecreaseInOtherOperatingLiabilities", false],
          ["IncreaseDecreaseInOtherOperatingCapitalNet", true],
          ["IncreaseDecreaseInOtherReceivables", true],
        ],
      },
      { label: "운전자본 변동", depth: 1, kind: "subtotal" },
      { label: "매출채권 증감", concepts: ["IncreaseDecreaseInAccountsReceivable", "IncreaseDecreaseInReceivables", "IncreaseDecreaseInAccountsAndOtherReceivables"], depth: 2, negate: true },
      { label: "재고자산 증감", concepts: ["IncreaseDecreaseInInventories", "IncreaseDecreaseInAirlineRelatedInventory"], depth: 2, negate: true },
      { label: "매입채무 증감", concepts: ["IncreaseDecreaseInAccountsPayable", "IncreaseDecreaseInAccountsPayableTrade", "IncreaseDecreaseInAccountsPayableAndAccruedLiabilities"], depth: 2 },
      { label: "기타 운전자본 증감", depth: 2, wcRest: true },
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
      // PaymentsForCapitalImprovements — GLW 현금흐름표 "Capital expenditures"(2022~ 이 개념, 2026-10-08 — 없어서 앱 CAPEX 가 0 으로 채워졌다)
      { label: "유형자산 취득", concepts: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets", "PaymentsForCapitalImprovements", "CapexComponentsDerived"], depth: 1, negate: true },
      {
        label: "투자자산 처분·만기",
        depth: 1,
        combine: [
          ["ProceedsFromSaleOfAvailableForSaleSecuritiesDebt", false],
          ["ProceedsFromMaturitiesPrepaymentsAndCallsOfAvailableForSaleSecurities", false],
          ["ProceedsFromSaleMaturityAndCollectionsOfInvestments", false],
          ["ProceedsFromSaleMaturityAndCollectionOfShorttermInvestments", false],
          ["ProceedsFromSaleAndMaturityOfMarketableSecurities", false],
          ["ProceedsFromSaleOfShortTermInvestments", false],
          // 분기·연간이 서로 다른 태그(META 연간 MarketableSecurities·분기 AvailableForSale, AMAT OtherInvestments — 2026-10-02 검증기 LTM 공란 검사)
          ["ProceedsFromSaleAndMaturityOfAvailableForSaleSecurities", false],
          ["ProceedsFromSaleAndMaturityOfOtherInvestments", false],
          ["ProceedsFromSaleOfEquitySecuritiesFvNi", false],
          ["InvestmentProceedsFaceDerived", false], // 본표 회사 고유 줄 포함 합(edgar-cf-wc.ts — NVDA)
        ],
      },
      {
        label: "투자자산 취득",
        depth: 1,
        negate: true,
        combine: [
          ["PaymentsToAcquireAvailableForSaleSecuritiesDebt", false],
          ["PaymentsToAcquireInvestments", false],
          ["PaymentsToAcquireShortTermInvestments", false],
          ["PaymentsToAcquireLongtermInvestments", false],
          ["PaymentsToAcquireMarketableSecurities", false],
          ["PaymentsToAcquireEquitySecuritiesFvNi", false],
          ["InvestmentPurchasesFaceDerived", false], // 본표 회사 고유 줄 포함 합(edgar-cf-wc.ts — NVDA)
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
      { label: "배당금 지급", concepts: ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock", "PaymentsOfOrdinaryDividends"], depth: 1, negate: true },
      { label: "자기주식 취득", concepts: ["PaymentsForRepurchaseOfCommonStock"], depth: 1, negate: true },
      // 차입금(오너 결정 2026-10-10 — StockAnalysis·야후와 같은 구조): 조달·상환 합계 = 단기 + 장기, 단기 순증감 = 순액으로만 공시한 줄.
      // 10-K·10-Q 공시 회사는 본표 차입 줄을 성격대로 모두 합한 합성 개념(회사 고유 줄·기업어음·신용한도 포함, 리스 제외 — edgar-cf-wc.ts DEBT_SYN).
      // 그 밖(20-F)은 표준 개념 목록(2026-10-10 이전 규칙 — MSFT·AMD 개념 포함)
      debtFace ? { label: "차입금 조달 합계", concepts: ["DebtIssuedTotalFaceDerived"], depth: 1, total: true } : { label: "차입금 조달 합계", depth: 1, sumOf: ["단기차입금 조달", "장기차입금 조달"] },
      { label: "단기차입금 조달", concepts: D("DebtIssuedShortFaceDerived", ["ProceedsFromShortTermDebt", "ProceedsFromIssuanceOfCommercialPaper", "ProceedsFromLinesOfCredit"]), depth: 2 },
      { label: "장기차입금 조달", concepts: D("DebtIssuedLongFaceDerived", ["ProceedsFromIssuanceOfLongTermDebt", "ProceedsFromIssuanceOfLongTermDebtAndCapitalSecuritiesNet", "ProceedsFromIssuanceOfDebt", "ProceedsFromDebtNetOfIssuanceCosts", "ProceedsFromDebtMaturingInMoreThanThreeMonths"]), depth: 2 },
      debtFace ? { label: "차입금 상환 합계", concepts: ["DebtRepaidTotalFaceDerived"], depth: 1, negate: true, total: true } : { label: "차입금 상환 합계", depth: 1, sumOf: ["단기차입금 상환", "장기차입금 상환"] },
      { label: "단기차입금 상환", concepts: D("DebtRepaidShortFaceDerived", ["RepaymentsOfShortTermDebt", "RepaymentsOfCommercialPaper", "RepaymentsOfLinesOfCredit"]), depth: 2, negate: true },
      // 전환사채 상환도 장기차입금 상환(TSLA 2024~ RepaymentsOfConvertibleDebt, 2026-10-02)
      { label: "장기차입금 상환", concepts: D("DebtRepaidLongFaceDerived", ["RepaymentsOfLongTermDebt", "RepaymentsOfLongTermDebtAndCapitalSecurities", "RepaymentsOfDebt", "RepaymentsOfConvertibleDebt", "RepaymentsOfDebtAndCapitalLeaseObligations", "RepaymentsOfDebtMaturingInMoreThanThreeMonths"]), depth: 2, negate: true },
      debtFace
        ? { label: "단기차입금 순증감", concepts: ["DebtNetShortFaceDerived"], depth: 1 }
        : {
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
}

const FX = ["EffectOfExchangeRateOnCashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "EffectOfExchangeRateOnCashAndCashEquivalents"];
const NET_CHANGE = [
  "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect",
  "CashAndCashEquivalentsPeriodIncreaseDecrease",
];
// 중단사업 현금흐름(영업·투자·재무 합계 밖 — 2026-09-30 MRK 2021 Organon 분사 349: 없으면 순증감 = 3개 구간 + 환율이 맞지 않았다)
const DISC = ["NetCashProvidedByUsedInDiscontinuedOperations"];
const TAX_PAID = ["IncomeTaxesPaidNet", "IncomeTaxesPaid"];
const INT_PAID = ["InterestPaidNet", "InterestPaid"];

const LTM = "현재/LTM";
const Q4_NO_NINE = "9개월 누적 공시 없음 — 4분기 산정 불가";
/** 공시별 병합 항목의 구성 개념 — 두 기간이 같은 개념을 함께 쓰면서 한쪽에만 있는 개념이 있으면 줄 구성이 다른 것(태그 교체가 아니라 줄이
 *  빠지거나 합쳐짐) → 두 기간을 더하고 빼면 기준이 섞인다(WMT 이연법인세: 10-K 별도 줄, 10-Q 엔 다른 줄에 합산, 2026-10-09) */
type MergedEntry = FactUnitEntry & { cs: Set<string> };
const mixedSets = (a: Set<string>, b: Set<string>) => [...a].some((c) => b.has(c)) && ([...a].some((c) => !b.has(c)) || [...b].some((c) => !a.has(c)));
const fyKey = (y: number) => `${y}Y`;

/**
 * 보통주 배당 근거 — 현금흐름표 "배당 지급"(PaymentsOfDividends, 포괄 태그)이 보통주 배당인지. 포괄 태그에는 비지배지분·종속회사 파트너 분배가 섞일 수
 * 있다(BE: 자회사 Bloom Electrons 의 세금형평 파트너 분배 146.8만·94.7만 달러 — 보통주 배당은 한 번도 없음). 근거가 하나라도 있으면 보통주 배당:
 * 주당배당 태그(USD/shares), 보통주 지급 태그, 자본변동표 배당 결의액 = 지급액(VRT), IFRS 주주 배당 주당액(TSM). 현금흐름표 화면·재무분석이 같이 쓴다
 */
export function hasCommonDividendEvidence(facts: CompanyFacts): boolean {
  return (
    entriesOf(facts, "CommonStockDividendsPerShareDeclared", "USD/shares").length > 0 ||
    entriesOf(facts, "CommonStockDividendsPerShareCashPaid", "USD/shares").length > 0 ||
    entriesOf(facts, "PaymentsOfDividendsCommonStock").length > 0 ||
    entriesOf(facts, "PaymentsOfOrdinaryDividends").length > 0 ||
    Object.values((facts.facts as Record<string, Record<string, { units: Record<string, unknown[]> }> | undefined>)["ifrs-full"]?.["DividendsRecognisedAsDistributionsToOwnersPerShare"]?.units ?? {}).some((l) => l.length > 0) ||
    ["Dividends", "DividendsCommonStock", "DividendsCommonStockCash"].some((c) =>
      entriesOf(facts, c).some((e) => e.start && e.val !== 0 && entriesOf(facts, "PaymentsOfDividends").some((d) => d.start === e.start && d.end === e.end && d.val === e.val)))
  );
}

export function buildUsCashFlow(
  facts: CompanyFacts,
  mode: "annual" | "quarter" = "annual",
  sic?: string | null,
): FinancialStatement {
  const isFin = isFinancialCompany(facts, sic ?? null);
  // 차입 줄 판독 자체가 실패(cfDebt)면 표준 개념 목록으로 바꿔 채우지 않는다 — 합성 개념 줄(빈칸) + 사유
  const BLOCKS = getBlocks(isFin, !!facts.debtFace || unavailableOn(facts, "cfDebt"));
  const opEntries = firstConcept(facts, BLOCKS[0].total.concepts);

  let periods: FinancialPeriod[];
  let valOf: (concepts: string[]) => Record<string, number | null>;
  // LTM 칸 주석(그림자 채우기 금지, 2026-09-27) — 줄별 LTM 공란 사유
  const ltmWhy = new WeakMap<Record<string, number | null>, string>();
  /** 분기 칸 주석(값이 빈 칸의 사유 — 누적 차에 필요한 직전 누적 없음 등) */
  const qWhy = new WeakMap<Record<string, number | null>, Record<string, string>>();
  /** 값이 있는 분기 칸 주석 — 회사 재분류 역산("공시수정 — 1분기 10-Q 공시값 …", edgar-series.ts recastFirstQuarter) */
  const qNote = new WeakMap<Record<string, number | null>, Record<string, string>>();
  const anchor = ltmAnchor(facts);
  /** 분기 모드 — 열별 값과 구성 항목(감가상각비 기준 혼합 판정용) */
  let quarterPartsOf: ((concepts: string[]) => Record<string, QuarterParts>) | null = null;
  /** 같은 분기 규칙을 개념 목록이 아니라 항목 목록에 — 태그를 기간 중간에 바꾼 합산 줄(아래 combineVals)이 공시별 병합 항목으로 쓴다 */
  let quarterPartsOfEntries: ((e: FactUnitEntry[]) => Record<string, QuarterParts>) | null = null;

  if (mode === "quarter") {
    // 분기 열 = 손익계산서와 같은 달력(재무 5층 구조 매출 지표의 분기 열, fin-revenue.ts)에서 Q4 를 뺀 열(현금흐름표는 누적 공시라
    // Q4 열 없음). 예전엔 companyfacts 의 fy·fp 라벨(공시의 회계연도 초점 — 비교 기간에도 같은 라벨이 붙는다)로 열을 묶어 ORCL 은
    // 2025-08-31 분기가 빠졌고, 누적 차에 쓸 직전 열이 전 사업연도가 되어 6개월 누적(3,881M)이 2026 Q2 값으로 나왔다(2026-09-27).
    // fin 분기 열이 없는 회사(20-F 등)만 종전 라벨
    // 4분기 열도 넣는다(2026-10-01 — 손익·재무상태표 분기 화면과 같은 열. 4분기 = 사업연도(10-K) − 9개월 누적(10-Q), 손익 분기 화면과 같은 방식)
    const finQ = facts.revenue?.quarters ?? [];
    const chron: QuarterCol[] = finQ.length
      ? finQ.slice(-6).map((c) => ({ label: revQuarterLabel(c), end: c.end, fyStartApprox: shiftYear(c.end, -1) }))
      : [...recentQuarters(opEntries, 6)].reverse(); // 6개 (0번은 prev 전용)
    periods = chron.slice(-5).map((q) => ({
      label: q.label,
      fiscalYear: Number(q.label.slice(0, 4)),
      fiscalQuarter: Number(q.label.slice(-1)) || null,
      endDate: q.end,
    }));
    const firstIsPrevOnly = chron.length > 5;
    quarterPartsOfEntries = (e) => {
      const out: Record<string, QuarterParts> = {};
      const dd = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;
      const latestOf = (xs: FactUnitEntry[]) => xs.reduce<FactUnitEntry | null>((m, x) => (!m || (x.filed ?? "") > (m.filed ?? "") ? x : m), null);
      chron.forEach((q, i) => {
        if (i === 0 && firstIsPrevOnly) return;
        if (/Q4$/.test(q.label)) {
          const fy = latestOf(e.filter((x) => x.start && ANNUAL_FORMS.includes(x.form) && dd(x.end, q.end) <= 6 && dd(x.start, x.end) >= 350 && dd(x.start, x.end) <= 380));
          const nine = fy ? latestOf(e.filter((x) => x.start && !ANNUAL_FORMS.includes(x.form) && dd(x.start, fy.start!) <= 6 && dd(x.start, x.end) >= 250 && dd(x.start, x.end) <= 290)) : null;
          out[q.label] = fy && nine
            ? { value: fy.val - nine.val, parts: [fy, nine], reason: null }
            : { value: null, parts: [], reason: fy ? Q4_NO_NINE : "사업연도 공시 없음 — 4분기 산정 불가" };
          return;
        }
        out[q.label] = singleQuarterParts(e, q, chron[i - 1]);
      });
      return out;
    };
    quarterPartsOf = (concepts) => quarterPartsOfEntries!(firstConcept(facts, concepts));
    valOf = (concepts) => {
      const parts = quarterPartsOf!(concepts);
      const out: Record<string, number | null> = {};
      const why: Record<string, string> = {};
      const notes: Record<string, string> = {};
      for (const [l, r] of Object.entries(parts)) {
        out[l] = r.value;
        if (r.value == null && r.reason) why[l] = r.reason;
        if (r.value != null && r.note) notes[l] = r.note;
      }
      if (Object.keys(why).length) qWhy.set(out, why);
      if (Object.keys(notes).length) qNote.set(out, notes);
      return out;
    };
  } else {
    const years = [...annualByYear(opEntries).keys()].sort((a, b) => a - b).slice(-5);
    const opAnnualEnds = new Map<number, string>();
    for (const e of opEntries)
      if (e.fp === "FY" && isFullYear(e) && ANNUAL_FORMS.includes(e.form)) {
        const y = fiscalYearOf(e.end);
        if (!opAnnualEnds.has(y) || e.end > opAnnualEnds.get(y)!) opAnnualEnds.set(y, e.end);
      }
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
      // LTM — edgar-series.ts 단일 함수(사업연도 뒤 분기가 있는데 누적이 없으면 공란 + 사유, 550일 규칙 포함)
      const r = ltmFlowOf(entries, anchor);
      out[LTM] = r.value;
      if (r.value == null && r.reason) ltmWhy.set(out, r.reason);
      return out;
    };
  }
  const labels = periods.map((p) => p.label);
  const blank = (): Record<string, number | null> =>
    Object.fromEntries(labels.map((l) => [l, null]));
  /** 줄의 LTM 칸 주석 — 값이 빈 칸만 */
  const ltmCell = (v: Record<string, number | null>): { cellNotes?: Record<string, string> } => {
    const w = ltmWhy.get(v);
    const m: Record<string, string> = {};
    if (w && labels.includes(LTM) && v[LTM] == null) m[LTM] = w;
    for (const [l, t] of Object.entries(qWhy.get(v) ?? {})) if (v[l] == null && !m[l]) m[l] = t;
    for (const [l, t] of Object.entries(qNote.get(v) ?? {})) if (v[l] != null && !m[l]) m[l] = t;
    return Object.keys(m).length ? { cellNotes: m } : {};
  };
  // 최근 연도엔 있는데 LTM 만 빈 값(분기 공시에 없음·Yahoo 분기 미매핑)은 합산·차감에서 0 으로 보지 않는다 — 부분 합·"기타"
  // 잔여가 부푸는 것 방지(20-F 뿐 아니라 모든 회사 — 그림자 채우기 금지, 2026-09-27)
  const ylCf = labels.includes(LTM);
  const prevLbl = labels[labels.length - 2];
  const ltmGap = (v: Record<string, number | null> | undefined) => !!ylCf && !!v && v[LTM] == null && v[prevLbl] != null;
  const GAP_NOTE = "LTM 구성 분기 없음(구성 항목이 분기 공시에 없음)";
  // 합계 태그 → 그 구성 태그(같은 기간에 합계가 있으면 구성은 더하지 않는다 — 이중 합산 방지, NVDA 는 셋 다 공시, 2026-10-02)
  const SUPERSEDES: Record<string, string[]> = {
    ProceedsFromSaleAndMaturityOfAvailableForSaleSecurities: ["ProceedsFromSaleOfAvailableForSaleSecuritiesDebt", "ProceedsFromMaturitiesPrepaymentsAndCallsOfAvailableForSaleSecurities"],
    // 본표 줄 전부 합(회사 고유 줄 포함) — 그 공시·기간의 표준 구성 개념을 모두 대신한다
    ...Object.fromEntries(CF_INV_FAMILIES.map((f) => [f.derived, cfInvStdConcepts(f.label)])),
  };
  const combineVals = (parts: [string, boolean][]): Record<string, number | null> => {
    const out: Record<string, number | null> = {};
    for (const lbl of labels) out[lbl] = null;
    let gap = false;
    const vals = new Map(parts.map(([c]) => [c, valOf([c])] as const));
    const skipAt = (concept: string, lbl: string) =>
      Object.entries(SUPERSEDES).some(([tot, comps]) => comps.includes(concept) && vals.get(tot)?.[lbl] != null);
    for (const [concept, neg] of parts) {
      const v = vals.get(concept)!;
      if (ltmGap(v) && !skipAt(concept, LTM)) gap = true;
      for (const lbl of labels) {
        const x = v[lbl];
        if (x == null || skipAt(concept, lbl)) continue;
        out[lbl] = (out[lbl] ?? 0) + (neg ? -x : x);
      }
    }
    // 태그를 기간 중간에 바꾼 줄(TSLA 2026 분기 "투자자산 취득" — PaymentsToAcquireInvestments → PaymentsToAcquireShortTermInvestments)은
    // 태그별 LTM 이 모두 빈다 — 기간마다 가장 최근 공시 한 건에 실린 구성 태그 합으로 기간 값을 만든 뒤 같은 LTM 함수로(2026-10-02, 야후 분기 합과 일치).
    // 같은 기간을 옛 태그(옛 공시)와 새 태그(새 공시 비교 열)가 함께 담아도 한 공시만 쓰므로 이중 합산되지 않는다
    const merged = (): MergedEntry[] => {
      // 공시 구분 = 제출일(filed) + 양식(form) — companyfacts 항목에는 접수번호가 없다
      const byPeriod = new Map<string, { filed: string; form: string; e: FactUnitEntry; sum: number; cs: Set<string> }>();
      for (const [concept, neg] of parts)
        for (const e of entriesOf(facts, concept)) {
          if (!e.start) continue;
          const k = `${e.start}|${e.end}`;
          const cur = byPeriod.get(k);
          const filed = e.filed ?? "";
          if (!cur || filed > cur.filed) byPeriod.set(k, { filed, form: e.form, e, sum: neg ? -e.val : e.val, cs: new Set([concept]) });
          else if (filed === cur.filed && e.form === cur.form) { cur.sum += neg ? -e.val : e.val; cur.cs.add(concept); }
        }
      // 합계 태그와 구성 태그가 같은 공시·기간에 함께 있으면 구성 분을 뺀다
      for (const [k, x] of byPeriod)
        for (const [tot, comps] of Object.entries(SUPERSEDES)) {
          const has = (c: string) => entriesOf(facts, c).find((e) => `${e.start}|${e.end}` === k && (e.filed ?? "") === x.filed && e.form === x.form);
          if (!parts.some(([c]) => c === tot) || !has(tot)) continue;
          for (const c of comps) {
            const e = has(c);
            const neg = parts.find(([pc]) => pc === c)?.[1];
            if (e && neg != null) { x.sum -= neg ? -e.val : e.val; x.cs.delete(c); }
          }
        }
      return [...byPeriod.values()].map((x) => ({ ...x.e, val: x.sum, cs: x.cs }));
    };
    // 분기 열(2026-10-09): 개념별로 못 낸 칸을 공시별 병합 항목으로 다시 낸다(META 2025 Q4 투자자산 — 10-K 는 MarketableSecurities, 10-Q 는
    // AvailableForSale 태그라 개념별 4분기 = 사업연도 − 9개월이 모두 비어 "본표에 별도 줄 없음"이 붙었다). 한 개념만 사업연도 값이 있고 9개월 누적이
    // 없으면(그 줄이 10-Q 에선 다른 줄에 합쳐짐) 나머지 개념 합은 부분값이라 빈칸 + 사유(WMT 2026 Q4 기타 비현금 조정 — 이연법인세)
    if (mode === "quarter" && quarterPartsOfEntries) {
      const why: Record<string, string> = {};
      let mq: Record<string, QuarterParts> | null = null;
      for (const lbl of labels) {
        const per = parts.map(([c]) => ({ v: vals.get(c)![lbl], r: qWhy.get(vals.get(c)!)?.[lbl] }));
        const partial = out[lbl] != null && per.some((x) => x.v == null && x.r === Q4_NO_NINE);
        if (out[lbl] != null && !partial) continue;
        mq ??= quarterPartsOfEntries(merged());
        const m = mq[lbl];
        const ok = m?.value != null && !(m.parts.length === 2 && mixedSets((m.parts[0] as MergedEntry).cs, (m.parts[1] as MergedEntry).cs));
        if (ok) { out[lbl] = m!.value; continue; }
        if (partial) { out[lbl] = null; why[lbl] = Q4_NO_NINE; continue; }
        const r0 = per.map((x) => x.r).find(Boolean);
        if (r0) why[lbl] = r0;
      }
      if (Object.keys(why).length) qWhy.set(out, why);
    }
    if (gap && mode !== "quarter" && labels.includes(LTM)) {
      const r = ltmFlowOf(merged(), anchor);
      // 사업연도·당기 누적·전년 동기의 구성 개념이 서로 다르면(한 줄이 빠지거나 합쳐짐) 기준이 섞인 값이라 쓰지 않는다(WMT 기타 비현금 조정 LTM)
      const ps = [r.fy, r.cur, r.prior].filter(Boolean) as MergedEntry[];
      const mix = ps.some((a, i) => ps.some((b, j) => j > i && mixedSets(a.cs, b.cs)));
      if (r.value != null && !mix) {
        out[LTM] = r.value;
        gap = false;
      }
    }
    if (gap) {
      out[LTM] = null;
      ltmWhy.set(out, GAP_NOTE);
    } else if (labels.includes(LTM) && out[LTM] == null) {
      // 구성 개념이 모두 LTM 에서 비었다(태그 중단 등) — 첫 구성 사유
      const why = parts.map(([c]) => ltmWhy.get(valOf([c]))).find(Boolean);
      if (why) ltmWhy.set(out, why);
    }
    return out;
  };
  const applyNegate = (v: Record<string, number | null>): Record<string, number | null> => {
    const out: Record<string, number | null> = {};
    for (const lbl of labels) out[lbl] = v[lbl] == null ? null : -(v[lbl] as number);
    return out;
  };

  const items: FinancialLineItem[] = [];
  /** 줄 칸 주석 — LTM 사유(ltmCell) + 분기 칸 사유(cellWhy, 값이 빈 칸만) */
  const cellsOf = (v: Record<string, number | null>): { cellNotes?: Record<string, string> } => {
    const m: Record<string, string> = { ...(ltmCell(v).cellNotes ?? {}) };
    for (const [l, t] of Object.entries(cellWhy.get(v) ?? {})) if (v[l] == null && !m[l]) m[l] = t;
    return Object.keys(m).length ? { cellNotes: m } : {};
  };
  const daOut = unavailableOn(facts, "da");
  /** 본표 판독 회사인데 본표 값이 없어 감가상각비를 비운 칸(분기·LTM) — 같은 구간의 잔여("기타") 줄도 함께 비운다 */
  const daBlank = new Set<string>();
  /** 분기 칸 주석(감가상각비 공란 사유) */
  const cellWhy = new WeakMap<Record<string, number | null>, Record<string, string>>();

  // **운전자본 변동 = 회사가 공시한 영업 자산·부채 순변동 합계가 있으면 그 값(2026-10-02)** — KO 등은 분기 현금흐름표를 요약형으로 내
  // 매출채권·재고·매입채무를 나누지 않고 IncreaseDecreaseInOperatingCapital 한 줄만 공시한다. 하위 줄 합으로만 만들면 분기에 하위 줄이 없어
  // LTM 운전자본·기타 영업활동이 통째로 비었고(오너 지적), 연간도 하위 세 줄 밖 운전자본(선급·미지급 등)이 "기타 영업활동"으로 샜다
  // 회사 공시 순변동 → 본표 운전자본 줄 합(edgar-cf-wc.ts, 10-K 는 항목별·10-Q 는 한 줄인 회사도 같은 정의)
  const wcCo = applyNegate(valOf(["IncreaseDecreaseInOperatingCapital", "OperatingCapitalCashFlowDerived"]));
  // 형제 줄 LTM 이 빈칸인데 최근 1년 안 분기 공시에 그 줄 값(0 아님)이 있으면 금액은 있는데 LTM 을 못 만든 것 — 잔여("기타") 줄이 그 금액을 떠안지
  // 않게 함께 빈칸(2026-10-09 — GEV 사업 인수: 10-K 본표엔 줄이 없고 2026 1분기 10-Q 에 −4,886 → "기타 투자활동" LTM 이 −2,902 로 떠안았다.
  // 영업활동은 이미 ltmGap(최근 사업연도엔 값 있음)으로 비우던 것과 같은 규칙)
  const ltmOpenRecent = (l: Line, v: Record<string, number | null> | undefined): boolean => {
    if (!ylCf || !v || v[LTM] != null || !anchor) return false;
    const from = shiftYear(anchor, -1);
    const cs = [...(l.concepts ?? []), ...(l.combine ?? []).map(([c]) => c), ...(l.fallbackCombine ?? []).map(([c]) => c)];
    return cs.some((c) => entriesOf(facts, c).some((e) => e.start && !ANNUAL_FORMS.includes(e.form) && e.end > from && e.val !== 0));
  };
  for (const block of BLOCKS) {
    const totalVals = valOf(block.total.concepts);
    // 매핑된 형제 라인(플러그 제외, subtotal 제외) 합 — 플러그 계산용
    const resolved: Record<string, Record<string, number | null>> = {};
    for (const line of block.lines) {
      if (line.kind === "subtotal" || line.plug || line.wcRest || line.sumOf) continue;
      let v: Record<string, number | null>;
      if (line.pickDa) {
        const totals = DA_TOTAL.map((c) => valOf([c]));
        const dep = valOf(DA_DEPRECIATION);
        const am = valOf([DA_INTANGIBLE]);
        // 본표 계열(현금흐름표 계산 구조·NFLX 콘텐츠 상각 포함 — edgar-ev.ts daStructConcept). 분기·LTM 칸은 본표 값만(없으면 공란 + 사유)
        const sc = daStructConcept(facts);
        const cf = sc ? valOf([sc]) : blank();
        v = {};
        if (qNote.get(cf)) qNote.set(v, qNote.get(cf)!);
        // 본표 판독이 원본 조회 실패로 빠졌으면 공란 — 태그 규칙 값으로 대체하지 않는다(sec-unavailable.ts)
        for (const l of labels) {
          const strict = !!sc && (mode === "quarter" || l === LTM);
          v[l] = daOut ? null : strict ? pickDaPeriod(true, [], null, null, cf[l]) : pickDa(totals.map((t) => t[l]), dep[l], am[l], cf[l]);
          if (!daOut && strict && v[l] == null) {
            daBlank.add(l);
            if (l === LTM) ltmWhy.set(v, DA_LTM_NO_STRUCT);
            else cellWhy.set(v, { ...(cellWhy.get(v) ?? {}), [l]: qWhy.get(cf)?.[l] ?? DA_QUARTER_NO_STRUCT });
          }
        }
        if (sc && !daOut) {
          // 파생 열(누적 차·LTM)의 구성 공시끼리 감가상각 줄 기준이 다르면 공란 + 사유(edgar-ev.ts daBasisMixed). 분기 3개월 값은 그대로
          if (quarterPartsOf) {
            for (const [l, r] of Object.entries(quarterPartsOf([sc])))
              if (v[l] != null && daBasisMixed(facts, r.parts)) {
                v[l] = null;
                daBlank.add(l);
                cellWhy.set(v, { ...(cellWhy.get(v) ?? {}), [l]: DA_BASIS_MIX });
              }
          } else if (labels.includes(LTM)) {
            const c = daTtmCell(facts);
            v[LTM] = c.value;
            if (c.value == null) {
              daBlank.add(LTM);
              if (c.reason) ltmWhy.set(v, c.reason);
            } else if (c.note) qNote.set(v, { ...(qNote.get(v) ?? {}), [LTM]: c.note });
          }
        }
        // 최근 연도엔 있는데 LTM 에 없는 합계 태그가 있으면(구성항목 합이면 구성 태그도) 나머지로 낸 값은 부분값 — 공란
        if (labels.includes(LTM) && !daOut && cf[LTM] == null) {
          const totalLtm = totals.some((t) => t[LTM] != null);
          if (totals.some(ltmGap) || (!totalLtm && (ltmGap(dep) || ltmGap(am)))) v[LTM] = null;
        }
        if (labels.includes(LTM) && !daOut && v[LTM] == null && v[prevLbl] != null && !ltmWhy.get(v)) ltmWhy.set(v, "LTM 감가상각비 구성 분기 없음");
      } else if (line.combine) v = combineVals(line.combine);
      else v = valOf(line.concepts ?? []);
      if (line.fallbackCombine && labels.some((l) => v[l] == null)) {
        const fb = combineVals(line.fallbackCombine);
        const primaryGap = ltmGap(v);
        for (const l of labels) if (v[l] == null && fb[l] != null && !(l === LTM && primaryGap)) v[l] = fb[l];
      }
      if (line.negate) {
        const why = ltmWhy.get(v);
        const qw = qWhy.get(v);
        v = applyNegate(v);
        if (why) ltmWhy.set(v, why);
        if (qw) qWhy.set(v, qw);
      }
      resolved[line.label] = v;
    }

    // 표시용 합계 줄(차입금 조달·상환 합계) — 하위 줄이 모두 빈칸이면 빈칸. 하위 줄 하나가 계산 불가 사유(분기 산정 불가·LTM 구성 분기 없음)로 비면
    // 부분합이라 함께 빈칸(같은 사유), 본표에 줄이 없어 빈 하위 줄은 0 으로 본다
    for (const line of block.lines) {
      if (!line.sumOf) continue;
      const kids = line.sumOf.map((k) => resolved[k] ?? blank());
      const v: Record<string, number | null> = {};
      const why: Record<string, string> = {};
      for (const lbl of labels) {
        const xs = kids.map((k) => k[lbl]);
        if (xs.every((x) => x == null)) { v[lbl] = null; continue; }
        const open = kids.find((k) => k[lbl] == null && (lbl === LTM ? ltmGap(k) || !!ltmWhy.get(k) : !!qWhy.get(k)?.[lbl]));
        if (open) { v[lbl] = null; const r = lbl === LTM ? (ltmGap(open) ? GAP_NOTE : ltmWhy.get(open)) : qWhy.get(open)?.[lbl]; if (r) why[lbl] = r; continue; }
        v[lbl] = xs.reduce((t: number, x) => t + (x ?? 0), 0);
      }
      if (why[LTM]) ltmWhy.set(v, why[LTM]);
      const qw = Object.fromEntries(Object.entries(why).filter(([l]) => l !== LTM));
      if (Object.keys(qw).length) qWhy.set(v, qw);
      resolved[line.label] = v;
    }

    /** 합계 줄(total) 바로 아래 하위 줄 — 잔여 계산은 합계 줄로 하므로 제외 */
    const underTotal = (l: Line): boolean => {
      if (l.depth !== 2) return false;
      const i = block.lines.indexOf(l);
      for (let j = i - 1; j >= 0; j--) if (block.lines[j].depth === 1) return !!block.lines[j].total;
      return false;
    };
    let wcVals: Record<string, number | null> | null = null;
    for (const line of block.lines) {
      let values: Record<string, number | null>;
      if (line.kind === "subtotal") {
        // 다음 depth 라인들 합 (운전자본 변동)
        const kids = block.lines.filter(
          (l) => l.depth === line.depth + 1 && !l.plug && !l.wcRest,
        );
        values = {};
        for (const lbl of labels) {
          if (wcCo[lbl] != null) { values[lbl] = wcCo[lbl]; continue; }
          let s: number | null = null;
          for (const k of kids) {
            const x = resolved[k.label]?.[lbl];
            if (x != null) s = (s ?? 0) + x;
          }
          values[lbl] = lbl === LTM && kids.some((k) => ltmGap(resolved[k.label])) ? null : s;
        }
        if (labels.includes(LTM) && values[LTM] == null) {
          const why = kids.some((k) => ltmGap(resolved[k.label])) ? GAP_NOTE : kids.map((k) => ltmWhy.get(resolved[k.label])).find(Boolean);
          if (why) ltmWhy.set(values, why);
        }
        wcVals = values;
      } else if (line.wcRest) {
        // 기타 운전자본 증감 = 회사 공시 운전자본 합계 − 이름 있는 하위 줄 합. 합계가 하위 줄 합에서 나온 칸(wcCo 없음)·이름 있는 하위 줄이 모두
        // 빈 칸(KO 분기 요약형 — 한 줄만 공시)·차가 0 인 칸은 빈칸. LTM 은 이름 있는 하위 줄이 LTM 구성 분기를 못 채우면 빈칸
        const named = block.lines.filter((l) => l.depth === line.depth && !l.plug && !l.wcRest && l.kind !== "subtotal");
        values = {};
        for (const lbl of labels) {
          const tot = wcVals?.[lbl] ?? null;
          const xs = named.map((k) => resolved[k.label]?.[lbl] ?? null);
          const gap = lbl === LTM && named.some((k) => ltmGap(resolved[k.label]));
          if (wcCo[lbl] == null || tot == null || gap || xs.every((x) => x == null)) { values[lbl] = null; continue; }
          const r = Math.round(tot - xs.reduce((t: number, x) => t + (x ?? 0), 0));
          values[lbl] = r === 0 ? null : r;
        }
      } else if (line.plug) {
        values = {};
        let plugWhyNote: string | null = null;
        for (const lbl of labels) {
          const tot = totalVals[lbl];
          // 감가상각비가 공란(원본 조회 실패)인 구간의 잔여 줄은 감가상각비를 떠안아 다른 숫자가 되므로 함께 공란
          if (tot == null || ((daOut || daBlank.has(lbl)) && block.lines.some((l) => l.pickDa))) {
            values[lbl] = null;
            if (lbl === LTM && tot == null && ltmWhy.get(totalVals)) plugWhyNote = ltmWhy.get(totalVals)!;
            else if (tot != null && daBlank.has(lbl)) {
              const t = "감가상각비 공란 구간 — 잔여 줄이 감가상각비를 떠안지 않게 함께 공란";
              if (lbl === LTM) plugWhyNote = t;
              else cellWhy.set(values, { ...(cellWhy.get(values) ?? {}), [lbl]: t });
            }
            continue;
          }
          let mapped = 0;
          for (const l of block.lines) {
            if (l.kind === "subtotal" || l.plug || l.sumOf) continue;
            if (l.depth !== 1) continue; // depth1 형제만(합계 줄 total 포함)
            mapped += resolved[l.label]?.[lbl] ?? 0;
          }
          // depth2 (운전자본 하위)는 subtotal 로 depth1 에 이미 반영 안 됨 → 별도 가산. 회사 공시 운전자본 합계가 있는 칸은 그 합계(하위 줄 대신)
          const hasWc = block.lines.some((l) => l.kind === "subtotal") && wcCo[lbl] != null;
          if (hasWc) mapped += wcCo[lbl]!;
          else
            for (const l of block.lines) {
              if (l.depth === 2 && !l.plug && !l.wcRest && !underTotal(l)) mapped += resolved[l.label]?.[lbl] ?? 0;
            }
          const gap = lbl === LTM && block.lines.some((l) => l.kind !== "subtotal" && !l.plug && !l.wcRest && !l.sumOf && !underTotal(l) && (l.depth === 1 || (l.depth === 2 && !hasWc)) && (ltmGap(resolved[l.label]) || ltmOpenRecent(l, resolved[l.label])));
          values[lbl] = gap ? null : Math.round(tot - mapped);
          if (gap) ltmWhy.set(values, GAP_NOTE);
        }
        if (plugWhyNote && !ltmWhy.get(values)) ltmWhy.set(values, plugWhyNote);
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
        ...cellsOf(values),
      });
    }
    items.push({
      accountName: block.total.label,
      accountId: `cf:total:${block.title}`,
      depth: 0,
      isSubtotal: true,
      isHighlight: true,
      values: totalVals,
      ...ltmCell(totalVals),
    });
  }

  // 순증감 · 환율효과(= 순증감 − 3개 구간 합, 미보고 시 잔여)
  const netChange = valOf(NET_CHANGE);
  const fxReported = valOf(FX);
  const disc = valOf(DISC);
  const hasDisc = labels.some((l) => disc[l] != null && disc[l] !== 0);
  const sect = (i: number) => {
    const it = items.find((x) => x.accountId === `cf:total:${BLOCKS[i].title}`);
    return it?.values ?? {};
  };
  const fx: Record<string, number | null> = {};
  let fxWhy: string | null = null;
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
        ? Math.round(nc - s0 - s1 - s2 - (disc[lbl] ?? 0))
        : null;
    if (lbl === LTM && fx[lbl] == null)
      fxWhy = ltmWhy.get(netChange) ?? ltmWhy.get(fxReported) ?? "환율변동 효과 산정 불가(순증감·구간 합계 중 LTM 없음)";
  }
  if (fxWhy) ltmWhy.set(fx, fxWhy);
  if (hasDisc)
    items.push({ accountName: "중단사업 현금흐름", accountId: "cf:disc", depth: 0, isSubtotal: false, isHighlight: false, values: disc, ...ltmCell(disc) });
  items.push({
    accountName: "환율변동 효과",
    accountId: "cf:fx",
    depth: 0,
    isSubtotal: false,
    isHighlight: false,
    values: fx,
    ...ltmCell(fx),
  });
  items.push({
    accountName: "현금및현금성자산 순증감",
    accountId: "cf:netchange",
    depth: 0,
    isSubtotal: true,
    isHighlight: true,
    values: netChange,
    ...ltmCell(netChange),
  });
  // ── 주석 항목 ──
  items.push({ accountName: "", accountId: "cf:sp", depth: 0, isSubtotal: false, isHighlight: false, values: blank() });
  // SEC 원본 조회 실패로 공란이 된 값(감가상각비·기타 영업활동 — 대체 계산 없음, sec-unavailable.ts)
  const unavailable = unavailableNote(facts);
  if (unavailable)
    items.push({ accountName: `※ ${unavailable}`, accountId: "cf:note:unavailable", depth: 1, isSubtotal: false, isHighlight: false, italic: true, values: blank() });
  items.push({ accountName: "[ 주석 항목 ]", accountId: "cf:note", depth: 0, isSubtotal: true, isHighlight: false, values: blank() });

  const capex = valOf(["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets", "PaymentsForCapitalImprovements", "CapexComponentsDerived"]);
  const opCf = sect(0);
  const fcf: Record<string, number | null> = {};
  for (const l of labels)
    if (opCf[l] != null && capex[l] != null) fcf[l] = Math.round(opCf[l]! - Math.abs(capex[l]!));
  const fcfWhy = ltmWhy.get(capex) ?? (labels.includes(LTM) && opCf[LTM] == null ? ltmWhy.get(valOf(BLOCKS[0].total.concepts)) : undefined);
  if (fcfWhy) ltmWhy.set(fcf, fcfWhy);
  items.push({ accountName: "자본적지출 (CapEx)", accountId: "cf:note:capex", depth: 1, isSubtotal: false, isHighlight: false, values: capex, ...ltmCell(capex) });
  items.push({ accountName: "잉여현금흐름 (FCF)", accountId: "cf:note:fcf", depth: 1, isSubtotal: false, isHighlight: false, values: fcf, ...ltmCell(fcf) });

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
      ...ltmCell(tax),
    });
  if (labels.some((l) => intp[l] != null))
    items.push({
      accountName: "이자 지급액",
      accountId: "cf:intpaid",
      depth: 1,
      isSubtotal: false,
      isHighlight: false,
      values: intp,
      ...ltmCell(intp),
    });

  // 보통주 배당 근거가 없는데 포괄 배당 태그 금액이 있으면 그 줄은 보통주 배당이 아니다(BE — 비지배지분·파트너 분배) — 이름으로 밝힌다(2026-10-01)
  if (!hasCommonDividendEvidence(facts)) {
    const it = items.find((x) => x.accountId === "cf:재무활동 현금흐름:배당금 지급");
    if (it && Object.values(it.values ?? {}).some((v) => v != null && v !== 0)) {
      // 설명은 칸 주석에만(오너 지시 2026-10-02 — 줄 이름에 설명을 넣지 않는다)
      it.accountName = "배당·분배 지급";
      const why = "보통주 배당 아님 — 비지배지분·파트너 분배(보통주 배당 근거 없음)";
      const cn: Record<string, string> = { ...(it.cellNotes ?? {}) };
      for (const [k, v] of Object.entries(it.values ?? {})) if (v != null && v !== 0 && !cn[k]) cn[k] = why;
      it.cellNotes = cn;
    }
  }
  // 차입금 줄 칸 사유(edgar-cf-debt.ts) — 판독 실패·분류 교체로 비운 칸에 그 사유. 판독 실패 기간·차입 판독 전체 실패(cfDebt)는 잔여 줄(기타 재무활동)도
  // 빈칸 — 차입 금액을 떠안지 않게(예전엔 그 해 차입이 기타로 들어갔다, 4a9b30d 전 GLW 2021)
  {
    const LINE_C: Record<string, string> = {
      "단기차입금 조달": "DebtIssuedShortFaceDerived", "장기차입금 조달": "DebtIssuedLongFaceDerived", "차입금 조달 합계": "DebtIssuedTotalFaceDerived",
      "단기차입금 상환": "DebtRepaidShortFaceDerived", "장기차입금 상환": "DebtRepaidLongFaceDerived", "차입금 상환 합계": "DebtRepaidTotalFaceDerived",
      "단기차입금 순증감": "DebtNetShortFaceDerived",
    };
    const cfOut = unavailableOn(facts, "cfDebt");
    const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 7 * 864e5;
    const fyEnd = mode === "quarter" ? null : periods[periods.length - 2]?.endDate ?? null;
    // LTM 구성 기간의 결산일(사업연도 + 당기 누적 − 전년 동기)
    const ltmEnds = anchor ? [anchor, shiftYear(anchor, -1), ...(fyEnd ? [fyEnd] : [])] : [];
    const endsOf = (p: FinancialPeriod) => (p.label === LTM ? ltmEnds : p.endDate ? [p.endDate] : []);
    const outNote = cfOut ? unavailableNote(facts) ?? "원본 조회 실패" : null;
    for (const it of items) {
      const line = it.accountId?.startsWith("cf:재무활동 현금흐름:") ? it.accountId!.slice("cf:재무활동 현금흐름:".length) : null;
      if (!line) continue;
      const concept = LINE_C[line];
      if (concept) {
        for (const p of periods) {
          if (cfOut) { it.values[p.label] = null; it.cellNotes = { ...(it.cellNotes ?? {}), [p.label]: outNote! }; continue; }
          if (it.values[p.label] != null) continue;
          const b = (facts.debtBlanks ?? []).find((x) => x.concept === concept && endsOf(p).some((e) => near(x.end, e)));
          if (b) it.cellNotes = { ...(it.cellNotes ?? {}), [p.label]: b.reason };
        }
      } else if (line === "기타 재무활동") {
        for (const p of periods) {
          const unread = cfOut || (facts.debtUnreadEnds ?? []).some((e) => endsOf(p).some((x) => near(x, e)));
          if (!unread) continue;
          it.values[p.label] = null;
          it.cellNotes = { ...(it.cellNotes ?? {}), [p.label]: cfOut ? outNote! : `${DEBT_UNREAD_NOTE} — 차입 금액을 떠안지 않게 함께 공란` };
        }
      }
    }
  }
  // 무배당 = 0(오너 결정 2026-10-02): 그 기간에 배당 공시가 하나도 없으면 배당금 지급 0. 그 밖의 사유 없는 빈 칸은 "본표에 별도 줄 없음"
  // (0 으로 채우지 않는다 — 다른 줄에 합쳐 공시했을 수 있음). 열의 현금흐름표가 있을 때만(영업활동 현금흐름 값 있음)
  {
    const opTot = items.find((x) => x.accountId === "cf:total:영업활동 현금흐름");
    const present = periods.map((p) => p.label).filter((l) => opTot?.values[l] != null);
    const div = items.find((x) => x.accountId === "cf:재무활동 현금흐름:배당금 지급");
    if (div)
      for (const p of periods) {
        // 구성 기간 부족 사유("LTM 구성 분기 없음"·"4분기 산정 불가")는 무배당 판정보다 앞서 달린 것 — 그 기간에 배당 공시가 하나도 없으면 0 이 정답이라
        // 덮어쓴다(2026-10-09, ISRG LTM — 연간 열은 0 인데 LTM 만 빈칸이던 것). 다른 사유가 달린 칸은 그대로
        const why0 = div.cellNotes?.[p.label];
        if (!present.includes(p.label) || div.values[p.label] != null || (why0 && !/^LTM 구성 분기 없음|4분기 산정 불가/.test(why0))) continue;
        const free = p.endDate
          ? p.fiscalQuarter == null && p.label !== "현재/LTM"
            ? dividendFreeYear(facts, p.fiscalYear)
            : dividendFreeSince(facts, new Date(Date.parse(p.endDate) - 365 * 864e5).toISOString().slice(0, 10), p.endDate)
          : false;
        if (free) {
          div.values[p.label] = 0;
          if (why0 && div.cellNotes) { const { [p.label]: _drop, ...rest } = div.cellNotes; void _drop; div.cellNotes = rest; }
        }
      }
    fillBlankReasons(items, present);
  }
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
