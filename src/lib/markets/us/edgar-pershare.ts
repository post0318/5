import "server-only";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import { annualByYear, entriesOf, splitFactorsByYear, ttmOf } from "./edgar-series";
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

const EQUITY = [
  "StockholdersEquity",
  "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
];

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

/**
 * 지배주주 순이익 시계열. NetIncomeLoss 가 없는 기간은 ProfitLoss(비지배지분 포함
 * 연결)에서 **같은 기간의 비지배지분 몫을 빼서** 만든다. 예전엔 ProfitLoss 를 그대로
 * 순이익으로 써서, 지배주주 태그가 없는 해(BE 2024·2025)의 순이익이 비지배지분만큼
 * 틀렸다(검증 체계 2층 — EPS × 주식수 ≈ 순이익 검사로 발견, 2026-09-23).
 */
export function netIncomeToParentEntries(facts: CompanyFacts): FactUnitEntry[] {
  const key = (e: FactUnitEntry) => `${e.start ?? ""}|${e.end}|${e.form}|${e.fp}`;
  const base = entriesOf(facts, "NetIncomeLoss");
  const covered = new Set(base.map(key));
  const nci = new Map<string, number>();
  for (const e of entriesOf(facts, "NetIncomeLossAttributableToNoncontrollingInterest"))
    if (e.val != null) nci.set(key(e), e.val);
  const out: FactUnitEntry[] = [...base];
  for (const e of entriesOf(facts, "ProfitLoss")) {
    const k = key(e);
    if (covered.has(k) || e.val == null) continue;
    covered.add(k);
    out.push({ ...e, val: e.val - (nci.get(k) ?? 0) });
  }
  for (const e of entriesOf(facts, "NetIncomeLossAvailableToCommonStockholdersBasic")) {
    const k = key(e);
    if (covered.has(k)) continue;
    covered.add(k);
    out.push(e);
  }
  return out;
}

/** EPS 분자 — 보통주 귀속 순이익(우선주 배당 차감 후) 우선, 없으면 지배주주 순이익. */
function niToCommonEntries(facts: CompanyFacts): FactUnitEntry[] {
  const key = (e: FactUnitEntry) => `${e.start ?? ""}|${e.end}|${e.form}|${e.fp}`;
  const out = mergeConcepts(facts, [
    "NetIncomeLossAvailableToCommonStockholdersDiluted",
    "NetIncomeLossAvailableToCommonStockholdersBasic",
  ]);
  const covered = new Set(out.map(key));
  for (const e of netIncomeToParentEntries(facts)) if (!covered.has(key(e))) out.push(e);
  return out;
}

/**
 * 최근 12개월 희석 EPS = LTM 보통주 귀속 순이익 ÷ 현재 주식수(edgar-shares).
 * 주당 지표에 흐름식(FY + 누적 − 전년누적)을 쓰지 않는다 — 분모가 기간마다 달라
 * 성립하지 않는다(오전 A1, 재무분석·은행 모듈에 같은 오류가 남아 있었음).
 */
export function ltmEps(facts: CompanyFacts, currentShares: number | null | undefined): number | null {
  const ni = ttmOf(niToCommonEntries(facts));
  return ni != null && currentShares ? ni / currentShares : null;
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
export function fyEps(
  facts: CompanyFacts,
  year: number,
  opts: { classFacts?: ClassAFacts | null; fyShares?: number | null; fyNetIncome?: number | null } = {},
): { eps: number | null; approx: boolean } {
  const sf = splitFactorsByYear(facts).get(year) ?? 1;
  const rep = annualByYear(entriesOf(facts, "EarningsPerShareDiluted", "USD/shares")).get(year);
  const ni = annualByYear(niToCommonEntries(facts)).get(year);
  // 순이익이 있는데 공시 EPS 가 정확히 0 = 자리표시자. CEG 2020·2021(2022-02 분사 전)은
  // EPS·가중평균주식수를 0 으로 태깅했다 → 앱이 "EPS 0, 순이익 −2.05억 달러"를 냈다
  // (검증 2026-09-24). 상장 전이라 주당 값이 없는 해이므로 근사로 만들지 않고 비운다.
  const netForCheck = ni ?? opts.fyNetIncome ?? null;
  if (rep === 0 && netForCheck != null && netForCheck !== 0) return { eps: null, approx: false };
  if (rep != null) return { eps: rep * sf, approx: false };
  const ca = classAEps(opts.classFacts ?? null, year, "diluted");
  if (ca != null) return { eps: ca, approx: false };
  // 총 희석 EPS 태그 없이 계속·중단영업 주당이익만 공시한 해 — 두 공시값의 합이 공시 총 희석 EPS 다(DELL FY2022,
  // VMware 분사: 6.26 + 0.76 = 7.02, 회사 공시 총 EPS·인포맥스 7.024 와 일치). 계속영업 EPS 단독은 쓰지 않는다.
  const perDil = (c: string) => annualByYear(entriesOf(facts, c, "USD/shares")).get(year);
  const contEps = perDil("IncomeLossFromContinuingOperationsPerDilutedShare");
  const discEps =
    perDil("IncomeLossFromDiscontinuedOperationsNetOfTaxPerDilutedShare") ??
    perDil("DiscontinuedOperationIncomeLossFromDiscontinuedOperationNetOfTaxPerDilutedShare");
  if (contEps != null && discEps != null) return { eps: (contEps + discEps) * sf, approx: false };
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
    return { eps: (num / wsh) * sf, approx: false };
  }
  if (opts.fyNetIncome != null && opts.fyShares) return { eps: opts.fyNetIncome / opts.fyShares, approx: true };
  return { eps: null, approx: false };
}

/** 최근 12개월 순이익(지배주주 우선). */
export function ltmNetIncome(facts: CompanyFacts): number | null {
  return ttmOf(netIncomeToParentEntries(facts));
}

/** 사업연도별 지배주주 순이익 (netIncomeToParentEntries 규칙). */
export function netIncomeAnnualByYear(facts: CompanyFacts): Map<number, number> {
  return annualByYear(netIncomeToParentEntries(facts));
}

/**
 * 기준일의 자기자본(지배주주 우선) — 기준일 이하 가장 최근 값, 같은 날짜면 **최신
 * 공시(재작성본) 우선**(8-K 재작성 포함). 자본을 클래스별로만 태깅하는 기업(Visa)은
 * 자산 − 부채로 보정.
 */
export function parentEquityAt(facts: CompanyFacts, asOf: string): number | null {
  const pick = (entries: FactUnitEntry[]) => {
    let best: { val: number; end: string; filed: string } | null = null;
    for (const e of entries) {
      if (e.start || e.val == null || !e.end || e.end > asOf) continue;
      const filed = e.filed ?? "";
      if (!best || e.end > best.end || (e.end === best.end && filed >= best.filed))
        best = { val: e.val, end: e.end, filed };
    }
    return best;
  };
  const eq = pick(mergeConcepts(facts, EQUITY));
  // 오래된 태그가 남아 있는 경우(개념 중단) 기준일에서 550일 넘게 떨어지면 안 쓴다
  const fresh = (b: { end: string } | null) =>
    b != null && (Date.parse(asOf) - Date.parse(b.end)) / 86_400_000 <= 550;
  if (eq && fresh(eq)) return eq.val;
  const a = pick(entriesOf(facts, "Assets"));
  const l = pick(entriesOf(facts, "Liabilities"));
  return a && l && fresh(a) && a.end === l.end ? a.val - l.val : null;
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
