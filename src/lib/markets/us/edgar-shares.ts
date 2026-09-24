import "server-only";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import {
  ANNUAL_FORMS,
  entriesOf,
  isFullYearDuration,
  splitFactorsByYear, fiscalYearOf } from "./edgar-series";
import {
  classALatest,
  classAOutstanding,
  classAOutstandingLatest,
  classAShares,
  classAsConverted,
  type ClassAFacts,
} from "./edgar-classfacts";
import { adrRatio } from "../adr";
import { SYN_EQUITY_SHARES } from "./edgar-equity-shares";
import type { EodQuote, QuoteBar } from "../types";

/**
 * 미국 종목 **발행주식수 단일 기준**.
 *
 * 왜 따로 뺐나 — 같은 회사의 PBR·PSR·EV/EBITDA 가 화면마다 달랐다(오너 지적
 * 2026-09-23 — "wmt 재무하이라이트 랑 재무분석의 pbr psr ev/ebitda가 다 다르다",
 * "per는 동일하다"). 원인 두 가지:
 *
 * 1. **주식수 소스 우선순위가 모듈마다 달랐다.** edgar-analysis 는
 *    `CommonStockSharesOutstanding → 공통 체인`, edgar-highlights 는
 *    `CommonStockSharesOutstanding → classA → DEI 표지 → 가중평균` 순으로,
 *    같은 회계연도에 서로 다른 값을 집었다.
 * 2. **시가총액에서 액면분할 기준이 어긋났다.** 시세(Stooq·Yahoo)는 분할
 *    소급 반영된 가격인데 공시 주식수는 그 시점의 as-reported 값이라,
 *    분할 전 연도의 시가총액이 분할배수만큼 틀렸다. PER 은 분자·분모가 같이
 *    보정돼 멀쩡했고(그래서 "per는 동일"), PBR·PSR·EV 만 틀어졌다.
 *    실측(WMT, 2024-02 3:1 분할): FY2024 시가총액이 1,483억 달러로 나왔으나
 *    실제는 약 4,400억 달러.
 *
 * 해결 — 분할 보정된 가격에 맞추려면 주식수도 같은 기준으로 환산해야 한다.
 * `splitFactorsByYear()` 가 주당 지표를 현재 기준으로 바꾸는 계수 f 를 주므로
 * (3:1 분할이면 분할 전 연도 f = 1/3), 주식수는 **반대로 나눈다**:
 *   `shares_현재기준 = shares_asReported / f`
 * 그러면 `분할보정가격 × shares_현재기준 = 실제 그 시점 시가총액` 으로
 * 분할에 불변이 된다.
 *
 * 소스 우선순위도 여기서 한 곳으로 고정한다. **DEI 표지 주식수는 맨 뒤**다 —
 * 그 값은 회계연도말이 아니라 **제출일 기준**이라, 결산 후 분할이 있었던
 * 연도(WMT FY2024)에는 이미 분할이 반영된 수치가 들어와 위 환산을 이중으로
 * 적용하게 된다.
 */

/** 시점 값이 기준일보다 이만큼 오래되면 안 쓴다(일). */
const MAX_STALE_DAYS = 550;

function instantAtOrBefore(
  entries: FactUnitEntry[],
  asOf: string,
  maxStaleDays = MAX_STALE_DAYS,
): number | null {
  let best: { val: number; end: string; filed: string } | null = null;
  for (const e of entries) {
    if (e.start) continue; // duration 제외 — 시점(instant) 값만
    if (e.val == null || !e.end || e.end > asOf) continue;
    const stale = (Date.parse(asOf) - Date.parse(e.end)) / 86_400_000;
    if (!Number.isFinite(stale) || stale > maxStaleDays) continue;
    const filed = e.filed ?? "";
    if (!best || e.end > best.end || (e.end === best.end && filed >= best.filed))
      best = { val: e.val, end: e.end, filed };
  }
  return best?.val ?? null;
}

function latestInstantOf(entries: FactUnitEntry[]): number | null {
  let best: { val: number; end: string } | null = null;
  for (const e of entries) {
    if (e.start || e.val == null || !e.end) continue;
    if (!best || e.end > best.end) best = { val: e.val, end: e.end };
  }
  return best?.val ?? null;
}

/** 사업연도(10-K, 온전한 1년) 항목만 — 분기(10-Q) 값이 섞이면 분할 기준
 * 판정이 어긋난다(실측: WMT FY2022 칸에 분할 전 10-Q 가중평균이 잡혔다). */
function isAnnual(e: FactUnitEntry): boolean {
  return (
    Boolean(e.start) &&
    e.fp === "FY" &&
    ANNUAL_FORMS.includes(e.form) &&
    isFullYearDuration(e)
  );
}

function annualOf(entries: FactUnitEntry[], year: number): number | null {
  let best: { val: number; end: string; filed: string } | null = null;
  for (const e of entries) {
    if (!isAnnual(e) || e.val == null) continue;
    if (fiscalYearOf(e.end) !== year) continue;
    const filed = e.filed ?? "";
    if (!best || e.end > best.end || (e.end === best.end && filed >= best.filed))
      best = { val: e.val, end: e.end, filed };
  }
  return best?.val ?? null;
}

function latestAnnualOf(entries: FactUnitEntry[]): number | null {
  let best: { val: number; end: string } | null = null;
  for (const e of entries) {
    if (!isAnnual(e) || e.val == null) continue;
    if (!best || e.end > best.end) best = { val: e.val, end: e.end };
  }
  return best?.val ?? null;
}

/**
 * 공시 단위 오류 보정 — 회사가 주식수를 "백만 주"·"천 주" 단위 숫자로 잘못
 * 태깅하는 경우가 있다(실측 2026-09-23: MCD 가 가중평균 희석주식수를 7억 1,640만
 * 주가 아니라 `716.4` 로 태깅). 기준값(ref)과의 비율이 정확히 1,000배·1,000,000배
 * (±50%) 근처면 그만큼 곱해 같은 단위로 맞춘다. 분할(최대 20:1 정도)로는 이런
 * 배수가 나오지 않으므로 분할 판정과 겹치지 않는다.
 */
function fixScale(v: number | null, ref: number | null): number | null {
  if (v == null || ref == null || v <= 0 || ref <= 0) return v;
  for (const k of [1e3, 1e6]) {
    const r = ref / v / k;
    if (r <= 1.5 && r >= 1 / 1.5) return v * k;
  }
  return v;
}

/**
 * **과거 시가총액·주당 비교용 가격 = 주식수와 같은 기준**(오너 승인 2026-09-24).
 *
 * 과거 결산일 가격은 Yahoo 종가(분할 소급 조정)이고, 주식수는 as-reported ÷ SEC 분할계수
 * (`splitFactorsByYear`, 가중평균주식수의 정수배 변화로 추정)다. Yahoo 는 **분사도 "분할"로 기록해** 이전 종가를
 * 나눠 두는데(WDC 2025-02-24 "1323:1000" 샌디스크 분사, GE 2023-01 GEHC 1.281·2024-04 GEV 1.253), 분사는 주식수가
 * 안 바뀌어 SEC 분할계수에 안 잡힌다 → "소급으로 깎인 가격 × 당시 실제 주식수"가 돼 WDC FY2022~2024 시가총액이
 * 인포맥스의 정확히 1/1.323 이었다(실측: 되돌린 종가 43.42·37.93·75.77 × 315·322·343백만 주 = 인포맥스 시총).
 *
 * 그래서 Yahoo 분할 이력 중 **SEC 주식수로 확인되지 않는 것만** 가격에서 되돌린다. 확인 = 분할일 직전·직후 공시
 * 표지 주식수(DEI, 제출 시점 as-of 값이라 소급 재작성이 없다)의 비율이 1 보다 분할비율에 가깝다. 앞뒤 표지가
 * 없으면 확인 불가로 보고 손대지 않는다(종전 동작). 실제 분할(NVDA 10:1·CMG 50:1·WMT 3:1 등)은 표지 주식수가
 * 그 배수로 바뀌므로 그대로 남는다. 20-F ADR 은 ADR 비율 변경이 "분할"로 기록될 수 있어(보통주 수는 불변) 제외.
 * 가격만 바꾸므로 PER·PBR·시가총액·EV·배당수익률이 함께 일관되게 바뀐다.
 */
const SPLIT_CONFIRM_WINDOW_DAYS = 200;

export function secBasisBars(facts: CompanyFacts, quote: EodQuote | null | undefined): QuoteBar[] {
  const bars = quote?.bars ?? [];
  const splits = quote?.splits ?? [];
  if (!bars.length || !splits.length) return bars;
  const dei = ((facts.facts.dei?.["EntityCommonStockSharesOutstanding"]?.units?.shares ?? []) as FactUnitEntry[])
    .filter((e) => !e.start && e.val != null && e.val > 0 && e.end);
  const lastDei = dei.reduce<FactUnitEntry | null>((b, e) => (!b || e.end > b.end ? e : b), null);
  if (/^20-F/.test(lastDei?.form ?? "") || (facts.adrRatio ?? 1) !== 1) return bars;
  const win = SPLIT_CONFIRM_WINDOW_DAYS * 864e5;
  // 같은 기준일 값이 여럿이면(클래스별 표지) 최댓값 — 앞뒤를 같은 규칙으로 고른다
  const coverAt = (pickBefore: boolean, date: string): number | null => {
    let best: { end: string; val: number } | null = null;
    for (const e of dei) {
      const gap = Date.parse(e.end) - Date.parse(date);
      if (pickBefore ? !(gap < 0 && -gap <= win) : !(gap >= 0 && gap <= win)) continue;
      if (!best || (pickBefore ? e.end > best.end : e.end < best.end) || (e.end === best.end && e.val > best.val))
        best = { end: e.end, val: e.val };
    }
    return best?.val ?? null;
  };
  const undo = splits.filter((s) => {
    if (!(s.ratio > 0) || s.ratio === 1) return false;
    const before = coverAt(true, s.date), after = coverAt(false, s.date);
    if (before == null || after == null) return false;
    const r = Math.log(after / before);
    return Math.abs(r) < Math.abs(r - Math.log(s.ratio));
  });
  if (!undo.length) return bars;
  const k = (d: string) => undo.reduce((m, s) => (d < s.date ? m * s.ratio : m), 1);
  return bars.map((b) => {
    const f = k(b.date);
    if (f === 1) return b;
    const x = (v: number | null) => (v == null ? v : v * f);
    return { ...b, open: x(b.open), high: x(b.high), low: x(b.low), close: x(b.close) };
  });
}

export interface ShareResolver {
  /**
   * 회계연도말 발행주식수 — **현재(분할 반영) 기준**으로 환산된 값.
   * 분할 보정된 시세와 곱해야 그 시점의 실제 시가총액이 된다.
   */
  atFiscalYearEnd(year: number, endDate: string): number | null;
  /** 최근 발행주식수(현재 기준). */
  current(): number | null;
  /** 공시 주식수를 못 찾아 힌트(시총÷주가 등)로 대체한 적이 있는지. */
  usedHint(): boolean;
}

/** EDGAR 표지 기준일이 이보다 오래되면 Yahoo 현재 주식수를 채택한다(인포맥스 실패 시).
 *  분기 공시 간격(~91일)의 절반 — INTC 는 표지 07-17 뒤 08-12 증자. */
const YAHOO_AFTER_COVER_DAYS = 45;

export function buildShareResolver(
  facts: CompanyFacts,
  opts: { classFacts?: ClassAFacts | null; sharesHint?: number | null } = {},
): ShareResolver {
  const cf = opts.classFacts ?? null;
  const hint = opts.sharesHint ?? null;
  const sharesEnd = entriesOf(facts, "CommonStockSharesOutstanding", "shares");
  // 유통주식수 태그 없이 본표에 "발행주식수"·"자기주식수"만 적는 회사(KO·MCD·DAL·GLW·MDLZ 등) — 발행 − 자기주식이
  // 인포맥스(FactSet) 연말 주식수와 정확히 일치(검증 2026-09-24). 예전엔 표지(제출일 기준)·가중평균으로 근사했다.
  const issuedE = entriesOf(facts, "CommonStockSharesIssued", "shares");
  // 자본변동표에 유통주식수를 적는 회사(WMT — 본표 태그 없음)
  const equityStmtE = entriesOf(facts, "SharesOutstanding", "shares");
  // 자본변동표 보통주 차원 값(10-K 원본, edgar-equity-shares.ts) — 위 태그가 차원으로만 있는 회사(WMT·BE·META)
  const equityDimE = entriesOf(facts, SYN_EQUITY_SHARES, "shares");
  const treasuryE = [...entriesOf(facts, "TreasuryStockCommonShares", "shares"), ...entriesOf(facts, "TreasuryStockShares", "shares")];
  // 종업원 신탁 보유주(LLY 5,000만 주) — 발행주식이지만 유통주식·EPS 분모에서 빠진다(재감사 MEDIUM)
  const trustE = entriesOf(facts, "CommonStockSharesHeldInEmployeeTrustShares", "shares");
  const dei = (facts.facts.dei?.["EntityCommonStockSharesOutstanding"]?.units?.shares ??
    []) as FactUnitEntry[];
  const wavgDil = entriesOf(facts, "WeightedAverageNumberOfDilutedSharesOutstanding", "shares");
  const wavgBasic = entriesOf(facts, "WeightedAverageNumberOfSharesOutstandingBasic", "shares");
  const splitF = splitFactorsByYear(facts);
  let hintUsed = false;
  // 20-F ADR 비율(보통주 ÷ ADR) — 1 이 아니면 모든 주식수를 ADR 기준으로 환산
  const lastDei = dei.reduce<FactUnitEntry | null>((b, e) => (!b || e.end > b.end ? e : b), null);
  const adr = adrRatio(/^20-F/.test(lastDei?.form ?? ""), lastDei?.val, hint);

  return {
    atFiscalYearEnd(year, endDate) {
      // 결산일(±7일) 시점 값 — 대차대조표 본표 기준. 후보는 같은 해 가중평균 주식수와 1.2배 안일 때만 채택한다
      // (PEP 는 "발행주식수" 태그가 이미 자기주식을 뺀 순발행분이라 또 빼면 틀린다 — 가중평균과 어긋나 걸러짐)
      const atEnd = (es: FactUnitEntry[]): number | null => {
        let b: FactUnitEntry | null = null;
        for (const e of es) if (!e.start && e.val != null && e.end && Math.abs(Date.parse(e.end) - Date.parse(endDate)) <= 7 * 864e5 && (!b || (e.filed ?? "") > (b.filed ?? ""))) b = e;
        return b?.val ?? null;
      };
      const issued = atEnd(issuedE), treasury = atEnd(treasuryE), trust = atEnd(trustE) ?? 0;
      // 잣대도 후보마다 단위 오류 보정 — MCD 는 가중평균을 7.164억 주가 아니라 716.4 로 태깅했다
      // 잣대는 기본 가중평균 우선 — 희석 가중평균은 전환사채 희석이 큰 해에 본표 주식수와 10% 넘게 벌어져 정답 후보가
      // 탈락했다(TSLA FY2020: 희석 32.49억 ÷ (본표 9.6억 × 3) = 1.128 → 가중평균 근사, 기본 27.98억이면 0.97)
      const refRaw = annualOf(wavgBasic, year) ?? annualOf(wavgDil, year);
      const near = (v: number | null) => {
        if (v == null || v <= 0) return false;
        const ref = fixScale(refRaw, v);
        if (ref == null) return true;
        const k = ref / v;
        // 가중평균이 분할로 소급 수정되고 본표 주식수는 그대로인 해(WMT FY2022·2023, 2024 3:1 분할)도 후보로 인정
        const kk = Math.round(k);
        return (k <= 1.2 && k >= 1 / 1.2) || (kk >= 2 && Math.abs(k / kk - 1) < 0.1);
      };
      // 발행주식수만 있는 경우(자기주식 태그 없음)는 가중평균과 10% 안일 때만 — 넓은 허용치로는 신탁·자기주식이 섞인
      // 발행주식수가 그대로 채택된다(재감사 MEDIUM)
      const nearTight = (v: number | null) => {
        if (v == null || v <= 0) return false;
        const ref = fixScale(refRaw, v);
        return ref != null && Math.abs(ref / v - 1) <= 0.1;
      };
      const issuedOnly = issued != null ? issued - trust : null;
      // 보통주를 클래스별로만 공시하고 클래스 간 전환비율이 있는 종목(Visa) — 10-K 의 전환 기준(as-converted) 보통주
      // 합계가 결산일 주식수다(edgar-classfacts.ts). 발행 주수 단순 합(B·C 과소 반영)·가중평균 근사보다 앞선다.
      const asConverted = classAsConverted(cf, year);
      const bsFace = asConverted ?? [atEnd(sharesEnd), atEnd(equityStmtE), atEnd(equityDimE), issued != null && treasury != null ? issued - treasury - trust : null].find(near)
        ?? (nearTight(issuedOnly) ? issuedOnly : null);
      // as-reported(그 회계연도 시점) 값만 쓴다 — DEI 표지 주식수는 제출일
      // 기준이라 결산 후 분할이 있으면 기준이 어긋나므로 맨 뒤.
      const instant =
        bsFace ??
        instantAtOrBefore(sharesEnd, endDate) ??
        classAOutstanding(cf, year) ??
        instantAtOrBefore(dei, endDate);
      const wavg = fixScale(
        annualOf(wavgDil, year) ?? annualOf(wavgBasic, year) ?? classAShares(cf, year),
        instant,
      );

      // **분할 소급 재작성 범위는 계정마다 다르다.** 실측(WMT, 2024-02 3:1):
      // 가중평균주식수는 FY2022 까지 소급 재작성돼 있는데(2.85억→8.42억 주로
      // 점프하는 경계가 FY2021/FY2022 사이) 기말 발행주식수는 FY2023 까지만
      // 재작성돼 있었다. 그래서 "가중평균 계열에서 뽑은 분할계수"를 기말
      // 발행주식수에 그대로 적용하면 FY2022 만 3배 어긋난다.
      //
      // 두 계열이 같은 기준인지 스스로 검증한다 — 같은 해 기말/가중평균이
      // 1.5배 넘게 벌어지면 분할 기준이 서로 다른 것이므로, 분할계수가
      // 유도된 바로 그 계열(가중평균)을 쓴다. 자사주 매입·증자로 생기는
      // 정상적인 차이는 이 배수를 넘지 않는다.
      const sameBasis =
        instant != null && wavg != null && instant / wavg <= 1.5 && instant / wavg >= 1 / 1.5;
      // 두 계열 비율이 정수 분할배수(±10%)면 연말 주식수를 가중평균 기준으로 환산해 쓴다 — 가중평균 자체를 쓰면 연중
      // 평균이라 연말 시가총액이 어긋난다(WMT FY2022: 가중평균 84.15억 vs 연말 27.61억×3 = 82.83억, 인포맥스와 일치)
      // 배수는 같은 연도 가중평균의 원공시 ÷ 분할 소급 재작성 공시 비율(= 실제 분할배수)을 우선한다. round(가중평균 ÷
      // 연말)은 배수가 크면 연중 자사주 매입 차이만으로 한 칸 틀린다 — CMG 2022(50:1): 14.03억 ÷ 2,762.7만 = 50.79 → 51
      // 로 연말 주식수가 2% 부풀었다(원공시 2,806.2만 → 재작성 14.03억 = 정확히 50).
      const wavgSrc = annualOf(wavgDil, year) != null ? wavgDil : wavgBasic;
      const fyW = wavgSrc.filter((e) => isAnnual(e) && e.val > 0 && fiscalYearOf(e.end) === year);
      const oldest = fyW.reduce<FactUnitEntry | null>((b, e) => (!b || (e.filed ?? "") < (b.filed ?? "") ? e : b), null);
      const restateR = oldest && wavg != null ? wavg / fixScale(oldest.val, wavg)! : 0;
      const restateK = Math.round(restateR) >= 2 && Math.abs(restateR / Math.round(restateR) - 1) < 0.01 ? Math.round(restateR) : 0;
      // 분할 배수 검사 잣대도 기본 가중평균 우선(위 refRaw 와 같은 이유 — TSLA FY2020 희석 1.128 vs 기본 0.97)
      const refW = fixScale(refRaw, instant) ?? wavg;
      const splitK = restateK || (instant != null && refW != null && instant > 0 ? Math.round(refW / instant) : 0);
      // 실제 분할 이력(가중평균 계열의 분할계수)이 있을 때만 — 없으면 우연한 정수배를 분할로 오인한다(재감사 LOW)
      const hasSplit = [...splitF.values()].some((v) => v != null && Math.abs(v - 1) > 0.01);
      const splitBasis = !sameBasis && hasSplit && splitK >= 2 && refW != null && Math.abs(refW / instant! / splitK - 1) < 0.1;
      const raw = sameBasis ? instant : splitBasis ? instant! * splitK : (wavg ?? instant);
      if (raw == null) {
        if (hint != null) hintUsed = true;
        return hint;
      }
      const f = splitF.get(year);
      return (f != null && f !== 0 ? raw / f : raw) / adr;
    },
    current() {
      // ADR 비율이 있는 20-F 기업은 Yahoo ADR 환산 주식수가 곧 현재 주식수
      if (adr !== 1) return hint;
      // 기준 검증용 잣대 — 최근 연간 가중평균주식수. 듀얼클래스 종목(Visa 등)
      // 은 DEI 표지 주식수가 클래스별 부분값만 잡히는 경우가 있어(실측:
      // Visa LTM 시가총액이 1,736억 달러로 실제의 1/3 수준으로 떨어짐)
      // 후보를 그대로 믿으면 안 된다. 잣대와 1.5배 넘게 벌어지는 후보는
      // 건너뛰고 다음 후보를 본다.
      const ref = fixScale(
        latestAnnualOf(wavgDil) ??
          latestAnnualOf(wavgBasic) ??
          classALatest(cf)?.dilShares ??
          classALatest(cf)?.basicShares ??
          null,
        latestInstantOf(dei) ?? latestInstantOf(sharesEnd),
      );
      const plausible = (v: number | null): v is number =>
        v != null && v > 0 && (ref == null || (v / ref <= 1.5 && v / ref >= 1 / 1.5));
      // 현재 주식수 보정(current-shares.ts, 오너 결정 2026-09-24) — 인포맥스는 그대로,
      // Yahoo 는 EDGAR 표지가 오래됐을 때만(표지 뒤 증자·자사주 반영용. Yahoo 는 옛 값이
      // 남는 경우가 있어 — MRVL +2.5% — 표지가 최근이면 EDGAR 를 믿는다).
      const cs = facts.currentShares ?? null;
      if (cs && plausible(cs.val)) {
        if (cs.source === "infomax") return cs.val;
        const coverEnd = lastDei?.end ?? null;
        const coverAgeDays = coverEnd ? (Date.now() - Date.parse(coverEnd)) / 86_400_000 : Infinity;
        if (coverAgeDays > YAHOO_AFTER_COVER_DAYS) return cs.val;
      }
      const candidates = [
        latestInstantOf(dei),
        latestInstantOf(sharesEnd),
        classAOutstandingLatest(cf),
        ref,
      ];
      for (const c of candidates) if (plausible(c)) return c;
      if (hint != null) {
        hintUsed = true;
        return hint;
      }
      return ref;
    },
    usedHint() {
      return hintUsed;
    },
  };
}
