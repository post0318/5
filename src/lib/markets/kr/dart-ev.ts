import "server-only";
import { annualSeries, type KrFactLine, type KrFacts } from "./dart-facts";
import { fetchKrxCapsOn } from "../quote/krx";

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

function isDebtLine(l: KrFactLine): boolean {
  if (l.sjDiv !== "BS") return false;
  const std = ids(l).filter(isStandard);
  if (std.length) return std.some((id) => DEBT_ID.test(id) && !DEBT_ID_EXCLUDE.test(id));
  const nm = nameOf(l);
  return DEBT_NAME.test(nm) && !DEBT_NAME_EXCLUDE.test(nm);
}
function isLeaseLine(l: KrFactLine): boolean {
  return ids(l).some((id) => /LeaseLiabilities/.test(id)) || /리스부채/.test(nameOf(l));
}
function isPlainFinLiabLine(l: KrFactLine): boolean {
  return (
    l.sjDiv === "BS" &&
    ids(l).some((id) => /Other(Current|Noncurrent)FinancialLiabilities/.test(id)) &&
    PLAIN_FIN_LIAB.test(nameOf(l))
  );
}

// ── 현금 판정 ────────────────────────────────────────────────────────

const CASH_ID =
  /^(ifrs-full|dart)_(CashAndCashEquivalents|Short[tT]ermDepositsNotClassifiedAsCashEquivalents|CurrentInvestments|CurrentFinancialAssetsAtAmortisedCost|CurrentFinancialAssetsAtFairValueThroughProfitOrLoss\w*)$/;
const CASH_NAME = /^(현금및현금성자산|단기금융상품|단기금융자산)$/;

function isCashLine(l: KrFactLine): boolean {
  if (l.sjDiv !== "BS") return false;
  const std = ids(l).filter(isStandard);
  if (std.length) return std.some((id) => CASH_ID.test(id));
  return CASH_NAME.test(nameOf(l));
}

const NCI_ID = /^ifrs-full_NoncontrollingInterests$/;
const NCI_NAME = /^비지배지분$/;

// ── 연도별 합산 ───────────────────────────────────────────────────────

function sumLines(facts: KrFacts, lines: KrFactLine[]): Map<number, number> {
  const out = new Map<number, number>();
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.key)) continue;
    seen.add(l.key);
    for (const [y, v] of facts.annual.get(l.key) ?? []) out.set(y, (out.get(y) ?? 0) + v);
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
    nci: bs.filter((l) => ids(l).some((id) => NCI_ID.test(id)) || NCI_NAME.test(nameOf(l))),
    plainFinLiab: plainLines.length > 0,
  };
}

/** 기간 라벨별 합(대차대조표 주석용) — 같은 라인 키는 한 번만. */
export function sumLinesByPeriod(facts: KrFacts, lines: KrFactLine[]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const p of facts.periods) out[p.label] = null;
  const seen = new Set<string>();
  for (const l of lines) {
    if (seen.has(l.key)) continue;
    seen.add(l.key);
    for (const p of facts.periods) {
      const v = l.byPeriod.get(p.label);
      if (v != null) out[p.label] = (out[p.label] ?? 0) + v;
    }
  }
  return out;
}

export function buildKrEvResolver(facts: KrFacts, code: string): KrEvResolver {
  const L = krBridgeLines(facts);
  const debt = sumLines(facts, L.debt);
  const lease = sumLines(facts, L.lease);
  // "기타유동금융자산"은 넣지 않는다 — 네이버가 회사마다 주석 내역으로 일부만 넣는 것으로
  // 보이는데 재무상태표만으론 가를 수 없다. 실측(33종목·147개 연도): 제외 시 평균 |차이|
  // 0.19조, 포함 시 0.23조, "별도 단기투자 라인이 없을 때만 포함" 0.30조.
  const cash = sumLines(facts, L.cash);
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
      return {
        debt: debt.get(year) ?? 0,
        lease: lease.get(year) ?? 0,
        cash: cash.get(year) ?? 0,
        nci: nci.get(year) ?? 0,
        plainFinLiab: L.plainFinLiab,
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
  if (resolver.blocker() || commonMcap == null) return null;
  const b = resolver.bridgeAt(year);
  if (!b) return null;
  return commonMcap + (preferredMcap ?? 0) + b.debt + b.nci - b.cash;
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
    fetchKrxCapsOn(code, ymd(today)).catch(() => null),
    ...years.map((y) => fetchKrxCapsOn(code, `${y}1231`).catch(() => null)),
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

// ── 지배주주 자본 (PBR 분모) ──────────────────────────────────────────

/**
 * 사업연도별 **지배기업 소유주지분** — PBR 분모. 미국과 같은 원칙(오너 결정 — 순이익·
 * 자기자본은 지배주주 기준, 5103d5a). 예전엔 하이라이트·재무분석이 비지배지분 포함
 * 자본총계를, 컨센서스는 지배주주 자본을 써서 같은 해 PBR 이 갈렸다(현대차 최대 10%,
 * 검증 체계 한국 확장으로 발견 2026-09-23). 별도재무제표만 있는 회사는 자본총계.
 */
export function krParentEquityByYear(facts: KrFacts): Map<number, number> {
  const parent = annualSeries(
    facts,
    ["ifrs-full_EquityAttributableToOwnersOfParent"],
    ["지배기업의 소유주에게 귀속되는 자본", "지배기업 소유주지분", "지배기업소유주지분", "지배기업의소유주지분"],
    "BS",
  );
  const total = annualSeries(facts, ["ifrs-full_Equity"], ["자본총계"], "BS");
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
  return annualSeries(
    facts,
    [
      "ifrs-full_DilutedEarningsLossPerShare",
      "ifrs-full_BasicEarningsLossPerShare",
      "ifrs-full_DilutedEarningsLossPerShareFromContinuingOperations",
      "ifrs-full_BasicEarningsLossPerShareFromContinuingOperations",
    ],
    ["희석주당이익", "희석주당순이익", "기본주당이익", "기본주당순이익", "보통주기본주당이익", "계속영업기본주당이익"],
    ["IS", "CIS"],
  );
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
