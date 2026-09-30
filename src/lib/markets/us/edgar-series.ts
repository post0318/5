import "server-only";
import type { CompanyFacts, FactUnitEntry } from "./edgar";

/** EDGAR companyfacts 시계열 헬퍼 (상세 CF·IS 공용). */

export const ANNUAL_FORMS = ["10-K", "10-K/A", "20-F", "20-F/A"];
export const INTERIM_FORMS = ["10-Q", "10-Q/A"];
/** LTM 조합 전용 — 10-Q + 20-F 발행사 Yahoo 분기 LTM 합성 공시(edgar-yahoo-quarters.ts YAHOO_Q_FORM) */
const YAHOO_Q_FORM = "YAHOO-Q";
export const LTM_INTERIM_FORMS = [...INTERIM_FORMS, YAHOO_Q_FORM];

export function days(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}
export function shiftYear(iso: string, n: number): string {
  const [y, m, d] = iso.split("-");
  return `${Number(y) + n}-${m}-${d}`;
}

/**
 * 회사 재분류 1분기 규칙(recastFirstQuarter) 대상 밖 — 현금흐름표 개념(감가상각비 제외, 오너 결정 2026-09-29 "현금흐름표는 감가상각비"). 현금흐름표가
 * 누적만 싣는 회사는 2분기 3개월 값이 주석 표 값이라(주식보상비용 — GOOG·META·ISRG·MAR) 6개월 누적과 빼면 정의가 섞인다. 로더(edgar.ts)가 개념
 * 이름으로 배열에 표시하고(markNoRecast), 분기·LTM 함수가 배열만 보고 판정 — 화면마다 같은 판정.
 */
const NO_RECAST = new WeakSet<FactUnitEntry[]>();
const CF_NO_RECAST_RE = /^(NetCashProvidedBy|PaymentsTo|PaymentsFor|PaymentsOf|ProceedsFrom|RepaymentsOf|IncreaseDecrease|ShareBasedCompensation$|OtherNoncash|DeferredIncomeTaxExpenseBenefit$|DeferredIncomeTaxesAndTaxCredits$|CashCashEquivalents|EffectOfExchangeRate)/;
export function markNoRecast(facts: CompanyFacts): void {
  for (const [c, o] of Object.entries(facts.facts["us-gaap"] ?? {}))
    if (CF_NO_RECAST_RE.test(c)) for (const arr of Object.values(o.units ?? {})) NO_RECAST.add(arr);
}
/** 병합 배열 — 입력 중 하나라도 대상 밖이면 대상 밖 */
export function inheritNoRecast(out: FactUnitEntry[], srcs: FactUnitEntry[][]): FactUnitEntry[] {
  if (srcs.some((s) => NO_RECAST.has(s))) NO_RECAST.add(out);
  return out;
}
export function recastAllowed(entries: FactUnitEntry[]): boolean {
  return !NO_RECAST.has(entries);
}

export function entriesOf(
  facts: CompanyFacts,
  concept: string,
  unit = "USD",
): FactUnitEntry[] {
  return facts.facts["us-gaap"]?.[concept]?.units?.[unit] ?? [];
}
/**
 * 나열된 개념(대체 태그)을 우선순위대로 병합한 엔트리 배열.
 * 같은 보고기간(start·end·form)은 앞선 개념 값을 쓰고, 없는 기간만 뒤 개념이 채운다.
 * → 회사가 연도에 따라 태그를 바꾼 경우(NVIDIA 등) 시계열이 끊기지 않음.
 * 단, 앞선 개념에 **같은 결산일(end)**로 끝나는 값이 하나라도 있으면 그 날짜는 뒤 개념으로 채우지 않는다(2026-09-30 — GOOG 주식보상비용:
 * 현금흐름표 ShareBasedCompensation 은 누적만 있고 3개월 값이 없어, LTM 분기 합의 3개월 칸이 손익 쪽 AllocatedShareBasedCompensationExpense
 * (1억 단위·다른 정의)로 채워져 28,222 ≠ 현금흐름표 기준 28,147). 한 결산일 = 한 개념.
 */
export function firstConcept(
  facts: CompanyFacts,
  concepts: string[],
  unit = "USD",
): FactUnitEntry[] {
  if (concepts.length === 1) return entriesOf(facts, concepts[0], unit);
  const out: FactUnitEntry[] = [];
  const seen = new Set<string>();
  const endsTaken = new Set<string>(); // 앞선 개념이 이미 값을 가진 결산일
  for (const c of concepts) {
    const own = entriesOf(facts, c, unit);
    for (const e of own) {
      const key = `${e.start ?? ""}|${e.end}|${e.form}`;
      if (seen.has(key) || endsTaken.has(e.end)) continue;
      seen.add(key);
      out.push(e);
    }
    for (const e of own) endsTaken.add(e.end);
  }
  return inheritNoRecast(out, concepts.map((c) => entriesOf(facts, c, unit)));
}

/**
 * 온전한 1개 회계연도 기간인지 (약 300~400일).
 * 일부 기업(NVIDIA 등)은 90일 분기 값에도 fp="FY" 를 붙여 태깅한다 → duration 으로 걸러야 한다.
 */
export function isFullYearDuration(e: FactUnitEntry): boolean {
  if (!e.start) return false;
  const d = days(e.start, e.end);
  return d >= 300 && d <= 400;
}

/**
 * **반올림 재태깅 제거** — 나중 공시가 과거 기간 값을 본문 문장("$189 billion")의
 * 반올림값으로 다시 태깅한 엔트리를 버린다. 모든 모듈이 "같은 기간이면 최신 공시
 * (재작성본) 우선"이라 이 값이 정밀값을 덮어썼다(검증 체계 A = L + E 검사로 발견 —
 * AXP 2021 총자산 188,548 → 189,000 백만 달러, 2024 10-K). 샘플 25개사 실측
 * 528건(2026-09-23): 총자산·영업이익·매출원가·매출총이익 등 핵심 계정 포함.
 *
 * 판정: 같은 개념·단위·기간(start·end)에 **먼저 공시된** 값 y 가 있고, 이 값이 y 를
 * 1억·10억·100억 단위로 반올림한 값과 정확히 같으면(그리고 y 자신은 그 단위의
 * 배수가 아니면) 반올림 재태깅으로 본다. 실제 재작성이 원래 값의 반올림과 정확히
 * 일치할 가능성은 사실상 없다. 원본 객체는 건드리지 않고 새 객체를 돌려준다.
 *
 * **백만 단위(1e6)도 포함**(오너 승인 2026-09-25): 회사가 표기를 천 달러 → 백만 달러로 바꾸면 비교 열의 과거
 * 값이 백만 단위 반올림값으로 재태깅된다(MCD 2025-02 10-K — 2022-12-31 총자산 50,435.6 → 50,436 백만 달러, 자산 ≠
 * 부채+자본). 대상 값은 1억 이상만(아래 하한 — 상대 오차 0.5% 이하라 작은 값의 실제 재작성을 반올림으로 오인하지 않는다).
 */
export function dropRoundedRetags(facts: CompanyFacts): CompanyFacts {
  const P = [1e6, 1e8, 1e9, 1e10];
  // 작은 단위(1e3·1e4·1e5) 반올림은 **버리지 않고 값만 교체**한다(usdSmallRounds — 2026-09-28). 버리는 방식(2026-09-26 시도)은
  // NVO·SAP(20-F)·TRV·PSA 연간 열을 통째로 없앴다.
  const usdRounds = (x: number, y: number) =>
    Math.abs(x) >= 1e8 && x !== y && P.some((p) => Math.round(y / p) * p === x && y % p !== 0);
  // 주식수(shares)도 같은 규칙 — MRVL 2022-01-29 유통주식수: 그 해 10-K 846,695,000 → 2023 10-K 846,700,000(10만 주
  // 반올림). 주식수 공시 관행 단위(천·만·10만·백만 주)마다 값이 그 단위의 100배 이상일 때만(상대 오차 0.5% 이하 — USD 규칙과 같은 폭.
  // 자사주 매입·발행 같은 실제 변동이 우연히 원래 값의 반올림과 같아질 여지를 없앤다).
  const sharesRounds = (x: number, y: number) =>
    x !== y && [1e3, 1e4, 1e5, 1e6].some((p) => Math.abs(x) >= 100 * p && Math.round(y / p) * p === x && y % p !== 0);
  // 작은 단위 반올림(값만 교체 — 아래 clean). 값이 반올림 단위의 100배 이상일 때(상대 오차 0.5% 이하 — 주식수 규칙과 같은 폭). 예전 하한 1억은
  // MRVL FY2022 법인세 −62,461,000(원 공시) → −62,500,000(2024 10-K 재게시)을 놓쳤다(2026-09-29, 검증기 법인세 대조로 발견)
  const usdSmallRounds = (x: number, y: number) =>
    x !== y && [1e3, 1e4, 1e5].some((p) => Math.abs(x) >= 100 * p && Math.round(y / p) * p === x && y % p !== 0);
  const clean = (es: FactUnitEntry[], roundsTo: (x: number, y: number) => boolean, smallRounds?: (x: number, y: number) => boolean): FactUnitEntry[] => {
    const groups = new Map<string, FactUnitEntry[]>();
    for (const e of es) {
      const k = `${e.start ?? ""}|${e.end}`;
      const g = groups.get(k);
      if (g) g.push(e);
      else groups.set(k, [e]);
    }
    const drop = new Set<FactUnitEntry>();
    const fix = new Map<FactUnitEntry, number>();
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      for (const x of g) {
        if (g.some((y) => (y.filed ?? "") < (x.filed ?? "") && roundsTo(x.val, y.val))) drop.add(x);
        else if (smallRounds) {
          // 작은 단위(10^3~10^5) 반올림 재게시는 항목을 버리지 않고 값만 먼저 공시된 정밀값으로 바꾼다 — 항목(fy·fp·공시)이 남아
          // 열이 사라지지 않는다(2026-09-26 버리는 방식이 NVO·SAP·TRV·PSA 연간 열을 없앴던 문제). 오너 결정 2026-09-28 "원 공시
          // 정밀값으로 통일": MRVL 2022 세전이익 −483,495,000(2022-03 10-K, 천 달러) → 2023 10-K −483,500,000(0.1백만 단위 재게시)
          const y = g.filter((y) => (y.filed ?? "") < (x.filed ?? "") && smallRounds(x.val, y.val)).sort((a, b) => (a.filed ?? "").localeCompare(b.filed ?? ""))[0];
          if (y) fix.set(x, y.val);
        }
      }
    }
    if (!drop.size && !fix.size) return es;
    return es.filter((e) => !drop.has(e)).map((e) => (fix.has(e) ? { ...e, val: fix.get(e)! } : e));
  };
  const out: CompanyFacts = { ...facts, facts: { ...facts.facts } };
  const gaap = facts.facts["us-gaap"];
  if (gaap) {
    const ng: NonNullable<CompanyFacts["facts"]["us-gaap"]> = {};
    for (const [concept, o] of Object.entries(gaap)) {
      const units: Record<string, FactUnitEntry[]> = {};
      for (const [u, es] of Object.entries(o.units)) units[u] = u === "USD" ? clean(es, usdRounds, usdSmallRounds) : u === "shares" ? clean(es, sharesRounds) : es;
      ng[concept] = { ...o, units };
    }
    out.facts["us-gaap"] = ng;
  }
  return out;
}

/** 같은 회계기간의 두 값 중 채택할 것 — 최신 종료일, 동률이면 최신 공시(재작성) 우선. */
function preferNewer(cand: FactUnitEntry, prev: { end: string; filed?: string }): boolean {
  if (cand.end !== prev.end) return cand.end > prev.end;
  return (cand.filed ?? "") >= (prev.filed ?? "");
}

/** 사업연도(FY, 10-K) duration 값 Map<year, val>. */
/**
 * 결산일 → 사업연도. 52/53주 결산 회사는 결산일이 1월 첫 주로 넘어가는 해가 있다 — 그 결산은
 * 전년도 사업연도다(업계 관행: WEN "fiscal 2022" = 2023-01-01 결산). 결산일의 연도로만 키를
 * 잡으면 2023-01-01 결산과 2023-12-31 결산이 같은 2023 으로 겹쳐 한 해가 통째로 사라졌다
 * (검증 2026-09-24, WEN). 연도 키를 만드는 모든 미국 모듈이 이 함수를 쓴다.
 */
export function fiscalYearOf(end: string): number {
  const y = Number(end.slice(0, 4));
  return end.slice(5, 7) === "01" && Number(end.slice(8, 10)) <= 7 ? y - 1 : y;
}

export function annualByYear(entries: FactUnitEntry[]): Map<number, number> {
  const m = new Map<number, { val: number; end: string; filed?: string }>();
  for (const e of entries) {
    if (e.fp !== "FY" || !isFullYearDuration(e) || !ANNUAL_FORMS.includes(e.form)) continue;
    const y = fiscalYearOf(e.end);
    const prev = m.get(y);
    if (!prev || preferNewer(e, prev)) m.set(y, { val: e.val, end: e.end, filed: e.filed });
  }
  return new Map([...m].map(([y, v]) => [y, v.val]));
}

/** 재무상태표(instant) — 사업연도말 값 Map<year, val>. */
export function instantByYear(entries: FactUnitEntry[]): Map<number, number> {
  const m = new Map<number, { val: number; end: string; filed?: string }>();
  for (const e of entries) {
    if (e.start || !ANNUAL_FORMS.includes(e.form)) continue;
    const y = fiscalYearOf(e.end);
    const prev = m.get(y);
    if (!prev || preferNewer(e, prev)) m.set(y, { val: e.val, end: e.end, filed: e.filed });
  }
  return new Map([...m].map(([y, v]) => [y, v.val]));
}

/** 재무상태표 — 가장 최근 instant 값 (분기 포함). */
export function latestInstant(entries: FactUnitEntry[]): number | null {
  let best: { val: number; end: string } | null = null;
  for (const e of entries) {
    if (e.start) continue;
    if (!best || e.end > best.end) best = { val: e.val, end: e.end };
  }
  return best?.val ?? null;
}

/** 이 공시(제출일 filed)에 개념들 중 하나라도 값이 있는가(어느 기간이든, 모든 단위) */
export function reportedInFiling(facts: CompanyFacts, concepts: string[], filed: string | undefined): boolean {
  if (!filed) return true; // 공시를 모르면 "없음"을 증명할 수 없다
  const g = facts.facts["us-gaap"] ?? {};
  return concepts.some((c) => Object.values(g[c]?.units ?? {}).some((es) => es.some((e) => e.filed === filed)));
}

/**
 * **없음 증명**(그림자 채우기 금지 — 0 으로 둘 수 있는 유일한 경우): 기준일(±7일) 재무상태표를 담은 정기공시에 이 개념들이
 * 어느 기간으로도 전혀 없으면 그 줄이 본표에 없는 것 = 0. 공시를 못 찾거나 같은 공시에 다른 날짜 값이라도 있으면(그 날짜만
 * 빠짐) 증명 불가 → false(값 공란).
 */
export function provenAbsentAt(facts: CompanyFacts, concepts: string[], date: string): boolean {
  const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 7 * 86_400_000;
  // 공시별 재무상태표 기준일(자산총계가 있는 날짜 — 당기·비교 칸)
  const bsDates = new Map<string, string[]>();
  for (const e of facts.facts["us-gaap"]?.["Assets"]?.units?.["USD"] ?? []) {
    if (e.start || !e.filed || ![...ANNUAL_FORMS, ...INTERIM_FORMS].includes(e.form)) continue;
    bsDates.set(e.filed, [...(bsDates.get(e.filed) ?? []), e.end]);
  }
  const filings = [...bsDates].filter(([, ds]) => ds.some((d) => near(d, date)));
  if (!filings.length) return false;
  const g = facts.facts["us-gaap"] ?? {};
  // 그 공시에서 개념 값이 (1) 이 기준일에 없고 (2) 있다면 재무상태표 비교 칸 날짜에만 있을 때 = 이 칸이 본표 "—"(0 공시).
  // 주석의 다른 날짜(분기말 등) 값이 있으면 이 칸이 빠진 이유를 알 수 없어 증명 불가(2026-09-27 — TER 2024 차입금·GLW 2021 우선주)
  return filings.every(([f, ds]) =>
    concepts.every((c) =>
      Object.values(g[c]?.units ?? {}).every((es) =>
        es.every((e) => e.filed !== f || (!e.start && !near(e.end, date) && ds.some((d) => near(d, e.end)))),
      ),
    ),
  );
}

/** 재무상태표 — 특정 기준일(정확 일치 ±6일)의 instant 값. */
export function instantOn(entries: FactUnitEntry[], end: string): number | null {
  let best: { val: number; d: number } | null = null;
  for (const e of entries) {
    if (e.start) continue;
    const dd = Math.abs(days(end, e.end));
    if (dd > 6) continue;
    if (!best || dd < best.d) best = { val: e.val, d: dd };
  }
  return best?.val ?? null;
}

/** 최근 n개 분기말 (instant 기준). */
export function recentInstantQuarters(entries: FactUnitEntry[], n = 5): string[] {
  const ends = new Set<string>();
  for (const e of entries) {
    if (e.start || !INTERIM_FORMS.includes(e.form)) continue;
    ends.add(e.end);
  }
  // 10-K 기말도 포함 (연말 분기)
  for (const e of entries) {
    if (e.start || !ANNUAL_FORMS.includes(e.form)) continue;
    ends.add(e.end);
  }
  return [...ends].sort().reverse().slice(0, n);
}

/** 사업연도 종료일 Map<year, endDate>. */
export function annualEnds(entries: FactUnitEntry[]): Map<number, string> {
  const m = new Map<number, string>();
  for (const e of entries) {
    if (e.fp !== "FY" || !isFullYearDuration(e) || !ANNUAL_FORMS.includes(e.form)) continue;
    const y = fiscalYearOf(e.end);
    if (!m.has(y) || e.end > m.get(y)!) m.set(y, e.end);
  }
  return m;
}

export interface QuarterCol {
  label: string; // "2026 Q3"
  end: string; // 2026-06-27
  fyStartApprox: string; // 회계연도 시작 근사 (전년 동월)
}

/** 최근 n개 분기 컬럼 (anchor 개념의 10-Q 보고 기간 기준, 최신→과거). */
export function recentQuarters(
  entries: FactUnitEntry[],
  n = 5,
): QuarterCol[] {
  const seen = new Map<string, { end: string; fy: number; fp: string }>();
  for (const e of entries) {
    if (!INTERIM_FORMS.includes(e.form) || e.fp === "FY" || !e.start) continue;
    const key = `${e.fy} ${e.fp}`;
    const prev = seen.get(key);
    if (!prev || e.end > prev.end) seen.set(key, { end: e.end, fy: e.fy, fp: e.fp });
  }
  return [...seen.entries()]
    .map(([label, v]) => ({
      label,
      end: v.end,
      fyStartApprox: shiftYear(v.end, -1),
    }))
    .sort((a, b) => b.end.localeCompare(a.end))
    .slice(0, n);
}

/** 단일 분기 값: 직접 태깅(≈90일) → 없으면 당기 YTD − 직전분기 YTD. */
/** singleQuarter 1단계(직접 단일분기, 기간 60~100일·end 일치)만 떼어낸 것 —
 * EPS 등 비율 지표가 2단계(YTD 차감)를 타지 않게 하는 용도로 별도 공개
 * (edgar-income.ts 참고). */
export function directQuarterValue(entries: FactUnitEntry[], col: QuarterCol): number | null {
  const interim = entries.filter(
    (e) => INTERIM_FORMS.includes(e.form) && e.fp !== "FY" && e.start,
  );
  const direct = interim.find(
    (e) =>
      Math.abs(days(e.start!, e.end)) >= 55 &&
      Math.abs(days(e.start!, e.end)) <= 100 &&
      Math.abs(days(col.end, e.end)) <= 6,
  );
  return direct ? direct.val : null;
}

/** 분기 누적 차에 필요한 직전 누적이 없음(같은 사업연도의 직전 분기 누적 미공시·열 누락) — 칸 주석 */
export const QUARTER_NO_PREV_YTD = "분기 누적 차에 필요한 직전 누적 없음 — 누적값을 분기로 쓰지 않음";

export interface QuarterParts {
  value: number | null;
  /** 값이 공시 3개월 값이 아닌 재분류 역산값일 때 칸 주석(recastFirstQuarter) */
  note?: string | null;
  /** 값을 만든 항목(직접 단일분기 1개, 누적 차 2개 — 누적 · 직전 누적) */
  parts: FactUnitEntry[];
  /** value 가 null 인 이유(값이 원래 없으면 null) */
  reason: string | null;
}

/**
 * 단일 분기 값과 구성 항목: 직접 태깅(≈90일) → 없으면 당기 YTD − 직전분기 YTD(같은 사업연도).
 * 직전 누적이 없거나 사업연도가 다르면(열 누락 — ORCL 현금흐름표 2026-09-27) 누적값을 분기로 쓰지 않는다: 당기 누적이 3개월
 * 이하(사업연도 첫 분기)일 때만 그 값, 아니면 공란 + QUARTER_NO_PREV_YTD. 예전엔 사업연도가 바뀌면 누적값(6개월)을 그대로 냈다.
 */
export function singleQuarterParts(
  entries: FactUnitEntry[],
  col: QuarterCol,
  prevCol: QuarterCol | undefined,
  /** 회사 재분류 1분기 규칙 적용 — 기본은 배열 표시(markNoRecast: 현금흐름표 개념은 감가상각비만) */
  recast = recastAllowed(entries),
): QuarterParts {
  const interim = entries.filter(
    (e) => INTERIM_FORMS.includes(e.form) && e.fp !== "FY" && e.start,
  );
  const direct = interim.find(
    (e) =>
      Math.abs(days(e.start!, e.end)) >= 55 &&
      Math.abs(days(e.start!, e.end)) <= 100 &&
      Math.abs(days(col.end, e.end)) <= 6,
  );
  if (direct) {
    // 1분기(3개월 = 사업연도 누적)면 이후 공시의 누적과 모순되는지(회사 재분류) 본다 — 모순이면 최신 누적에서 역산
    // (1분기 판정은 recastFirstQuarter 안에서 — 이 분기 시작일로 시작하는 6·9개월 누적이 있어야 사업연도 첫 분기)
    const rc = recast ? recastFirstQuarter(interim, direct.start!, direct) : null;
    if (rc) return { value: rc.value, parts: rc.parts, reason: null, note: rc.note };
    return { value: direct.val, parts: [direct], reason: null };
  }
  // 2) YTD 차감
  const ytd = (end: string) =>
    interim
      .filter((e) => Math.abs(days(end, e.end)) <= 6)
      .sort((a, b) => Math.abs(days(a.start!, a.end)) - Math.abs(days(b.start!, b.end)))
      .pop(); // 가장 긴 기간 = YTD
  const cur = ytd(col.end);
  if (!cur) return { value: null, parts: [], reason: null };
  const firstQuarter = Math.abs(days(cur.start!, cur.end)) <= 100;
  if (firstQuarter && recast) {
    const rc = recastFirstQuarter(interim, cur.start!, cur);
    if (rc) return { value: rc.value, parts: rc.parts, reason: null, note: rc.note };
  }
  if (!prevCol) {
    // 회계연도 첫 분기로 추정 (start 가 fy 시작 근처면 YTD == 단일분기)
    return Math.abs(days(col.fyStartApprox, cur.start!)) <= 20 && firstQuarter
      ? { value: cur.val, parts: [cur], reason: null }
      : { value: null, parts: [], reason: QUARTER_NO_PREV_YTD };
  }
  const prev = ytd(prevCol.end);
  // 서로 같은 회계연도인지 (prev.start ≈ cur.start) — 다르면 cur 가 사업연도 첫 분기(3개월)일 때만 그 값
  if (!prev || Math.abs(days(cur.start!, prev.start!)) > 20)
    return firstQuarter ? { value: cur.val, parts: [cur], reason: null } : { value: null, parts: [], reason: QUARTER_NO_PREV_YTD };
  return { value: cur.val - prev.val, parts: [cur, prev], reason: null };
}

/**
 * **회사 재분류 — 1분기(오너 결정 2026-09-29)**. 회사가 이후 공시에서 과거 분기를 재분류하면(합계 불변, 줄 사이 이동) 1분기 3개월
 * 공시값이 이후 누적과 모순된다. 두 상태:
 *  (a) 역산추정 — 같은 사업연도 6개월 누적을 실은 **한 공시** 안에서 1분기 = 6개월 누적 − 2분기 3개월(서로 다른 공시 값을 섞지 않는다 —
 *      WDC 는 샌디스크 분사로 나중 공시가 9개월만 재작성해, 섞으면 매출 −471 같은 값이 나왔다). 가장 나중 공시의 쌍을 쓰되, 그 쌍이
 *      처음 실린 공시(역산 시점)가 1분기 3개월 값의 최신 공시보다 나중이고 역산값이 다르면 역산값 + "역산추정 — 1분기 {form} 공시값 {원래 값}".
 *      예: MSFT FY2026 현금흐름표 "Depreciation, amortization, and other" — 1분기 10-Q 13,061, 2분기 10-Q("We have recast certain
 *      prior period amounts on our consolidated cash flows statements") 6개월 17,345 − 2분기 9,198 = 8,147(분기 합 = 연간 38,534).
 *  (b) 최신공시변경 — 나중 공시(다음 해 같은 분기 10-Q 의 전년 열 등)가 1분기 3개월 값을 직접 다시 실었고, 그 공시가 역산 시점
 *      이후이거나 역산값과 같으면 그 값(앱 기본 = 최신 판본) + "최신공시변경 — 1분기 {form} 공시값 {원래 값}". 역산 근거 이후의 직접
 *      공시는 역산값과 달라도 공시값이 우선. 직접 공시값이 원공시와 같으면(1분기가 아니라 2분기 쪽이 바뀐 것 — BE 2022 감가상각비) null.
 *      예: IBM 2021 1분기 매출 10-Q 17,730 → 2022 1분기 10-Q 전년 열 13,187(킨드릴 분사 재작성, 2분기 10-Q 역산 13,187과 같음).
 * 재분류가 없으면(역산값 = 공시값) null — 종전과 같다. 반올림 차는 모순으로 보지 않는다 — 허용치 = 비교하는 값들 중 가장 굵은 표기 단위의
 * 2배(MCD 2023 1분기 매출: 원공시 5,897.8(0.1 백만 단위) vs 이후 공시 백만 단위 12,395 − 6,498 = 5,897 — 반올림 차 1).
 */
export function recastFirstQuarter(
  interims: FactUnitEntry[],
  fyStart: string,
  q1: FactUnitEntry,
): { value: number; parts: FactUnitEntry[]; note: string } | null {
  const q1s = interims
    .filter((e) => e.start && Math.abs(days(q1.start!, e.start)) <= 6 && Math.abs(days(q1.end, e.end)) <= 6 && days(e.start, e.end) >= 55 && days(e.start, e.end) <= 100)
    .sort((x, y) => (x.filed ?? "").localeCompare(y.filed ?? ""));
  const orig = q1s[0] ?? q1, latest = q1s.at(-1) ?? q1;
  // 6개월 누적과 2분기 3개월을 **같은 공시**에 실은 공시 중 가장 나중 것
  const six = interims.filter((e) => e.start && Math.abs(days(fyStart, e.start)) <= 12 && Math.abs(days(e.start, e.end) - 2 * 91.3) <= 20);
  let best: { y: FactUnitEntry; d: FactUnitEntry } | null = null;
  for (const y of six) {
    const d = interims.find((e) => e.start && e.filed === y.filed && e.form === y.form && (e.basis ?? "") === (y.basis ?? "") && Math.abs(days(y.end, e.end)) <= 6 && days(e.start, e.end) >= 55 && days(e.start, e.end) <= 100);
    if (d && (!best || (y.filed ?? "") > (best.y.filed ?? ""))) best = { y, d };
  }
  if (!best) return null;
  // 역산 근거의 시점 = 지금 쓰는 6개월·2분기 값 쌍이 처음 실린 공시 — 다음 해 2분기 10-Q 가 전년 열로 같은 값을 되풀이한 것은 새 정보가 아니다
  // (MRVL FY2023: 2분기 10-Q(2022-08) 6개월 432.4 − 2분기 211.7 = 220.7 ≠ 1분기 235.7, 그런데 다음 해 1분기 10-Q(2023-05)가 1분기를 235.7 로
  // 다시 실었다 — 역산보다 나중의 직접 공시라 그 값)
  const b = best;
  const info = six
    .filter((y) => y.val === b.y.val && interims.some((e) => e.filed === y.filed && e.form === y.form && (e.basis ?? "") === (y.basis ?? "") && e.val === b.d.val && e.start === b.d.start && e.end === b.d.end))
    .reduce((m, y) => ((y.filed ?? "") < m ? (y.filed ?? "") : m), b.y.filed ?? "");
  if (info <= (orig.filed ?? "")) return null;
  const derived = best.y.val - best.d.val;
  // 표기 단위 — 끝자리 0 때문에 과대 판정되지 않게 백만 단위로 상한(AMD 2024 1분기 판관비 620 은 백만 단위 공시)
  const unit = (v: number) => { let u = 1; while (u < 1e6 && v % (u * 10) === 0) u *= 10; return u; };
  const same = (a: number, b: number, ...es: FactUnitEntry[]) => Math.abs(a - b) <= 2 * Math.max(...es.map((e) => unit(e.val)));
  if (same(derived, orig.val, orig, best.y, best.d)) return null; // 재분류 없음
  const m = (v: number) => (v / 1e6).toLocaleString("en-US", { maximumFractionDigits: 3 });
  // (b) 1분기 3개월 값을 나중에 직접 다시 실은 공시 — 역산 근거 이후이거나 역산값과 같으면 그 값
  if (latest !== orig && ((latest.filed ?? "") >= info || same(latest.val, derived, latest, best.y, best.d))) {
    if (same(latest.val, orig.val, latest, orig)) return null;
    return { value: latest.val, parts: [latest], note: "최신공시변경 — 1분기 " + orig.form + " 공시값 " + m(orig.val) };
  }
  return { value: derived, parts: [best.y, best.d], note: "역산추정 — 1분기 " + orig.form + " 공시값 " + m(orig.val) };
}

export function singleQuarter(
  entries: FactUnitEntry[],
  col: QuarterCol,
  prevCol: QuarterCol | undefined,
): number | null {
  return singleQuarterParts(entries, col, prevCol).value;
}

/**
 * 액면분할 보정 계수 Map<year, factor>. 보고된 주당 지표(EPS·BPS·DPS)에 곱하면
 * 최신 연도 기준으로 환산된다. 가중평균 희석주식수(최신 공시 기준) 시계열에서
 * 인접 연도 배수가 크고 매출 배수는 ~1 인 지점을 분할로 판정한다.
 * NVIDIA(10:1, FY2025) 등 소급 재작성 안 된 과거 연도 대응.
 */
export function splitFactorsByYear(
  facts: CompanyFacts,
  shareConcepts: string[] = [
    "WeightedAverageNumberOfDilutedSharesOutstanding",
    "WeightedAverageNumberOfSharesOutstandingBasic",
  ],
  revenueConcepts: string[] = [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
  ],
): Map<number, number> {
  const merge = (concepts: string[], unit = "USD") => {
    const out = new Map<number, number>();
    for (const c of concepts)
      for (const [y, v] of annualByYear(entriesOf(facts, c, unit))) if (!out.has(y)) out.set(y, v);
    return out;
  };
  const sh = merge(shareConcepts, "shares");
  const rev = merge(revenueConcepts);
  const years = [...sh.keys()].sort((a, b) => a - b);
  const factor = new Map<number, number>();
  if (!years.length) return factor;
  factor.set(years[years.length - 1], 1);
  // 25~100 추가 — CMG 50:1(2024-06)을 못 알아봐 2021 EPS 가 22.9(실제 0.458)로 나왔다(검증 2026-09-24).
  // 3:2(1.5배)는 증자·자사주와 구분이 어려워 넣지 않는다 — 검증 도구가 Yahoo 분할 이력으로 따로 잡는다.
  const SPLITS = [2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 25, 30, 40, 50, 100];
  // **같은 공시로 두 해를 잇는다(우선)** — yOld 의 최신 판본이 실린 공시(A)에는 yNew 값도 있다(10-K 비교 열). A 의 yNew
  // 값과 yNew 의 최신 판본 값의 비율은 두 공시 사이의 분할 배수 그 자체다(연도 간 주식수 증감·희석이 섞이지 않는다).
  // 인접 연도 비교(아래 폴백)는 TSLA 에서 2020 희석 32.49억(3:1 소급) ÷ 2019 8.87억(5:1 까지만 소급) = 3.66 → 4 로
  // 틀려 2018·2019 계수가 1/4(실제 1/3), FY2018 결산일 주식수가 ×20(실제 5×3=15)이 됐다(검증 2026-09-25).
  const annualE = (c: string) =>
    entriesOf(facts, c, "shares").filter((e) => e.fp === "FY" && isFullYearDuration(e) && ANNUAL_FORMS.includes(e.form));
  const newestOf = (es: FactUnitEntry[], y: number) =>
    es.filter((e) => fiscalYearOf(e.end) === y).reduce<FactUnitEntry | null>((b, e) => (!b || preferNewer(e, b) ? e : b), null);
  const crossStep = (yOld: number, yNew: number): number | null => {
    for (const c of shareConcepts) {
      const es = annualE(c);
      const o = newestOf(es, yOld), n = newestOf(es, yNew);
      if (!o || !n) continue;
      const inA = es.find((e) => fiscalYearOf(e.end) === yNew && e.filed === o.filed);
      if (!inA || !(inA.val > 0) || !(n.val > 0)) return null;
      const r = n.val / inA.val, R = r >= 1 ? r : 1 / r, k = Math.round(R);
      if (k === 1) return Math.abs(R - 1) < 0.02 ? 1 : null;
      return k <= 100 && Math.abs(R / k - 1) < 0.005 ? (r >= 1 ? 1 / k : k) : null;
    }
    return null;
  };
  for (let i = years.length - 1; i > 0; i--) {
    const yNew = years[i];
    const yOld = years[i - 1];
    const f = factor.get(yNew) ?? 1;
    const sNew = sh.get(yNew);
    const sOld = sh.get(yOld);
    const cross = crossStep(yOld, yNew);
    let step = cross ?? 1;
    if (cross == null && sNew != null && sOld != null && sOld > 0) {
      const r = sNew / sOld;
      const rvNew = rev.get(yNew);
      const rvOld = rev.get(yOld);
      const revStable = rvNew != null && rvOld != null && rvOld > 0
        ? rvNew / rvOld > 0.4 && rvNew / rvOld < 2.5
        : true;
      if (revStable) {
        if (r >= 1.6) {
          const k = SPLITS.reduce((best, c) => (Math.abs(c - r) < Math.abs(best - r) ? c : best), SPLITS[0]);
          if (Math.abs(k - r) / k < 0.15) step = 1 / k; // 정방향 분할
        } else if (r <= 1 / 1.6) {
          const k = SPLITS.reduce((best, c) => (Math.abs(c - 1 / r) < Math.abs(best - 1 / r) ? c : best), SPLITS[0]);
          if (Math.abs(k - 1 / r) / k < 0.15) step = k; // 병합
        }
      }
    }
    factor.set(yOld, f * step);
  }
  return factor;
}

/** 최근 사업연도 종료일이 이만큼(일) 넘게 지났으면 태그를 중단한 개념으로 본다. */
export const STALE_ANNUAL_DAYS = 550;
export function isStaleAnnual(fyEnd: string, now = Date.now()): boolean {
  return (now - Date.parse(fyEnd)) / 86_400_000 > STALE_ANNUAL_DAYS;
}

/**
 * TTM 구성요소의 공시 판본 선택 — 같은 기간 값이 여러 공시에 있으면(비교 열 재공시) 전년동기 누적은 **당기 누적과
 * 같은 공시의 비교 열**, 그 외는 가장 최근 공시. 예전엔 배열 순서(최초 공시)를 따라 LLY 처럼 2026 부터 백만 단위로
 * 반올림해 공시하는 회사는 LTM 이 원공시 8,419.8 과 비교 열 8,420 을 섞어 0.2 백만 달랐다(검증 2026-09-24).
 */
export function vintageOrder(a: { filed?: string }, b: { filed?: string }, prefer?: string): number {
  if (prefer) {
    const pa = a.filed === prefer ? 0 : 1, pb = b.filed === prefer ? 0 : 1;
    if (pa !== pb) return pa - pb;
  }
  return (b.filed ?? "").localeCompare(a.filed ?? "");
}

/**
 * LTM 조합 — 최근 FY + 당기누적 − 전년동기누적. 외화 공시 기업은 각 구성요소의
 * 분기 합 환산값(ltmQ, edgar-foreign.ts)으로 더해 "최근 4개 분기 × 각 분기 평균 환율"이 된다(오너 결정 2026-09-25,
 * 인포맥스·Finviz 방식). 구성요소 하나라도 ltmQ 가 없으면 공시값(val, 기간 평균 환율) 조합.
 * cur·prior 를 모두 주지 않으면(사업연도 뒤 정기공시가 아직 없음 — ltmFlowOf 가 판정) 사업연도 값 그대로.
 */
export function ttmCombine(
  fy: { val: number; ltmQ?: number; ltmNone?: boolean },
  cur?: { val: number; ltmQ?: number; form?: string } | null,
  prior?: { val: number; ltmQ?: number; form?: string } | null,
): number | null {
  // 20-F Yahoo 분기 LTM 에서 채우지 못한 항목 — FY 값으로 대신하지 않고 공란(edgar-yahoo-quarters.ts)
  if (fy.ltmNone) return null;
  if (!cur && !prior) return fy.ltmQ ?? fy.val;
  // 한쪽만 있으면(전년동기 누락 등) 조합 불가 — 사업연도 값으로 대신하지 않는다(그림자 채우기 금지, 2026-09-27)
  if (!cur || !prior) return null;
  if (fy.ltmQ != null && cur.ltmQ != null && prior.ltmQ != null) return fy.ltmQ + cur.ltmQ - prior.ltmQ;
  // Yahoo 분기 구성요소는 LTM 전용 값(ltmQ) 조합으로만 — 공시값(val)과 섞으면 기간·원천이 섞인다
  if (cur.form === YAHOO_Q_FORM || prior.form === YAHOO_Q_FORM) return null;
  return fy.val + cur.val - prior.val;
}

/** LTM 공란 사유 — 화면 칸 주석 문구(그림자 채우기 금지, 오너 규칙 2026-09-27) */
export const LTM_NO_QUARTER = "LTM 구성 분기 없음";
export const LTM_STALE = "LTM 구성 분기 없음(최근 사업연도 공시가 550일 넘게 지남 — 태그 중단)";
export const LTM_YAHOO_GAP = "LTM 구성 분기 없음(Yahoo 분기에 없는 항목)";

export interface LtmFlow {
  value: number | null;
  /** value 가 null 인 이유(값이 원래 없는 개념이면 null) */
  reason: string | null;
  fy: FactUnitEntry | null;
  cur: FactUnitEntry | null;
  prior: FactUnitEntry | null;
  /** 분기 합 LTM 을 만든 항목(기준 혼합 판정용 — edgar-ev.ts daBasisMixed). 종전 식이면 없음 */
  parts?: FactUnitEntry[];
}

const anchorCache = new WeakMap<object, string | null>();
/**
 * **LTM 기준일** — 회사의 가장 최근 정기공시(10-K·10-Q·20-F, 20-F Yahoo 분기) 재무상태표 기준일(자산총계 시점 값). 흐름
 * 개념의 LTM 은 반드시 이 날짜에서 끝나야 한다 — 사업연도 뒤 분기 공시가 있는데 그 개념의 당기 누적(또는 전년 동기
 * 누적)이 없으면 사업연도 값을 LTM 으로 쓰지 않고 공란(LTM_NO_QUARTER). 개념마다 제각각이던 "가장 최근 값"은 서로 다른
 * 기간을 같은 LTM 열에 섞었다.
 */
export function ltmAnchor(facts: CompanyFacts): string | null {
  const gaap = facts.facts["us-gaap"];
  const key = (gaap ?? facts) as object;
  const ys = facts.ltmQuarterSource?.source === "yahoo" ? facts.ltmQuarterSource.through : null;
  if (anchorCache.has(key)) {
    const a = anchorCache.get(key) ?? null;
    return ys && (!a || ys > a) ? ys : a;
  }
  let best: string | null = null;
  const periodic = [...ANNUAL_FORMS, ...INTERIM_FORMS];
  for (const e of gaap?.["Assets"]?.units?.["USD"] ?? []) {
    if (e.start || !e.end || e.val == null || !periodic.includes(e.form)) continue;
    if (e.filed && e.end > e.filed) continue;
    if (!best || e.end > best) best = e.end;
  }
  // 자산총계 태그가 없는 회사 — 순이익 기간 끝
  if (!best)
    for (const c of ["NetIncomeLoss", "ProfitLoss"])
      for (const e of gaap?.[c]?.units?.["USD"] ?? []) {
        if (!e.start || !periodic.includes(e.form) || (e.filed && e.end > e.filed)) continue;
        if (!best || e.end > best) best = e.end;
      }
  anchorCache.set(key, best);
  return ys && (!best || ys > best) ? ys : best;
}

/**
 * **흐름 LTM 단일 함수** — 최근 FY + 당기누적 − 전년동기누적. 모든 화면(하이라이트·재무분석·손익·현금흐름·은행·개요 TTM)이
 * 이것만 쓴다(예전엔 모듈마다 사본이 있어 550일 규칙·전년동기 누락 처리가 제각각이었다).
 *  - 최근 사업연도 종료가 550일 넘게 지났으면(태그 중단) 공란 — LTM_STALE
 *  - 사업연도 뒤 정기공시(anchor)가 있는데 이 개념의 당기 누적이 없거나 그 끝이 anchor 가 아니면 공란 — LTM_NO_QUARTER
 *  - 당기 누적은 있는데 전년 동기 누적이 없으면 공란 — LTM_NO_QUARTER(사업연도 값으로 대신하지 않음)
 *  - 사업연도 뒤 정기공시가 아직 없으면(anchor ≈ FY 말) LTM = 사업연도 값(정의상 같은 기간)
 */
export function ltmFlowOf(entries: FactUnitEntry[], anchor: string | null, recast = recastAllowed(entries)): LtmFlow {
  const none = (reason: string | null): LtmFlow => ({ value: null, reason, fy: null, cur: null, prior: null });
  const annuals = entries
    .filter((e) => e.val != null && e.fp === "FY" && isFullYearDuration(e) && ANNUAL_FORMS.includes(e.form))
    .sort((a, b) => b.end.localeCompare(a.end) || vintageOrder(a, b));
  const fy = annuals[0];
  if (!fy?.start) {
    // 사업연도 값이 없는 개념 — 분기 값만 있으면 LTM 을 만들 수 없다
    return none(entries.some((e) => e.start && LTM_INTERIM_FORMS.includes(e.form)) ? LTM_NO_QUARTER : null);
  }
  // 태그를 중단한 개념의 옛 연간값을 "최근 12개월"로 쓰지 않는다(감사 2026-09-23: GE OperatingIncomeLoss)
  if (isStaleAnnual(fy.end)) return none(LTM_STALE);
  const interims = entries.filter((e) => e.start && e.val != null && LTM_INTERIM_FORMS.includes(e.form));
  const cur = interims
    .filter((e) => Math.abs(days(fy.end, e.start!)) <= 12 && e.end > fy.end)
    .sort((a, b) => b.end.localeCompare(a.end) || vintageOrder(a, b))[0];
  const laterFiling = anchor != null && days(fy.end, anchor) > 12;
  if (!cur?.start) {
    if (laterFiling) return none(LTM_NO_QUARTER);
    const v = ttmCombine(fy);
    return { value: v, reason: v == null ? LTM_YAHOO_GAP : null, fy, cur: null, prior: null };
  }
  // 개념의 최근 누적이 회사의 최근 정기공시보다 앞서 끝나면(그 분기 공시에 없는 개념) 공란
  if (anchor != null && days(cur.end, anchor) > 12) return none(LTM_NO_QUARTER);
  const wS = shiftYear(cur.start, -1);
  const wE = shiftYear(cur.end, -1);
  const prior = interims
    .filter((e) => Math.abs(days(wS, e.start!)) <= 12 && Math.abs(days(wE, e.end)) <= 12)
    .sort((a, b) => Math.abs(days(wE, a.end)) - Math.abs(days(wE, b.end)) || vintageOrder(a, b, cur.filed))[0];
  if (!prior) return none(LTM_NO_QUARTER);
  // LTM = 최근 4개 분기 합(오너 결정 2026-09-28 "LTM 분기합" — fin/read ltmCol 과 같은 규칙). Yahoo 분기로 만든 20-F LTM(ltmQ)은 종전 식
  const qs = fy.ltmQ == null && cur.form !== YAHOO_Q_FORM && prior.form !== YAHOO_Q_FORM ? quarterSumLtm(interims, fy, cur, recast) : null;
  const v = qs?.value ?? ttmCombine(fy, cur, prior);
  return { value: v, reason: v == null ? LTM_YAHOO_GAP : null, fy, cur, prior, ...(qs ? { parts: qs.parts } : {}) };
}

/**
 * 최근 4개 분기 합 — 분기 = 3개월 공시값(최신 판본), 없으면 누적 차(누적_j − 누적_{j−1}), 4분기 = 사업연도 − 9개월 누적. 화면의 분기 열
 * (edgar-income.ts quarterParts)과 같은 규칙이라 분기 열 4개 합 = LTM. 회사가 연간·누적·분기를 따로 반올림해 종전 식("사업연도 + 당기 누적
 * − 전년 동기")과 ±1(백만) 어긋났다(CL 2026 Q2 매출 21,047 → 21,046 = 블룸버그·Yahoo). 분기 하나라도 못 만들면 null(종전 식)
 */
function quarterSumLtm(interims: FactUnitEntry[], fy: FactUnitEntry, cur: FactUnitEntry, recast = true): { value: number; parts: FactUnitEntry[] } | null {
  if (!fy.start || !cur.start) return null;
  const k = Math.round(days(cur.start, cur.end) / 91.3);
  if (k < 1 || k > 3) return null;
  const newest = (xs: FactUnitEntry[]) => xs.sort((a, b) => (b.filed ?? "").localeCompare(a.filed ?? ""))[0];
  /** 사업연도 시작 s 부터 j 분기 누적(j = 0 이면 0) */
  const ytd = (s: string, j: number): FactUnitEntry | null | 0 =>
    j === 0 ? 0 : newest(interims.filter((e) => e.start && Math.abs(days(s, e.start)) <= 12 && Math.abs(days(e.start, e.end) - j * 91.3) <= 20)) ?? null;
  /** 사업연도 시작 s 의 j 분기(1~3) 값 */
  const parts: FactUnitEntry[] = [];
  const quarter = (s: string, j: number): number | null => {
    const c = ytd(s, j), p = ytd(s, j - 1);
    if (!c) return null;
    const direct = newest(interims.filter((e) => e.start && Math.abs(days(c.end, e.end)) <= 6 && days(e.start, e.end) >= 80 && days(e.start, e.end) <= 100));
    const q1 = direct ?? (j === 1 ? c : null);
    // 1분기는 재분류 역산(화면 분기 열 singleQuarterParts 와 같은 규칙)
    if (j === 1 && q1 && recast) { const rc = recastFirstQuarter(interims, s, q1); if (rc) { parts.push(...rc.parts); return rc.value; } }
    if (direct) { parts.push(direct); return direct.val; }
    if (p === null) return null;
    parts.push(c, ...(p === 0 ? [] : [p]));
    return c.val - (p === 0 ? 0 : p.val);
  };
  let sum = 0;
  for (let j = 1; j <= k; j++) { const v = quarter(cur.start, j); if (v == null) return null; sum += v; }
  for (let j = k + 1; j <= 3; j++) { const v = quarter(fy.start, j); if (v == null) return null; sum += v; }
  const nine = ytd(fy.start, 3);
  if (!nine) return null;
  parts.push(fy, nine);
  return { value: sum + fy.val - nine.val, parts };
}

/** 회사의 최근 사업연도 결산일(연간 공시의 자산총계 기준일) */
export function latestAnnualEnd(facts: CompanyFacts): string | null {
  let best: string | null = null;
  for (const e of facts.facts["us-gaap"]?.["Assets"]?.units?.["USD"] ?? [])
    if (!e.start && e.end && ANNUAL_FORMS.includes(e.form) && (!best || e.end > best)) best = e.end;
  return best;
}

/**
 * **LTM 구성 공백** — 이 개념이 회사의 최근 사업연도 값은 있는데 LTM 을 만들 분기 누적이 없다(연간에만 태깅). 여러 태그 중
 * 최댓값·첫 값을 고르는 지표(감가상각비 등)는 이런 태그가 하나라도 있으면 나머지 태그만으로 낸 LTM 이 부분값일 수 있어 공란으로 둔다.
 */
export function ltmGapConcept(facts: CompanyFacts, entries: FactUnitEntry[]): boolean {
  const fyEnd = latestAnnualEnd(facts);
  if (!fyEnd) return false;
  const hasFy = entries.some((e) => e.fp === "FY" && isFullYearDuration(e) && ANNUAL_FORMS.includes(e.form) && Math.abs(days(e.end, fyEnd)) <= 12);
  return hasFy && ltmFlowOf(entries, ltmAnchor(facts)).value == null;
}

/** 흐름 TTM 값만(ltmFlowOf). anchor = ltmAnchor(facts) */
export function ttmOf(entries: FactUnitEntry[], anchor: string | null): number | null {
  return ltmFlowOf(entries, anchor).value;
}

/**
 * 여러 후보 개념 중 **가장 최근 데이터가 있는 개념**의 LTM(태그 이전 후 옛 개념의 FY 값 방지 — NVIDIA 등). 값과 사유.
 */
export function bestLtmFlow(facts: CompanyFacts, concepts: string[], unit = "USD"): { value: number | null; reason: string | null } {
  let best: { value: number | null; reason: string | null } = { value: null, reason: null };
  let bestEnd = "";
  const anchor = ltmAnchor(facts);
  for (const c of concepts) {
    const es = entriesOf(facts, c, unit);
    if (!es.length) continue;
    const maxEnd = es.reduce((m, e) => (e.end > m ? e.end : m), "");
    if (maxEnd > bestEnd) {
      bestEnd = maxEnd;
      const r = ltmFlowOf(es, anchor);
      best = { value: r.value, reason: r.reason };
    }
  }
  return best;
}

// 매출원가 태그 판정(cogsConcepts)은 삭제 — 매출원가·매출총이익은 재무 5층 구조 지표(src/lib/fin metrics/cogs.ts)가 본표 계산 구조로
// 정한다(docs/metrics/cogs.md). 태그 우선순위 판정은 CAT 주석 조각·MCD 10-Q 가맹점 임차비용을 매출원가로 오인했다.
