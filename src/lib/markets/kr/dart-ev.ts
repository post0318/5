import "server-only";
import { annualSeries, seriesOf, type KrFactLine, type KrFacts } from "./dart-facts";
import { fetchKrxCapsOn } from "../quote/krx";
import type { KrLeaseNote } from "@/lib/db/kr-da";

/**
 * 리스부채 주석 입력(오너 결정 2026-10-05) — 재무상태표 본표에 리스부채 줄이 없는 해는 주석의 리스부채 합계를 총차입금에 넣는다. 감가상각
 * 적재본(kr_da)의 leaseNote·leasePolicyLatest(scripts/populate-kr-da.mjs 가 사업보고서 XBRL 주석·회계정책 문장에서 만든다).
 */
export interface KrLeaseInput {
  leaseNote?: Record<string, KrLeaseNote>;
  leasePolicyLatest?: KrLeaseNote | null;
  leaseQuarter?: (KrLeaseNote & { label: string }) | null;
}
/**
 * 본표 리스부채 줄이 없는 기간의 판정 — add(총차입금에 더할 금액), unknown(EV 공란 사유), how(근거 — 주석 표시).
 * 사업연도는 그해 주석(added·included). 분기말은 최근 사업보고서 회계정책이 "차입금 줄에 포함"이면 0, 아니면 그 분기 보고서 원문 주석 리스부채
 * (leaseQuarter — 라벨이 같은 분기만, 오너 결정 2026-10-05), 그것도 없으면 EV 공란(그림자 채우기 금지 — 연말 금액을 분기말에 쓰지 않는다).
 */
export function krLeaseFor(
  year: number | null,
  lease: KrLeaseInput | null | undefined,
  quarterLabel?: string | null,
): { add: number; unknown: string | null; how: string | null } {
  if (year != null) {
    const n = lease?.leaseNote?.[String(year)];
    if (n?.status === "added" && n.amount != null) return { add: n.amount, unknown: null, how: `FY${year} 리스부채 ${n.amount} 주석 가산(${n.how})` };
    if (n?.status === "included") return { add: 0, unknown: null, how: `FY${year} 리스부채는 본표 차입금 줄에 포함(${n.how})` };
    return { add: 0, unknown: n ? `FY${year} 리스부채 확인 불가(${n.how})` : `FY${year} 리스부채 주석 미적재(본표에 리스부채 줄 없음)`, how: null };
  }
  const p = lease?.leasePolicyLatest;
  if (p?.status === "included") return { add: 0, unknown: null, how: `분기말 리스부채는 본표 차입금 줄에 포함(최근 사업보고서 회계정책 — ${p.how})` };
  const q = lease?.leaseQuarter;
  const mine = q != null && quarterLabel != null && q.label === quarterLabel;
  if (mine && q.status === "added" && q.amount != null) return { add: q.amount, unknown: null, how: `분기말 리스부채: ${q.how}` };
  return {
    add: 0,
    unknown: mine ? `${quarterLabel} 분기말 리스부채 확인 불가(${q.how})` : `${quarterLabel ?? "분기말"} 리스부채 확인 불가(본표에 리스부채 줄 없음 · 분기 보고서 주석 리스부채 미적재)`,
    how: null,
  };
}

/**
 * 한국 종목 **EV 브릿지 단일 기준** — 하이라이트·재무분석·개요 멀티플·컨센서스가 모두
 * 여기서 차입금·현금·비지배지분·시가총액(보통주·우선주)을 받는다. 미국
 * `us/edgar-ev.ts` 와 같은 역할.
 *
 * 왜 따로 뺐나 (B16, 2026-09-23 국내 사이트 대조):
 *  - 하이라이트·재무분석은 계정명 정규식(/차입금|사채|리스부채/)으로 합산해
 *    **이름에 그 글자가 없는 차입금을 놓쳤다** — 삼성전자 "유동성장기부채" 1.18조,
 *    한전 "유동/비유동금융부채" 130조(차입금 전액), HD현대중공업·HD현대일렉트릭
 *    "단기/장기금융부채". 네이버 순부채와 평균 24.5조 차이.
 *  - 개요 멀티플·컨센서스는 차입금 대신 **부채총계**를 더해 EV 가 2~16배 과대.
 *  - 과거 시가총액은 "연말 종가 × 현재 상장주식수" 근사.
 *
 * 정의 (미국과 같은 구조 — 오너 결정 2026-09-23):
 *   EV = 보통주 시가총액 + 우선주 시가총액(우선주 자체 시세, "우선주는 포함한다")
 *        + 이자부 차입금(리스부채 포함) + 비지배지분 − 현금성자산
 *   현금성자산 = 현금및현금성자산 + 단기금융상품 + 유동 상각후원가·FVPL 금융자산
 *   (네이버 WiseReport EV 정의와 같은 범위)
 *
 * 리스부채는 **포함**한다 — 미국(US GAAP)과 다르다. IFRS 16 은 운용리스도 부채로
 * 인식하고 리스료가 영업비용이 아니라 감가상각비·이자비용으로 가서 EBITDA 에 이미
 * 빠져 있다. 넣지 않으면 오히려 EV 가 과소(미국 운용리스 제외와 같은 논리의 반대편).
 */

// ── 차입금 판정 ───────────────────────────────────────────────────────

/** 차입금 표준 계정 ID — 실측(유니버스 30종목 2025 연결 BS). */
const DEBT_ID =
  /(?:^|_)(?:Current|Noncurrent|Longterm|Shortterm|LongTerm|ShortTerm)?\w*(?:Borrowings|LoansReceived|BondsIssued|LeaseLiabilities|ConvertibleBonds?|ExchangeableBonds?|PortionOfBonds|BondsWithWarrant\w*|Debentures?)(?:Gross|Net)?$/;
/** 차입금 ID 에 걸려도 빼는 것 — 파생상품·충당부채·이자·미지급 등. */
const DEBT_ID_EXCLUDE = /Derivative|Provision|Payable|Receivable|Asset/;
/** 표준코드 미사용 라인은 계정명으로 — "단기차입금", "유동성장기부채", "판매후리스부채". */
const DEBT_NAME = /차입|사채|리스부채|장기부채/;
const DEBT_NAME_EXCLUDE = /리스채권|투자|자산|받을|대여|이자|파생|확정계약|충당/;
/**
 * 한전·HD현대 계열은 차입금을 "(유동|비유동|단기|장기)금융부채" 이름으로
 * `Other*FinancialLiabilities` 태그에 담는다. 같은 태그라도 "기타금융부채"(SK하이닉스
 * 4.91조 — 미지급비용 등)는 차입금이 아니므로 **이름이 정확히 이 형태일 때만**,
 * 그리고 다른 차입금 라인이 없을 때만 쓴다.
 */
const PLAIN_FIN_LIAB = /^(유동|비유동|단기|장기)금융부채$/;

const isStandard = (id: string) => /^(ifrs-full|dart)_/.test(id);
const ids = (l: KrFactLine) => (l.accountIds?.length ? l.accountIds : [l.accountId]).filter(Boolean);
const nameOf = (l: KrFactLine) => l.accountName.replace(/\s/g, "");

/** 차입금 태그가 붙어도 자산(대여금·채권)인 줄 — 회사가 해마다 태그를 바꾸면 같은 줄에 차입금 ID 가 섞여 들어온다(402340 "단기대여금" 이 총차입금에 들어갔다, 감사 1차) */
const DEBT_STD_NAME_EXCLUDE = /대여|자산|받을|리스채권/;
function isDebtLine(l: KrFactLine): boolean {
  if (l.sjDiv !== "BS") return false;
  if (DEBT_STD_NAME_EXCLUDE.test(nameOf(l))) return false;
  const std = ids(l).filter(isStandard);
  if (std.length) return std.some((id) => DEBT_ID.test(id) && !DEBT_ID_EXCLUDE.test(id));
  const nm = nameOf(l);
  return DEBT_NAME.test(nm) && !DEBT_NAME_EXCLUDE.test(nm);
}
function isLeaseLine(l: KrFactLine): boolean {
  return ids(l).some((id) => /LeaseLiabilities/.test(id)) || /리스부채/.test(nameOf(l));
}
/**
 * 이름은 이 줄이 여러 보고서에서 쓴 이름 전부(KrFactLine.names) — 한전 2026 반기보고서는 같은 줄(같은 태그, 전기말 = 2025 사업보고서 "유동금융부채")을
 * "기타 유동 금융부채"로 이름을 바꿔 달아 LTM 총차입금이 0(실제 약 133조)이 됐다(2026-10-05, 분기말 리스부채를 채우며 드러남)
 */
function isPlainFinLiabLine(l: KrFactLine): boolean {
  return (
    l.sjDiv === "BS" &&
    ids(l).some((id) => /Other(Current|Noncurrent)FinancialLiabilities/.test(id)) &&
    [nameOf(l), ...(l.names ?? [])].some((n) => PLAIN_FIN_LIAB.test(n))
  );
}

// ── 현금 판정 ────────────────────────────────────────────────────────

const CASH_ID =
  /^(ifrs-full|dart)_(CashAndCashEquivalents|Short[tT]ermDeposits(?:Not)?ClassifiedAsCashEquivalents|CurrentInvestments|CurrentFinancialAssetsAtAmortisedCost|CurrentFinancialAssetsAtFairValueThroughProfitOrLoss\w*)$/;
const CASH_NAME = /^(현금및현금성자산|단기금융상품|단기금융자산|단기투자자산|단기투자증권)$/;
/**
 * B16 — "기타(유동)금융자산"은 제외하되, **그 기간 자기 보고서**(연간 = 그해 사업보고서, 분기 = 그 분기 보고서)가 이 줄에 단기예치금 표준 ID 를
 * 달았으면 포함(오너 결정 2026-10-05 — 064350 "기타금융자산": 2020~2022 사업보고서 dart_ShortTermDepositsNotClassifiedAsCashEquivalents,
 * 2023 보고서부터 포괄 ifrs-full_OtherCurrentFinancialAssets). 값은 그 해를 담은 가장 최근 보고서에서 오지만(재작성 반영) 성격은 그 기간 보고서의
 * 분류로 본다. 감사 1차(2026-10-05)엔 태그와 무관하게 제외했었다 — 줄 ID 가 해마다 섞여 판정이 해마다 갈렸기 때문(기간별 판정으로 해결)
 */
const CASH_NAME_EXCLUDE = /^기타(유동)?금융자산$/;
const DEPOSIT_ID = /^(ifrs-full|dart)_Short[tT]ermDeposits(?:Not)?ClassifiedAsCashEquivalents$/;
/** 기간 라벨("FY2021"·"2026 Q2")에서 이 줄이 현금성자산인가 — 기타(유동)금융자산 줄만 기간별로 갈린다 */
function cashIn(l: KrFactLine, label: string): boolean {
  if (!CASH_NAME_EXCLUDE.test(nameOf(l))) return true;
  return [...(l.ownIds?.get(label) ?? [])].some((id) => DEPOSIT_ID.test(id));
}

function isCashLine(l: KrFactLine): boolean {
  if (l.sjDiv !== "BS") return false;
  if (CASH_NAME_EXCLUDE.test(nameOf(l))) return [...(l.ownIds?.values() ?? [])].some((ids) => [...ids].some((id) => DEPOSIT_ID.test(id)));
  // B16 에 이름이 적힌 항목(현금및현금성자산·단기금융상품·단기투자자산(증권)·단기금융자산)은 태그와 관계없이 — 회사가 같은 줄을 해마다 다른 태그로
  // 단다(402340 "단기투자자산": 2023 보고서 InvestmentsOtherThan…, 2024~ 포괄 OtherCurrentFinancialAssets)
  if (CASH_NAME.test(nameOf(l))) return true;
  return ids(l).filter(isStandard).some((id) => CASH_ID.test(id));
}

const NCI_ID = /^ifrs-full_NoncontrollingInterests$/;
const NCI_NAME = /^비지배지분$/;

// ── 연도별 합산 ───────────────────────────────────────────────────────

function sumLines(facts: KrFacts, lines: KrFactLine[], include?: (l: KrFactLine, label: string) => boolean): Map<number, number> {
  const out = new Map<number, number>();
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.key)) continue;
    seen.add(l.key);
    for (const [y, v] of facts.annual.get(l.key) ?? []) if (!include || include(l, `FY${y}`)) out.set(y, (out.get(y) ?? 0) + v);
  }
  return out;
}

export interface KrBalanceBridge {
  /** 이자부 차입금(리스부채 포함) */
  debt: number;
  /** 그중 리스부채 */
  lease: number;
  cash: number;
  nci: number;
  /** 한전·HD현대식 "(유동|비유동)금융부채"를 차입금으로 쓴 경우 */
  plainFinLiab: boolean;
  /** 본표 리스부채 줄 없음 — 리스부채를 확인 못한 사유(있으면 EV 공란) */
  leaseUnknown?: string | null;
  /** 본표 리스부채 줄 없음 — 주석 가산·차입금 포함 근거 */
  leaseHow?: string | null;
}

/** 금융업(은행·보험·증권) — EV 개념이 맞지 않아 비운다(미국 은행과 같은 원칙). */
function isFinancialBs(facts: KrFacts): boolean {
  return facts.lines.some(
    (l) => l.sjDiv === "BS" && /^(예수부채|보험계약부채|책임준비금)$/.test(nameOf(l)),
  );
}

/**
 * 금융 자회사 차입금을 연결 BS 에서 분리하지 않는 회사 — 미국 DE 와 같은 이유로
 * EV 를 비운다(오너 결정 2026-09-23 "ev/ebitda 최종은 뒤로 미루고" — 금융 자회사
 * 전체 N/A 가 임시 원칙). 현대차: 현대캐피탈·현대카드 연결, 금융부문 차입금이
 * 연결 차입금의 대부분(2025 약 100조+).
 */
const KR_CAPTIVE = new Set(["005380"]);

export type KrEvBlocker = "financial" | "captive-unsplit" | null;

export interface KrEvResolver {
  blocker(): KrEvBlocker;
  /** 사업연도말 BS 브릿지 (해당 연도 값이 없으면 null) */
  bridgeAt(year: number): KrBalanceBridge | null;
  years(): number[];
}

/**
 * EV 브릿지 계정 라인 분류 — 연간(resolver)·기간별(대차대조표 주석, 분기 보기 포함)이
 * 같은 판정을 쓰도록 공개한다.
 */
export function krBridgeLines(facts: KrFacts): {
  debt: KrFactLine[];
  lease: KrFactLine[];
  cash: KrFactLine[];
  /** 현금 줄의 기간별 포함 여부 — 합산할 때 넘긴다(sumLines·sumLinesByPeriod) */
  cashIn: (l: KrFactLine, label: string) => boolean;
  nci: KrFactLine[];
  plainFinLiab: boolean;
} {
  const bs = facts.lines.filter((l) => l.sjDiv === "BS");
  const debtLines = bs.filter(isDebtLine);
  const hasBorrowing = debtLines.some((l) => !isLeaseLine(l));
  const plainLines = hasBorrowing ? [] : bs.filter(isPlainFinLiabLine);
  return {
    debt: [...debtLines, ...plainLines],
    lease: debtLines.filter(isLeaseLine),
    cash: bs.filter(isCashLine),
    cashIn,
    nci: bs.filter((l) => ids(l).some((id) => NCI_ID.test(id)) || NCI_NAME.test(nameOf(l))),
    plainFinLiab: plainLines.length > 0,
  };
}

/**
 * 유동 차입금 — ROIC 투하자본(총자산 − (유동부채 − 유동 차입금), 미국 edgar-analysis 와 같은 정의, 2026-10-02). EV 와 같은 차입금 줄을
 * 이름·ID 로 유동/비유동으로 나눈다("단기·유동·유동성장기" / "장기·비유동"). 어느 쪽인지 판정 못 하는 줄에 그 기간 값이 있으면 그 기간은
 * null(0 으로 보지 않음).
 */
function debtSide(l: KrFactLine): "cur" | "non" | null {
  const t = [...ids(l), nameOf(l)].join(" ");
  if (/Noncurrent|NonCurrent|Longterm|LongTerm|비유동|^장기|\s장기/.test(t)) return "non";
  if (/Current|Shortterm|ShortTerm|유동|단기/.test(t)) return "cur";
  return null;
}
/** 연간 시계열판(표시 기간보다 1년 앞 기초값 포함 — 평균잔액용) */
export function krCurrentDebtByYear(facts: KrFacts): Map<number, number | null> {
  const L = krBridgeLines(facts).debt;
  const cur = sumLines(facts, L.filter((l) => debtSide(l) === "cur"));
  const amb = sumLines(facts, L.filter((l) => debtSide(l) == null));
  const all = sumLines(facts, L);
  const out = new Map<number, number | null>();
  for (const y of all.keys()) out.set(y, amb.get(y) ? null : (cur.get(y) ?? 0));
  return out;
}
export function krCurrentDebtByPeriod(facts: KrFacts): Record<string, number | null> {
  const L = krBridgeLines(facts).debt;
  const cur = sumLinesByPeriod(facts, L.filter((l) => debtSide(l) === "cur"));
  const amb = sumLinesByPeriod(facts, L.filter((l) => debtSide(l) == null));
  const out: Record<string, number | null> = {};
  for (const p of facts.periods) out[p.label] = amb[p.label] ? null : (cur[p.label] ?? 0);
  return out;
}

/**
 * 대차대조표 주석 총차입금(기간 라벨별) — 하이라이트 EV 브릿지와 같은 판정(본표 리스부채 줄이 없는 기간은 krLeaseFor). 연간 화면은 사업연도
 * 주석, 분기 화면은 회계정책 판정만(금액 못 구함 → 본표 값 그대로 + 사유)
 */
export function krDebtByPeriod(facts: KrFacts, leaseIn?: KrLeaseInput | null): { debt: Record<string, number | null>; notes: string[] } {
  const L = krBridgeLines(facts);
  const debt = sumLinesByPeriod(facts, L.debt);
  const lease = sumLinesByPeriod(facts, L.lease);
  const cash = sumLinesByPeriod(facts, L.cash, L.cashIn);
  const notes: string[] = [];
  for (const p of facts.periods) {
    // 그 기간에 차입금 줄이 없으면 0(현금 줄이 있는 기간 — EV 브릿지 `debt.get(year) ?? 0` 과 같은 규칙)
    if (debt[p.label] == null && cash[p.label] != null) debt[p.label] = 0;
    if (lease[p.label] != null || debt[p.label] == null) continue;
    const lz = facts.mode === "quarter" ? krLeaseFor(null, leaseIn, p.label) : krLeaseFor(p.year, leaseIn);
    debt[p.label] = debt[p.label]! + lz.add;
    notes.push(`${p.label}: ${lz.how ?? `⚠ ${lz.unknown} — 총차입금은 본표 차입금 줄만`}`);
  }
  return { debt, notes };
}

/** 기간 라벨별 합(대차대조표 주석용) — 같은 라인 키는 한 번만. */
export function sumLinesByPeriod(facts: KrFacts, lines: KrFactLine[], include?: (l: KrFactLine, label: string) => boolean): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const p of facts.periods) out[p.label] = null;
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.key)) continue;
    seen.add(l.key);
    for (const p of facts.periods) {
      const v = l.byPeriod.get(p.label);
      if (v != null && (!include || include(l, p.label))) out[p.label] = (out[p.label] ?? 0) + v;
    }
  }
  return out;
}

export function buildKrEvResolver(facts: KrFacts, code: string, leaseIn?: KrLeaseInput | null): KrEvResolver {
  const L = krBridgeLines(facts);
  const debt = sumLines(facts, L.debt);
  const lease = sumLines(facts, L.lease);
  // "기타유동금융자산"은 넣지 않는다 — 네이버가 회사마다 주석 내역으로 일부만 넣는 것으로
  // 보이는데 재무상태표만으론 가를 수 없다. 실측(33종목·147개 연도): 제외 시 평균 |차이|
  // 0.19조, 포함 시 0.23조, "별도 단기투자 라인이 없을 때만 포함" 0.30조.
  const cash = sumLines(facts, L.cash, L.cashIn);
  const nci = sumLines(facts, L.nci);
  const blocker: KrEvBlocker = isFinancialBs(facts)
    ? "financial"
    : KR_CAPTIVE.has(code.replace(/\D/g, "").padStart(6, "0"))
      ? "captive-unsplit"
      : null;
  const yearsWithBs = [...new Set([...cash.keys(), ...debt.keys()])].sort((a, b) => a - b);
  return {
    blocker: () => blocker,
    years: () => yearsWithBs,
    bridgeAt(year) {
      if (!debt.has(year) && !cash.has(year)) return null;
      // 본표에 그해 리스부채 줄 값이 없으면 주석 판정(오너 결정 2026-10-05)
      const lz = lease.has(year) ? { add: 0, unknown: null, how: null } : krLeaseFor(year, leaseIn);
      return {
        debt: (debt.get(year) ?? 0) + lz.add,
        lease: (lease.get(year) ?? 0) + lz.add,
        cash: cash.get(year) ?? 0,
        nci: nci.get(year) ?? 0,
        plainFinLiab: L.plainFinLiab,
        leaseUnknown: lz.unknown,
        leaseHow: lz.how,
      };
    },
  };
}

/** EV = 보통주 + 우선주 시가총액 + 차입금 + 비지배지분 − 현금. 막힘·결측이면 null. */
export function krEv(
  resolver: KrEvResolver,
  year: number,
  commonMcap: number | null,
  preferredMcap: number | null,
): number | null {
  return krEvFromBridge(resolver.blocker(), resolver.bridgeAt(year), commonMcap, preferredMcap);
}

/** krEv 의 브릿지 직접 입력판 — LTM 열(최신 분기말 재무상태표)용. 식은 같다. */
export function krEvFromBridge(
  blocker: KrEvBlocker | string | null | undefined,
  b: Pick<KrBalanceBridge, "debt" | "nci" | "cash" | "leaseUnknown"> | null,
  commonMcap: number | null,
  preferredMcap: number | null,
): number | null {
  if (blocker || commonMcap == null || !b || b.leaseUnknown) return null;
  return commonMcap + (preferredMcap ?? 0) + b.debt + b.nci - b.cash;
}

// ── LTM 열 재무상태표 (최신 분기·반기 보고서) ──────────────────────────

export interface KrLtmBalance {
  /**
   * 기준 라벨 — 분기 보고서 값이면 분기 재무제표 라벨 그대로("2026 Q2"), 손익 TTM 자체가
   * 연간이면 "FY2025", 분기 재무상태표를 못 구해 연말값으로 대체했으면 그 사실을 적는다
   * ("FY2025 (2026 Q2 재무상태표 없음 — 연말값)").
   */
  label: string;
  bridge: KrBalanceBridge | null;
  parentEquity: number | null;
  /** bridge·parentEquity 각각의 재무상태표 기준일(YYYY-MM-DD) — 외화 환산(DART 연결 ADR) 기말 환율용 */
  bridgeEnd: string | null;
  equityEnd: string | null;
}

/**
 * LTM(현재/LTM) 열의 재무상태표 — **손익 TTM 의 마지막 분기말** 기준(오너 결정 2026-09-24,
 * 미국 MRQ 와 같은 원칙). 판정 규칙은 연간과 같은 krBridgeLines·지배주주 자본 계정을
 * 분기 facts 에 그대로 적용한다. 분기 facts 에 그 분기가 없거나 계정이 비면 최근
 * 사업연도말 값으로 폴백하되 label 에 드러낸다(조용한 대체 금지).
 *
 * @param target 손익 TTM 의 마지막 분기(getKrTtm 의 분기·반기 보고서). null 이면 TTM 이
 *               연간값 — 사업연도말 재무상태표가 곧 같은 기준일.
 */
export function krLtmBalance(
  annual: KrFacts,
  quarter: KrFacts | null,
  target: { year: number; quarter: number } | null,
  code: string,
  leaseIn?: KrLeaseInput | null,
): KrLtmBalance {
  const res = buildKrEvResolver(annual, code, leaseIn);
  const lastFy = res.years().at(-1) ?? null;
  const fyEq = lastFy != null ? (krParentEquityByYear(annual).get(lastFy) ?? null) : null;
  const fyBridge = lastFy != null ? res.bridgeAt(lastFy) : null;
  const fyLabel = lastFy != null ? `FY${lastFy}` : "";
  const fyEnd = lastFy != null ? (annual.annualEndByYear.get(lastFy) ?? `${lastFy}-12-31`) : null;
  if (!target) return { label: fyLabel, bridge: fyBridge, parentEquity: fyEq, bridgeEnd: fyEnd, equityEnd: fyEnd };

  const qLabel = `${target.year} Q${target.quarter}`;
  const fallback = (why: string): KrLtmBalance => ({
    label: `${fyLabel} (${qLabel} ${why} — 연말값)`,
    bridge: fyBridge,
    parentEquity: fyEq,
    bridgeEnd: fyEnd,
    equityEnd: fyEnd,
  });
  if (!quarter || !quarter.periods.some((p) => p.label === qLabel)) return fallback("재무상태표 없음");

  const qEnd = quarter.periods.find((p) => p.label === qLabel)?.endDate ?? null;
  const L = krBridgeLines(quarter);
  const at = (lines: KrFactLine[], include?: (l: KrFactLine, label: string) => boolean) => sumLinesByPeriod(quarter, lines, include)[qLabel] ?? null;
  const debt = at(L.debt);
  const cash = at(L.cash, L.cashIn);
  const parent = seriesOf(quarter, PARENT_EQ.ids, PARENT_EQ.names, "BS")[qLabel] ?? null;
  const equity = parent ?? seriesOf(quarter, TOTAL_EQ.ids, TOTAL_EQ.names, "BS")[qLabel] ?? null;
  const hasBridge = debt != null || cash != null;
  const leaseQ = at(L.lease);
  const lzQ = leaseQ != null ? { add: 0, unknown: null, how: null } : krLeaseFor(null, leaseIn, qLabel);
  if (!hasBridge && equity == null) return fallback("재무상태표 계정 없음");
  // 한 쪽만 비면 그 항목만 연말값 — 라벨에 어느 항목인지 적는다
  const missing = [!hasBridge && "차입금·현금", equity == null && "자본"].filter(Boolean);
  return {
    label: missing.length ? `${qLabel} (${missing.join("·")}은 ${fyLabel} 연말값)` : qLabel,
    bridge: hasBridge
      ? {
          // 연간 resolver 와 같은 규칙 — 현금만 있고 차입금 계정이 없으면 무차입(0). 본표에 리스 줄이 없으면 분기 주석 리스부채를 더한다
          debt: (debt ?? 0) + lzQ.add,
          lease: (leaseQ ?? 0) + lzQ.add,
          cash: cash ?? 0,
          nci: at(L.nci) ?? 0,
          plainFinLiab: L.plainFinLiab,
          leaseUnknown: lzQ.unknown,
          leaseHow: lzQ.how,
        }
      : fyBridge,
    parentEquity: equity ?? fyEq,
    bridgeEnd: hasBridge ? qEnd : fyEnd,
    equityEnd: equity != null ? qEnd : fyEnd,
  };
}

// ── 시가총액 (KRX 실측) ───────────────────────────────────────────────

export interface KrCaps {
  /** 사업연도 → 연말(마지막 거래일) 보통주·우선주 시가총액 */
  byYear: Map<number, { common: number | null; preferred: number; close: number | null }>;
  /** 최근 거래일 */
  current: { common: number | null; preferred: number } | null;
  preferredIssues: string[];
}

/**
 * 연말 시가총액 — KRX 일별 전종목 MKTCAP(그날의 실제 상장주식수 × 종가). 예전엔
 * "연말 종가 × 현재 상장주식수"라 증자·소각이 있던 해의 PBR·PSR·EV 가 틀렸다.
 * 우선주는 자체 시세로(삼성전자우 등), 보통주 가격을 우선주 주식수에 곱하지 않는다.
 */
export async function loadKrCaps(code: string, years: number[]): Promise<KrCaps> {
  const today = new Date();
  const ymd = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const [cur, ...fy] = await Promise.all([
    // 조회 실패는 던진다(호출자가 처리) — 연도별 null 로 삼키면 그 해 시가총액·EV 가 사유 없이 빠졌다. 자료 없음은 fetchKrxCapsOn 이 null
    fetchKrxCapsOn(code, ymd(today)),
    ...years.map((y) => fetchKrxCapsOn(code, `${y}1231`)),
  ]);
  const byYear = new Map<number, { common: number | null; preferred: number; close: number | null }>();
  years.forEach((y, i) => {
    const c = fy[i];
    if (c) byYear.set(y, { common: c.commonMarketCap, preferred: c.preferredMarketCap, close: c.close });
  });
  return {
    byYear,
    current: cur ? { common: cur.commonMarketCap, preferred: cur.preferredMarketCap } : null,
    preferredIssues: cur?.preferredIssues ?? [],
  };
}

/**
 * loadKrCaps + 조회 실패 사유 — 호출부가 실패를 경고·공란 사유로 남기게(재감사 14차 ③ — 예전엔 호출부 6곳이 실패를 null 로 삼켜
 * 연도 시가총액이 "종가 × 현재 주식수" 근사·우선주 0 으로 표시 없이 바뀌었다)
 */
export async function loadKrCapsChecked(code: string, years: number[]): Promise<{ caps: KrCaps | null; error: string | null }> {
  try {
    return { caps: await loadKrCaps(code, years), error: null };
  } catch (e) {
    return { caps: null, error: `KRX 시가총액 조회 실패 — ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
  }
}

// ── 지배주주 자본 (PBR 분모) ──────────────────────────────────────────

/**
 * 사업연도별 **지배기업 소유주지분** — PBR 분모. 미국과 같은 원칙(오너 결정 — 순이익·
 * 자기자본은 지배주주 기준, 5103d5a). 예전엔 하이라이트·재무분석이 비지배지분 포함
 * 자본총계를, 컨센서스는 지배주주 자본을 써서 같은 해 PBR 이 갈렸다(현대차 최대 10%,
 * 검증 체계 한국 확장으로 발견 2026-09-23). 별도재무제표만 있는 회사는 자본총계.
 */
const PARENT_EQ = {
  ids: ["ifrs-full_EquityAttributableToOwnersOfParent"],
  names: ["지배기업의 소유주에게 귀속되는 자본", "지배기업 소유주지분", "지배기업소유주지분", "지배기업의소유주지분"],
};
const TOTAL_EQ = { ids: ["ifrs-full_Equity"], names: ["자본총계"] };

export function krParentEquityByYear(facts: KrFacts): Map<number, number> {
  const parent = annualSeries(facts, PARENT_EQ.ids, PARENT_EQ.names, "BS");
  const total = annualSeries(facts, TOTAL_EQ.ids, TOTAL_EQ.names, "BS");
  const out = new Map(parent);
  for (const [y, v] of total) if (!out.has(y)) out.set(y, v);
  return out;
}

/**
 * 사업연도별 희석 EPS(없으면 기본) — PER 분자·분모 공통. 하이라이트·재무분석·컨센서스가
 * 같은 값을 쓰게 한 곳에 둔다(컨센서스만 재무제표 표시용 계정명 매칭으로 EPS 를 골라
 * 현대차 PER 이 27% 갈렸다, 2026-09-23).
 */
export function krEpsByYear(facts: KrFacts): Map<number, number> {
  const out = new Map(krEpsAnnual(facts, "diluted").values);
  for (const [y, v] of krEpsAnnual(facts, "basic").values) if (!out.has(y)) out.set(y, v);
  return out;
}

/**
 * **EPS 단일 기준(2026-10-01)** — 전체(계속 + 중단영업) 주당이익. 전체 EPS 를 공시하지 않고 계속영업·중단영업 주당이익만
 * 공시한 기간은 **두 공시값의 합**(K-IFRS 1033 의 표시 구조 — 전체 = 계속 + 중단). 계속영업 EPS 만 쓰면 중단영업 이익이 큰 해에
 * 순이익과 EPS 의 정의가 갈린다(NAVER 2021: 순이익 16.48조(라인 지분 정리 이익 포함)인데 EPS 는 계속영업 9,887원 → PER 38배.
 * 전체는 9,887 + 99,973 = 109,860원). 미국 원칙(계속영업 EPS 태그 미사용, DELL)과 같다. 손익계산서·하이라이트·재무분석 공통.
 * 계속·중단영업 EPS 는 표준 계정 ID 로만 찾는다 — 계정명 "계속영업순이익" 은 NAVER 가 순이익 줄에도 쓴다.
 */
export type KrEpsKind = "basic" | "diluted";
// 기본·희석 합친 줄("보통주 기본 및 희석주당이익" — 373220)은 기본·희석 모두의 전체 EPS
const EPS_TOTAL: Record<KrEpsKind, { ids: string[]; names: string[] }> = {
  diluted: { ids: ["ifrs-full_DilutedEarningsLossPerShare"], names: ["희석주당이익", "희석주당순이익", "보통주희석주당이익", "기본및희석주당이익", "보통주기본및희석주당이익", "보통주기본및희석주당순이익"] },
  basic: { ids: ["ifrs-full_BasicEarningsLossPerShare"], names: ["기본주당이익", "기본주당순이익", "기본및희석주당이익", "보통주기본주당이익", "보통주기본및희석주당이익", "보통주기본및희석주당순이익"] },
};
/**
 * 전체 EPS ID 를 달았지만 계정명이 계속·중단영업 주당이익인 줄 — 태그 오류(373220 2023 사업보고서: "보통주 기본 및 희석주당계속영업이익" 에
 * DilutedEarningsLossPerShare). 전체 EPS 로 쓰지 않는다(2021 계속영업 3,036 이 전체 3,963 대신 나왔다, 감사 11차 K7). 계속영업 줄은 EPS_CONT 이름으로 잡힌다
 */
export function isPartialOpsEpsName(name: string): boolean {
  // 계속·중단 한쪽만 — "계속영업과 중단영업 …"·"중단사업 및 계속사업 …"(순서 무관) 합계 줄은 전체 EPS
  const n = name.replace(/\s/g, "");
  return /계속(영업|사업)/.test(n) !== /중단(영업|사업)/.test(n);
}
const notTotalEps = (l: KrFactLine) => isPartialOpsEpsName(l.accountName);
// 계정명은 "주당" 이 들어간 것만(순이익 줄 "계속영업순이익" 과 겹치지 않게)
const EPS_CONT: Record<KrEpsKind, { ids: string[]; names: string[] }> = {
  diluted: { ids: ["ifrs-full_DilutedEarningsLossPerShareFromContinuingOperations"], names: ["계속영업희석주당이익", "계속영업희석주당순이익", "보통주기본및희석주당계속영업이익"] },
  basic: { ids: ["ifrs-full_BasicEarningsLossPerShareFromContinuingOperations"], names: ["계속영업기본주당이익", "계속영업기본주당순이익", "보통주기본및희석주당계속영업이익"] },
};
const EPS_DISC: Record<KrEpsKind, { ids: string[]; names: string[] }> = {
  diluted: { ids: ["ifrs-full_DilutedEarningsLossPerShareFromDiscontinuedOperations"], names: ["중단영업희석주당이익", "중단영업희석주당순이익"] },
  basic: { ids: ["ifrs-full_BasicEarningsLossPerShareFromDiscontinuedOperations"], names: ["중단영업기본주당이익", "중단영업기본주당순이익"] },
};
export const KR_EPS_SUM_NOTE = "전체 EPS 미공시 — 계속영업 + 중단영업 주당이익(회사 공시 두 값)의 합";
/** 사업연도 EPS 빈칸 사유 — 그해 DART 사업보고서에 전체 EPS·계속영업 EPS 줄이 모두 없음(감사 12차 ①) */
export const KR_EPS_BLANK_NOTE = "DART 사업보고서에 EPS 줄 없음(전체·계속영업 모두) — 빈칸";

/** 기간 라벨별(연간·분기 화면) 전체 EPS. summed = 계속 + 중단영업 합으로 채운 라벨 */
export function krEpsSeries(facts: KrFacts, kind: KrEpsKind): { values: Record<string, number | null>; summed: Set<string> } {
  const SJ = ["IS", "CIS"];
  const values = seriesOf(facts, EPS_TOTAL[kind].ids, EPS_TOTAL[kind].names, SJ, notTotalEps);
  const cont = seriesOf(facts, EPS_CONT[kind].ids, EPS_CONT[kind].names, SJ);
  const disc = seriesOf(facts, EPS_DISC[kind].ids, EPS_DISC[kind].names, SJ);
  const summed = new Set<string>();
  for (const l of Object.keys(values))
    if (values[l] == null && cont[l] != null) {
      values[l] = cont[l]! + (disc[l] ?? 0);
      summed.add(l);
    }
  return { values, summed };
}

/** 사업연도별 전체 EPS(6개년 연간 시계열). summed = 계속 + 중단영업 합으로 채운 해 */
export function krEpsAnnual(facts: KrFacts, kind: KrEpsKind): { values: Map<number, number>; summed: Set<number> } {
  const SJ = ["IS", "CIS"];
  const values = annualSeries(facts, EPS_TOTAL[kind].ids, EPS_TOTAL[kind].names, SJ, notTotalEps);
  const cont = annualSeries(facts, EPS_CONT[kind].ids, EPS_CONT[kind].names, SJ);
  const disc = annualSeries(facts, EPS_DISC[kind].ids, EPS_DISC[kind].names, SJ);
  const summed = new Set<number>();
  for (const [y, c] of cont)
    if (!values.has(y)) {
      values.set(y, c + (disc.get(y) ?? 0));
      summed.add(y);
    }
  return { values, summed };
}

/**
 * 사업연도별 영업이익 — EBITDA 분자. 하이라이트·재무분석·컨센서스 공통(컨센서스는
 * 표시용 재무제표의 계정명으로, 재무분석은 ID 목록이 하나 적어 현대로템·삼성SDI 등에서
 * EV/EBITDA 가 갈리거나 비었다, 2026-09-23 유니버스 전수 검증).
 */
export function krOpIncomeByYear(facts: KrFacts): Map<number, number> {
  return annualSeries(
    facts,
    ["dart_OperatingIncomeLoss", "ifrs-full_ProfitLossFromOperatingActivities"],
    ["영업이익"],
    ["IS", "CIS"],
  );
}
