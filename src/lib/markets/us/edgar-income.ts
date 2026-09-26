import "server-only";
import { unavailableNote, unavailableOn } from "./sec-unavailable";
import { yahooLtm } from "./edgar-yahoo-quarters";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import type { FinancialStatement, FinancialLineItem, FinancialPeriod } from "../types";
import {
  ANNUAL_FORMS,
  INTERIM_FORMS,
  annualByYear,
  days,
  directQuarterValue,
  entriesOf,
  firstConcept,
  isFullYearDuration,
  shiftYear,
  singleQuarter,
  splitFactorsByYear,
  ttmOf,
  type QuarterCol,
} from "./edgar-series";
import { DA_DEPRECIATION, DA_INTANGIBLE, DA_TOTAL, opIncomeIsDerived, pickDa, SYN_DA_CF, SYN_OP_INCOME } from "./edgar-ev";
import { fyEps, ltmEps, ltmNetIncome, netIncomeAnnualByYear, netIncomeToParentEntries } from "./edgar-pershare";
import { buildShareResolver } from "./edgar-shares";
import {
  classAEps,
  classALatest,
  classAShares,
  type ClassAFacts,
} from "./edgar-classfacts";
import {
  FIN_NONINTEREST_EXPENSE,
  FIN_PROVISION,
  isFinancialCompany,
} from "./edgar-financial";
import { revAnnualEnds, revAnnualMap, revAnnualYears, revLtm, revQuarterLabel, type RevCol } from "./fin-revenue";
import { COGS_NOTE } from "@/lib/fin";

/**
 * 미국 상세 손익계산서 — SEC EDGAR companyfacts 정규화 재분류 (블룸버그 I/S 근사).
 * 컬럼: 최근 5개 사업연도 + 최근 12개월 (분기 모드는 최근 5분기).
 * 계산 라인('기타 영업비용' 등)은 (구간값 − 매핑 라인)으로 자동 정합.
 * 예상치는 재무 하이라이트(개요)에서 제공 → 여기선 실적만.
 */

const OPEX = ["OperatingExpenses", "CostsAndExpenses"];
const SGA = [
  "SellingGeneralAndAdministrativeExpense",
  "GeneralAndAdministrativeExpense",
];
// 취득 IPR&D 를 별도 줄로 공시하는 회사(LLY 2023~)는 R&D 태그가 "취득 IPR&D 제외"로 바뀐다 — 없으면 연구개발비·
// 기타 영업비용 행이 통째로 비었다. 취득 IPR&D 는 기타 영업비용(차감 계산)에 남는다.
const RND = ["ResearchAndDevelopmentExpense", "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost"];
// 영업이익 — edgar-ev.ts 단일 기준 시계열(공시 → 세전+이자 → 세전, 로더가 합성).
// 하이라이트·재무분석·개요 멀티플과 같은 값(예전엔 여기만 매출 − 원가로 만든 매출총이익
// 에서 판관비·연구개발비를 빼 BMY 등에서 EBITDA 가 화면마다 달랐다).
const OP_INCOME = [SYN_OP_INCOME];
const PRETAX = [
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
];
const TAX = ["IncomeTaxExpenseBenefit"];
const EPS_BASIC = ["EarningsPerShareBasic", "EarningsPerShareBasicAndDiluted"];
const EPS_DIL = ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"];
const NONOP = ["NonoperatingIncomeExpense", "OtherNonoperatingIncomeExpense"];
const INT_EXP = [
  "InterestExpense",
  "InterestExpenseNonoperating",
  "InterestAndDebtExpense",
  "InterestExpenseDebt",
];
const INT_INC = [
  "InvestmentIncomeInterestAndDividend",
  "InvestmentIncomeInterest",
  "InterestAndDividendIncomeOperating",
  "InterestIncomeOperating",
  "InterestIncomeNonoperating",
];

const LTM = "현재/LTM";
const fyKey = (y: number) => `${y}Y`;

export function buildUsIncome(
  facts: CompanyFacts,
  mode: "annual" | "quarter" = "annual",
  opts: { sharesHint?: number | null; classFacts?: ClassAFacts | null; sic?: string | null } = {},
): FinancialStatement {
  const quarterly = mode === "quarter";
  const sharesHint = opts.sharesHint ?? null;
  const classFacts = opts.classFacts ?? null;
  // 금융회사(은행·카드사) — 매출 대신 순수익(이자비용 차감), 매출총이익 대신 충당금전이익.
  const isFin = isFinancialCompany(facts, opts.sic ?? null);
  // 매출(순수익) = 재무 5층 구조 매출 지표(fin-revenue.ts). 열(연도·분기)도 그 열을 따른다 — 분기는 Q4(사업연도 − 9개월
  // 누적) 포함, 최신 판본(docs/metrics/revenue.md §2).
  const rev = facts.revenue ?? null;
  const revAnnual = revAnnualMap(rev);

  // 개념 태그가 시기별로 바뀌는 기업(NVIDIA 등) → 나열 개념을 연도별로 병합
  const mergedAnnual = (concepts: string[], unit = "USD"): Map<number, number> => {
    const out = new Map<number, number>();
    for (const c of concepts)
      for (const [y, v] of annualByYear(entriesOf(facts, c, unit))) if (!out.has(y)) out.set(y, v);
    return out;
  };

  const years = revAnnualYears(rev, 5);
  const ends = revAnnualEnds(rev);
  const lastFy = years[years.length - 1] ?? new Date().getFullYear();
  // 분기 열 — fin 분기(Q4 포함) 최근 5개. 누적 차감용 직전 열은 Q4 가 아닌 직전 분기(10-Q 누적 기준, 종전과 같음)
  const finQ = rev?.quarters ?? [];
  const toCol = (c: (typeof finQ)[number]): QuarterCol => ({ label: revQuarterLabel(c), end: c.end, fyStartApprox: shiftYear(c.end, -1) });
  const qShowFin = quarterly ? finQ.slice(-5) : [];
  const qShow = qShowFin.map(toCol);
  const q4Labels = new Set(qShowFin.filter((c) => c.fq === 4).map(revQuarterLabel));
  /** 분기 열 i 의 누적 차감용 직전 분기(Q4 제외) */
  const prevOf = (i: number): QuarterCol | undefined => {
    const idx = finQ.indexOf(qShowFin[i]);
    for (let j = idx - 1; j >= 0; j--) if (finQ[j].fq !== 4) return toCol(finQ[j]);
    return undefined;
  };
  /** Q4 열의 3분기 말(같은 사업연도) */
  const q3EndOf = (i: number): string | null => {
    const c = qShowFin[i];
    return finQ.find((x) => x.fy === c.fy && x.fq === 3)?.end ?? null;
  };
  /** 분기 값 — 1~3분기는 종전 규칙(직접 → 누적 차감), Q4 = 사업연도(최신 판본) − 9개월 누적(최신 판본). 주식수·주당 값은 Q4 없음 */
  const quarterValue = (entries: FactUnitEntry[], i: number, flow: boolean): number | null => {
    const q = qShow[i];
    if (!q4Labels.has(q.label)) return singleQuarter(entries, q, prevOf(i));
    if (!flow) return null;
    const q3End = q3EndOf(i);
    if (!q3End) return null;
    const newest = (xs: FactUnitEntry[]) => xs.sort((a, b) => (b.filed ?? "").localeCompare(a.filed ?? ""))[0];
    const fy = newest(entries.filter((e) => e.start && ANNUAL_FORMS.includes(e.form) && isFullYearDuration(e) && Math.abs(days(q.end, e.end)) <= 6));
    const nine = newest(entries.filter((e) => e.start && INTERIM_FORMS.includes(e.form) && Math.abs(days(q3End, e.end)) <= 6 && days(e.start, e.end) >= 250 && days(e.start, e.end) <= 290));
    if (!fy?.start || !nine?.start || Math.abs(days(fy.start, nine.start)) > 12) return null;
    return fy.val - nine.val;
  };

  let periods: FinancialPeriod[];
  if (quarterly) {
    periods = qShow.map((q) => ({
      label: q.label,
      fiscalYear: Number(q.label.slice(0, 4)),
      fiscalQuarter: Number(q.label.slice(-1)) || null,
      endDate: q.end,
    }));
  } else {
    periods = years.map((y) => ({
      label: fyKey(y),
      fiscalYear: y,
      fiscalQuarter: null,
      endDate: ends.get(y) ?? `${y}-12-31`,
    }));
    periods.push({
      label: LTM,
      fiscalYear: lastFy + 1,
      fiscalQuarter: null,
      endDate: new Date().toISOString().slice(0, 10),
    });
  }
  const labels = periods.map((p) => p.label);

  const blank = (): Record<string, number | null> =>
    Object.fromEntries(labels.map((l) => [l, null]));

  const val = (concepts: string[], unit = "USD"): Record<string, number | null> => {
    const out = blank();
    if (quarterly) {
      qShow.forEach((q, i) => {
        for (const c of concepts) {
          const v = quarterValue(entriesOf(facts, c, unit), i, unit === "USD");
          if (v != null) { out[q.label] = v; break; }
        }
      });
      return out;
    }
    const ann = mergedAnnual(concepts, unit);
    for (const y of years) out[fyKey(y)] = ann.get(y) ?? null;
    // 가장 최근 데이터가 있는 개념의 TTM (태그 이전 후 과거 개념 옛 FY값 방지)
    let ttmEnd = "";
    for (const c of concepts) {
      const es = entriesOf(facts, c, unit);
      if (!es.length) continue;
      const maxEnd = es.reduce((m, e) => (e.end > m ? e.end : m), "");
      if (maxEnd > ttmEnd) { ttmEnd = maxEnd; out[LTM] = ttmOf(es); }
    }
    return out;
  };
  const diff = (
    a: Record<string, number | null>,
    ...subs: Record<string, number | null>[]
  ): Record<string, number | null> => {
    const out = blank();
    for (const l of labels) {
      if (a[l] == null) continue;
      let x = a[l]!;
      let ok = true;
      for (const s of subs) {
        if (s[l] == null) {
          ok = false;
          break;
        }
        x -= s[l]!;
      }
      out[l] = ok ? Math.round(x) : null;
    }
    return out;
  };

  // 매출(순수익) — 재무 5층 구조 매출 지표(fin-revenue.ts)
  const revenue = blank();
  if (quarterly) qShowFin.forEach((c) => (revenue[revQuarterLabel(c)] = c.v));
  else {
    for (const y of years) revenue[fyKey(y)] = revAnnual.get(y) ?? null;
    revenue[LTM] = revLtm(rev);
  }
  // 매출원가·매출총이익 = 재무 5층 구조 지표(fin-revenue.ts 열의 cogs·gp, docs/metrics/cogs.md) — 본표 계산 구조로 찾은 원가 줄,
  // 본표 매출총이익 소계(없으면 매출 − 매출원가 합성). 태그를 여기서 고르지 않는다(eslint)
  const annualCol = new Map((rev?.annual ?? []).map((c) => [c.fy, c] as const));
  /** 표시 열 → fin 열 */
  const finColOf = new Map<string, RevCol>();
  if (quarterly) qShowFin.forEach((c) => finColOf.set(revQuarterLabel(c), c));
  else {
    for (const y of years) { const c = annualCol.get(y); if (c) finColOf.set(fyKey(y), c); }
    if (rev?.ltm) finColOf.set(LTM, rev.ltm);
  }
  const finVal = (pick: (c: RevCol) => number | null): Record<string, number | null> => {
    const out = blank();
    for (const l of labels) { const c = finColOf.get(l); out[l] = c ? pick(c) : null; }
    return out;
  };
  const cogs = finVal((c) => c.cogs);
  // 금융회사: 매출총이익 대신 충당금전이익(=순수익 − 총이자외비용), 대손충당금 별도.
  const finNoninterestExpense = val(FIN_NONINTEREST_EXPENSE);
  const finProvision = val(FIN_PROVISION);
  const grossProfit = (() => {
    if (isFin) {
      const g = blank();
      for (const l of labels)
        if (revenue[l] != null && finNoninterestExpense[l] != null)
          g[l] = revenue[l]! - finNoninterestExpense[l]!;
      return g;
    }
    return finVal((c) => c.gp);
  })();
  const sga = val(SGA);
  const rnd = val(RND);
  const opex = val(OPEX);
  const pretax = val(PRETAX);
  // 영업이익: 금융회사는 충당금전이익 − 대손충당금. 그 외는 단일 기준 시계열
  const opIncome = (() => {
    if (isFin) {
      const o = blank();
      for (const l of labels)
        if (grossProfit[l] != null) o[l] = Math.round(grossProfit[l]! - (finProvision[l] ?? 0));
      return o;
    }
    const o = val(OP_INCOME);
    return o;
  })();
  // 기타 영업비용 = OPEX − SGA − RND, 없으면 GrossProfit − OpIncome − SGA − RND
  const otherOpex = (() => {
    const base = labels.some((l) => opex[l] != null)
      ? opex
      : diff(grossProfit, opIncome);
    return diff(base, sga, rnd);
  })();
  // (−)영업외손익 = 세전이익 − 영업이익 (부호 반전). 워터폴 정합을 위해 항상 이 정의 우선.
  // NonoperatingIncomeExpense 태그는 일부 항목만 담는 기업(IBM 등)이 많아 사용 안 함.
  const nonOpLoss = (() => {
    const nonop = val(NONOP);
    const out = blank();
    for (const l of labels) {
      if (pretax[l] != null && opIncome[l] != null) out[l] = -(pretax[l]! - opIncome[l]!);
      else if (nonop[l] != null) out[l] = -nonop[l]!;
    }
    return out;
  })();
  // 순이자손익(−) = 이자비용 − 이자수익 (양수 = 순이자 부담, 음수 = 순이자 이익).
  // 금융회사는 이자비용이 이미 순수익(매출)에 반영된 영업비용이라 영업외손익 하위
  // 각주로 표시하지 않는다(이중계상 오인 방지).
  const intInc = val(INT_INC);
  const intExp = val(INT_EXP);
  const netIntCost = blank();
  if (!isFin) {
    // 20-F Yahoo 분기 LTM: 한쪽만 채워졌으면(다른 쪽은 LTM 에서만 빔) 0 으로 보지 않는다
    const ylI = !quarterly && yahooLtm(facts);
    const prevL = labels[labels.length - 2];
    const gapI = (x: Record<string, number | null>) => !!ylI && x[LTM] == null && x[prevL] != null;
    for (const l of labels) {
      if (intExp[l] == null && intInc[l] == null) continue;
      if (l === LTM && (gapI(intExp) || gapI(intInc))) continue;
      netIntCost[l] = (intExp[l] ?? 0) - (intInc[l] ?? 0);
    }
  }
  // 최근 데이터가 없으면(예: 회사가 이자 항목 별도 표시 중단) LTM 공란
  const recentIso = new Date(Date.now() - 500 * 864e5).toISOString().slice(0, 10);
  const intFresh = [...INT_EXP, ...INT_INC].some((c) =>
    firstConcept(facts, [c]).some((e) => e.end >= recentIso),
  );
  if (!intFresh && LTM in netIntCost) netIntCost[LTM] = null;
  const hasInterest = !isFin && labels.some((l) => netIntCost[l] != null);
  const tax = val(TAX);
  // 지배주주 순이익 — edgar-pershare.ts 공통 규칙(하이라이트·재무분석과 같은 값).
  // NetIncomeLoss 가 없는 기간은 ProfitLoss − 비지배지분(BE 2024·2025).
  const netIncome = (() => {
    const out = blank();
    const entries = netIncomeToParentEntries(facts);
    if (quarterly) {
      qShow.forEach((q, i) => {
        out[q.label] = quarterValue(entries, i, true);
      });
      return out;
    }
    const ann = netIncomeAnnualByYear(facts);
    for (const y of years) out[fyKey(y)] = ann.get(y) ?? null;
    out[LTM] = ltmNetIncome(facts);
    return out;
  })();
  // (−) 기타 = (세전이익 − 법인세비용) − 공시 당기순이익 (중단사업·소수주주지분 등)
  const otherToNi = blank();
  for (const l of labels)
    if (pretax[l] != null && tax[l] != null && netIncome[l] != null)
      otherToNi[l] = Math.round(pretax[l]! - tax[l]! - netIncome[l]!);
  // 액면분할 보정: 소급 재작성 안 된 과거 연도 EPS 를 최신 연도 기준으로 환산
  const splitF = splitFactorsByYear(facts);
  const adjEps = (o: Record<string, number | null>): Record<string, number | null> => {
    if (quarterly) return o;
    const r = { ...o };
    for (const y of years) {
      const f = splitF.get(y);
      if (f != null && f !== 1 && r[fyKey(y)] != null) r[fyKey(y)] = r[fyKey(y)]! * f;
    }
    return r;
  };
  // EPS: 공시 태그 우선. 클래스별로만 태깅하는 기업(Visa)은 순이익÷주식수로 산출.
  const wavgShares = val(
    ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfSharesOutstandingBasic"],
    "shares",
  );
  // 주식수는 흐름(더하고 빼도 되는 값)이 아니라 시점 값이라, val() 이 LTM 칸에
  // 채워 넣는 ttmOf 차감식("최근 FY + 당기누적 − 전년동기누적") 결과가 의미가
  // 없다 — 실측(2026-09-23, Bloom Energy): 실제 발행주식수가 2.3억→2.84억으로
  // 늘어난 구간인데 이 식은 3.3억 주를 내놔, 같은 회사 LTM EPS 가 재무제표
  // 탭에서는 0.030, 개요/하이라이트에서는 0.035 로 갈렸다(오너 지적 — "be 개요
  // 재무하이라이트에 eps -0.04 재무제표 is에서 0.03"). LTM 칸은 비워서 아래
  // deriveEps 가 현재 주식수(sharesHint, 다른 모듈과 같은 분모)를 쓰게 한다.
  if (!quarterly) wavgShares[LTM] = null;
  let epsApprox = false;
  const yearOf = (l: string): number => Number(l.replace(/[^0-9]/g, "")) || 0;
  const deriveEps = (
    o: Record<string, number | null>,
    kind: "basic" | "diluted",
  ): Record<string, number | null> => {
    const r = { ...o };
    for (const l of labels) {
      if (r[l] != null) continue;
      // Q4 열(사업연도 − 9개월 누적)은 주당 값을 빼서 만들 수 없다 — 현재 주식수로 근사하지 않고 공란
      if (q4Labels.has(l)) continue;
      // Class A 공시값(실측) 우선 — 근사 아님
      const ca = quarterly ? null : classAEps(classFacts, yearOf(l), kind);
      if (ca != null) {
        r[l] = ca;
        continue;
      }
      const dcl =
        wavgShares[l] ??
        (quarterly
          ? null
          : l === LTM
            ? (classALatest(classFacts)?.dilShares ?? null)
            : classAShares(classFacts, yearOf(l)));
      const sh = dcl ?? sharesHint;
      if (netIncome[l] != null && sh) {
        r[l] = netIncome[l]! / sh;
        if (dcl == null) epsApprox = true;
      }
    }
    return r;
  };
  // ① EPS 는 흐름(매출·순이익)과 달라 singleQuarter/ttmOf 의 "누적값 차감"
  // 식이 안 성립한다 — 분모(가중평균 주식수)가 분기마다 달라 단순 뺄셈이
  // 실제 TTM 주당순이익을 안 준다(오너 지적, 2026-09-23 — Bloom Energy
  // "당기순이익은 9백만인데 기본/희석 EPS는 마이너스"). val()의 LTM 결과가
  // null이 아니면 바로 아래 deriveEps()의 "순이익÷주식수" 폴백이
  // `r[l] != null` 에 걸려 아예 안 도는 게 원인 — LTM은 차감식 결과를 버리고
  // 항상 그 폴백을 타게 한다.
  //
  // ② 공시 태그값 자체가 틀린 경우도 있다 — 실측(2026-09-23): Bloom Energy
  // 2025 Q3 10-Q(accn 0001628280-25-046844)가 `EarningsPerShareBasic`/
  // `Diluted`를 단일분기 -100, 9개월 누적 -380으로 오기재했다(당기순손실
  // 2,296만 달러·주식수 약 2.3억주면 정상 EPS는 -0.1 안팎이어야 함 — 회사가
  // 자릿수를 잘못 태깅한 것으로 보임). ①과 달리 이건 차감식이 아니라
  // "직접 단일분기로 태깅된 값"(direct) 자체가 틀린 사례라 경로를 우회해도
  // 못 피한다 — 태그값을 순이익÷주식수 근사와 대조해 벌어지면 신뢰하지
  // 않고 폴백으로 넘긴다.
  //
  // 배수는 처음 10배로 뒀다가 5배로 낮췄다(오너 지적, 2026-09-23 — "10배
  // 괴리는 너무 크다, 반도체 기업처럼 2~3배 변동도 있을 수 있는데 그러면
  // 일반적 오류를 못 찾을 수 있다"). 이 대조는 분기별 실적 변동(다른 분기
  // 대비 2~3배)이 아니라 **같은 분기 안에서** "공시 태그"와 "순이익÷주식수
  // 단순 나눗셈"을 비교하는 것이라 성격이 다르다 — 우선주 배당 차감·
  // Two-Class Method·희석증권 등 정상적인 차이도 보통 2배를 잘 안 넘는다
  // (그 이상 벌어지는 진짜 예외는 Visa 등 별도 classFacts 경로로 이미
  // 처리됨). 5배는 그 정상 오차보다 넉넉한 여유를 두면서도, 10배보다
  // 작은 규모의 오기재(자릿수 일부만 밀린 경우 등)를 더 많이 잡아낸다.
  const plausibleEps = (tagVal: number, l: string): boolean => {
    const ni = netIncome[l];
    const sh = wavgShares[l] ?? sharesHint;
    if (ni == null || !sh) return true; // 대조 불가 — 태그값 그대로 신뢰
    const approx = ni / sh;
    if (Math.abs(approx) < 0.01) return Math.abs(tagVal) < 1; // 거의 손익분기인데 태그가 크면 의심
    const ratio = Math.abs(tagVal / approx);
    return ratio <= 5 && ratio >= 0.2;
  };
  const valEps = (concepts: string[]): Record<string, number | null> => {
    if (quarterly) {
      const out = blank();
      qShow.forEach((q) => {
        for (const c of concepts) {
          const v = directQuarterValue(entriesOf(facts, c, "USD/shares"), q);
          if (v != null && plausibleEps(v, q.label)) { out[q.label] = v; break; }
        }
      });
      return out;
    }
    const out = val(concepts, "USD/shares");
    out[LTM] = null; // TTM 흐름식 결과 버림 — 항상 순이익÷주식수로 계산
    for (const y of years) {
      const l = fyKey(y);
      if (out[l] != null && !plausibleEps(out[l]!, l)) out[l] = null;
    }
    return out;
  };
  const epsBasic = deriveEps(adjEps(valEps(EPS_BASIC)), "basic");
  const epsDil = deriveEps(adjEps(valEps(EPS_DIL)), "diluted");
  // 연간 희석 EPS 는 하이라이트·재무분석·컨센서스와 **같은 공통 함수**로 덮어쓴다(단일 기준).
  // 예전엔 여기서 따로 계산해 (1) LTM 은 Yahoo 주식수를, 하이라이트는 공통 현재 주식수를 써서
  // 거의 전 종목이 0.2~5% 갈렸고 (2) MCD 처럼 가중평균 주식수를 백만 단위로 공시한 회사는
  // 타당성 검사가 단위 보정 전 주식수와 비교하다 정상 EPS(10.04)를 버리고 1,003만을 냈다
  // (검증 도구 재구축 후 첫 실행에서 발견, 2026-09-24).
  if (!quarterly) {
    const shareRes = buildShareResolver(facts, { classFacts, sharesHint });
    const le = ltmEps(facts, shareRes.current());
    if (le != null) epsDil[LTM] = le;
    for (const p of periods) {
      if (p.label === LTM) continue;
      const y = yearOf(p.label);
      const r = fyEps(facts, y, {
        classFacts,
        fyShares: shareRes.atFiscalYearEnd(y, p.endDate ?? `${y}-12-31`),
        fyNetIncome: netIncome[p.label] ?? null,
      });
      epsDil[p.label] = r.eps;
      if (r.approx) epsApprox = true;
    }
  }

  // 감가상각비 — edgar-ev.ts pickDa 규칙(하이라이트·분석 지표와 같은 판정).
  // "앞 태그 우선"이던 예전 방식은 MCD 등에서 일부 항목만 담긴 태그를 집었다.
  const da = (() => {
    const totals = DA_TOTAL.map((c) => val([c]));
    const dep = val(DA_DEPRECIATION);
    const am = val([DA_INTANGIBLE]);
    const cf = val([SYN_DA_CF]);
    const o = blank();
    // 본표 판독이 원본 조회 실패로 빠졌으면 태그 규칙으로 대체하지 않고 공란(sec-unavailable.ts)
    if (unavailableOn(facts, "da")) return o;
    for (const l of labels) o[l] = pickDa(totals.map((t) => t[l]), dep[l], am[l], cf[l]);
    return o;
  })();
  const oneOff = unavailableOn(facts, "oneOff") ? blank() : val(["OneOffChargesDerived"]);
  // 감가상각비 구성요소가 없으면(매핑 누락 — IFRS 20-F 등) EBITDA 도 공란(0 으로
  // 보지 않음, Yahoo 분기 LTM 여부와 무관 — 독립 감사 지적 2026-09-25 NVO·SAP)
  const ebitda = blank();
  for (const l of labels)
    if (opIncome[l] != null && da[l] != null) ebitda[l] = opIncome[l]! + da[l]!;

  const row = (
    label: string,
    values: Record<string, number | null>,
    opts: Partial<FinancialLineItem> = {},
  ): FinancialLineItem => ({
    accountName: label,
    accountId: `is:${label}`,
    depth: 1,
    isSubtotal: false,
    isHighlight: false,
    values,
    ...opts,
  });

  // 매출원가·매출총이익 구조가 없는 업종(항공·호텔·서비스·정유 등)은
  // 매출액 → (−)영업비용 총계 → 영업이익 으로 축약
  const hasGross = labels.some((l) => grossProfit[l] != null);
  const totalOpex = (() => {
    const o = blank();
    for (const l of labels)
      if (revenue[l] != null && opIncome[l] != null) o[l] = revenue[l]! - opIncome[l]!;
    return o;
  })();

  // 매출원가·매출총이익 칸 주석 — 합성 매출총이익은 줄 이름에, 그 밖의 사유(구성 규칙 대기·회사 공시 자체·제외 항목 있는 원가 줄·
  // 빈칸 사유)는 각주로(표시 열만)
  const noteGroups = (pick: (c: RevCol) => string | null) => {
    const by = new Map<string, string[]>();
    for (const l of labels) { const t = finColOf.get(l) ? pick(finColOf.get(l)!) : null; if (t) by.set(t, [...(by.get(t) ?? []), l]); }
    return [...by];
  };
  const gpNotes = noteGroups((c) => c.gpNote);
  const cogsNotes = noteGroups((c) => c.cogsNote);
  const synthNote = gpNotes.find(([t]) => t.startsWith(COGS_NOTE.synth))?.[0] ?? null;
  const sameCols = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const cogsFootnotes: FinancialLineItem[] = isFin && !cogsNotes.length ? [] : [
    ...cogsNotes.map(([t, ls]) => ({ what: gpNotes.some(([g, gl]) => g === t && sameCols(gl, ls)) ? "매출원가·매출총이익" : "매출원가", t, ls })),
    ...gpNotes.filter(([t, ls]) => !t.startsWith(COGS_NOTE.synth) && !cogsNotes.some(([c, cl]) => c === t && sameCols(cl, ls))).map(([t, ls]) => ({ what: "매출총이익", t, ls })),
  ].map(({ what, t, ls }) =>
    row(`※ ${what}: ${t}${ls.length === labels.length ? "" : ` (${ls.join(", ")})`}`, blank(), { depth: 1, italic: true }));

  const items: FinancialLineItem[] = [
    row(isFin ? "순수익" : "매출액", revenue, { depth: 0, isSubtotal: true, isHighlight: true }),
    ...(isFin
      ? [
          row("(−) 총이자외비용", finNoninterestExpense),
          row("충당금전이익", grossProfit, { depth: 0, isSubtotal: true, isHighlight: true }),
          row("(−) 대손충당금", finProvision),
        ]
      : hasGross
        ? [
            row("(−) 매출원가", cogs),
            row(synthNote ? `매출총이익 (${synthNote})` : "매출총이익", grossProfit, { depth: 0, isSubtotal: true, isHighlight: true }),
            row("(−) 판매관리비", sga),
            row("(−) 연구개발비", rnd),
            row("(−) 기타 영업비용", otherOpex),
          ]
        : [row("(−) 영업비용", totalOpex)]),
    row(
      !isFin && opIncomeIsDerived(facts)
        ? facts.opIncomeFromStructure
          ? "영업이익 (소계 없음 · 세전이익−영업외 항목, 공시 계산 구조)"
          : facts.financialSector
          ? "영업이익 (태그 없음 · 세전이익 — 금융업은 이자가 본업)"
          : facts.nonopInRevenues
          ? "영업이익 (태그 없음 · 세전이익+이자비용−지분법·기타수익)"
          : "영업이익 (태그 없음 · 세전이익+이자비용−지분법이익 근사)"
        : "영업이익",
      opIncome,
      { depth: 0, isSubtotal: true, isHighlight: true },
    ),
    row("(−) 영업외손익", nonOpLoss),
    ...(hasInterest
      ? [row("(순이자비용)", netIntCost, { depth: 2, italic: true, paren: true })]
      : []),
    row("세전이익", pretax, { depth: 0, isSubtotal: true, isHighlight: true }),
    row("(−) 법인세비용", tax),
    row("(−) 기타", otherToNi),
    row("당기순이익", netIncome, { depth: 0, isSubtotal: true, isHighlight: true }),
    row("기본 EPS", epsBasic, { numberFormat: "eps" }),
    row("희석 EPS", epsDil, { numberFormat: "eps" }),
    { accountName: "", accountId: "is:sp", depth: 0, isSubtotal: false, isHighlight: false, values: blank() },
    row("[ 주석 항목 ]", blank(), { depth: 0, isSubtotal: true }),
    row("EBITDA", ebitda),
    row("감가상각비", da),
    // 손익계산서에 별도 줄로 공시된 구조조정·손상·위약금·합의금 등의 합(edgar-oneoff.ts) — 영업이익에 이미 반영
    row("일회성비용(구조조정·손상차손·위약금·합의금 등)", oneOff),
  ];
  items.push(...cogsFootnotes);
  // SEC 원본 조회 실패로 공란이 된 값(영업이익·감가상각비·EBITDA·일회성비용 — 대체 계산 없음, sec-unavailable.ts)
  const unavailable = unavailableNote(facts);
  if (unavailable) items.push(row(`※ ${unavailable}`, blank(), { depth: 1, italic: true }));
  if (!isFin && labels.some((l) => oneOff[l] != null))
    items.push(
      row("※ 일회성비용: 손익계산서에 별도 줄로 공시된 항목만(다른 비용 줄에 섞인 금액은 빠짐) · 영업이익에 이미 반영된 금액", blank(), {
        depth: 1,
        italic: true,
      }),
    );

  if (epsApprox && !quarterly)
    items.push(
      row("※ EPS: 클래스별로만 공시(Visa 등) → 순이익÷주식수 근사", blank(), {
        depth: 1,
        italic: true,
      }),
    );

  return {
    symbol: "",
    market: "us",
    periodType: "annual",
    unit: "USD",
    currency: "USD",
    consolidation: "consolidated",
    periods,
    sections: [{ title: "손익계산서", items }],
    source: "SEC EDGAR · 표준화 재분류",
  };
}
