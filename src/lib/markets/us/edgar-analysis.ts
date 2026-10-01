import "server-only";
import { STI_TAGS, SYN_STI_FACE } from "./edgar-bs-structure";
import { equityRestatement } from "./edgar-balance";
import { buildUsCashFlow } from "./edgar-cashflow";
import { unavailableNote } from "./sec-unavailable";
import type { CompanyFacts } from "./edgar";
import type { FinancialStatement, FinancialLineItem, FinancialPeriod } from "../types";
import type { QuoteBar } from "../types";
import {
  annualByYear,
  bestLtmFlow,
  days,
  entriesOf,
  firstConcept,
  instantByYear,
  instantOn,
  shiftYear,
  splitFactorsByYear,
} from "./edgar-series";
import type { ClassAFacts } from "./edgar-classfacts";
import { buildShareResolver } from "./edgar-shares";
import { yahooLtm } from "./edgar-yahoo-quarters";
import {
  ltmEpsOf,
  fyEps,
  ltmNetIncomeOf,
  netIncomeAnnualByYear,
  parentEquityOf,
  positiveRatio,
} from "./edgar-pershare";
import {
  buildEvResolver,
  daAnnualByYear,
  daTtmCell,
  daTtm,
  opIncomeAnnualByYear,
  opIncomeAnnualCells,
  opIncomeLtm,
  opIncomeViaFin,
  SYN_OP_INCOME,
  type EvBlocker,
  type EvContext,
} from "./edgar-ev";
import {
  FIN_NONINTEREST_EXPENSE,
  FIN_PROVISION,
  isFinancialCompany,
} from "./edgar-financial";
import { revAnnualEnds, revAnnualMap, revAnnualYears, revLtm } from "./fin-revenue";

/**
 * 미국 분석 지표 — 밸류에이션·수익성·현금창출·재무건전성·주주환원·성장성.
 * SEC EDGAR companyfacts + 시세(bars). 컬럼: 최근 5개 사업연도 + 현재/LTM.
 */

const LTM = "현재/LTM";
const PRETAX_C = [
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesAndExtraordinaryItemsNoncontrollingInterest",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndEquityMethodInvestments",
];
const INT_EXP = [
  "InterestExpense",
  "InterestExpenseNonoperating",
  "InterestExpenseOperating",
  "InterestAndDebtExpense",
  "InterestExpenseNet",
  "InterestExpenseDebt",
];
// EV·순차입금용 차입금·현금은 edgar-ev.ts 가 계산한다(단일 기준).
// ※ 한국식 '부채비율'의 부채총계(Liabilities)와 다름 — 이건 이자 내는 빚만.
// 유동성 지표용 현금 (장기 투자자산 제외)

function closeOnOrBefore(bars: QuoteBar[], iso: string): number | null {
  let best: number | null = null;
  for (const b of bars) if (b.date <= iso && b.close != null) best = b.close;
  return best;
}

export function buildUsAnalysis(
  facts: CompanyFacts,
  bars: QuoteBar[],
  opts: {
    sharesHint?: number | null;
    classFacts?: ClassAFacts | null;
    sic?: string | null;
    /** EV 브릿지 맥락(금융 자회사·UP-REIT 파트너 지분) — edgar-ev.ts */
    evCtx?: EvContext;
  } = {},
): FinancialStatement {
  // Yahoo 현재 주식수 힌트 — ADR 비율 판정에만(주식수 값으로 대신 쓰지 않음, edgar-shares.ts)
  const sharesHint = opts.sharesHint ?? null;
  const classFacts = opts.classFacts ?? null;
  // 금융회사(은행·카드사) — 매출 대신 순수익(이자비용 차감), 매출총이익 대신 충당금전이익 사용.
  const isFin = isFinancialCompany(facts, opts.sic ?? null);
  // 매출(순수익) = 재무 5층 구조 매출 지표(fin-revenue.ts) — 하이라이트·손익계산서와 같은 값. 연도 열도 그 연도를 따른다
  const revAnnual = revAnnualMap(facts.revenue);
  // 개념 태그가 시기에 따라 바뀌는 기업(NVIDIA: RevenueFromContract…→Revenues,
  // 메타: InterestExpense→InterestExpenseNonoperating 등)이 많아, 단일 개념이 아니라
  // 나열된 개념들을 "연도별로 첫 유효값" 규칙으로 병합한다.
  const mergedAnnual = (concepts: string[], unit = "USD"): Map<number, number> => {
    const maps = concepts.map((c) => annualByYear(entriesOf(facts, c, unit)));
    const out = new Map<number, number>();
    for (const m of maps) for (const [y, v] of m) if (!out.has(y)) out.set(y, v);
    return out;
  };
  const years = revAnnualYears(facts.revenue, 5);
  const ends = revAnnualEnds(facts.revenue);
  const lastBar = [...bars].reverse().find((b) => b.close != null);
  const nowIso = lastBar?.date ?? new Date().toISOString().slice(0, 10);

  const periods: FinancialPeriod[] = years.map((y) => ({
    label: `${y}Y`,
    fiscalYear: y,
    fiscalQuarter: null,
    endDate: ends.get(y) ?? `${y}-12-31`,
  }));
  periods.push({ label: LTM, fiscalYear: (years.at(-1) ?? 0) + 1, fiscalQuarter: null, endDate: nowIso });
  const labels = periods.map((p) => p.label);
  const blank = (): Record<string, number | null> => Object.fromEntries(labels.map((l) => [l, null]));
  const prevLabel = labels[labels.length - 2];

  // ── 칸 주석(그림자 채우기 금지, 2026-09-27) — 값이 빈 칸의 사유, 근사값의 라벨. 파생 지표는 구성 항목의 주석을 물려받는다 ──
  const WHY = new WeakMap<Record<string, number | null>, Record<string, string>>();
  const note = (o: Record<string, number | null>, l: string, t: string | null | undefined) => {
    if (!t) return;
    const m = WHY.get(o) ?? {};
    if (!m[l]) m[l] = t;
    WHY.set(o, m);
  };
  /** out 의 각 칸에 입력들의 주석을 물려준다 — 입력 값이 빈 칸의 사유는 out 도 빈 칸일 때만, 근사 라벨은 항상 */
  const inheritWhy = (out: Record<string, number | null>, ...ins: Record<string, number | null>[]) => {
    for (const l of labels)
      for (const i of ins) {
        const w = WHY.get(i)?.[l];
        if (!w) continue;
        if (i[l] == null ? out[l] == null : true) {
          note(out, l, w);
          break;
        }
      }
    return out;
  };

  // 흐름값: FY → 연간(개념 병합), LTM → TTM(가장 최근 데이터가 있는 개념 — NVIDIA 태그 이전 대응, edgar-series.ts bestLtmFlow)
  const flow = (concepts: string[], unit = "USD"): Record<string, number | null> => {
    const ann = mergedAnnual(concepts, unit);
    const o = blank();
    for (const y of years) o[`${y}Y`] = ann.get(y) ?? null;
    const r = bestLtmFlow(facts, concepts, unit);
    o[LTM] = r.value;
    if (r.value == null) note(o, LTM, r.reason);
    return o;
  };
  const flowM = flow;
  /** 전체 연도 시계열 (CAGR용). */
  const fullAnnual = (concepts: string[], unit = "USD") => mergedAnnual(concepts, unit);
  // 잔액값 (단일 개념 우선 목록)
  // 20-F Yahoo 분기 LTM(edgar-yahoo-quarters.ts) — LTM 잔액은 그 기준일 값만, 흐름과 짝이 안 맞는 값은 비운다
  const yl = yahooLtm(facts);
  // LTM 열 잔액 기준일 — 최근 정기공시 재무상태표(20-F Yahoo 분기면 그 분기말)
  const evRes = buildEvResolver(facts, { ...(opts.evCtx ?? {}), isFinancial: isFin });
  const ltmBal = yl?.through ?? evRes.latestBalanceDate() ?? nowIso;
  /** LTM 에서 이 값을 못 채웠는지(최근 연도엔 있는데 LTM 만 빔) — 0 으로 보고 계산하지 않기 위해(20-F 뿐 아니라 모든 회사) */
  const ltmGap = (x: Record<string, number | null>) =>
    x[LTM] == null && labels.length >= 2 && x[prevLabel] != null;
  const stock = (concepts: string[]): Record<string, number | null> => {
    const e = firstConcept(facts, concepts);
    const ann = instantByYear(e);
    const o = blank();
    for (const y of years) o[`${y}Y`] = ann.get(y) ?? null;
    // LTM = 최근 재무상태표 기준일(±6일) 값만 — 그 전 가장 최근 값으로 대신하지 않는다(그림자 채우기 금지)
    o[LTM] = instantOn(e, ltmBal);
    if (o[LTM] == null && o[prevLabel] != null) note(o, LTM, `분기 재무상태표에 없음(${ltmBal})`);
    return o;
  };

  // 액면분할 보정 계수 (소급 재작성 안 된 과거 연도의 주당 지표를 최신 연도 기준으로 환산)
  const splitF = splitFactorsByYear(facts);
  const adjPerShare = (o: Record<string, number | null>): Record<string, number | null> => {
    const r = { ...o };
    for (const y of years) {
      const f = splitF.get(y);
      if (f != null && f !== 1 && r[`${y}Y`] != null) r[`${y}Y`] = r[`${y}Y`]! * f;
    }
    return r;
  };
  const adjMap = (m: Map<number, number>): Map<number, number> => {
    const out = new Map<number, number>();
    for (const [y, v] of m) out.set(y, v * (splitF.get(y) ?? 1));
    return out;
  };

  const revenue = blank();
  for (const y of years) revenue[`${y}Y`] = revAnnual.get(y) ?? null;
  revenue[LTM] = revLtm(facts.revenue);
  // 매출원가·매출총이익 = 재무 5층 구조 지표(fin-revenue.ts 열의 cogs·gp, docs/metrics/cogs.md) — 손익계산서와 같은 값
  const finAnnual = new Map((facts.revenue?.annual ?? []).map((c) => [c.fy, c] as const));
  const cogs0 = blank();
  const grossProfitFin = blank();
  for (const y of years) {
    cogs0[`${y}Y`] = finAnnual.get(y)?.cogs ?? null;
    grossProfitFin[`${y}Y`] = finAnnual.get(y)?.gp ?? null;
  }
  cogs0[LTM] = facts.revenue?.ltm?.cogs ?? null;
  grossProfitFin[LTM] = facts.revenue?.ltm?.gp ?? null;
  // 금융회사(은행·카드사): 매출총이익 대신 충당금전이익(=순수익 − 총이자외비용).
  const finNoninterestExpense = flow(FIN_NONINTEREST_EXPENSE);
  const finProvision = flow(FIN_PROVISION);
  const grossProfit0 = blank();
  for (const l of labels)
    grossProfit0[l] = isFin
      ? (revenue[l] != null && finNoninterestExpense[l] != null
          ? revenue[l]! - finNoninterestExpense[l]!
          : null)
      : grossProfitFin[l];
  // 영업이익: 금융회사는 충당금전이익 − 대손충당금. 그 외는 단일 기준 시계열
  const opIncome = (() => {
    const o = blank();
    if (isFin) {
      // 대손충당금이 그 기간에 없으면 0 으로 보지 않는다(그림자 채우기 금지) — 태그 자체가 없는 회사만 0
      const provEver = FIN_PROVISION.some((c) => entriesOf(facts, c).length > 0);
      for (const l of labels)
        if (grossProfit0[l] != null && (finProvision[l] != null || !provEver)) o[l] = grossProfit0[l]! - (finProvision[l] ?? 0);
      return inheritWhy(o, grossProfit0, finProvision);
    }
    // 금융사(fin 유형 증권·보험 — 은행 레이아웃 아님)는 옛 단일 기준 시계열(공시 → 세전)
    if (!opIncomeViaFin(facts)) return flow([SYN_OP_INCOME]);
    // 재무 5층 구조 영업이익 지표(edgar-ev.ts — fin 열, 본표 소계 · 없으면 공시 계산 구조 합성) — 하이라이트·손익계산서와 같은 값.
    // 빈칸은 fin 사유, 합성 값은 그 표기를 칸 주석으로(파생 지표가 물려받는다)
    const cells = opIncomeAnnualCells(facts);
    for (const y of years) {
      const c = cells.get(y);
      o[`${y}Y`] = c?.v ?? null;
      note(o, `${y}Y`, c ? c.note : "영업이익 없음(fin 열 없음)");
    }
    const l = opIncomeLtm(facts);
    o[LTM] = l.value;
    note(o, LTM, l.value == null ? l.reason : l.note);
    return o;
  })();
  // 지배주주 순이익 — edgar-pershare.ts 공통 규칙(NetIncomeLoss 없으면 ProfitLoss − 비지배지분)
  const niByYear = netIncomeAnnualByYear(facts);
  const netIncome = blank();
  for (const y of years) netIncome[`${y}Y`] = niByYear.get(y) ?? null;
  // LTM 순이익 — edgar-pershare.ts 공통(하이라이트·개요 멀티플과 같은 값)
  {
    const r = ltmNetIncomeOf(facts);
    netIncome[LTM] = r.value;
    if (r.value == null) note(netIncome, LTM, r.reason);
  }
  // 주식수 단일 기준(edgar-shares.ts) — 시가총액·LTM EPS·주당 지표 공통. 가중평균·표지·Class A·Yahoo 힌트로 이어 붙이던
  // 자체 주식수 사슬은 없앴다(그림자 채우기 금지, 2026-09-27)
  const shareRes = buildShareResolver(facts, { classFacts, sharesHint });
  const shares = blank();
  for (const p of periods) {
    shares[p.label] = p.label === LTM ? shareRes.current() : shareRes.atFiscalYearEnd(p.fiscalYear, p.endDate ?? "");
    note(shares, p.label, p.label === LTM ? shareRes.currentNote() : shareRes.yearEndNote(p.fiscalYear));
  }
  // 사업연도 EPS — edgar-pershare.ts fyEps 공통 규칙(하이라이트·컨센서스·은행과 같은 값).
  // 예전엔 계속영업 EPS 태그까지 후보로 병합해 중단영업이 있는 해(DELL FY2022)에
  // 하이라이트와 PER 이 17% 갈렸다(검증 체계, 2026-09-23).
  const fyEpsNote = new Map<number, string | null>();
  const fyEpsOf = (y: number) => {
    const end = periods.find((p) => p.fiscalYear === y)?.endDate;
    const r = fyEps(facts, y, {
      classFacts,
      // 근사 폴백의 분모는 하이라이트와 같은 연도말 주식수(edgar-shares)만 — 가중평균·Class A·현재 주식수로 대신하지 않는다
      fyShares: end ? shareRes.atFiscalYearEnd(y, end) : null,
      fyNetIncome: niByYear.get(y) ?? null,
    });
    fyEpsNote.set(y, r.note);
    return r.eps;
  };
  const eps = (() => {
    const o = blank();
    for (const y of years) {
      o[`${y}Y`] = fyEpsOf(y);
      note(o, `${y}Y`, fyEpsNote.get(y));
    }
    // LTM EPS 는 주당 지표에 흐름식(FY + 누적 − 전년누적)을 쓰지 않는다 — 분모가
    // 기간마다 달라 성립하지 않는다. 하이라이트와 같게 LTM 순이익 ÷ 현재 주식수.
    const le = ltmEpsOf(facts, shares[LTM]);
    o[LTM] = le.value;
    if (le.value == null) note(o, LTM, le.reason);
    else note(o, LTM, shareRes.currentNote());
    return o;
  })();
  const epsFull = (() => {
    const out = new Map<number, number>();
    for (const y of niByYear.keys()) {
      const v = fyEpsOf(y);
      if (v != null) out.set(y, v);
    }
    return out;
  })();
  const revFull = revAnnual;
  // D&A — edgar-ev.ts 단일 규칙(합계 태그 최댓값, 무형상각 누락 시 구성항목 합).
  // "앞 태그 우선"이던 예전 방식은 MCD·CRM 등에서 일부 항목만 담긴 태그를 집었다.
  const daByYear = daAnnualByYear(facts);
  const da = (() => {
    const o = blank();
    for (const y of years) o[`${y}Y`] = daByYear.get(y) ?? null;
    o[LTM] = daTtm(facts);
    const c = daTtmCell(facts);
    note(o, LTM, o[LTM] == null ? c.reason : (c.note ?? null));
    return o;
  })();
  // 현금흐름표 화면과 같은 개념 목록(계속사업 태그만 쓰는 해 — MRK 2021, 2026-10-01)
  const OCF_C = ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"];
  const CAPEX_C = [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsToAcquireProductiveAssets",
    "PaymentsForCapitalImprovements",
    "PaymentsToAcquireOtherProductiveAssets",
  ];
  // 영업현금흐름·유형자산 취득 = 현금흐름표 화면 값(edgar-cashflow.ts, 2026-10-01 — 따로 읽으면 화면과 갈렸다: MAR 2025 태그 교체로 LTM 공란,
  // MRK 2021 계속사업 태그). 화면에 그 열이 없을 때만(연도 범위 차이) 종전 태그 조회
  const cfStmt = buildUsCashFlow(facts, "annual", opts.sic ?? null);
  const cfRow = (id: string) => (cfStmt.sections ?? []).flatMap((x) => x.items ?? []).find((it) => it.accountId === id);
  const fromCf = (id: string, fb: Record<string, number | null>, abs = false) => {
    const it = cfRow(id);
    const o = blank();
    for (const l of labels) {
      const v = it?.values?.[l];
      o[l] = v != null ? (abs ? Math.abs(v) : v) : (it && l in (it.values ?? {}) ? null : fb[l]);
      const w = it?.cellNotes?.[l];
      if (o[l] == null && w) note(o, l, w);
    }
    return inheritWhy(o, fb);
  };
  const ocf = fromCf("cf:total:영업활동 현금흐름", flow(OCF_C));
  const capexRaw = fromCf("cf:투자활동 현금흐름:유형자산 취득", flow(CAPEX_C), true);
  // 1년 성장률 첫 해(표시 첫 컬럼) 보정용 전체 시계열 — 전년 값 소스
  const opIncFull = (() => {
    if (isFin) {
      // 금융회사: 순수익 − 총이자외비용 − 대손충당금 (전체 연도)
      const rev = revAnnual;
      const nie = fullAnnual(FIN_NONINTEREST_EXPENSE);
      const prov = fullAnnual(FIN_PROVISION);
      const out = new Map<number, number>();
      const provEver = prov.size > 0;
      for (const [y, v] of rev) if (nie.has(y) && (prov.has(y) || !provEver)) out.set(y, v - nie.get(y)! - (prov.get(y) ?? 0));
      return out;
    }
    return opIncomeViaFin(facts) ? opIncomeAnnualByYear(facts) : fullAnnual([SYN_OP_INCOME]);
  })();
  const niFull = niByYear;
  const daFull = daByYear;
  const ocfFull = fullAnnual(OCF_C);
  const capexFull = fullAnnual(CAPEX_C);
  // 감가상각비 구성요소가 없는 해는 공란(0 으로 보지 않음) — 표시 EBITDA 와 같은 원칙
  const ebitdaFull = new Map<number, number>();
  for (const [y, v] of opIncFull) {
    const d = daFull.get(y);
    if (d != null) ebitdaFull.set(y, v + d);
  }
  const fcfFull = new Map<number, number>();
  for (const [y, v] of ocfFull) {
    const cx = capexFull.get(y);
    if (cx != null) fcfFull.set(y, v - Math.abs(cx));
  }
  const dividends = flow(["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"]);
  // "PaymentsOfDividends"(포괄) 는 보통주 배당뿐 아니라 비지배지분(NCI)·종속회사
  // 우선주 분배까지 섞여 들어올 수 있다(실측, 2026-09-23 — Bloom Energy: 재무
  // 제표엔 보통주 배당이 전혀 없는데 "주당배당금 성장률"이 -47%로 나옴. 원인:
  // PaymentsOfDividends 947천~1,468천 달러는 BE의 프로젝트금융 자회사(Bloom
  // Electrons)가 세금평등 파트너에게 지급하는 분배금으로 보이는데, 이걸 보통주
  // 배당인 것처럼 DPS·배당성향·growth%를 계산해 의미 없는 "배당 삭감" 신호가
  // 떴다). 실제 보통주 배당 지급 기업은 거의 항상 `CommonStockDividendsPer
  // ShareDeclared` 같은 직접 주당배당 태그도 함께 공시한다 — 이 태그도, 명시적
  // 으로 "보통주"라고 못박은 `PaymentsOfDividendsCommonStock`도 전혀 없으면
  // 포괄 개념 하나만 믿고 보통주 지표(DPS·배당성향·총주주환원율의 배당분)를
  // 만들지 않는다(빈 칸/버뱩만 반영 — 오배당 신호보다 안전).
  const hasCommonDivEvidence =
    // 주당배당 태그는 단위가 USD/shares — 기본값(USD)으로 조회하면 항상 빈
    // 배열이라 이 조건이 한 번도 참이 된 적이 없었다(감사 2026-09-23).
    entriesOf(facts, "CommonStockDividendsPerShareDeclared", "USD/shares").length > 0 ||
    entriesOf(facts, "CommonStockDividendsPerShareCashPaid", "USD/shares").length > 0 ||
    entriesOf(facts, "PaymentsOfDividendsCommonStock").length > 0 ||
    // 자본변동표 배당 결의액(Dividends·DividendsCommonStock·DividendsCommonStockCash)이 포괄 지급액과 같은 기간에 정확히 같으면 보통주 배당(2026-10-01 VRT —
    // 주당배당·보통주 지급 태그 없이 PaymentsOfDividends 만 쓰는데, 자본변동표 Dividends 3.8·9.5·42.2·66.6 이 지급액과 매년 일치). BE 는 자본변동표에 이런 줄이 없다
    // IFRS 공시(TSM 등 20-F) — 주주 배당 주당액(DividendsRecognisedAsDistributionsToOwnersPerShare) = 미국 기준 주당 배당 결의 태그와 같은 성격(2026-10-01)
    Object.values((facts.facts as Record<string, Record<string, { units: Record<string, unknown[]> }> | undefined>)["ifrs-full"]?.["DividendsRecognisedAsDistributionsToOwnersPerShare"]?.units ?? {}).some((l) => l.length > 0) ||
    ["Dividends", "DividendsCommonStock", "DividendsCommonStockCash"].some((c) =>
      entriesOf(facts, c).some((e) => e.start && e.val !== 0 && entriesOf(facts, "PaymentsOfDividends").some((d) => d.start === e.start && d.end === e.end && d.val === e.val)));
  const commonDividends = hasCommonDivEvidence ? dividends : blank();
  const buyback = flow(["PaymentsForRepurchaseOfCommonStock"]);
  const INT_PAID_C = ["InterestPaidNet", "InterestPaid"];
  const intPaid = flow(INT_PAID_C); // 현금 이자 지급액
  const intExp = flowM(INT_EXP);
  // 순이자 개념이 잡혀 음수(순이자수익)면 이자보상 지표에 무의미 → 공란
  for (const l of labels)
    if (intExp[l] != null && intExp[l]! <= 0) {
      intExp[l] = null;
      note(intExp, l, "순이자수익(이자비용 ≤ 0) — 이자보상 지표 미표시");
    }
  // 총이자 태그가 없는 기간을 현금 이자지급액으로 대신하지 않는다(정의가 다름 — 그림자 채우기 금지, 2026-09-27)
  for (const l of labels) if (intExp[l] == null) note(intExp, l, "이자비용 공시 없음");
  // 이자비용 개념이 최근 500일 내 태깅이 끊긴 경우(예: AAPL FY2024~ 별도표시 중단)
  // 오래된 값으로 비율 왜곡 방지 → 해당 컬럼 공란
  {
    const recentIso = new Date(Date.now() - 500 * 864e5).toISOString().slice(0, 10);
    const freshOf = (cs: string[]) =>
      cs.some((c) => entriesOf(facts, c).some((e) => e.end >= recentIso));
    if (!freshOf(INT_EXP)) intExp[LTM] = null;
    if (!freshOf(INT_PAID_C)) intPaid[LTM] = null;
  }
  // 현금이자 = 공시 현금 이자지급액만 — 미공시 기간을 발생주의 이자비용으로 대신하지 않는다(그림자 채우기 금지)
  const intCash = intPaid;
  for (const l of labels) if (intCash[l] == null) note(intCash, l, "현금 이자지급액 공시 없음");
  const taxExp = flow(["IncomeTaxExpenseBenefit"]);
  // 세전이익 = 공시값만(순이익 + 법인세로 대신하지 않음 — 비지배지분·중단영업이 끼면 정의가 다르다)
  const pretax = flow(PRETAX_C);
  for (const l of labels) if (pretax[l] == null && !WHY.get(pretax)?.[l]) note(pretax, l, "세전이익 공시 없음");
  // 금융회사 영업이익(충당금전이익 − 대손충당금)을 못 구한 칸은 세전이익으로 대신하지 않는다(정의가 다름 — 그림자 채우기 금지,
  // 2026-09-27). 은행 하이라이트·손익계산서와 같은 규칙
  if (isFin) for (const l of labels) if (opIncome[l] == null) note(opIncome, l, "영업이익 산정 불가(순수익·총이자외비용·대손충당금 중 공시 없음)");
  // ebitdaFull 보강 — opIncFull 연도 중 감가상각비가 있는 해
  {
    for (const [y, v] of opIncFull) {
      if (ebitdaFull.has(y)) continue;
      const d = daFull.get(y);
      if (d != null) ebitdaFull.set(y, v + d);
    }
  }

  const assets = stock(["Assets"]);
  const liabAndEquity = stock(["LiabilitiesAndStockholdersEquity"]);
  // 자본 정정 열(재무상태표 화면과 같은 규칙, edgar-balance.ts equityRestatement — WDC FY2022): 자본은 나중 공시 값(parentEquityOf)이므로 자산·부채와 자본 총계도
  // 정정 금액만큼 올린다(정정 대상이 자산 쪽 — 지분법 투자). ROA·회전율·부채 파생이 화면과 같은 값을 쓰게
  for (const p of periods) {
    if (p.label === LTM || !p.endDate) continue;
    const r = equityRestatement(facts, p.endDate);
    if (!r) continue;
    if (assets[p.label] != null) assets[p.label] = assets[p.label]! + r.delta;
    if (liabAndEquity[p.label] != null) liabAndEquity[p.label] = liabAndEquity[p.label]! + r.delta;
  }
  // 자기자본 — edgar-pershare.ts 단일 기준(재작성본 우선). 예전엔 연간 보고서 양식만
  // 봐서 8-K 재작성본(GE 2021 LDTI 소급)을 놓쳐 PBR 이 하이라이트와 달랐다.
  const equity = (() => {
    const o = blank();
    for (const p of periods) {
      const d = p.label === LTM ? ltmBal : (p.endDate ?? "");
      const r = d ? parentEquityOf(facts, d) : { value: null, reason: "기준일 없음" };
      o[p.label] = r.value;
      if (r.value == null) note(o, p.label, r.reason);
    }
    return o;
  })();
  const curAssets = stock(["AssetsCurrent"]);
  const curLiab = stock(["LiabilitiesCurrent"]);
  // 이자부 차입금·현금 — edgar-ev.ts 단일 기준(하이라이트·멀티플·컨센서스와 동일).
  // 예전엔 여기서 LongTermInvestments(UNH·GE 의 보험 투자자산)까지 현금으로 빼
  // EV 가 11~15% 과소했고, 차입금 태그 목록이 짧아 VZ·T 등이 과소했다.
  const balDate = (l: string): string =>
    l === LTM ? ltmBal : (periods.find((p) => p.label === l)?.endDate ?? "");
  const evBlockers = new Set<EvBlocker>();
  const bridgeWhy: Record<string, string | null> = {};
  let evPartial = false;
  let evCaptive = false;
  const bridge = Object.fromEntries(
    labels.map((l) => {
      const d = balDate(l);
      const blk = evRes.blocker(d);
      if (blk) evBlockers.add(blk);
      const b0 = evRes.bridgeAt(d);
      // Yahoo 분기 LTM: 차입금·현금 등 EV 구성요소가 같은 기준일로 다 채워졌을 때만(아니면 LTM EV·순차입금 공란)
      const b = b0 && l === LTM && yl && (!yl.evComplete || b0.balanceDate !== yl.through) ? null : b0;
      if (!b && !blk) bridgeWhy[l] = b0 && yl ? (yl.evReason ?? "Yahoo 분기 EV 구성요소 불완전") : evRes.bridgeReason(d);
      if (b?.debtPartial) evPartial = true;
      if (b?.captiveDebtExcluded != null) evCaptive = true;
      return [l, b];
    }),
  );
  const debt = blank();
  const cash = blank();
  for (const l of labels) {
    debt[l] = bridge[l]?.debt ?? null;
    cash[l] = bridge[l]?.cash ?? null;
    note(debt, l, bridgeWhy[l]);
    note(cash, l, bridgeWhy[l]);
  }
  // 신용지표용 총차입금 = 이자부 차입금(금융리스 포함), **운용리스 제외** — EV 와
  // 같은 기준(오너 결정 2026-09-23). 미국 회계기준은 운용리스 부채를 차입금이 아닌
  // 영업부채로 분류하고, 순차입금/EBITDA 는 임차료가 이미 빠진 EBITDA 와 짝이라
  // 리스를 넣으면 이중 반영이 된다. 운용리스 규모는 대차대조표 주석에 따로 보인다.
  const debtTotal = debt;
  // 장기차입금 = 비유동 차입금(+비유동 금융리스) — 같은 단일 기준(태그 목록)
  const ltDebt = blank();
  for (const l of labels) ltDebt[l] = bridge[l]?.debtNoncurrent ?? null;
  inheritWhy(ltDebt, debt);
  // 부채비율 참고용 — 신용평가사(S&P·Moody's)처럼 운용리스까지 넣은 총차입금.
  // 이름을 따로 붙인 별도 행으로만 쓴다(다른 지표는 위 debtTotal 기준).
  // 운용리스가 그 기간에 공시되지 않았으면 비운다(리스 없이 합한 값이 "포함"으로
  // 보이지 않게).
  const debtWithOpLease = blank();
  for (const l of labels) {
    const b = bridge[l];
    if (b && b.operatingLease != null) debtWithOpLease[l] = b.debt + b.operatingLease;
  }
  // 유동성 지표용 현금(장기투자 제외) — 현금 줄은 없음 증명 불가(현금 없는 재무상태표는 없다 — 제한현금 포함 총액만 공시하는 회사는 공란)
  // 현금·단기투자 — 단기투자는 본표 유동자산 단기투자 줄 합(SYN_STI_FACE, 재무상태표 화면·EV 와 같은 값, 2026-10-01 — 태그를 모두 더하던 방식은
  // 화면과 달랐다: CAT·INTC·KO·DELL 현금비율). 본표 판독이 없는 기간만 종전 태그 합
  const cashCur = (() => {
    // 재무상태표 화면 현금 줄과 같은 개념 목록(MDLZ 2023~ 중단사업 현금 포함 태그, 2026-10-01)
    const c0 = stock(["CashAndCashEquivalentsAtCarryingValue", "CashAndCashEquivalentsAtCarryingValueIncludingDiscontinuedOperations"]);
    // 판독값이 없는 기간 = 현금 + 재무상태표 화면과 같은 단기투자 태그 목록(STI_TAGS, 앞 태그 우선 — 예전 CASH_CUR 태그 전부 합은 화면과 달랐다: DELL 2022)
    const stiTag = stock(STI_TAGS);
    const old = blank();
    for (const l of labels) old[l] = c0[l] != null ? c0[l]! + (stiTag[l] ?? 0) : null;
    inheritWhy(old, c0);
    // 본표 판독값은 날짜마다 그 날짜를 담은 가장 최근 공시(10-Q 비교 열 포함) 하나 — 공시 종류가 아니라 기준일로 읽는다(재무상태표 화면과 같은 방식)
    const faceE = firstConcept(facts, [SYN_STI_FACE]).filter((e) => !e.start);
    const o = blank();
    for (const p of periods) {
      const l = p.label, d = l === LTM ? ltmBal : (p.endDate ?? "");
      const f = d ? faceE.find((x) => Math.abs(Date.parse(x.end) - Date.parse(d)) <= 6 * 864e5) : undefined;
      o[l] = c0[l] != null && f ? c0[l]! + f.val : old[l];
    }
    return inheritWhy(o, old);
  })();
  const AR_C = [
    "AccountsReceivableNetCurrent",
    "ReceivablesNetCurrent",
    "AccountsAndOtherReceivablesNetCurrent",
    "AccountsAndNotesReceivableNet",
  ];
  const ar = stock(AR_C); // 매출채권(당좌비율용)
  const retained = stock([
    "RetainedEarningsAccumulatedDeficit",
    "RetainedEarningsAppropriated",
  ]);
  const cogs = cogs0;
  const grossProfit = grossProfit0;
  const wc = blank(); // 운전자본 = 유동자산 − 유동부채
  for (const l of labels) if (curAssets[l] != null && curLiab[l] != null) wc[l] = curAssets[l]! - curLiab[l]!;
  // 주당배당금(DPS) — 공시 주당배당금(선언 기준, 없으면 지급 기준) 태그만, 액면분할 보정. 성장률 계산용.
  // 예전엔 배당 지급 총액 ÷ 자체 주식수 사슬로 만들었다(정의가 다름 — 그림자 채우기 금지, 2026-09-27). 하이라이트 DPS 와 같은 원천
  const DPS_C = ["CommonStockDividendsPerShareDeclared", "CommonStockDividendsPerShareCashPaid"];
  const dps = adjPerShare(flow(DPS_C, "USD/shares"));
  inheritWhy(dps, flow(DPS_C, "USD/shares"));
  for (const l of labels) if (dps[l] == null && hasCommonDivEvidence) note(dps, l, WHY.get(dps)?.[l] ?? "주당배당금 공시 없음");
  const dpsFull = adjMap(fullAnnual(DPS_C, "USD/shares"));

  // 파생
  // 감가상각비 구성요소가 없으면(매핑 누락 — IFRS 20-F 등) EBITDA 도 공란(0 으로
  // 보지 않음, Yahoo 분기 LTM 여부와 무관 — 독립 감사 지적 2026-09-25 NVO·SAP)
  const ebitda = blank();
  for (const l of labels) if (opIncome[l] != null && da[l] != null) ebitda[l] = opIncome[l]! + da[l]!;
  inheritWhy(ebitda, opIncome, da);
  const fcf = blank();
  for (const l of labels) if (ocf[l] != null && capexRaw[l] != null) fcf[l] = ocf[l]! - Math.abs(capexRaw[l]!);
  inheritWhy(fcf, ocf, capexRaw);

  // 순차입금(총차입금 − 현금·투자) — 블룸버그 신용지표 기준
  // 순차입금 — 차입금·현금 둘 다 같은 기준일 값일 때만(한쪽을 0 으로 보지 않음)
  const netDebtT = blank();
  for (const l of labels)
    if (debtTotal[l] != null && cash[l] != null) netDebtT[l] = debtTotal[l]! - cash[l]!;
  inheritWhy(netDebtT, debtTotal, cash);
  // NOPAT — 유효세율(법인세 ÷ 세전이익)을 구할 수 있을 때만. 21% 법정세율로 대신하지 않는다(그림자 채우기 금지)
  const nopat = blank();
  for (const l of labels) {
    if (opIncome[l] == null) continue;
    if (!pretax[l] || taxExp[l] == null) {
      note(nopat, l, "유효세율 산정 불가(세전이익·법인세 공시 없음)");
      continue;
    }
    const rate = taxExp[l]! / pretax[l]!;
    nopat[l] = opIncome[l]! * (1 - Math.min(Math.max(rate, 0), 0.4));
  }
  inheritWhy(nopat, opIncome);
  const liabTotal = (() => {
    const o = stock(["Liabilities"]);
    // 파생: (부채와자본 총계 또는 자산) − 비지배지분 포함 자본 − 임시자본(재무상태표 화면 edgar-balance.ts 와 같은 정의, 2026-10-01 —
    // 지배주주 자본만 빼면 비지배지분·임시자본이 부채에 섞여 부채비율이 화면 재계산과 달랐다: KO·WMT·INTC·MRK·ORCL)
    const eqAll = stock(["StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]);
    const tmpAll = stock(["TemporaryEquityCarryingAmountIncludingPortionAttributableToNoncontrollingInterests"]);
    const tmpParent = stock(["TemporaryEquityCarryingAmountAttributableToParent"]);
    const tmpNci = stock(["RedeemableNoncontrollingInterestEquityCarryingAmount", "RedeemableNoncontrollingInterestEquityCommonCarryingAmount"]);
    for (const l of labels) {
      if (o[l] != null) continue;
      const be = liabAndEquity[l] ?? assets[l];
      // 포함 자본 태그가 없으면 지배주주 자본 + 비지배지분(비지배지분은 EV 브리지 값 — 태그는 edgar-ev.ts 에서만 고른다)
      const eAll = eqAll[l] ?? (equity[l] != null ? equity[l]! + (bridge[l]?.nci ?? 0) : null);
      const tmp = tmpAll[l] ?? (tmpParent[l] != null || tmpNci[l] != null ? (tmpParent[l] ?? 0) + (tmpNci[l] ?? 0) : 0);
      if (be != null && eAll != null) o[l] = be - eAll - tmp;
    }
    return o;
  })();

  // 잔액 평균 = (기초 + 기말) / 2 — 블룸버그 ROE·ROA·회전율 방식.
  // FY: 전년말·당해말 평균 / LTM: 최근 분기말·1년 전 동시점 평균 (TTM 흐름과 짝).
  const avgStock = (concepts: string[]): Record<string, number | null> => {
    const full = new Map<number, number>();
    for (const c of concepts)
      for (const [y, v] of instantByYear(entriesOf(facts, c)))
        if (!full.has(y)) full.set(y, v);
    // 자산 평균 — 자본 정정 연도는 정정 금액 반영(equityRestatement, 재무상태표 화면과 같은 값)
    if (concepts.includes("Assets"))
      for (const [y, v] of full) {
        const end = ends.get(y);
        const r = end ? equityRestatement(facts, end) : null;
        if (r) full.set(y, v + r.delta);
      }
    const o = blank();
    // 기초 잔액이 없으면 기말 잔액으로 대신하지 않는다(평균이 아님 — 그림자 채우기 금지, 2026-09-27)
    for (const y of years) {
      const cur = full.get(y);
      const prev = full.get(y - 1);
      o[`${y}Y`] = cur != null && prev != null ? (cur + prev) / 2 : null;
      if (cur != null && prev == null) note(o, `${y}Y`, "평균 잔액 산정 불가(기초 잔액 없음)");
    }
    // LTM = 최근 재무상태표 기준일 값 + 1년 전 같은 시점 값의 평균 — 둘 다 있어야
    const latest = concepts.map((c) => instantOn(entriesOf(facts, c), ltmBal)).find((v) => v != null) ?? null;
    const target = shiftYear(ltmBal, -1);
    const prevE = concepts
      .flatMap((c) => entriesOf(facts, c))
      .filter((e) => !e.start && Math.abs(days(e.end, target)) <= 25)
      .sort((a, b) => Math.abs(days(a.end, target)) - Math.abs(days(b.end, target)))[0];
    o[LTM] = latest != null && prevE ? (latest + prevE.val) / 2 : null;
    if (o[LTM] == null && (latest != null || o[prevLabel] != null))
      note(o, LTM, latest == null ? `분기 재무상태표에 없음(${ltmBal})` : "평균 잔액 산정 불가(1년 전 잔액 없음)");
    return o;
  };
  // 지배주주 자본 평균 — 기초·기말 모두 edgar-pershare.ts 지배주주 자본(비지배지분 포함 자본을 섞지 않는다, 기말만으로 대신하지 않음)
  const equityAvg = (() => {
    const o = blank();
    for (const p of periods) {
      const endD = p.label === LTM ? ltmBal : (p.endDate ?? "");
      if (!endD) continue;
      const prevD = p.label === LTM ? shiftYear(ltmBal, -1) : (ends.get(p.fiscalYear - 1) ?? shiftYear(endD, -1));
      const cur = equity[p.label];
      const prev = parentEquityOf(facts, prevD);
      o[p.label] = cur != null && prev.value != null ? (cur + prev.value) / 2 : null;
      if (o[p.label] == null) note(o, p.label, cur == null ? (WHY.get(equity)?.[p.label] ?? "자기자본 없음") : `평균 자본 산정 불가(기초 자본 없음 — ${prev.reason ?? prevD})`);
    }
    return o;
  })();
  const assetsAvg = avgStock(["Assets"]);
  // 투하자본 = 총자산 − 비이자 유동부채 (= 총차입금 + 자기자본 + 비유동 비이자부채).
  // 블룸버그 ROIC 기준. 순현금 기업이라도 음수화 안 됨.
  const curLiabAvg = avgStock(["LiabilitiesCurrent"]);
  // 유동 차입금(평균) — edgar-ev.ts 단일 기준: 전체 차입금 − 비유동 차입금.
  // 예전엔 여기서 차입금 태그를 따로 골라 EV 쪽과 기준이 달랐다(감사 2026-09-23).
  // strict: 그 기준일 값만(이전 연말로 대체된 값은 버림) — Yahoo 분기 LTM 열
  const curDebtAt = (d: string): number | null => {
    const b = d ? evRes.bridgeAt(d) : null;
    return b && b.debtNoncurrent != null ? Math.max(0, b.debt - b.debtNoncurrent) : null;
  };
  const curDebtAvg = blank();
  for (const l of labels) {
    const d = balDate(l);
    const prevD = l === LTM ? shiftYear(d, -1) : (ends.get(Number(l.slice(0, 4)) - 1) ?? "");
    const cur = curDebtAt(d);
    const prev = prevD ? curDebtAt(prevD) : null;
    // 기초 값이 없으면 기말 값으로 대신하지 않는다(평균이 아님)
    curDebtAvg[l] = cur != null && prev != null ? (cur + prev) / 2 : null;
    if (curDebtAvg[l] == null) note(curDebtAvg, l, cur == null ? (bridgeWhy[l] ?? "유동 차입금 구분 불가") : "평균 잔액 산정 불가(기초 유동 차입금 없음)");
  }
  // 투하자본 — 유동 차입금 평균을 0 으로 보지 않는다(그림자 채우기 금지)
  const investedCapAvg = blank();
  for (const l of labels) {
    if (assetsAvg[l] == null || curLiabAvg[l] == null || curDebtAvg[l] == null) continue;
    investedCapAvg[l] = assetsAvg[l]! - (curLiabAvg[l]! - curDebtAvg[l]!);
  }
  inheritWhy(investedCapAvg, assetsAvg, curLiabAvg, curDebtAvg);

  // 주가·시총 — 주식수는 공용 기준(edgar-shares.ts)으로 통일한다. 시세는 분할
  // 소급 반영된 값이므로 주식수도 현재 기준으로 환산해야 시가총액이 맞는다
  // (오너 지적 2026-09-23 — 하이라이트와 PBR·PSR·EV 가 달랐던 원인. 자세한
  // 내용은 edgar-shares.ts 주석 참고).
  const price = blank();
  const mktcap = blank();
  for (const p of periods) {
    const px = p.label === LTM ? (lastBar?.close ?? null) : closeOnOrBefore(bars, p.endDate ?? "");
    price[p.label] = px;
    const sh = shares[p.label];
    mktcap[p.label] = px != null && sh != null ? px * sh : null;
    if (px == null) note(mktcap, p.label, "주가 없음");
  }
  inheritWhy(mktcap, shares);
  const curMktcap = mktcap[LTM];

  const ratio = (a: Record<string, number | null>, b: Record<string, number | null>, mul = 1) => {
    const o = blank();
    for (const l of labels) if (a[l] != null && b[l]) o[l] = (a[l]! / b[l]!) * mul;
    return inheritWhy(o, a, b);
  };
  // 주당 지표 — 분모는 공통 주식수(edgar-shares, 이미 현재 분할 기준)
  const perShare = (a: Record<string, number | null>) => {
    const o = blank();
    for (const l of labels) if (a[l] != null && shares[l]) o[l] = a[l]! / shares[l]!;
    return inheritWhy(o, a, shares);
  };
  // CAGR: 전체 연도 시계열에서 각 컬럼 대비 n년 전 값.
  // 현재/LTM 은 최근 FY 보다 약 1년 뒤 시점 → 분자는 TTM 값, 기준연도도 1 앞으로
  // (예: 5년 CAGR 이면 마지막 FY 열은 FY-5, LTM 열은 FY-4 를 기준으로).
  const cagr = (full: Map<number, number>, n: number, ltm?: number | null) => {
    const o = blank();
    const lastY = years.at(-1) ?? 0;
    for (const p of periods) {
      const isLtm = p.label === LTM;
      const anchorY = isLtm ? lastY + 1 : p.fiscalYear;
      // LTM 값이 없으면 최근 사업연도 값으로 대신하지 않는다(기간 혼합 — 그림자 채우기 금지, 2026-09-27)
      const cur = isLtm ? (ltm ?? null) : (full.get(anchorY) ?? null);
      if (isLtm && ltm == null) note(o, p.label, "LTM 값 없음");
      const base = full.get(anchorY - n);
      if (cur != null && base != null && base > 0 && cur > 0)
        o[p.label] = (Math.pow(cur / base, 1 / n) - 1) * 100;
    }
    return o;
  };
  const fwdMktcap = () => {
    const o = blank();
    for (const l of labels) o[l] = l === LTM ? curMktcap : mktcap[l];
    return o;
  };
  // 1년 성장률: 표시 첫 해(예 2021)는 직전 컬럼이 없으므로
  // companyfacts 전체 시계열(이미 받아온 payload)에서 전년(2020) 값을 끌어와 채운다.
  const yoy1 = (a: Record<string, number | null>, full?: Map<number, number>) => {
    const o = blank();
    for (let i = 0; i < labels.length; i++) {
      const c = a[labels[i]];
      let p = i >= 1 ? a[labels[i - 1]] : null;
      if (p == null && full && labels[i] !== LTM) {
        p = full.get(Number(labels[i].replace("Y", "")) - 1) ?? null;
      }
      if (c != null && p != null && p !== 0) o[labels[i]] = ((c - p) / Math.abs(p)) * 100;
    }
    return inheritWhy(o, a);
  };
  const combine3 = (
    a: Record<string, number | null>,
    b: Record<string, number | null>,
    c: Record<string, number | null>,
  ) => {
    const o = blank();
    for (const l of labels)
      if (a[l] != null && b[l] != null && c[l] != null) o[l] = a[l]! + b[l]! - c[l]!;
    return inheritWhy(o, a, b, c);
  };

  const R = (
    label: string,
    values: Record<string, number | null>,
    nf?: FinancialLineItem["numberFormat"],
    opts: Partial<FinancialLineItem> = {},
  ): FinancialLineItem => ({
    accountName: label,
    accountId: `an:${label}`,
    depth: 1,
    isSubtotal: false,
    isHighlight: false,
    values,
    numberFormat: nf,
    ...(WHY.get(values) ? { cellNotes: WHY.get(values) } : {}),
    ...opts,
  });
  const HEAD = (label: string): FinancialLineItem => ({
    accountName: label,
    accountId: `an:h:${label}`,
    depth: 0,
    isSubtotal: true,
    isHighlight: false,
    values: blank(),
  });
  const SP = (k: string): FinancialLineItem => ({
    accountName: "",
    accountId: `an:sp:${k}`,
    depth: 0,
    isSubtotal: false,
    isHighlight: false,
    values: blank(),
  });

  // 분모 0 이하(적자 EPS)면 비운다 — edgar-pershare.ts 공통 부호 규칙
  const per = blank();
  for (const l of labels) per[l] = positiveRatio(price[l], eps[l]);
  inheritWhy(per, eps, price);
  const pbrV = blank();
  for (const l of labels) pbrV[l] = positiveRatio(mktcap[l], equity[l]);
  inheritWhy(pbrV, mktcap, equity);
  const psrV = blank();
  for (const l of labels) {
    const mc = l === LTM ? curMktcap : mktcap[l];
    if (mc != null && revenue[l]) psrV[l] = mc / revenue[l]!;
  }
  inheritWhy(psrV, mktcap, revenue);
  const evV = blank();
  for (const l of labels) {
    const mc = l === LTM ? curMktcap : mktcap[l];
    evV[l] = bridge[l] ? evRes.evAt(balDate(l), mc, price[l]) : null; // Yahoo 분기 LTM 에서 비운 브릿지는 EV 도 공란
    if (evV[l] == null && !bridge[l]) note(evV, l, bridgeWhy[l]);
  }
  inheritWhy(evV, mktcap);
  // EBITDA ≤ 0 이면 비운다 — 음수 배수는 의미가 없고, 하이라이트·컨센서스도 같은 규칙
  const evEbitda = ratio(
    evV,
    Object.fromEntries(labels.map((l) => [l, ebitda[l] != null && ebitda[l]! > 0 ? ebitda[l] : null])),
  );
  // PEG: 분모는 3년(부족 시 2년) EPS CAGR% — 1년 YoY 는 변동이 커 왜곡 심함
  const epsCagr3 = cagr(epsFull, 3, eps[LTM]);
  const epsCagr2 = cagr(epsFull, 2, eps[LTM]);
  const peg = blank();
  for (const l of labels) {
    const g = epsCagr3[l] ?? epsCagr2[l];
    if (per[l] != null && per[l]! > 0 && g != null && g >= 1) peg[l] = per[l]! / g;
  }
  inheritWhy(peg, per, epsCagr3);

  const effTax = ratio(taxExp, pretax, 100);
  // 듀퐁 분해: ROE(%) = 순이익률(%) × 총자산회전율 × 재무레버리지 (잔액은 평균)
  const duTurnover = ratio(revenue, assetsAvg);
  const duLeverage = ratio(assetsAvg, equityAvg);
  // 당좌비율 = (현금·현금성 + 단기투자 + 매출채권) / 유동부채 (엄격 정의, 블룸버그와 동일)
  const quick = (() => {
    const o = blank();
    for (const l of labels) {
      if (!curLiab[l]) continue;
      // 현금성·매출채권 — 값이 없으면 0 으로 보지 않는다(매출채권 태그를 아예 안 쓰는 회사만 0 — 그 줄이 없음)
      const arEver = AR_C.some((c) => entriesOf(facts, c).length > 0);
      if (cashCur[l] == null) continue;
      if (ar[l] == null && arEver) {
        note(o, l, "매출채권 공시 없음");
        continue;
      }
      const qa = cashCur[l]! + (ar[l] ?? 0);
      if (qa > 0) o[l] = qa / curLiab[l]!;
    }
    return inheritWhy(o, cashCur, ar, curLiab);
  })();
  const cogsAbs = (() => {
    const o = blank();
    for (const l of labels) if (cogs[l] != null) o[l] = Math.abs(cogs[l]!);
    return o;
  })();
  const arAvg = avgStock(["AccountsReceivableNetCurrent", "ReceivablesNetCurrent"]);
  const INV_C = ["InventoryNet", "AirlineRelatedInventoryNet", "EnergyRelatedInventory", "RetailRelatedInventoryMerchandise"];
  const invAvg = avgStock(INV_C);
  const apAvg = avgStock([
    "AccountsPayableCurrent",
    "AccountsPayableTradeCurrent",
    "AccountsPayableAndAccruedLiabilitiesCurrent",
  ]);
  const dso = (() => {
    const o = blank();
    for (const l of labels) if (arAvg[l] != null && revenue[l]) o[l] = (arAvg[l]! / revenue[l]!) * 365;
    return inheritWhy(o, arAvg, revenue);
  })();
  // 재고 태그가 없으면 재고 0 (플랫폼·서비스) → DIO 0, CCC 계산 가능
  // 재고 태그를 아예 안 쓰는 회사(플랫폼·서비스)만 재고 0 → DIO 0. 태그가 있는데 그 기간 값이 없으면 공란(0 으로 보지 않음)
  const invEver = INV_C.some((c) => entriesOf(facts, c).length > 0);
  const dio = (() => {
    const o = blank();
    for (const l of labels)
      if (cogsAbs[l] && (invAvg[l] != null || !invEver)) o[l] = ((invAvg[l] ?? 0) / cogsAbs[l]!) * 365;
    return inheritWhy(o, invAvg, cogsAbs);
  })();
  const dpo = ratio(apAvg, cogsAbs, 365);
  const ccc = combine3(dso, dio, dpo);
  const altZ = (() => {
    const o: Record<string, number | null> = blank();
    for (const l of labels) {
      const mc = l === LTM ? curMktcap : mktcap[l];
      if (
        assets[l] &&
        wc[l] != null &&
        retained[l] != null &&
        opIncome[l] != null &&
        mc != null &&
        liabTotal[l] &&
        revenue[l] != null
      )
        o[l] =
          1.2 * (wc[l]! / assets[l]!) +
          1.4 * (retained[l]! / assets[l]!) +
          3.3 * (opIncome[l]! / assets[l]!) +
          0.6 * (mc / liabTotal[l]!) +
          1.0 * (revenue[l]! / assets[l]!);
    }
    return o;
  })();

  // ── 레버리지·커버리지 파생 ──
  const capexAbs = blank();
  for (const l of labels) if (capexRaw[l] != null) capexAbs[l] = Math.abs(capexRaw[l]!);
  const ebitdaLessCapex = blank();
  for (const l of labels)
    if (ebitda[l] != null && capexAbs[l] != null) ebitdaLessCapex[l] = ebitda[l]! - capexAbs[l]!;
  // 재무레버리지 정도 (DFL) = EBIT / (EBIT − 이자비용). 이자비용 없으면 공란.
  const dfl = blank();
  for (const l of labels)
    if (opIncome[l] != null && intExp[l] != null && opIncome[l]! - intExp[l]! !== 0)
      dfl[l] = opIncome[l]! / (opIncome[l]! - intExp[l]!);
  inheritWhy(dfl, opIncome, intExp);
  inheritWhy(ebitdaLessCapex, ebitda, capexAbs);

  const items: FinancialLineItem[] = [
    HEAD("밸류에이션"),
    R("PER", per, "mult"),
    R("PBR", pbrV, "mult"),
    R("PSR", psrV, "mult"),
    R("EV/EBITDA", evEbitda, "mult"),
    R("주가 / FCF", ratio(fwdMktcap(), fcf), "mult"),
    R("PEG (EPS 3Y CAGR)", peg, "mult"),
    SP("1"),
    HEAD("수익성"),
    R("ROE (%)", ratio(netIncome, equityAvg, 100), "pct"),
    R("순이익률 (%)", ratio(netIncome, revenue, 100), "pct", { depth: 2 }),
    R("× 총자산회전율 (회)", duTurnover, "mult", { depth: 2 }),
    R("× 재무레버리지 (배)", duLeverage, "mult", { depth: 2 }),
    R("ROA (%)", ratio(netIncome, assetsAvg, 100), "pct"),
    R("ROIC (%)", ratio(nopat, investedCapAvg, 100), "pct"),
    R("FCF 마진 (%)", ratio(fcf, revenue, 100), "pct"),
    R(isFin ? "충당금전이익률 (%)" : "매출총이익률 (%)", ratio(grossProfit, revenue, 100), "pct"),
    R("영업이익률 (%)", ratio(opIncome, revenue, 100), "pct"),
    R("유효세율 (%)", effTax, "pct"),
    SP("2"),
    HEAD("현금창출"),
    R("FCF 수익률 (%)", ratio(fcf, fwdMktcap(), 100), "pct"),
    R("영업현금흐름 / 순이익", ratio(ocf, netIncome), "mult"),
    R("주당 FCF", perShare(fcf), "eps"),
    SP("3"),
    HEAD("레버리지"),
    R("부채비율 (%)", ratio(liabTotal, equity, 100), "pct"),
    R("총차입금 / 자기자본 (%)", ratio(debtTotal, equity, 100), "pct"),
    R("총차입금(운용리스 포함) / 자기자본 (%)", ratio(debtWithOpLease, equity, 100), "pct"),
    R("총차입금 / 총자산 (%)", ratio(debtTotal, assets, 100), "pct"),
    R("장기차입금 / 자기자본 (%)", ratio(ltDebt, equity, 100), "pct"),
    R("장기차입금 / 총자산 (%)", ratio(ltDebt, assets, 100), "pct"),
    R("순차입금 / 자기자본 (%)", ratio(netDebtT, equity, 100), "pct"),
    R("재무레버리지 정도 (DFL)", dfl, "mult"),
    SP("4"),
    HEAD("재무건전성"),
    R("총차입금 / EBITDA", ratio(debtTotal, ebitda), "mult"),
    R("순차입금 / EBITDA", ratio(netDebtT, ebitda), "mult"),
    R("영업이익 / 총차입금", ratio(opIncome, debtTotal), "mult"),
    R("이자보상배율 (EBIT/이자)", ratio(opIncome, intExp), "mult"),
    R("EBITDA / 이자비용", ratio(ebitda, intExp), "mult"),
    R("(EBITDA−CapEx) / 이자비용", ratio(ebitdaLessCapex, intExp), "mult"),
    R("EBIT / 현금이자", ratio(opIncome, intCash), "mult"),
    R("EBITDA / 현금이자", ratio(ebitda, intCash), "mult"),
    R("CFO / 총차입금", ratio(ocf, debtTotal), "mult"),
    R("FCF / 총차입금", ratio(fcf, debtTotal), "mult"),
    R("알트만 Z-스코어", altZ, "eps"),
    SP("4a"),
    HEAD("유동성"),
    R("유동비율", ratio(curAssets, curLiab), "mult"),
    R("당좌비율", quick, "mult"),
    R("현금비율", ratio(cashCur, curLiab), "mult"),
    R("CFO / 유동부채", ratio(ocf, curLiabAvg), "mult"),
    SP("4b"),
    HEAD("운전자본"),
    R("매출채권 회전일수 (DSO)", dso, "eps"),
    R("재고자산 회전일수 (DIO)", dio, "eps"),
    R("매입채무 회전일수 (DPO)", dpo, "eps"),
    R("현금전환주기 (CCC)", ccc, "eps"),
    SP("4c"),
    HEAD("주주환원"),
    R("배당성향 (%)", (() => {
      const o = blank();
      for (const l of labels)
        if (commonDividends[l] != null && netIncome[l]) o[l] = (Math.abs(commonDividends[l]!) / netIncome[l]!) * 100;
      return inheritWhy(o, commonDividends, netIncome);
    })(), "pct"),
    R("총주주환원율 (%)", (() => {
      const o = blank();
      // 배당·자사주 — 그 기간 값이 없으면 0 으로 보지 않는다(태그를 아예 쓰지 않는 회사·배당 근거 없는 회사만 0)
      const buyEver = entriesOf(facts, "PaymentsForRepurchaseOfCommonStock").length > 0;
      for (const l of labels) {
        if ((hasCommonDivEvidence && commonDividends[l] == null) || (buyEver && buyback[l] == null)) {
          note(o, l, hasCommonDivEvidence && commonDividends[l] == null ? "배당금 지급액 공시 없음" : "자사주 매입액 공시 없음");
          continue;
        }
        if (l === LTM && (ltmGap(commonDividends) || ltmGap(buyback))) continue;
        const ret = (commonDividends[l] != null ? Math.abs(commonDividends[l]!) : 0) + (buyback[l] != null ? Math.abs(buyback[l]!) : 0);
        if (netIncome[l]) o[l] = (ret / netIncome[l]!) * 100;
      }
      return inheritWhy(o, commonDividends, buyback, netIncome);
    })(), "pct"),
    SP("5"),
    HEAD("성장률 (1년 YoY)"),
    R("매출액", yoy1(revenue, revFull), "pct"),
    R("EBITDA", yoy1(ebitda, ebitdaFull), "pct"),
    R("영업이익", yoy1(opIncome, opIncFull), "pct"),
    R("순이익", yoy1(netIncome, niFull), "pct"),
    R("희석 EPS", yoy1(eps, epsFull), "pct"),
    R("주당배당금", yoy1(dps, dpsFull), "pct"),
    R("영업활동 현금흐름", yoy1(ocf, ocfFull), "pct"),
    R("자본지출", yoy1(capexRaw, capexFull), "pct"),
    R("잉여현금흐름", yoy1(fcf, fcfFull), "pct"),
    SP("6"),
    HEAD("성장률 (3년 CAGR)"),
    R("매출액", cagr(revFull, 3, revenue[LTM]), "pct"),
    R("EPS", cagr(epsFull, 3, eps[LTM]), "pct"),
    R("주당배당금", cagr(dpsFull, 3, dps[LTM]), "pct"),
  ];

  const evNotes: string[] = [
    "※ EV = 시가총액 + 차입금(금융리스 포함·운용리스 제외) + 우선주·비지배지분 − 현금·단기투자·장기 투자증권",
  ];
  if (evBlockers.has("captive-unsplit"))
    evNotes.push("※ EV/EBITDA 미표시: 금융 자회사(할부금융) 보유 — 산정 기준 확정 전까지 비움");
  if (evBlockers.has("captive-unknown"))
    evNotes.push("※ EV/EBITDA 미표시: 금융 자회사 여부를 판별할 최신 공시 조회 실패(일시적 오류일 수 있음)");
  if (evBlockers.has("debt-untagged")) evNotes.push("※ EV/EBITDA 미표시: 차입금이 표준 태그로 공시되지 않음");
  if (evCaptive) evNotes.push("※ 금융 자회사(할부금융) 차입금 제외 — 제조 부문 차입금만 반영");
  if (evPartial) evNotes.push("※ 차입금 일부(건별로만 공시된 기간대출 등) 미집계 — EV 과소 가능");
  if (opts.evCtx?.opUnits)
    evNotes.push("※ 운영 파트너십 지분을 시가로 EV 에 반영(수량 출처: Yahoo implied shares)");
  if (!isFin) {
    items.push(SP("evnote"));
    for (const n of evNotes) items.push(R(n, blank(), undefined, { italic: true }));
  }

  // SEC 원본 조회 실패로 공란이 된 값(대체 계산 없음 — sec-unavailable.ts)
  const unavailable = unavailableNote(facts);
  if (unavailable) {
    items.push(SP("unavailable"));
    items.push(R(unavailable, blank(), undefined, { italic: true }));
  }


  return {
    symbol: "",
    market: "us",
    periodType: "annual",
    unit: "USD",
    currency: "USD",
    consolidation: "consolidated",
    periods,
    sections: [{ title: "분석 지표", items }],
    source: "SEC EDGAR + 시세 · 자체 계산",
  };
}
