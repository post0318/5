import "server-only";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import { annualByYear, entriesOf, ltmAnchor, ltmFlowOf, provenAbsentAt, reportedInFiling, splitFactorsByYear } from "./edgar-series";
import { classAEps, type ClassAFacts } from "./edgar-classfacts";

/**
 * 미국 종목 **자기자본·LTM 순이익·LTM EPS·배수 부호 규칙 단일 기준**.
 *
 * 왜 따로 뺐나 — 검증 체계 2층(scripts/verify-financials.mjs, 2026-09-23 첫 실행)이
 * EV/EBITDA 를 통일한 뒤에도 PER·PBR 이 화면마다 다른 것을 잡았다:
 *  - GE 2021 PBR 하이라이트 2.02 vs 재무분석 1.60 — 자기자본을 하이라이트는 재작성본
 *    (2023 8-K, 보험회계 LDTI 소급 320억 달러), 재무분석은 10-K 원본(403억 달러)으로 씀
 *  - LTM PER T 4.2%·GE 2.0%·SPG 16% 차이 — 재무분석은 주당 EPS 에 흐름식(FY + 누적 −
 *    전년누적)을 적용(오전 A1 에서 하이라이트·손익에서 고친 것과 같은 오류가 남아 있었음)
 *  - 음수 배수: 적자 PER·자본잠식 PBR 을 재무분석·컨센서스는 표시, 하이라이트는 비움
 *  - 컨센서스 PBR: T·VZ 는 자기자본 계정 매칭 실패로 빈칸
 */

/**
 * 후보 개념을 하나로 합치되 **앞 개념이 이미 채운 기간은 뒤 개념이 덮지 못하게**
 * 한다(월마트: NetIncomeLoss 지배주주 vs ProfitLoss 연결 — 뒤쪽이 이기면 순이익·
 * 자기자본이 NCI 포함값으로 뒤집힌다). 한 개념 안의 소급 재작성본은 그대로 둔다.
 */
export function mergeConcepts(facts: CompanyFacts, concepts: string[], unit = "USD"): FactUnitEntry[] {
  const out: FactUnitEntry[] = [];
  const claimed = new Set<string>();
  const keyOf = (e: FactUnitEntry) => `${e.start ?? ""}|${e.end}|${e.form}|${e.fp}`;
  for (const c of concepts) {
    const mine = new Set<string>();
    for (const e of entriesOf(facts, c, unit)) {
      const k = keyOf(e);
      if (claimed.has(k)) continue;
      out.push(e);
      mine.add(k);
    }
    for (const k of mine) claimed.add(k);
  }
  return out;
}

/** 비지배지분 몫 순이익 */
const NCI_NI = ["NetIncomeLossAttributableToNoncontrollingInterest"];
/** 우선주 배당(손익 영향) — 보통주 귀속 순이익 = 지배주주 순이익 − 이것 */
const PREF_DIV = [
  "PreferredStockDividendsIncomeStatementImpact",
  "PreferredStockDividendsAndOtherAdjustments",
  "DividendsPreferredStock",
  "DividendsPreferredStockCash",
];

/**
 * 지배주주 순이익 시계열. NetIncomeLoss 가 없는 기간은 ProfitLoss(비지배지분 포함
 * 연결)에서 **같은 기간의 비지배지분 몫을 빼서** 만든다. 예전엔 ProfitLoss 를 그대로
 * 순이익으로 써서, 지배주주 태그가 없는 해(BE 2024·2025)의 순이익이 비지배지분만큼
 * 틀렸다(검증 체계 2층 — EPS × 주식수 ≈ 순이익 검사로 발견, 2026-09-23).
 *
 * **그림자 채우기 금지(2026-09-27)**: 비지배지분 몫이 그 기간에 없으면 0 으로 보지 않는다 — 그 값을 공시한 공시(같은
 * 제출일)에 비지배지분 줄이 아예 없을 때만(없음 증명) ProfitLoss 그대로. 보통주 귀속 순이익(우선주 배당 차감 후)도
 * 그 공시에 우선주 배당·비지배지분 줄이 없을 때만 지배주주 순이익으로 쓴다(정의가 같음이 증명될 때만).
 */
export function netIncomeToParentEntries(facts: CompanyFacts): FactUnitEntry[] {
  const key = (e: FactUnitEntry) => `${e.start ?? ""}|${e.end}|${e.form}|${e.fp}`;
  const base = entriesOf(facts, "NetIncomeLoss");
  const covered = new Set(base.map(key));
  const nci = new Map<string, number>();
  for (const e of entriesOf(facts, NCI_NI[0]))
    if (e.val != null) nci.set(key(e), e.val);
  const out: FactUnitEntry[] = [...base];
  for (const e of entriesOf(facts, "ProfitLoss")) {
    const k = key(e);
    if (covered.has(k) || e.val == null) continue;
    const n = nci.get(k);
    if (n == null && reportedInFiling(facts, NCI_NI, e.filed)) continue; // 그 기간 비지배지분 몫 미상 — 공란
    covered.add(k);
    out.push({ ...e, val: e.val - (n ?? 0) });
  }
  for (const e of entriesOf(facts, "NetIncomeLossAvailableToCommonStockholdersBasic")) {
    const k = key(e);
    if (covered.has(k)) continue;
    if (reportedInFiling(facts, [...PREF_DIV, ...NCI_NI], e.filed)) continue; // 우선주 배당·비지배지분이 있으면 정의가 다르다
    covered.add(k);
    out.push(e);
  }
  return out;
}

/** EPS 분자 — 보통주 귀속 순이익(우선주 배당 차감 후) 우선, 없으면 그 공시에 우선주 배당이 없을 때만 지배주주 순이익. */
function niToCommonEntries(facts: CompanyFacts): FactUnitEntry[] {
  const key = (e: FactUnitEntry) => `${e.start ?? ""}|${e.end}|${e.form}|${e.fp}`;
  const out = mergeConcepts(facts, [
    "NetIncomeLossAvailableToCommonStockholdersDiluted",
    "NetIncomeLossAvailableToCommonStockholdersBasic",
  ]);
  const covered = new Set(out.map(key));
  for (const e of netIncomeToParentEntries(facts))
    if (!covered.has(key(e)) && !reportedInFiling(facts, PREF_DIV, e.filed)) out.push(e);
  return out;
}

/**
 * 최근 12개월 희석 EPS = LTM 보통주 귀속 순이익 ÷ 현재 주식수(edgar-shares).
 * 주당 지표에 흐름식(FY + 누적 − 전년누적)을 쓰지 않는다 — 분모가 기간마다 달라
 * 성립하지 않는다(오전 A1, 재무분석·은행 모듈에 같은 오류가 남아 있었음).
 * 값이 없으면 사유(LTM 순이익 사유 또는 현재 주식수 없음) — 다른 경로로 대신하지 않는다.
 */
export function ltmEpsOf(facts: CompanyFacts, currentShares: number | null | undefined): { value: number | null; reason: string | null } {
  const ni = ltmFlowOf(niToCommonEntries(facts), ltmAnchor(facts));
  if (ni.value == null) return { value: null, reason: ni.reason ? `LTM 순이익: ${ni.reason}` : "LTM 보통주 귀속 순이익 없음" };
  if (!currentShares) return { value: null, reason: "현재 주식수 없음" };
  return { value: ni.value / currentShares, reason: null };
}
export function ltmEps(facts: CompanyFacts, currentShares: number | null | undefined): number | null {
  return ltmEpsOf(facts, currentShares).value;
}

/**
 * 사업연도 희석 EPS — 공시값(액면분할 보정) → 듀얼클래스 Class A 실측(Visa) →
 * 계속영업 + 중단영업 희석 EPS 공시값의 합(총 EPS 미태깅, DELL FY2022) →
 * 보통주 귀속 순이익 ÷ 가중평균 희석주식수(공시 EPS 정의 그대로) → 순이익 ÷
 * 연도말 주식수(근사). 하이라이트·재무분석·컨센서스·은행 모듈 공통.
 *
 * 계속영업 EPS(IncomeLossFromContinuingOperationsPerDilutedShare)는 쓰지 않는다 —
 * 중단영업이 있는 해(DELL FY2022, VMware 분사)에 순이익 기준 PER 과 분자가
 * 달라진다. 재무분석만 이 태그를 후보에 두어 하이라이트와 PER 이 17% 갈렸다
 * (검증 체계, 2026-09-23 유니버스 전수).
 */
/** 사업연도 EPS 칸 주석(원인별) — 화면이 칸마다 붙인다(예전의 "클래스별로만 공시(Visa 등)" 일괄 문구는 원인이 틀린 경우가 많았다) */
export const FY_EPS_NOTE = {
  classA: "Class A 1주 기준 EPS(클래스별로만 공시 — 10-K 원본 실측)",
  contDisc: "계속영업 + 중단영업 희석 EPS 공시값의 합(총 EPS 태그 없음)",
  wavg: "보통주 귀속 순이익 ÷ 희석 가중평균주식수(EPS 태그 없음)",
  approx: "근사: 순이익 ÷ 결산일 주식수(EPS·가중평균 주식수 미공시)",
} as const;

export function fyEps(
  facts: CompanyFacts,
  year: number,
  opts: { classFacts?: ClassAFacts | null; fyShares?: number | null; fyNetIncome?: number | null } = {},
): { eps: number | null; approx: boolean; note: string | null } {
  const sf = splitFactorsByYear(facts).get(year) ?? 1;
  const rep = annualByYear(entriesOf(facts, "EarningsPerShareDiluted", "USD/shares")).get(year);
  const ni = annualByYear(niToCommonEntries(facts)).get(year);
  // 순이익이 있는데 공시 EPS 가 정확히 0 = 자리표시자. CEG 2020·2021(2022-02 분사 전)은
  // EPS·가중평균주식수를 0 으로 태깅했다 → 앱이 "EPS 0, 순이익 −2.05억 달러"를 냈다
  // (검증 2026-09-24). 상장 전이라 주당 값이 없는 해이므로 근사로 만들지 않고 비운다.
  const netForCheck = ni ?? opts.fyNetIncome ?? null;
  if (rep === 0 && netForCheck != null && netForCheck !== 0) return { eps: null, approx: false, note: "공시 EPS 0(상장 전 자리표시자)" };
  if (rep != null) return { eps: rep * sf, approx: false, note: null };
  const ca = classAEps(opts.classFacts ?? null, year, "diluted");
  if (ca != null) return { eps: ca, approx: false, note: FY_EPS_NOTE.classA };
  // 총 희석 EPS 태그 없이 계속·중단영업 주당이익만 공시한 해 — 두 공시값의 합이 공시 총 희석 EPS 다(DELL FY2022,
  // VMware 분사: 6.26 + 0.76 = 7.02, 회사 공시 총 EPS·인포맥스 7.024 와 일치). 계속영업 EPS 단독은 쓰지 않는다.
  const perDil = (c: string) => annualByYear(entriesOf(facts, c, "USD/shares")).get(year);
  const contEps = perDil("IncomeLossFromContinuingOperationsPerDilutedShare");
  const discEps =
    perDil("IncomeLossFromDiscontinuedOperationsNetOfTaxPerDilutedShare") ??
    perDil("DiscontinuedOperationIncomeLossFromDiscontinuedOperationNetOfTaxPerDilutedShare");
  if (contEps != null && discEps != null) return { eps: (contEps + discEps) * sf, approx: false, note: FY_EPS_NOTE.contDisc };
  const wsh = annualByYear(entriesOf(facts, "WeightedAverageNumberOfDilutedSharesOutstanding", "shares")).get(year);
  if (ni != null && wsh) {
    // "보통주 귀속 순이익" 태그에 계속영업분만 단 공시(DELL FY2024 10-K 의 FY2022 = 4,948 = 5,563 − 중단영업 615)
    // — 중단영업 귀속분을 더한 값이 지배주주 순이익에 (1% 안에서) 더 가까우면 더한다.
    const discNi = annualByYear(
      entriesOf(facts, "NetIncomeLossFromDiscontinuedOperationsAvailableToCommonShareholdersDiluted"),
    ).get(year);
    const parent = annualByYear(netIncomeToParentEntries(facts)).get(year);
    const withDisc = discNi ? ni + discNi : null;
    const num =
      withDisc != null && parent != null &&
      Math.abs(withDisc - parent) < Math.abs(ni - parent) &&
      Math.abs(withDisc - parent) <= Math.abs(parent) * 0.01
        ? withDisc
        : ni;
    return { eps: (num / wsh) * sf, approx: false, note: FY_EPS_NOTE.wavg };
  }
  // 오너 승인 근사(라벨 필수) — EPS·가중평균 주식수가 모두 미공시인 해: 순이익 ÷ 결산일 주식수
  if (opts.fyNetIncome != null && opts.fyShares) return { eps: opts.fyNetIncome / opts.fyShares, approx: true, note: FY_EPS_NOTE.approx };
  return { eps: null, approx: false, note: "EPS 미공시(순이익·결산일 주식수 없음)" };
}

/** 최근 12개월 순이익(지배주주 우선). */
export function ltmNetIncome(facts: CompanyFacts): number | null {
  return ltmNetIncomeOf(facts).value;
}
export function ltmNetIncomeOf(facts: CompanyFacts): { value: number | null; reason: string | null } {
  const r = ltmFlowOf(netIncomeToParentEntries(facts), ltmAnchor(facts));
  return { value: r.value, reason: r.reason };
}

/** 사업연도별 지배주주 순이익 (netIncomeToParentEntries 규칙). */
export function netIncomeAnnualByYear(facts: CompanyFacts): Map<number, number> {
  return annualByYear(netIncomeToParentEntries(facts));
}

/**
 * 기준일의 자기자본(지배주주) — **그 기준일(±7일) 값만**, 같은 날짜면 최신 공시(재작성본 — 8-K 포함) 우선.
 * 그림자 채우기 금지(2026-09-27): 기준일 이전의 옛 값, 비지배지분 포함 자본은 쓰지 않는다. 지배주주 자본 태그가 없으면
 * 비지배지분 포함 자본 − 비지배지분(같은 날짜), 비지배지분이 그 재무상태표에 없음이 증명되면 포함 자본 그대로. 자본을
 * 클래스별로만 태깅하는 기업(Visa)은 자산 − 부채 — 비지배지분·임시자본(메자닌)이 그 재무상태표에 없음이 증명될 때만.
 */
export function parentEquityAt(facts: CompanyFacts, asOf: string): number | null {
  return parentEquityOf(facts, asOf).value;
}
const NCI_BAL = ["MinorityInterest", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"];
const TEMP_EQUITY = [
  "TemporaryEquityCarryingAmountAttributableToParent",
  "TemporaryEquityCarryingAmountIncludingPortionAttributableToNoncontrollingInterests",
  "RedeemableNoncontrollingInterestEquityCarryingAmount",
];
export function parentEquityOf(facts: CompanyFacts, asOf: string): { value: number | null; reason: string | null } {
  const t = Date.parse(asOf);
  const at = (entries: FactUnitEntry[]) => {
    let best: { val: number; d: number; filed: string } | null = null;
    for (const e of entries) {
      if (e.start || e.val == null || !e.end) continue;
      const d = Math.abs(Date.parse(e.end) - t) / 86_400_000;
      if (d > 7) continue;
      const filed = e.filed ?? "";
      if (!best || d < best.d || (d === best.d && filed >= best.filed)) best = { val: e.val, d, filed };
    }
    return best?.val ?? null;
  };
  const eq = at(entriesOf(facts, "StockholdersEquity"));
  if (eq != null) return { value: eq, reason: null };
  const incl = at(entriesOf(facts, "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"));
  const nci = at(entriesOf(facts, "MinorityInterest"));
  if (incl != null) {
    if (nci != null) return { value: incl - nci, reason: null };
    if (provenAbsentAt(facts, ["MinorityInterest"], asOf)) return { value: incl, reason: null };
    return { value: null, reason: "지배주주 자본 미공시(비지배지분 포함 자본만 — 비지배지분 미상)" };
  }
  const a = at(entriesOf(facts, "Assets"));
  const l = at(entriesOf(facts, "Liabilities"));
  if (a != null && l != null) {
    if (provenAbsentAt(facts, [...NCI_BAL, ...TEMP_EQUITY], asOf)) return { value: a - l, reason: null };
    return { value: null, reason: "지배주주 자본 미공시(자산 − 부채에 비지배지분·임시자본 포함 가능)" };
  }
  return { value: null, reason: "기준일 재무상태표에 자기자본 없음" };
}

/**
 * 배수(PER·PBR·EV/EBITDA 등) 공통 부호 규칙 — **분모가 0 이하면 비운다.** 적자 PER·
 * 자본잠식 PBR·음수 EBITDA 배수는 의미가 없고, 화면마다 표시 여부가 갈리면 같은
 * 종목이 다르게 보인다(검증 체계에서 MCD·SBUX·T 등으로 확인).
 */
export function positiveRatio(num: number | null | undefined, den: number | null | undefined): number | null {
  if (num == null || den == null || !Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null;
  return num / den;
}
