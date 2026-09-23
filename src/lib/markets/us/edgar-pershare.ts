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
 * 순이익 ÷ 연도말 주식수(근사). 하이라이트·컨센서스·은행 모듈 공통.
 */
export function fyEps(
  facts: CompanyFacts,
  year: number,
  opts: { classFacts?: ClassAFacts | null; fyShares?: number | null; fyNetIncome?: number | null } = {},
): { eps: number | null; approx: boolean } {
  const rep = annualByYear(entriesOf(facts, "EarningsPerShareDiluted", "USD/shares")).get(year);
  if (rep != null) return { eps: rep * (splitFactorsByYear(facts).get(year) ?? 1), approx: false };
  const ca = classAEps(opts.classFacts ?? null, year, "diluted");
  if (ca != null) return { eps: ca, approx: false };
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
