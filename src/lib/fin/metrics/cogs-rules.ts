/**
 * 3층 — 본표에 매출원가 줄이 없는 회사(유형 D)의 매출원가 구성 규칙(docs/metrics/cogs.md §3·§6). **회사별 규칙은 이 표 한 곳.**
 *
 * 오너 결정(2026-09-26): 유형 D 는 빈칸으로 두지 않는다 — 회사마다 본표 줄 조합(개념·부호)으로 매출원가를 정한다.
 * 조합(리드 결정 2026-09-27, 조사 scratchpad cogs-dtype/rules.json·report.md): 매출과 영업이익 사이 본표 비용 줄 중
 * 판관비류·연구개발비·**별도 줄 감가상각·상각**(오너 지시 — 넣지 않음)·손상·구조조정·소송·처분·일반 "기타" 줄(라벨이 매장·제품 원가를
 * 가리키면 포함 — MCD 기타 매장비용)·비소득세·탐사비·이자를 뺀 나머지. 영업이익은 본표 값 그대로(opinc.ts).
 * `rule: null` 이면 대기 — 매출원가·매출총이익을 비우고 사유 "구성 규칙 대기"(화면 주석에 그대로 표시).
 *
 * 규칙(`rule`):
 *  - terms: 본표(손익계산서 표시 구조) 줄의 개념 id 후보와 부호. 열의 구성 공시마다 **그 공시 본표에 있는** 첫 후보를 읽는다
 *    (assemble/is.ts readCogsTerms — 공시마다 개념 이름이 바뀌는 회사: ORCL·DAL·HLT·MCD). 후보가 배열이면 그 줄들의 합(MCD 10-K
 *    직영점 비용 세 줄 ↔ 10-Q 한 줄). "개념[축=멤버]" 는 본표 차원 줄(MAR — 무차원 합계 줄 없이 멤버로만 공시).
 *    optional: 그 공시 본표에 줄이 없거나 값이 없으면 0(CEG 계열사 줄은 분사 후 사라짐, DAL 조종사 합의금은 2023 한 해). optional 이
 *    아닌 항이 한 공시에서라도 없으면 그 칸은 빈칸 + 사유(조용히 0 으로 두지 않는다)
 *  - label: 화면 주석에 쓰는 구성 설명(화면에는 "구성: …" 로 붙는다)
 *  - evidence: 공시 accn 과 숫자(overrides.ts 와 같은 S2 규칙 — 없으면 로드 시 예외)
 *  - 매출총이익은 매출 − 이 매출원가로 합성한다("본표 소계 없음 · 매출 − 매출원가(구성: label)")
 * 검증기는 같은 규칙을 데이터 파일(scripts/metrics/cogs-rules.json, --cogs-rules)로 받는다 — 규칙표를 공유하므로 이 행들은 설계상
 * 공통모드(COMMON)이고, 외부 2곳 이상이 기간별로 정확 일치할 때만 닫힌다(cogs.md §6).
 */

/** 항 형식은 types.ts(2층 assemble/is.ts 가 읽는다 — 2층은 3층을 import 하지 않음) */
import type { CogsTerm } from "../types";
export type { CogsTerm };

export interface CogsRule {
  terms: CogsTerm[];
  label: string;
  /** 공시 accn 과 숫자로 된 근거 */
  evidence: string;
  since: string;
}

export interface CogsRuleEntry {
  symbol: string;
  /** null = 구성 규칙 대기(매출원가·매출총이익 빈칸 + 사유) */
  rule: CogsRule | null;
}

/** 유형 D(본표에 매출원가 줄 없음) — cogs.md §3 조사 결과 10종목(백만 달러 근거).
 *  AXP 는 제외 — 카드·보험·은행은 금융사 기준(오너 2026-09-26, 앱 금융사 판정 SIC 60~64 과 같음): cogs.ts FIN_TYPES */
export const COGS_RULES: CogsRuleEntry[] = [
  { symbol: "XOM", rule: {
    terms: [
      { group: "purch", concepts: ["xom:CrudeOilAndProductPurchases"], sign: 1 },
      { group: "prodmfg", concepts: ["xom:ProductionAndManufacturingExpenses"], sign: 1 },
    ],
    label: "원유·제품 매입 + 생산·제조비",
    evidence: "10-K 0000034088-26-000045 FY2025: 원유·제품 매입 184,248 + 생산·제조비 42,424 = 226,672 · Yahoo = 이 값 + DD&A 9/9, SA 분기 9/9 정확",
    since: "2026-09-27",
  } },
  { symbol: "MCD", rule: {
    terms: [
      { group: "coOperated", concepts: [["mcd:FoodAndPaperCosts", "mcd:PayrollAndEmployeeBenefits", "mcd:OccupancyAndOtherOperatingExpenses"], "mcd:CompanyOperatedRestaurantExpenses"], sign: 1 },
      // 10-Q 는 가맹점 임차비용 줄을 us-gaap:CostOfGoodsAndServicesSold 로 태깅(라벨 "Franchised restaurants-occupancy expenses")
      { group: "franOcc", concepts: ["mcd:Franchisedrestaurantsoccupancyexpenses", "us-gaap:CostOfGoodsAndServicesSold"], sign: 1 },
      { group: "otherRest", concepts: ["us-gaap:OtherExpenses"], sign: 1 },
    ],
    label: "직영점 비용(식자재·인건비·임차 및 기타) + 가맹점 임차비용 + 기타 매장비용",
    evidence: "10-K 0000063908-26-000035 FY2025: 직영점 비용 8,269(3,006+2,905+2,358) + 가맹점 임차 2,618 + 기타 매장비용 564 = 11,451 · Yahoo 9/9·SA 17/17 정확",
    since: "2026-09-27",
  } },
  { symbol: "V", rule: {
    terms: [
      { group: "personnel", concepts: ["us-gaap:LaborAndRelatedExpense"], sign: 1 },
      { group: "network", concepts: ["us-gaap:CommunicationsAndInformationTechnology"], sign: 1 },
    ],
    label: "인건비 + 네트워크·처리비(원가 대용 — 성격별 손익계산서)",
    evidence: "10-K 0001403161-25-000089 FY2025: 인건비 6,961 + 네트워크·처리비 894 = 7,855 · Yahoo 9/9 정확(리드 결정 — Yahoo ① 안)",
    since: "2026-09-27",
  } },
  { symbol: "ORCL", rule: {
    terms: [
      { group: "cloudSw", concepts: ["orcl:CloudAndSoftwareExpenses", "orcl:CloudServicesAndLicenseSupportExpenses"], sign: 1 },
      { group: "hardware", concepts: ["orcl:HardwareExpenses"], sign: 1 },
      { group: "services", concepts: ["orcl:ServicesExpense"], sign: 1 },
    ],
    label: "클라우드·SW + 하드웨어 + 서비스 원가",
    evidence: "10-K 0001193125-26-277521 FY2025(2025-05-31): 클라우드·SW 11,569 + 하드웨어 782 + 서비스 4,576 = 16,927 · Yahoo 9/9·SA 17/17 정확",
    since: "2026-09-27",
  } },
  { symbol: "MAR", rule: {
    terms: [
      { group: "ownedCost", concepts: ["us-gaap:CostOfRevenue[ProductOrServiceAxis=OwnedLeasedandOtherMember]"], sign: 1 },
      { group: "reimbCost", concepts: ["us-gaap:CostOfRevenue[ProductOrServiceAxis=ReimbursementsMember]"], sign: 1 },
    ],
    label: "자가·임차 호텔 원가 + 환급 비용(Operating costs 차원 줄 합)",
    evidence: "10-K 0001048286-26-000007 FY2025: 자가·임차 등 원가 1,461 + 환급 비용 19,503 = 20,964 · Yahoo 9/9 정확",
    since: "2026-09-27",
  } },
  { symbol: "HLT", rule: {
    terms: [
      { group: "ownership", concepts: ["hlt:OwnershipExpenses", "hlt:OwnedAndLeasedHotelExpenses"], sign: 1 },
      { group: "reimb", concepts: ["hlt:ReimbursedExpenses", "hlt:OtherExpensesFromManagedAndFranchisedProperties"], sign: 1 },
    ],
    label: "소유 호텔 비용 + 환급 비용",
    evidence: "10-K 0001585689-26-000007 FY2025: 소유 호텔 비용 1,094 + 환급 비용 7,550 = 8,644 · Yahoo 9/9 정확",
    since: "2026-09-27",
  } },
  { symbol: "SBUX", rule: {
    terms: [
      { group: "prodDist", concepts: ["us-gaap:ProductionAndDistributionCosts"], sign: 1 },
      { group: "storeOp", concepts: ["sbux:StoreOperatingExpenses"], sign: 1 },
    ],
    label: "제품·유통 원가 + 매장 운영비",
    evidence: "10-K 0000829224-25-000114 FY2025: 제품·유통 원가 11,658.2 + 매장 운영비 17,058.9 = 28,717.1 · Yahoo 9/9 정확",
    since: "2026-09-27",
  } },
  { symbol: "DAL", rule: {
    // 외주 서비스(ProfessionalAndContractServicesExpense)는 뺀다 — Yahoo 와 같음(리드 결정)
    terms: [
      { group: "salaries", concepts: ["us-gaap:LaborAndRelatedExpense"], sign: 1 },
      { group: "fuel", concepts: ["us-gaap:FuelCosts"], sign: 1 },
      { group: "ancillary", concepts: ["dal:AncillaryBusinessesAndRefineryExpenses", ["dal:RefineryExpenses", "dal:AncillaryBusinessExpense"]], sign: 1 },
      { group: "landing", concepts: ["us-gaap:LandingFeesAndOtherRentals"], sign: 1 },
      { group: "regional", concepts: ["us-gaap:AirlineCapacityPurchaseArrangements"], sign: 1 },
      { group: "maint", concepts: ["us-gaap:AircraftMaintenanceMaterialsAndRepairs"], sign: 1 },
      { group: "paxService", concepts: ["us-gaap:CostOfServicesCatering"], sign: 1 },
      { group: "profitShare", concepts: ["us-gaap:OtherLaborRelatedExpenses"], sign: 1 },
      { group: "aircraftRent", concepts: ["us-gaap:AircraftRental"], sign: 1 },
      { group: "pilot", concepts: ["dal:PilotAgreementAndRelatedExpenses"], sign: 1, optional: true },
    ],
    label: "운항 원가(인건비·연료·부대사업/정유·착륙료·지역항공·정비·승객서비스·이익분배·항공기 임차·조종사 합의금)",
    evidence: "10-K 0000027904-26-000013 FY2025: 17,520 + 9,819 + 5,987 + 3,564 + 2,553 + 2,432 + 1,855 + 1,337 + 542 = 45,609 · Yahoo = 이 값 + D&A 8/9",
    since: "2026-09-27",
  } },
  { symbol: "CEG", rule: {
    terms: [
      { group: "ppFuel", concepts: ["us-gaap:CostDirectMaterial"], sign: 1 },
      { group: "ppFuelAff", concepts: ["us-gaap:RelatedPartyTransactionAmountsOfTransaction"], sign: 1, optional: true },
      { group: "om", concepts: ["us-gaap:UtilitiesOperatingExpenseMaintenanceOperationsAndOtherCostsAndExpenses"], sign: 1 },
      { group: "omAff", concepts: ["ceg:RelatedPartyCostsOperatingAndMaintenance"], sign: 1, optional: true },
    ],
    label: "구매전력·연료(계열사 포함) + 운영·유지(계열사 포함)",
    evidence: "10-K 0001868275-26-000032 FY2025: 구매전력·연료 14,681 + 운영·유지 6,159 = 20,840 (FY2022 계열사 줄 5 + 44 포함 22,303) · Yahoo 9/9 정확",
    since: "2026-09-27",
  } },
  { symbol: "VST", rule: {
    terms: [
      { group: "fuelPP", concepts: ["vistra:CostOfFuelPurchasedPowerAndDelivery"], sign: 1 },
      { group: "opCosts", concepts: ["us-gaap:OtherCostAndExpenseOperating"], sign: 1 },
    ],
    label: "연료·구매전력·송배전 + 운영비",
    evidence: "10-K 0001692819-26-000006 FY2025: 연료·구매전력·송배전 9,101 + 운영비 2,803 = 11,904 · Yahoo 9/9 정확",
    since: "2026-09-27",
  } },
];

const ACCN = /\d{10}-\d{2}-\d{6}/;
for (const e of COGS_RULES)
  if (e.rule && (!ACCN.test(e.rule.evidence) || !/\d{1,3}(,\d{3})+/.test(e.rule.evidence) || !e.rule.terms.length))
    throw new Error(`metrics/cogs-rules.ts: ${e.symbol} 매출원가 구성 규칙에 항·공시 accn·숫자 근거가 없습니다(S2)`);

/** 종목의 구성 규칙 항목 — 표에 없으면 null(본표 구조로 판정), 있으면 { rule: null } = 대기 */
export function cogsRuleFor(symbol: string): CogsRuleEntry | null {
  return COGS_RULES.find((e) => e.symbol === symbol.toUpperCase()) ?? null;
}
