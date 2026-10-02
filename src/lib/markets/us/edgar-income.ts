import "server-only";
import { unavailableNote, unavailableOn } from "./sec-unavailable";
import { yahooLtm } from "./edgar-yahoo-quarters";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import type { FinancialStatement, FinancialLineItem, FinancialPeriod } from "../types";
import {
  ANNUAL_FORMS,
  INTERIM_FORMS,
  annualByYear,
  bestLtmFlow,
  days,
  directQuarterValue,
  entriesOf,
  firstConcept,
  fiscalYearOf,
  isFullYearDuration,
  ltmAnchor,
  ltmFlowOf,
  shiftYear,
  singleQuarterParts,
  type QuarterParts,
  splitFactorsByYear,
  type QuarterCol,
} from "./edgar-series";
import { DA_BASIS_MIX, daBasisMixed, DA_DEPRECIATION, DA_INTANGIBLE, DA_LTM_NO_STRUCT, DA_QUARTER_NO_STRUCT, DA_TOTAL, daStructConcept, daTtmCell, OPINC_FIN_FAIL, opIncomeIsDerived, opIncomeViaFin, pickDa, pickDaPeriod, SYN_OP_INCOME } from "./edgar-ev";
import { FY_EPS_NOTE, fyEps, ltmEpsOf, ltmNetIncomeOf, netIncomeAnnualByYear, netIncomeToParentEntries } from "./edgar-pershare";
import { buildShareResolver } from "./edgar-shares";
import { classAEps, type ClassAFacts } from "./edgar-classfacts";
import {
  FIN_NONINTEREST_EXPENSE,
  FIN_PROVISION,
  isFinancialCompany,
} from "./edgar-financial";
import { revAnnualEnds, revAnnualMap, revAnnualYears, revLtm, revQuarterLabel, type FinSubLine, type RevCol } from "./fin-revenue";
import { COGS_NOTE, SGA_NOTE } from "@/lib/fin";

/**
 * 미국 상세 손익계산서 — SEC EDGAR companyfacts 정규화 재분류 (블룸버그 I/S 근사).
 * 컬럼: 최근 5개 사업연도 + 최근 12개월 (분기 모드는 최근 5분기).
 * 계산 라인('기타 영업비용' 등)은 (구간값 − 매핑 라인)으로 자동 정합.
 * 예상치는 재무 하이라이트(개요)에서 제공 → 여기선 실적만.
 */

const OPEX = ["OperatingExpenses", "CostsAndExpenses"];
// 판관비·연구개발비는 태그로 고르지 않는다 — 재무 5층 구조 지표(fin-revenue.ts 열의 sga·rnd, docs/metrics/sga.md): 본표 영업이익 식의
// 판관비·연구개발비 성격 줄 합(여러 줄이면 하위 줄 표시). 예전 태그 목록(SG&A → G&A 순)은 판매·마케팅 줄을 기타 영업비용으로 흘렸다
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
/** 합성 영업이익이 세전이익 그대로인 칸(이자비용 태그 없음) — G6 */
const PRETAX_ONLY_NOTE = "영업이익 태그 없음 · 세전이익 그대로(이자비용 태그 없음 — 이자·지분법 미조정)";

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
  /** quarterValue 와 같은 값 + 구성 항목(감가상각비 기준 혼합 판정 — edgar-ev.ts daBasisMixed) */
  const quarterParts = (entries: FactUnitEntry[], i: number, flow: boolean): QuarterParts => {
    const q = qShow[i];
    if (!q4Labels.has(q.label)) return singleQuarterParts(entries, q, prevOf(i));
    const none: QuarterParts = { value: null, parts: [], reason: null };
    if (!flow) return none;
    const q3End = q3EndOf(i);
    if (!q3End) return none;
    const newest = (xs: FactUnitEntry[]) => xs.sort((a, b) => (b.filed ?? "").localeCompare(a.filed ?? ""))[0];
    const fy = newest(entries.filter((e) => e.start && ANNUAL_FORMS.includes(e.form) && isFullYearDuration(e) && Math.abs(days(q.end, e.end)) <= 6));
    const nine = newest(entries.filter((e) => e.start && INTERIM_FORMS.includes(e.form) && Math.abs(days(q3End, e.end)) <= 6 && days(e.start, e.end) >= 250 && days(e.start, e.end) <= 290));
    if (!fy?.start || !nine?.start || Math.abs(days(fy.start, nine.start)) > 12) return none;
    return { value: fy.val - nine.val, parts: [fy, nine], reason: null };
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
  // 칸 주석(그림자 채우기 금지, 2026-09-27) — 빈칸 사유·근사 라벨. row() 가 cellNotes 로 싣는다
  const WHY = new WeakMap<Record<string, number | null>, Record<string, string>>();
  const note = (o: Record<string, number | null>, l: string, t: string | null | undefined) => {
    if (!t) return;
    const m = WHY.get(o) ?? {};
    if (!m[l]) m[l] = t;
    WHY.set(o, m);
  };
  /** 회사 재분류 1분기 칸 주석(edgar-series.ts recastFirstQuarter)을 파생 행에 물려줄 때 붙일 원 행 이름 — 없으면 물려주지 않는다(원래 값이 어느 줄 값인지 모름) */
  const ROW_NAME = new WeakMap<Record<string, number | null>, string>();
  const RECAST_NOTE = /^(역산추정|최신공시변경) — /;
  const inheritWhy = (out: Record<string, number | null>, ...ins: Record<string, number | null>[]) => {
    for (const l of labels)
      for (const i of ins) {
        const w = WHY.get(i)?.[l];
        if (w && (i[l] == null ? out[l] == null : true)) {
          if (RECAST_NOTE.test(w)) {
            const nm = ROW_NAME.get(i);
            if (!nm) continue;
            note(out, l, `${nm} ${w}`);
            break;
          }
          note(out, l, w);
          break;
        }
      }
    return out;
  };

  const val = (concepts: string[], unit = "USD"): Record<string, number | null> => {
    const out = blank();
    if (quarterly) {
      qShow.forEach((q, i) => {
        for (const c of concepts) {
          const r = quarterParts(entriesOf(facts, c, unit), i, unit === "USD");
          if (r.value != null) { out[q.label] = r.value; if (r.note) note(out, q.label, r.note); break; }
        }
      });
      return out;
    }
    const ann = mergedAnnual(concepts, unit);
    for (const y of years) out[fyKey(y)] = ann.get(y) ?? null;
    // 가장 최근 데이터가 있는 개념의 TTM (태그 이전 후 과거 개념 옛 FY값 방지) — 없으면 공란 + 사유
    const r = bestLtmFlow(facts, concepts, unit);
    out[LTM] = r.value;
    if (r.value == null) note(out, LTM, r.reason);
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
    return inheritWhy(out, a, ...subs);
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
  const opex = val(OPEX);
  const pretax = val(PRETAX);
  // 세전이익 태그가 없는 칸 — 순이익 + 법인세 등으로 만들지 않는다(사유)
  for (const l of labels) if (pretax[l] == null && !WHY.get(pretax)?.[l]) note(pretax, l, "세전이익 공시 없음");
  // 영업이익·영업비용 = 재무 5층 구조 지표(fin opinc·opex — 본표 영업이익 소계, 없으면 공시 계산 구조 합성, docs/metrics/cogs.md §8).
  // 열은 매출과 같은 fin 열. 빈칸은 fin 사유(옛 합성 시계열로 채우지 않음). 금융사(fin 유형)는 옛 경로(아래)
  const opViaFin = !isFin && opIncomeViaFin(facts);
  const finCellVal = (pick: (c: RevCol) => number | null, why: (c: RevCol) => string | null): Record<string, number | null> => {
    const o = finVal(pick);
    for (const l of labels) {
      const c = finColOf.get(l);
      note(o, l, !rev ? OPINC_FIN_FAIL : !c ? "fin 열 없음" : (why(c) ?? (pick(c) == null ? "fin 값 없음" : null)));
    }
    return o;
  };
  const finOpex = opViaFin ? finCellVal((c) => c.opex, (c) => c.opexNote) : null;
  // 판관비·연구개발비 = fin 지표(본표 판관비·연구개발비 성격 줄 합). 빈칸은 fin 사유(칸 주석)
  const sga = finCellVal((c) => c.sga, (c) => c.sgaNote);
  const rnd = finCellVal((c) => c.rnd, (c) => c.rndNote);
  /** 기타 영업비용 차감용 — 본표에 그 줄이 없는 칸(SGA_NOTE.noLine)은 0, 그 밖의 빈칸은 빈칸(차감 불가) */
  const asZeroIfNoLine = (o: Record<string, number | null>): Record<string, number | null> => {
    const r = blank();
    for (const l of labels) r[l] = o[l] ?? (WHY.get(o)?.[l]?.startsWith(SGA_NOTE.noLine) ? 0 : null);
    WHY.set(r, Object.fromEntries(labels.filter((l) => r[l] == null && WHY.get(o)?.[l]).map((l) => [l, WHY.get(o)![l]])));
    return r;
  };
  // 영업이익: 금융회사는 충당금전이익 − 대손충당금. 그 외는 fin 영업이익(금융사 유형 증권·보험은 옛 단일 기준 시계열)
  const opIncome = (() => {
    if (isFin) {
      // 대손충당금이 그 기간에 없으면 0 으로 보지 않는다(태그 자체가 없는 회사만 0 — 그림자 채우기 금지)
      const provEver = FIN_PROVISION.some((c) => entriesOf(facts, c).length > 0);
      const o = blank();
      for (const l of labels)
        if (grossProfit[l] != null && (finProvision[l] != null || !provEver)) o[l] = Math.round(grossProfit[l]! - (finProvision[l] ?? 0));
      return inheritWhy(o, grossProfit, finProvision);
    }
    if (opViaFin) return finCellVal((c) => c.opinc, (c) => c.opincNote);
    const o = val(OP_INCOME);
    // 합성 영업이익 산식이 "세전이익 그대로"(이자비용 태그 없음)인 칸 — 칸마다 라벨(G6)
    if (!quarterly) {
      const syn = entriesOf(facts, SYN_OP_INCOME);
      for (const y of years) {
        const e = syn
          .filter((x) => x.synBasis && x.fp === "FY" && isFullYearDuration(x) && ANNUAL_FORMS.includes(x.form) && fiscalYearOf(x.end) === y)
          .sort((a, b) => (b.filed ?? "").localeCompare(a.filed ?? ""))[0];
        if (e?.synBasis === "pretax" && o[fyKey(y)] != null) note(o, fyKey(y), PRETAX_ONLY_NOTE);
      }
      const lf = ltmFlowOf(syn, ltmAnchor(facts));
      if (o[LTM] != null && [lf.fy, lf.cur, lf.prior].some((x) => x?.synBasis === "pretax")) note(o, LTM, PRETAX_ONLY_NOTE);
    }
    return o;
  })();
  // 기타 영업비용 = OPEX − SGA − RND, 없으면 GrossProfit − OpIncome − SGA − RND. fin 경로는 fin 영업비용(매출총이익 − 영업이익) − SGA − RND
  const otherOpex = (() => {
    if (finOpex) return diff(finOpex, asZeroIfNoLine(sga), asZeroIfNoLine(rnd));
    const base = labels.some((l) => opex[l] != null)
      ? opex
      : diff(grossProfit, opIncome);
    return diff(base, asZeroIfNoLine(sga), asZeroIfNoLine(rnd));
  })();
  // (−)영업외손익 = 세전이익 − 영업이익 (부호 반전). 워터폴 정합을 위해 이 정의만.
  // NonoperatingIncomeExpense 태그는 일부 항목만 담는 기업(IBM 등)이 많아 대신 쓰지 않는다(그림자 채우기 금지, 2026-09-27)
  const nonOpLoss = (() => {
    const out = blank();
    for (const l of labels) if (pretax[l] != null && opIncome[l] != null) out[l] = -(pretax[l]! - opIncome[l]!);
    return inheritWhy(out, pretax, opIncome);
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
    // 한쪽이 그 기간에 없으면 0 으로 보지 않는다 — 그 개념 태그를 아예 쓰지 않는 회사만 0(그 줄이 없음)
    const expEver = INT_EXP.some((c) => entriesOf(facts, c).length > 0);
    const incEver = INT_INC.some((c) => entriesOf(facts, c).length > 0);
    for (const l of labels) {
      if (intExp[l] == null && intInc[l] == null) {
        // 둘 다 빈 칸 — 구성 항목의 사유(LTM 구성 분기 없음 등)를 물려준다
        note(netIntCost, l, WHY.get(intExp)?.[l] ?? WHY.get(intInc)?.[l]);
        continue;
      }
      if (l === LTM && (gapI(intExp) || gapI(intInc))) {
        note(netIntCost, l, gapI(intExp) ? "LTM 이자비용 구성 분기 없음" : "LTM 이자수익 구성 분기 없음");
        continue;
      }
      if ((intExp[l] == null && expEver) || (intInc[l] == null && incEver)) {
        note(netIntCost, l, intExp[l] == null ? "이자비용 공시 없음" : "이자수익 공시 없음");
        continue;
      }
      netIntCost[l] = (intExp[l] ?? 0) - (intInc[l] ?? 0);
    }
  }
  // 최근 데이터가 없으면(예: 회사가 이자 항목 별도 표시 중단) LTM 공란
  const recentIso = new Date(Date.now() - 500 * 864e5).toISOString().slice(0, 10);
  const intFresh = [...INT_EXP, ...INT_INC].some((c) =>
    firstConcept(facts, [c]).some((e) => e.end >= recentIso),
  );
  if (!intFresh && LTM in netIntCost) netIntCost[LTM] = null;
  // 값이 없어도 사유가 있으면 줄을 둔다(빈칸 사유가 화면에서 사라지지 않게)
  const hasInterest = !isFin && labels.some((l) => netIntCost[l] != null || WHY.get(netIntCost)?.[l]);
  const tax = val(TAX);
  // 지배주주 순이익 — edgar-pershare.ts 공통 규칙(하이라이트·재무분석과 같은 값).
  // NetIncomeLoss 가 없는 기간은 ProfitLoss − 비지배지분(BE 2024·2025).
  const netIncome = (() => {
    const out = blank();
    const entries = netIncomeToParentEntries(facts);
    if (quarterly) {
      qShow.forEach((q, i) => {
        const r = quarterParts(entries, i, true);
        out[q.label] = r.value;
        if (r.note) note(out, q.label, r.note);
      });
      return out;
    }
    const ann = netIncomeAnnualByYear(facts);
    for (const y of years) out[fyKey(y)] = ann.get(y) ?? null;
    const r = ltmNetIncomeOf(facts);
    out[LTM] = r.value;
    if (r.value == null) note(out, LTM, r.reason);
    return out;
  })();
  // (−) 기타 = (세전이익 − 법인세비용) − 공시 당기순이익 (중단사업·소수주주지분 등)
  const otherToNi = blank();
  for (const l of labels)
    if (pretax[l] != null && tax[l] != null && netIncome[l] != null)
      otherToNi[l] = Math.round(pretax[l]! - tax[l]! - netIncome[l]!);
  inheritWhy(otherToNi, pretax, tax, netIncome);
  // 액면분할 보정: 소급 재작성 안 된 과거 연도 EPS 를 최신 연도 기준으로 환산
  const splitF = splitFactorsByYear(facts);
  const adjEps = (o: Record<string, number | null>): Record<string, number | null> => {
    if (quarterly) return o;
    const r = { ...o };
    if (WHY.get(o)) WHY.set(r, { ...WHY.get(o)! });
    for (const y of years) {
      const f = splitF.get(y);
      if (f != null && f !== 1 && r[fyKey(y)] != null) r[fyKey(y)] = r[fyKey(y)]! * f;
    }
    return r;
  };
  // EPS: 공시 태그만. 없으면 Class A 공시 EPS(클래스별로만 공시 — 라벨), 그 밖은 공란 + 사유.
  // 그림자 채우기 금지(2026-09-27): 예전엔 순이익 ÷ (희석 가중평균 → Class A → Yahoo 힌트)로 만들었다 — 기본 EPS 를 희석 주식수로
  // 나누는 등 정의가 달랐고, 분기·LTM 근사에 라벨도 없었다. 연간 희석 EPS 는 공통 함수 fyEps(라벨 포함, 오너 승인 근사 G4).
  const wavgShares = val(
    ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfSharesOutstandingBasic"],
    "shares",
  );
  // 주식수는 흐름이 아니라 LTM 차감식이 성립하지 않는다 — LTM 칸은 비운다(타당성 대조에도 안 씀)
  if (!quarterly) wavgShares[LTM] = null;
  const yearOf = (l: string): number => Number(l.replace(/[^0-9]/g, "")) || 0;
  /** Class A 공시 EPS(Visa 등, 10-K 원본 실측) — 연간만. 라벨(G5) */
  const withClassA = (o: Record<string, number | null>, kind: "basic" | "diluted"): Record<string, number | null> => {
    const r = { ...o };
    WHY.set(r, { ...(WHY.get(o) ?? {}) });
    if (quarterly) return r;
    for (const l of labels) {
      if (r[l] != null || l === LTM) continue;
      const ca = classAEps(classFacts, yearOf(l), kind);
      if (ca != null) {
        r[l] = ca;
        note(r, l, FY_EPS_NOTE.classA);
      }
    }
    return r;
  };
  // ② 공시 태그값 자체가 틀린 경우 — 실측(2026-09-23): Bloom Energy 2025 Q3 10-Q 가 EPS 를 단일분기 -100, 9개월 -380 으로
  // 오기재. 태그값을 순이익 ÷ 공시 가중평균 주식수와 대조해 5배 넘게 벌어지면 쓰지 않는다 — 근사값으로 바꾸지 않고
  // 공란 + "공시 EPS 이상치"(그림자 채우기 금지). 대조할 주식수가 없으면 태그값 그대로.
  const plausibleEps = (tagVal: number, l: string): boolean => {
    const ni = netIncome[l];
    const sh = wavgShares[l];
    if (ni == null || !sh) return true; // 대조 불가 — 태그값 그대로 신뢰
    const approx = ni / sh;
    if (Math.abs(approx) < 0.01) return Math.abs(tagVal) < 1; // 거의 손익분기인데 태그가 크면 의심
    const ratio = Math.abs(tagVal / approx);
    // 가중평균 주식수를 천·백만 주 단위로 잘못 태깅한 회사(MCD 716.4 = 7억 1,640만 주 — edgar-shares.ts fixScale)는 주식수
    // 쪽 단위 오류 — 공시 EPS 는 정상이다
    return [1, 1e3, 1e6].some((k) => ratio * k <= 5 && ratio * k >= 0.2);
  };
  const EPS_OUTLIER = "공시 EPS 이상치(순이익 ÷ 가중평균 주식수와 5배 넘게 차이) — 공란";
  const valEps = (concepts: string[]): Record<string, number | null> => {
    if (quarterly) {
      const out = blank();
      qShow.forEach((q) => {
        if (q4Labels.has(q.label)) {
          // Q4 열(사업연도 − 9개월 누적)은 주당 값을 빼서 만들 수 없다 — 공란
          note(out, q.label, "4분기 EPS 미공시(주당 값은 연간 − 9개월 차감 불가)");
          return;
        }
        let outlier = false;
        for (const c of concepts) {
          const v = directQuarterValue(entriesOf(facts, c, "USD/shares"), q);
          if (v == null) continue;
          if (plausibleEps(v, q.label)) { out[q.label] = v; outlier = false; break; }
          outlier = true;
        }
        if (out[q.label] == null) note(out, q.label, outlier ? EPS_OUTLIER : "분기 EPS 공시 없음");
      });
      return out;
    }
    const out = val(concepts, "USD/shares");
    out[LTM] = null; // TTM 흐름식 결과 버림 — 주당 지표는 누적 차감이 성립하지 않는다
    WHY.set(out, {});
    for (const y of years) {
      const l = fyKey(y);
      if (out[l] != null && !plausibleEps(out[l]!, l)) {
        out[l] = null;
        note(out, l, EPS_OUTLIER);
      }
    }
    return out;
  };
  const epsBasic = withClassA(adjEps(valEps(EPS_BASIC)), "basic");
  const epsDil = withClassA(adjEps(valEps(EPS_DIL)), "diluted");
  // 공시 EPS 가 없는 연도 칸 — 순이익 ÷ 주식수로 대신 만들지 않는다(그림자 채우기 금지) — 사유
  if (!quarterly)
    for (const y of years) if (epsBasic[fyKey(y)] == null && netIncome[fyKey(y)] != null) note(epsBasic, fyKey(y), "기본 EPS 공시 없음");
  if (!quarterly) note(epsBasic, LTM, "LTM 기본 EPS 미산정(희석 EPS 만 — 순이익 ÷ 현재 주식수)");
  // 연간 희석 EPS 는 하이라이트·재무분석·컨센서스와 **같은 공통 함수**로 덮어쓴다(단일 기준).
  // 예전엔 여기서 따로 계산해 (1) LTM 은 Yahoo 주식수를, 하이라이트는 공통 현재 주식수를 써서
  // 거의 전 종목이 0.2~5% 갈렸고 (2) MCD 처럼 가중평균 주식수를 백만 단위로 공시한 회사는
  // 타당성 검사가 단위 보정 전 주식수와 비교하다 정상 EPS(10.04)를 버리고 1,003만을 냈다
  // (검증 도구 재구축 후 첫 실행에서 발견, 2026-09-24).
  if (!quarterly) {
    const shareRes = buildShareResolver(facts, { classFacts, sharesHint });
    const le = ltmEpsOf(facts, shareRes.current());
    epsDil[LTM] = le.value;
    const m = WHY.get(epsDil) ?? {};
    delete m[LTM];
    WHY.set(epsDil, m);
    note(epsDil, LTM, le.value == null ? le.reason : shareRes.currentNote());
    for (const p of periods) {
      if (p.label === LTM) continue;
      const y = yearOf(p.label);
      const r = fyEps(facts, y, {
        classFacts,
        fyShares: shareRes.atFiscalYearEnd(y, p.endDate ?? `${y}-12-31`),
        fyNetIncome: netIncome[p.label] ?? null,
      });
      epsDil[p.label] = r.eps;
      const mm = WHY.get(epsDil)!;
      delete mm[p.label];
      note(epsDil, p.label, r.note);
    }
  }

  // 감가상각비 — edgar-ev.ts pickDa 규칙(하이라이트·분석 지표와 같은 판정).
  // "앞 태그 우선"이던 예전 방식은 MCD 등에서 일부 항목만 담긴 태그를 집었다.
  const da = (() => {
    const totals = DA_TOTAL.map((c) => val([c]));
    const dep = val(DA_DEPRECIATION);
    const am = val([DA_INTANGIBLE]);
    // 본표 계열(현금흐름표 계산 구조·NFLX 콘텐츠 상각 포함 — edgar-ev.ts daStructConcept). 분기·LTM 칸은 본표 값만(없으면 공란 + 사유)
    const sc = daStructConcept(facts);
    const cf = sc ? val([sc]) : blank();
    const o = blank();
    // 본표 판독이 원본 조회 실패로 빠졌으면 태그 규칙으로 대체하지 않고 공란(sec-unavailable.ts)
    if (unavailableOn(facts, "da")) return o;
    for (const l of labels) {
      const strict = !!sc && (quarterly || l === LTM);
      o[l] = strict ? pickDaPeriod(true, [], null, null, cf[l]) : pickDa(totals.map((t) => t[l]), dep[l], am[l], cf[l]);
      if (strict && o[l] == null) note(o, l, l === LTM ? DA_LTM_NO_STRUCT : DA_QUARTER_NO_STRUCT);
    }
    if (sc) {
      // 파생 열(누적 차·Q4·LTM)의 구성 공시끼리 감가상각 줄 기준이 다르면 공란 + 사유(edgar-ev.ts daBasisMixed). 분기 3개월 값은 그대로
      if (quarterly)
        qShow.forEach((q, i) => {
          const r = quarterParts(entriesOf(facts, sc), i, true);
          if (o[q.label] != null && daBasisMixed(facts, r.parts)) {
            o[q.label] = null;
            WHY.set(o, { ...(WHY.get(o) ?? {}), [q.label]: DA_BASIS_MIX });
          } else if (o[q.label] == null && r.reason) WHY.set(o, { ...(WHY.get(o) ?? {}), [q.label]: r.reason });
          else if (o[q.label] != null && r.note) WHY.set(o, { ...(WHY.get(o) ?? {}), [q.label]: r.note });
        });
      else if (labels.includes(LTM)) {
        const c = daTtmCell(facts);
        o[LTM] = c.value;
        if (c.value == null && c.reason) WHY.set(o, { ...(WHY.get(o) ?? {}), [LTM]: c.reason });
        else if (c.value != null && c.note) WHY.set(o, { ...(WHY.get(o) ?? {}), [LTM]: c.note });
      }
    }
    // LTM — 최근 연도엔 있는데 LTM 에 없는 합계 태그가 있으면(구성항목 합이면 구성 태그도) 나머지로 낸 값은 부분값 — 공란
    if (!quarterly && cf[LTM] == null) {
      const prevL = labels[labels.length - 2];
      const g = (t: Record<string, number | null>) => t[LTM] == null && t[prevL] != null;
      if (totals.some(g) || (!totals.some((t) => t[LTM] != null) && (g(dep) || g(am)))) o[LTM] = null;
    }
    if (!quarterly && o[LTM] == null && o[labels[labels.length - 2]] != null) note(o, LTM, "LTM 감가상각비 구성 분기 없음");
    return o;
  })();
  const oneOff = unavailableOn(facts, "oneOff") ? blank() : val(["OneOffChargesDerived"]);
  const hasOneOff = labels.some((l) => oneOff[l] != null && oneOff[l] !== 0);
  // 감가상각비 구성요소가 없으면(매핑 누락 — IFRS 20-F 등) EBITDA 도 공란(0 으로
  // 보지 않음, Yahoo 분기 LTM 여부와 무관 — 독립 감사 지적 2026-09-25 NVO·SAP)
  for (const [r, nm] of [[grossProfit, "매출총이익"], [pretax, "세전이익"], [opIncome, "영업이익"], [tax, "법인세"], [netIncome, "당기순이익"], [da, "감가상각비"]] as const) ROW_NAME.set(r, nm);
  const ebitda = blank();
  for (const l of labels)
    if (opIncome[l] != null && da[l] != null) ebitda[l] = opIncome[l]! + da[l]!;
  inheritWhy(ebitda, opIncome, da);

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
    ...(WHY.get(values) && Object.keys(WHY.get(values)!).length ? { cellNotes: WHY.get(values) } : {}),
    ...opts,
  });

  // 매출원가·매출총이익 구조가 없는 업종(항공·호텔·서비스·정유 등)은
  // 매출액 → (−)영업비용 총계 → 영업이익 으로 축약
  const hasGross = labels.some((l) => grossProfit[l] != null);
  const totalOpex = (() => {
    const o = blank();
    for (const l of labels)
      if (revenue[l] != null && opIncome[l] != null) o[l] = revenue[l]! - opIncome[l]!;
    return inheritWhy(o, opIncome);
  })();

  // 매출원가·매출총이익 칸 주석 — 합성 매출총이익은 줄 이름에, 그 밖의 사유(구성 규칙 대기·회사 공시 자체·제외 항목 있는 원가 줄·
  // 빈칸 사유)는 각주로(표시 열만)
  const noteGroups = (pick: (c: RevCol) => string | null) => {
    const by = new Map<string, string[]>();
    for (const l of labels) { const t = finColOf.get(l) ? pick(finColOf.get(l)!) : null; if (t) by.set(t, [...(by.get(t) ?? []), l]); }
    return [...by];
  };
  const gpNotes = noteGroups((c) => c.gpNote);
  // 판관비·연구개발비 — 본표 원래 줄 이름은 칸 주석("본표 줄 이름: …", 열별)에만. 행 이름 병기(2026-09-28)는 칸 주석과 중복이라 뺐다
  // (오너 지시 2026-10-02, AMD). 여러 줄 합이면 하위 줄을 행으로. 빈칸 사유(본표에 줄 없음 제외)는 각주
  const opexRow = (title: string, values: Record<string, number | null>, parts: FinSubLine[], id: string): FinancialLineItem[] => {
    const subs: { sp: FinSubLine; v: Record<string, number | null> }[] = [];
    for (const sp of parts) {
      const v = Object.fromEntries(labels.map((l) => [l, finColOf.get(l) ? (sp.v.get(finColOf.get(l)!.key) ?? null) : null])) as Record<string, number | null>;
      if (!labels.some((l) => v[l] != null)) continue;
      // 공시마다 개념만 다른 같은 이름 줄(KO "Other operating charges" — 10-K 와 10-Q 태그가 다름)은 열이 겹치지 않으면 한 행으로
      const same = subs.find((x) => x.sp.label === sp.label && labels.every((l) => x.v[l] == null || v[l] == null));
      if (same) for (const l of labels) same.v[l] ??= v[l];
      else subs.push({ sp, v });
    }
    return [
      row(title, values, { accountId: `is:${title}` }),
      ...subs.map((x) => row(x.sp.label, x.v, { depth: 2, italic: true, accountId: `is:${id}:${x.sp.id}` })),
    ];
  };
  const opexFootnotes = ([["판매관리비", (c: RevCol) => (c.sga == null ? c.sgaNote : null)], ["연구개발비", (c: RevCol) => (c.rnd == null ? c.rndNote : null)]] as const).flatMap(([what, pick]) =>
    noteGroups(pick)
      .filter(([t]) => !t.startsWith(SGA_NOTE.noLine))
      .map(([t, ls]) => row(`※ ${what}: ${t}${ls.length === labels.length ? "" : ` (${ls.join(", ")})`}`, blank(), { depth: 1, italic: true })));
  const cogsNotes = noteGroups((c) => c.cogsNote);
  // 매출총이익 합성(본표 소계 없음 · 매출 − 매출원가)은 줄 이름에 붙이지 않는다 — 불필요한 문구(오너 지시 2026-10-02, WMT)
  const sameCols = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const cogsFootnotes: FinancialLineItem[] = isFin && !cogsNotes.length ? [] : [
    ...cogsNotes.map(([t, ls]) => ({ what: gpNotes.some(([g, gl]) => g === t && sameCols(gl, ls)) ? "매출원가·매출총이익" : "매출원가", t, ls })),
    ...gpNotes.filter(([t, ls]) => !t.startsWith(COGS_NOTE.synth) && !cogsNotes.some(([c, cl]) => c === t && sameCols(cl, ls))).map(([t, ls]) => ({ what: "매출총이익", t, ls })),
  ].map(({ what, t, ls }) =>
    row(`※ ${what}: ${t}${ls.length === labels.length ? "" : ` (${ls.join(", ")})`}`, blank(), { depth: 1, italic: true }));

  // 영업이익 산식(합성·근사)은 줄 이름이 아니라 칸 주석에만 — 줄 이름과 칸 주석이 같은 말을 두 번 했다(오너 지시 2026-10-02 "본문행과 주석에
  // 같이 있는것은 주석만 남기고 지워라"). 이미 칸 주석(합성 산식·세전이익 그대로 등)이 있는 칸은 그대로 둔다
  if (!opViaFin && !isFin && opIncomeIsDerived(facts)) {
    const why = facts.opIncomeFromStructure
      ? "영업이익 소계 없음 · 세전이익 − 영업외 항목(공시 계산 구조)"
      : facts.financialSector
        ? "영업이익 태그 없음 · 세전이익(금융업은 이자가 본업)"
        : facts.nonopInRevenues
          ? "영업이익 태그 없음 · 세전이익 + 이자비용 − 지분법·기타수익"
          : "영업이익 태그 없음 · 세전이익 + 이자비용 − 지분법이익 근사";
    for (const l of labels) if (opIncome[l] != null && !WHY.get(opIncome)?.[l]) note(opIncome, l, why);
  }

  const items: FinancialLineItem[] = [
    row(isFin ? "순수익" : "매출액", revenue, {
      depth: 0,
      isSubtotal: true,
      isHighlight: true,
      // 매출이 빈 칸의 사유 — 조립 항등식 불성립으로 비운 열(fin-revenue.ts issues). 예전엔 출처 문구에만 내부 진단으로 붙었다(2026-10-01)
      ...(() => {
        const notes: Record<string, string> = {};
        for (const l of labels) {
          const c = finColOf.get(l);
          if (revenue[l] != null || !c) continue;
          const iss = rev?.issues.find((x) => x.col === c.key);
          if (iss?.rev.length) notes[l] = "매출 비움 — 회사 공시의 소계와 하위 줄 합이 맞지 않음(값을 대신 채우지 않음)";
        }
        return Object.keys(notes).length ? { cellNotes: notes } : {};
      })(),
    }),
    ...(isFin
      ? [
          row("(−) 총이자외비용", finNoninterestExpense),
          row("충당금전이익", grossProfit, { depth: 0, isSubtotal: true, isHighlight: true }),
          row("(−) 대손충당금", finProvision),
        ]
      : hasGross
        ? [
            row("(−) 매출원가", cogs),
            row("매출총이익", grossProfit, { depth: 0, isSubtotal: true, isHighlight: true }),
            ...opexRow("(−) 판매관리비", sga, rev?.sgaParts ?? [], "sga"),
            ...opexRow("(−) 연구개발비", rnd, rev?.rndParts ?? [], "rnd"),
            row("(−) 기타 영업비용", otherOpex),
          ]
        : [row("(−) 영업비용", totalOpex)]),
    row(
      "영업이익",
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
    // 손익계산서에 별도 줄로 공시된 구조조정·손상·위약금·합의금 등의 합(edgar-oneoff.ts) — 영업이익에 이미 반영.
    // 금액이 있는 경우에만 표시(오너 지시 2026-10-01 — 전 기간 0·빈칸이면 줄과 설명 모두 숨김, AAPL)
    ...(hasOneOff ? [row("일회성비용(구조조정·손상차손·위약금·합의금 등)", oneOff)] : []),
  ];
  items.push(...cogsFootnotes);
  if (!isFin && hasGross) items.push(...opexFootnotes);
  // SEC 원본 조회 실패로 공란이 된 값(영업이익·감가상각비·EBITDA·일회성비용 — 대체 계산 없음, sec-unavailable.ts)
  const unavailable = unavailableNote(facts);
  if (unavailable) items.push(row(`※ ${unavailable}`, blank(), { depth: 1, italic: true }));
  if (!isFin && hasOneOff)
    items.push(
      row("※ 일회성비용: 손익계산서에 별도 줄로 공시된 항목만(다른 비용 줄에 섞인 금액은 빠짐) · 영업이익에 이미 반영된 금액", blank(), {
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
