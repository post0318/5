import "server-only";
import { AdapterError, type FinancialStatement, type QuoteBar, type TtmFlows } from "../types";
import type { FinancialHighlights } from "./edgar-highlights";
import { estimatesToUsd } from "./edgar-foreign";
import { fetchEcosKrwPerUsd } from "../quote/ecos-fx";
import { getEodQuote } from "../quote";
import { fetchYahooEstimates } from "../quote/yahoo";
import { fetchStooqEod } from "../quote/stooq";
import { fetchKrxCloseOn } from "../quote/krx";
import { resolveCorpCode } from "../kr/corpcode";
import { daAndAmortSeries, fetchKrDistributedShares, fetchKrDps, fetchKrFacts, type KrDaInput, type KrFactLine, type KrFacts, type KrPeriod } from "../kr/dart-facts";
import { loadKrCaps, type KrCaps } from "../kr/dart-ev";
import { getKrJurirNo, krOpenDartAdapter, loadKrTtmDetail, type KrTtmPart } from "../kr/opendart";
import { fetchKrAnnualDps } from "../kr/rights-schedule";
import { buildKrHighlights } from "../kr/dart-highlights";
import { buildKrAnalysis } from "../kr/dart-analysis";
import { buildKrIncome } from "../kr/dart-income";
import { buildKrBalance } from "../kr/dart-balance";
import { buildKrCashFlow } from "../kr/dart-cashflow";
import { buildKrSummary } from "../kr/dart-summary";
import { getKrDaDoc } from "@/lib/db/kr-da";

/**
 * **DART 연결 ADR** — SEC XBRL 재무가 없는 미국 상장 ADR(20-F 미제출)을 본국 DART 재무로 채운다
 * (오너 지시 2026-09-24 "SKHY는 DART 연결 어댑터로 바로 붙이자").
 *
 * 계산은 한국 경로(kr/dart-*.ts)를 그대로 쓴다 — 여기서는 **입력만** USD·ADR 1주 기준으로 바꿔
 * 같은 빌더에 넣는다(같은 숫자는 한 모듈에서만). 환산 규칙은 미국 외국기업(edgar-foreign.ts,
 * 인포맥스 방식)과 같다:
 *   - 손익·현금흐름·주당이익·배당 = 그 기간 평균 환율, 재무상태표 = 기말 환율
 *   - 환율 원천 = 한국은행 ECOS(다른 외국기업은 Yahoo 그대로).
 *     평균 = 기간 영업일 매매기준율(원/달러)의 산술평균으로 나눈다(오너 결정 2026-09-24). 인포맥스(FactSet) 역산 환율
 *     10개 기간(5개 연도·5개 분기) 대조에서 |오차| 합 0.70%p — 역수평균(달러/원 평균) 1.05%p, Yahoo 평균보다 가깝다.
 *     시점(재무상태표·시가총액·현재) = 그 날짜 이전 마지막 거래일의 서울 외환시장 종가 15:30(오너 결정 2026-09-25).
 *   - LTM = 최근 4개 분기를 분기마다 그 분기 평균 환율로 환산해 합산(오너 결정 2026-09-25, 인포맥스·Finviz 방식)
 *   - 연말 시가총액(KRX 실측)은 재무상태표와 같은 결산일 환율 → PBR 은 원화 기준과 같다
 *   - 환율이 없는 기간의 값은 버린다(원화 숫자를 USD 로 섞지 않음 — 빈칸)
 *   - 주당 값(EPS·BPS·DPS·주가)은 × sharesPerAdr, 주식수는 ÷ sharesPerAdr (ADR 1주 기준)
 *
 * 현재 시가총액 = **ADR 현재가 × (유통주식수 ÷ sharesPerAdr)** — 20-F ADR(TSM)과 같은 방식(ADR 가격 × ADR 환산
 * 주식수). 주식수 = 자사주 제외 **유통주식수**(DART 주식총수 현황, LTM 자본과 같은 기준일 — 오너 결정 2026-09-25,
 * Finviz·인포맥스·Yahoo 7.11B ADS 기준). BPS 와 같은 주식수라 PBR = 주가 ÷ BPS 가 성립한다.
 * 연도 열도 같은 원칙 — 결산일 유통주식수 × 결산일 KRX 종가(× 환율). KRX 연말 시가총액(상장주식수 = 자사주 포함)을
 * 그대로 쓰면 같은 화면의 연도별 PBR 이 컨센서스의 주가 ÷ BPS(결산일 유통주식수)와 어긋난다.
 */

export interface DartAdrSpec {
  /** 본국 종목코드(6자리) — DART·KRX 원천 */
  krCode: string;
  /** ADR 1주가 나타내는 보통주 수 */
  sharesPerAdr: number;
}

/**
 * 대상 목록 — 종목별 상수는 여기 한 곳에만.
 * SKHY: 1 ADS = 보통주 0.1주. 근거 — 예탁증권 명칭 "SK HYNIX INC SPON ADS EACH REP 0.1 SHS"
 * (인포맥스 종목 마스터, ISIN US78392B2060), 인포맥스 ADS 수 7,288,651천 = 보통주 7.29억 주 × 10,
 * ADR 가격(≈$186) ≈ 000660 종가(≈186만 원) × 0.1 ÷ 환율.
 */
export const DART_ADR: Record<string, DartAdrSpec> = {
  SKHY: { krCode: "000660", sharesPerAdr: 0.1 },
};

export function dartAdrOf(symbol: string): (DartAdrSpec & { symbol: string }) | null {
  const s = symbol.trim().toUpperCase();
  const spec = DART_ADR[s];
  return spec ? { ...spec, symbol: s } : null;
}

// ── 환율 ──────────────────────────────────────────────────────────────

interface KrwFx {
  /** 그 날짜(이전 최근 영업일) 환율 — 원 1단위당 USD */
  at(date: string): number | null;
  /** 기간 평균 환율 */
  avg(start: string, end: string): number | null;
  now: { date: string; rate: number };
}

async function krwFx(): Promise<KrwFx> {
  // ECOS 실패 시 예외 — Yahoo 로 대체하지 않는다(오너 결정: 원천이 섞이지 않게, 빈칸/오류)
  const [ref, close] = await Promise.all([fetchEcosKrwPerUsd("reference"), fetchEcosKrwPerUsd("close")]);
  const last = close.at(-1);
  if (!last || !ref.length) throw new AdapterError("원/달러 환율(ECOS)을 구할 수 없습니다 — DART 연결 ADR 재무 숨김", { status: 502 });
  // 시점 값 = 그 날짜 이전 마지막 거래일 종가(15:30). 10일 넘게 떨어지면 데이터 공백으로 보고 쓰지 않는다
  const at = (date: string): number | null => {
    let lo = 0, hi = close.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (close[mid].date <= date) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best < 0) return null;
    return (Date.parse(date) - Date.parse(close[best].date)) / 864e5 <= 10 ? 1 / close[best].krwPerUsd : null;
  };
  // 기간 평균 = 1 ÷ (기간 영업일 매매기준율 평균)
  const avg = (start: string, end: string): number | null => {
    let sum = 0, n = 0;
    for (const q of ref) if (q.date >= start && q.date <= end) { sum += q.krwPerUsd; n++; }
    const days = (Date.parse(end) - Date.parse(start)) / 864e5;
    return n > 0 && n >= days * 0.3 ? n / sum : null;
  };
  return { at, avg, now: { date: last.date, rate: 1 / last.krwPerUsd } };
}

// ── 입력 환산 ─────────────────────────────────────────────────────────

const isPerShareLine = (l: KrFactLine) =>
  (l.accountIds.length ? l.accountIds : [l.accountId]).some((id) => /PerShare/i.test(id)) || /주당/.test(l.accountName);

function periodSpan(p: KrPeriod): [string, string] {
  if (p.kind === "quarter" && p.quarter)
    return [`${p.year}-${String(p.quarter * 3 - 2).padStart(2, "0")}-01`, p.endDate];
  return [`${p.year}-01-01`, p.endDate];
}

/** DART facts → USD·ADR 1주 기준. 흐름(IS·CIS·CF)은 기간 평균, 잔액(BS)은 기말 환율. */
function convertFacts(f: KrFacts, fx: KrwFx, k: number): KrFacts {
  const conv = (l: KrFactLine, v: number, start: string, end: string): number | null => {
    const r = l.sjDiv === "BS" ? fx.at(end) : fx.avg(start, end);
    if (r == null) return null;
    return isPerShareLine(l) ? v * r * k : v * r;
  };
  const spans = new Map(f.periods.map((p) => [p.label, periodSpan(p)]));
  const lineMap = new Map<KrFactLine, KrFactLine>();
  const lines = f.lines.map((l) => {
    const byPeriod = new Map<string, number>();
    for (const [label, v] of l.byPeriod) {
      const sp = spans.get(label);
      const c = sp ? conv(l, v, sp[0], sp[1]) : null;
      if (c != null) byPeriod.set(label, c);
    }
    const nl: KrFactLine = { ...l, accountIds: [...l.accountIds], byPeriod };
    lineMap.set(l, nl);
    return nl;
  });
  const remap = (m: Map<string, KrFactLine>) => new Map([...m].map(([key, l]) => [key, lineMap.get(l) ?? l]));
  const lineByKey = new Map(f.lines.map((l) => [l.key, l]));
  const annual = new Map<string, Map<number, number>>();
  for (const [key, s] of f.annual) {
    const l = lineByKey.get(key);
    if (!l) continue; // 판정할 수 없는 계정은 버린다(원화 값이 섞이지 않게)
    const m = new Map<number, number>();
    for (const [y, v] of s) {
      const c = conv(l, v, `${y}-01-01`, f.annualEndByYear.get(y) ?? `${y}-12-31`);
      if (c != null) m.set(y, c);
    }
    annual.set(key, m);
  }
  return { ...f, lines, byId: remap(f.byId), byName: remap(f.byName), annual };
}

/**
 * KRX 연말 시가총액·종가 → 결산일 환율. 보통주 시가총액은 결산일 유통주식수(자사주 제외) × KRX 종가로 다시 낸다
 * (outstanding 연도 → 보통주 수). 유통주식수가 없는 해는 비운다(상장주식수로 대체하지 않음). 현재 보통주 시가총액은
 * 비운다 — 현재/LTM 은 ADR 현재가 × 유통주식수(호출부)만 쓴다.
 */
function convertCaps(c: KrCaps | null, fx: KrwFx, k: number, outstanding: Map<number, number>): KrCaps | null {
  if (!c) return null;
  const byYear: KrCaps["byYear"] = new Map();
  for (const [y, v] of c.byYear) {
    const r = fx.at(`${y}-12-31`);
    if (r == null) continue;
    byYear.set(y, {
      common: outstanding.get(y) != null && v.close != null ? outstanding.get(y)! * v.close * r : null,
      preferred: v.preferred * r,
      close: v.close == null ? null : v.close * r * k,
    });
  }
  const rn = fx.now.rate;
  return {
    ...c,
    byYear,
    current: c.current
      ? { common: null, preferred: c.current.preferred * rn }
      : null,
  };
}

/** 원화 보통주 가격 → ADR 1주 USD 가격(그날 환율) */
function convertBars(bars: QuoteBar[], fx: KrwFx, k: number): QuoteBar[] {
  const out: QuoteBar[] = [];
  for (const b of bars) {
    const r = fx.at(b.date);
    if (r == null) continue;
    const m = (v: number | null) => (v == null ? null : v * r * k);
    out.push({ ...b, open: m(b.open), high: m(b.high), low: m(b.low), close: m(b.close) });
  }
  return out;
}

/**
 * 감가상각비 주석(daDoc) → USD. 연간 facts 가 있으면 한국 함수(daAndAmortSeries)로 **원화** 연도별
 * 값(주석 실측 + 나머지 연도 근사)을 먼저 확정한 뒤 연도 평균 환율로 바꿔 전 연도를 넘긴다 — 근사
 * 연도의 비율 스케일·롤포워드를 USD 재무상태표(기말 환율)로 다시 계산하면 "원화 값 × 그 해 평균 환율"과
 * 달라진다(실측: FY2021 EBITDA 1.0% 차이). TTM 필드는 버린다 — LTM 은 dartAdrTtm 의 구성 기간 환산값으로
 * 호출하는 쪽이 채운다.
 */
function convertDaDoc(d: KrDaInput | null, fx: KrwFx, krwAnnual: KrFacts | null): KrDaInput | null {
  const yearly = krwAnnual?.mode === "annual" ? daAndAmortSeries(krwAnnual, d).byYear : null;
  if (!d && !yearly) return null;
  const byYear: NonNullable<KrDaInput["byYear"]> = {};
  const m = (v: number | null | undefined, r: number) => (v == null ? null : v * r);
  const years = yearly ? [...yearly.keys()].map(String) : Object.keys(d?.byYear ?? {});
  for (const y of years) {
    const r = fx.avg(`${y}-01-01`, `${y}-12-31`);
    if (r == null) continue;
    const note = d?.byYear?.[y];
    // 주석 실측 연도는 감가상각·무형상각 구분을 유지, 근사 연도는 합계를 감가상각비 칸에
    byYear[y] = note && (note.depreciation != null || note.amortisation != null)
      ? { depreciation: m(note.depreciation, r), amortisation: m(note.amortisation, r) }
      : { depreciation: m(yearly?.get(Number(y)), r), amortisation: null };
  }
  return { byYear };
}

/**
 * 구성 기간별 평균 환율로 바꿔 더한다. 한 기간이라도 환율이 없거나, 구성 합이 원화 TTM 값과
 * 다르면(구성 정보 누락) null — 다른 정의의 값을 대신 내지 않는다.
 */
function convertParts(krw: number | null | undefined, parts: KrTtmPart[] | undefined, fx: KrwFx, k = 1): number | null {
  if (krw == null || !parts?.length) return null;
  const total = parts.reduce((a, p) => a + p.v, 0);
  if (Math.abs(total - krw) > Math.max(1e-6, Math.abs(krw) * 1e-9)) return null;
  let sum = 0;
  for (const p of parts) {
    const r = fx.avg(p.start, p.end);
    if (r == null) return null;
    sum += p.v * r * k;
  }
  return sum;
}

/** 서술 문구 — 화면 주석·출처 */
function fxNote(spec: DartAdrSpec, fx: KrwFx): string {
  return (
    `DART 연결 ADR: ${spec.krCode} OpenDART 재무를 USD 환산(손익·현금흐름·주당이익 = 기간 평균 환율, ` +
    `재무상태표·연말 시가총액 = 결산일(마지막 거래일) 환율, LTM = 분기별 평균 환율 합; 한국은행 ECOS 매매기준율 평균·종가(15:30); 현재 ${fx.now.date} ${Number(fx.now.rate.toPrecision(5))}) · ` +
    `주당 값은 ADR 1주(보통주 ${spec.sharesPerAdr}주) 기준`
  );
}

function asUsStatement(st: FinancialStatement, symbol: string, spec: DartAdrSpec): FinancialStatement {
  return {
    ...st,
    symbol,
    market: "us",
    unit: "USD",
    currency: "USD",
    source: `${st.source} · ${spec.krCode} DART → USD 환산(ADR 1주 = 보통주 ${spec.sharesPerAdr}주)`,
  };
}

// ── 공개 함수 ─────────────────────────────────────────────────────────

type Spec = DartAdrSpec & { symbol: string };

/** 기준일(분기말·결산일)의 보통주 유통주식수(자사주 제외) — 그 날짜 보고서의 주식총수 현황 */
async function distributedSharesAt(corpCode: string, date: string | null): Promise<number | null> {
  if (!date) return null;
  const reprt = { "03-31": "11013", "06-30": "11012", "09-30": "11014", "12-31": "11011" }[date.slice(5)];
  if (!reprt) return null;
  const r = await fetchKrDistributedShares(corpCode, Number(date.slice(0, 4)), reprt);
  return r && r.date === date ? r.shares : null;
}

/** 사업연도말 유통주식수(보통주 수) — 연도 → 주식수. 없는 해는 빠진다 */
async function outstandingByYearEnd(corpCode: string, years: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  await Promise.all(
    years.map(async (y) => {
      const v = await distributedSharesAt(corpCode, `${y}-12-31`).catch(() => null);
      if (v != null) out.set(y, v);
    }),
  );
  return out;
}

/** getTtm 대응 — 한국 TTM(구성 기간별)·LTM 재무상태표를 USD·ADR 기준으로 */
export async function dartAdrTtm(spec: Spec): Promise<TtmFlows | null> {
  const { corpCode } = resolveCorpCode("", spec.krCode);
  const [detail, fx, dps, dpsTtm] = await Promise.all([
    loadKrTtmDetail(spec.krCode),
    krwFx(),
    fetchKrDps(corpCode).catch(() => null),
    getKrJurirNo(spec.krCode).then((c) => fetchKrAnnualDps(c)).catch(() => null),
  ]);
  if (!detail) return null;
  const k = spec.sharesPerAdr;
  const t = detail.ttm;
  // BPS 분모 — 자본 기준일의 자사주 제외 유통주식수(시가총액 주식수와 별개, 오너 결정 2026-09-25)
  const bookCommon = await distributedSharesAt(corpCode, detail.equityEnd).catch(() => null);
  // LTM 방식 표기 — 구성 기간이 모두 분기면 분기별 평균 환율 합, 아니면(분기 분해 불가) 구성 기간 평균 환율
  const quarterly = (detail.parts.revenue ?? []).length === 4 && (detail.parts.revenue ?? []).every((p) => (Date.parse(p.end) - Date.parse(p.start)) / 864e5 < 100);
  const s = t.snapshot ?? null;
  const rb = detail.bridgeEnd ? fx.at(detail.bridgeEnd) : null;
  const re = detail.equityEnd ? fx.at(detail.equityEnd) : null;
  const mb = (v: number | null | undefined) => (v == null || rb == null ? null : v * rb);
  const b = s?.evBridge ?? null;

  // 배당 — 최근 사업연도 DPS(기간 평균) · 최근 12개월 DPS(배당기준일 구간 평균)
  const lastDpsYear = dps ? [...dps.dpsByYear.keys()].sort((a, c) => a - c).at(-1) : undefined;
  const dpsA = lastDpsYear != null ? dps!.dpsByYear.get(lastDpsYear)! : null;
  const rA = lastDpsYear != null ? fx.avg(`${lastDpsYear}-01-01`, `${lastDpsYear}-12-31`) : null;
  const tt = dpsTtm?.ttm ?? null;
  const rT = tt ? (fx.avg(tt.from, tt.to) ?? fx.at(tt.to)) : null;

  return {
    periodLabel: quarterly
      ? `${detail.parts.revenue![0].start} ~ ${detail.parts.revenue![3].end} 최근 4개 분기 · USD 환산(분기마다 그 분기 평균 환율)`
      : `${t.periodLabel} · USD 환산(구성 기간 평균 환율 — 분기 분해 불가)`,
    revenue: convertParts(t.revenue, detail.parts.revenue, fx),
    opIncome: convertParts(t.opIncome, detail.parts.opIncome, fx),
    netIncome: convertParts(t.netIncome, detail.parts.netIncome, fx),
    eps: convertParts(t.eps, detail.parts.eps, fx, k),
    daTtm: convertParts(t.daTtm, detail.parts.daTtm, fx),
    snapshot: s
      ? {
          label: s.label,
          equity: s.equity == null || re == null ? null : s.equity * re,
          liabilities: null,
          cash: mb(s.cash),
          shares: null,
          evNetDebt: mb(s.evNetDebt),
          evBlocker: s.evBlocker ?? null,
          // 시가총액용 주식수 = BPS 와 같은 유통주식수(ADR 환산). 이미 ADR 기준이라 is20F 보정 없음
          evShares: bookCommon != null ? bookCommon / k : null,
          bookShares: bookCommon != null ? bookCommon / k : null,
          isReit: false,
          is20F: false,
          evPreferredMcap: s.evPreferredMcap == null ? null : s.evPreferredMcap * fx.now.rate,
          evBridge:
            b && rb != null
              ? { debt: b.debt * rb, lease: b.lease * rb, cash: b.cash * rb, nci: b.nci * rb, plainFinLiab: b.plainFinLiab }
              : null,
        }
      : null,
    dpsAnnual: dpsA != null && rA != null ? { dps: dpsA * rA * k, label: `FY${lastDpsYear}` } : null,
    dpsTtm: tt && rT != null ? { dps: tt.dps * rT * k, from: tt.from, to: tt.to } : null,
  };
}

/** adapter.getFinancials 대응 — 연간은 DART 원본 재무제표(계정명 그대로)를 환산, 분기는 표준화 총괄 */
export async function dartAdrFinancials(spec: Spec, periodType: "annual" | "quarter"): Promise<FinancialStatement> {
  const fx = await krwFx();
  const k = spec.sharesPerAdr;
  if (periodType === "quarter") {
    const { corpCode } = resolveCorpCode("", spec.krCode);
    const [facts, daDoc] = await Promise.all([fetchKrFacts(corpCode, "quarter"), getKrDaDoc(spec.krCode).catch(() => null)]);
    if (!facts) throw new AdapterError("분기 재무제표를 찾을 수 없습니다", { status: 404 });
    return asUsStatement(buildKrSummary(convertFacts(facts, fx, k), convertDaDoc(daDoc, fx, null)), spec.symbol, spec);
  }
  const st = await krOpenDartAdapter.getFinancials(spec.krCode, "annual");
  const sections = st.sections.map((sec) => {
    const bs = sec.title === "재무상태표";
    return {
      ...sec,
      items: sec.items.map((it) => {
        const perShare = /주당/.test(it.accountName);
        const values: Record<string, number | null> = {};
        for (const p of st.periods) {
          const v = it.values[p.label];
          const end = p.endDate ?? `${p.fiscalYear}-12-31`;
          const r = bs ? fx.at(end) : fx.avg(`${p.fiscalYear}-01-01`, end);
          values[p.label] = v == null || r == null ? null : v * r * (perShare ? k : 1);
        }
        return { ...it, values };
      }),
    };
  });
  return asUsStatement({ ...st, sections }, spec.symbol, spec);
}

/** 상세 재분류 뷰(is·bs·cf·summary) — 한국 빌더에 환산 facts 를 넣는다 */
export async function dartAdrDetail(
  spec: Spec,
  view: "is" | "bs" | "cf" | "summary",
  period: "annual" | "quarter",
): Promise<FinancialStatement> {
  const { corpCode } = resolveCorpCode("", spec.krCode);
  const [factsKrw, daDoc, fx] = await Promise.all([
    fetchKrFacts(corpCode, period),
    view === "is" || view === "summary" ? getKrDaDoc(spec.krCode).catch(() => null) : Promise.resolve(null),
    krwFx(),
  ]);
  if (!factsKrw) throw new AdapterError("재무제표를 찾을 수 없습니다", { status: 404 });
  const k = spec.sharesPerAdr;
  const facts = convertFacts(factsKrw, fx, k);
  const da = convertDaDoc(daDoc, fx, period === "annual" ? factsKrw : null);
  const st =
    view === "cf" ? buildKrCashFlow(facts) : view === "is" ? buildKrIncome(facts, da) : view === "bs" ? buildKrBalance(facts) : buildKrSummary(facts, da);
  return asUsStatement(st, spec.symbol, spec);
}

/** 하이라이트·재무분석 공통 입력 — 한국 라우트와 같은 원천을 모아 USD·ADR 기준으로 */
async function loadValuationInputs(spec: Spec, yahoo: string | null) {
  const { corpCode } = resolveCorpCode("", spec.krCode);
  const k = spec.sharesPerAdr;
  const [factsKrw, dps, barsKrw, ttm, dpsTtm, daDoc, adrQuote, estimatesRaw, fx] = await Promise.all([
    fetchKrFacts(corpCode, "annual"),
    fetchKrDps(corpCode),
    fetchStooqEod("kr", spec.krCode, { from: `${new Date().getFullYear() - 6}-01-01` }).catch(() => [] as QuoteBar[]),
    dartAdrTtm(spec).catch(() => null),
    getKrJurirNo(spec.krCode)
      .then((crno) => fetchKrAnnualDps(crno))
      .catch(() => null),
    getKrDaDoc(spec.krCode).catch(() => null),
    // 현재가 = ADR 시세(미국 화면 공통 시세 함수)
    getEodQuote("us", spec.symbol, { yahooOverride: yahoo }).catch(() => null),
    fetchYahooEstimates("us", spec.symbol, yahoo).catch(() => null),
    krwFx(),
  ]);
  if (!factsKrw) return null;
  // 회계연도말 종가 — Stooq 커버리지가 부족하면 KRX 로 개별 조회(한국 라우트와 같다)
  const fyCloseKrw = new Map<number, number>();
  const needYears = factsKrw.periods
    .map((p) => p.year)
    .filter((y) => !barsKrw.some((b) => b.date <= `${y}-12-31` && b.date >= `${y}-11-01` && b.close != null));
  await Promise.all(
    needYears.map(async (y) => {
      const c = await fetchKrxCloseOn(spec.krCode, `${y}1231`).catch(() => null);
      if (c != null) fyCloseKrw.set(y, c);
    }),
  );
  const years = factsKrw.periods.map((p) => p.year);
  const [capsKrw, outstanding] = await Promise.all([
    loadKrCaps(spec.krCode, years).catch(() => null),
    outstandingByYearEnd(corpCode, years),
  ]);

  const facts = convertFacts(factsKrw, fx, k);
  const fyCloseByYear = new Map<number, number>();
  for (const [y, c] of fyCloseKrw) {
    const r = fx.at(`${y}-12-31`);
    if (r != null) fyCloseByYear.set(y, c * r * k);
  }
  // 가격 시계열 — ADR 상장 전은 KRX 종가 환산, 상장 후는 ADR 시세
  const adrBars = adrQuote?.bars ?? [];
  const firstAdr = adrBars[0]?.date ?? "9999-12-31";
  const bars = [...convertBars(barsKrw, fx, k).filter((b) => b.date < firstAdr), ...adrBars];
  // 현재 주식수 = LTM 자본 기준일의 유통주식수(dartAdrTtm 스냅샷 — BPS 와 같은 값)
  const adrShares = ttm?.snapshot?.bookShares ?? null;
  const price = adrQuote?.last ?? null;
  const tt = dpsTtm?.ttm ?? null;
  const rT = tt ? (fx.avg(tt.from, tt.to) ?? fx.at(tt.to)) : null;
  const dpsByYear = new Map<number, number>();
  for (const [y, v] of dps.dpsByYear) {
    const r = fx.avg(`${y}-01-01`, `${y}-12-31`);
    if (r != null) dpsByYear.set(y, v * r * k);
  }
  const estimates = estimatesRaw
    ? await dartAdrEstimatesToUsd(spec, estimatesRaw, fx).catch(() => null)
    : null;
  return {
    facts,
    fx,
    caps: convertCaps(capsKrw, fx, k, outstanding),
    bars,
    fyCloseByYear,
    adrShares,
    price,
    currentMarketCap: price != null && adrShares != null ? price * adrShares : null,
    ttm,
    dpsByYear,
    payoutByYear: dps.payoutByYear,
    dpsTtm: tt && rT != null ? tt.dps * rT * k : null,
    daDoc: (() => {
      const conv = convertDaDoc(daDoc, fx, factsKrw);
      // 주석 TTM 이 있으면 LTM 감가상각비 = dartAdrTtm 의 구성 기간 환산값(원화 경로와 같은 값의 환산)
      if (conv && daDoc?.ttmDepreciation != null && ttm?.daTtm != null) Object.assign(conv, { ttmDepreciation: ttm.daTtm, ttmAmortisation: 0 });
      return conv;
    })(),
    estimates,
    estimatesFailed: Boolean(estimatesRaw && !estimates),
  };
}

/** 재무 하이라이트 — 한국 빌더(buildKrHighlights)에 환산 입력을 넣고 통화 표기만 바꾼다 */
export async function dartAdrHighlights(spec: Spec, yahoo: string | null): Promise<FinancialHighlights | null> {
  const x = await loadValuationInputs(spec, yahoo);
  if (!x) return null;
  const lastFy = x.facts.periods.at(-1)?.year ?? 0;
  // 추정 1개년 — Yahoo ADR 예상치(estimatesToUsd: 매출 원화 → 현재 환율, EPS 는 이미 ADR 1주당 USD)
  const est = (x.estimates?.periods ?? []).find(
    (p) => (p.period === "0y" || p.period === "+1y") && p.endDate && Number(p.endDate.slice(0, 4)) > lastFy,
  );
  const hl = buildKrHighlights({
    code: spec.krCode,
    caps: x.caps,
    facts: x.facts,
    bars: x.bars,
    fyCloseByYear: x.fyCloseByYear,
    sharesOutstanding: x.adrShares,
    currentMarketCap: x.currentMarketCap,
    currentPrice: x.price,
    ttm: x.ttm,
    dpsByYear: x.dpsByYear,
    payoutByYear: x.payoutByYear,
    dpsTtm: x.dpsTtm,
    daDoc: x.daDoc,
    consensus: est
      ? {
          estYear: Number(est.endDate!.slice(0, 4)),
          // 빌더는 네이버 표시 단위(억)를 받는다 — USD 를 1e8 로 나눠 넘기면 빌더가 다시 곱한다
          estRevenue: est.revenueAvg == null ? null : est.revenueAvg / 1e8,
          estOpIncome: null,
          estNetIncome: null,
          estEps: est.epsAvg,
          estPer: null,
          estPbr: null,
        }
      : null,
  });
  const notes = hl.notes.map((n) =>
    n.startsWith("시가총액: KRX")
      ? `시가총액: 연도 열 = 결산일 유통주식수(자사주 제외, DART 주식총수 현황) × 결산일 KRX 종가 × 결산일 환율, 현재/LTM = ADR 현재가 × 유통주식수(${x.ttm?.snapshot?.label ?? "최근 분기말"} 기준, ADR 환산 ÷ ${spec.sharesPerAdr}) — BPS 와 같은 주식수`
      : n,
  );
  notes.unshift(fxNote(spec, x.fx));
  if (est) notes.push(x.estimates?.fxNote ?? "예상: Yahoo ADR 컨센서스");
  if (x.estimatesFailed) notes.push("외화 예상치 환산 실패 — 예상치 숨김");
  return { ...hl, currency: "USD", unitLabel: "USD 백만", notes, source: `${hl.source} · USD 환산` };
}

/** 재무분석 — 한국 빌더(buildKrAnalysis)에 환산 입력 */
export async function dartAdrAnalysis(spec: Spec, yahoo: string | null): Promise<FinancialStatement> {
  const x = await loadValuationInputs(spec, yahoo);
  if (!x) throw new AdapterError("재무제표를 찾을 수 없습니다", { status: 404 });
  const st = buildKrAnalysis({
    code: spec.krCode,
    caps: x.caps,
    facts: x.facts,
    bars: x.bars,
    fyCloseByYear: x.fyCloseByYear,
    sharesOutstanding: x.adrShares,
    currentPrice: x.price,
    currentMarketCap: x.currentMarketCap,
    ttm: x.ttm,
    daDoc: x.daDoc,
  });
  return asUsStatement(st, spec.symbol, spec);
}

/**
 * 컨센서스(consensus.ts) 한국 경로 입력 — 연간 facts·연말 시가총액·감가상각비 주석을 USD·ADR 기준으로.
 * 주식수는 ADR 환산(BPS 분모), 예상치 환산용 통화 정보도 함께.
 */
export async function dartAdrConsensusInputs(spec: Spec, years: number[]) {
  const { corpCode } = resolveCorpCode("", spec.krCode);
  const k = spec.sharesPerAdr;
  const [factsKrw, daDoc, capsKrw, fx, outstanding] = await Promise.all([
    fetchKrFacts(corpCode, "annual"),
    getKrDaDoc(spec.krCode).catch(() => null),
    loadKrCaps(spec.krCode, years).catch(() => null),
    krwFx(),
    // BPS 분모·연말 시가총액 — 각 사업연도말 자사주 제외 유통주식수
    outstandingByYearEnd(corpCode, years),
  ]);
  if (!factsKrw) return null;
  const bookShares = new Map<number, number>();
  for (const [y, v] of outstanding) bookShares.set(y, v / k);
  const lastY = [...bookShares.keys()].sort((a, b) => a - b).at(-1);
  return {
    code: spec.krCode,
    facts: convertFacts(factsKrw, fx, k),
    daDoc: convertDaDoc(daDoc, fx, factsKrw),
    caps: convertCaps(capsKrw, fx, k, outstanding),
    // 연말 시가총액 대체 계산(caps 없는 해)용 — 최근 결산일 유통주식수
    adrShares: lastY != null ? bookShares.get(lastY)! : null,
    bookShares,
  };
}

/** Yahoo ADR 예상치 → USD(estimatesToUsd 규칙: 매출 원화 → 현재 환율, EPS 는 이미 ADR 1주당 USD). 현재 환율도 ECOS */
export async function dartAdrEstimatesToUsd<T extends Parameters<typeof estimatesToUsd>[0]>(
  spec: DartAdrSpec,
  est: T,
  fx?: { now: { date: string; rate: number } },
) {
  const now = (fx ?? (await krwFx())).now;
  return estimatesToUsd(est, { reportingCurrency: "KRW", adrRatio: spec.sharesPerAdr }, { ...now, source: "ECOS 종가" });
}
