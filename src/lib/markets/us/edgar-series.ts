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
 */
export function firstConcept(
  facts: CompanyFacts,
  concepts: string[],
  unit = "USD",
): FactUnitEntry[] {
  if (concepts.length === 1) return entriesOf(facts, concepts[0], unit);
  const out: FactUnitEntry[] = [];
  const seen = new Set<string>();
  for (const c of concepts) {
    for (const e of entriesOf(facts, c, unit)) {
      const key = `${e.start ?? ""}|${e.end}|${e.form}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out;
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
  const usdRounds = (x: number, y: number) =>
    Math.abs(x) >= 1e8 && x !== y && P.some((p) => Math.round(y / p) * p === x && y % p !== 0);
  // 주식수(shares)도 같은 규칙 — MRVL 2022-01-29 유통주식수: 그 해 10-K 846,695,000 → 2023 10-K 846,700,000(10만 주
  // 반올림). 주식수 공시 관행 단위(천·만·10만·백만 주)마다 값이 그 단위의 100배 이상일 때만(상대 오차 0.5% 이하 — USD 규칙과 같은 폭.
  // 자사주 매입·발행 같은 실제 변동이 우연히 원래 값의 반올림과 같아질 여지를 없앤다).
  const sharesRounds = (x: number, y: number) =>
    x !== y && [1e3, 1e4, 1e5, 1e6].some((p) => Math.abs(x) >= 100 * p && Math.round(y / p) * p === x && y % p !== 0);
  const clean = (es: FactUnitEntry[], roundsTo: (x: number, y: number) => boolean): FactUnitEntry[] => {
    const groups = new Map<string, FactUnitEntry[]>();
    for (const e of es) {
      const k = `${e.start ?? ""}|${e.end}`;
      const g = groups.get(k);
      if (g) g.push(e);
      else groups.set(k, [e]);
    }
    const drop = new Set<FactUnitEntry>();
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      for (const x of g) {
        if (g.some((y) => (y.filed ?? "") < (x.filed ?? "") && roundsTo(x.val, y.val))) drop.add(x);
      }
    }
    return drop.size ? es.filter((e) => !drop.has(e)) : es;
  };
  const out: CompanyFacts = { ...facts, facts: { ...facts.facts } };
  const gaap = facts.facts["us-gaap"];
  if (gaap) {
    const ng: NonNullable<CompanyFacts["facts"]["us-gaap"]> = {};
    for (const [concept, o] of Object.entries(gaap)) {
      const units: Record<string, FactUnitEntry[]> = {};
      for (const [u, es] of Object.entries(o.units)) units[u] = u === "USD" ? clean(es, usdRounds) : u === "shares" ? clean(es, sharesRounds) : es;
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

export function singleQuarter(
  entries: FactUnitEntry[],
  col: QuarterCol,
  prevCol: QuarterCol | undefined,
): number | null {
  const direct = directQuarterValue(entries, col);
  if (direct != null) return direct;
  const interim = entries.filter(
    (e) => INTERIM_FORMS.includes(e.form) && e.fp !== "FY" && e.start,
  );
  // 2) YTD 차감
  const ytd = (end: string) =>
    interim
      .filter((e) => Math.abs(days(end, e.end)) <= 6)
      .sort((a, b) => Math.abs(days(a.start!, a.end)) - Math.abs(days(b.start!, b.end)))
      .pop(); // 가장 긴 기간 = YTD
  const cur = ytd(col.end);
  if (!cur) return null;
  if (!prevCol) {
    // 회계연도 첫 분기로 추정 (start 가 fy 시작 근처면 YTD == 단일분기)
    return Math.abs(days(col.fyStartApprox, cur.start!)) <= 20 &&
      Math.abs(days(cur.start!, cur.end)) <= 100
      ? cur.val
      : null;
  }
  const prev = ytd(prevCol.end);
  if (!prev) return null;
  // 서로 같은 회계연도인지 (prev.start ≈ cur.start)
  if (Math.abs(days(cur.start!, prev.start!)) > 20) return cur.val; // 회계연도 바뀜 → cur 이 곧 단일분기 성격
  return cur.val - prev.val;
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
 * LTM 조합 — 최근 FY + 당기누적 − 전년동기누적(전년동기·당기누적이 없으면 FY). 외화 공시 기업은 각 구성요소의
 * 분기 합 환산값(ltmQ, edgar-foreign.ts)으로 더해 "최근 4개 분기 × 각 분기 평균 환율"이 된다(오너 결정 2026-09-25,
 * 인포맥스·Finviz 방식). 구성요소 하나라도 ltmQ 가 없으면 공시값(val, 기간 평균 환율) 조합.
 */
export function ttmCombine(
  fy: { val: number; ltmQ?: number; ltmNone?: boolean },
  cur?: { val: number; ltmQ?: number; form?: string } | null,
  prior?: { val: number; ltmQ?: number; form?: string } | null,
): number | null {
  // 20-F Yahoo 분기 LTM 에서 채우지 못한 항목 — FY 값으로 대신하지 않고 공란(edgar-yahoo-quarters.ts)
  if (fy.ltmNone) return null;
  if (!cur || !prior) return fy.ltmQ ?? fy.val;
  if (fy.ltmQ != null && cur.ltmQ != null && prior.ltmQ != null) return fy.ltmQ + cur.ltmQ - prior.ltmQ;
  // Yahoo 분기 구성요소는 LTM 전용 값(ltmQ) 조합으로만 — 공시값(val)과 섞으면 기간·원천이 섞인다
  if (cur.form === YAHOO_Q_FORM || prior.form === YAHOO_Q_FORM) return null;
  return fy.val + cur.val - prior.val;
}

/** 흐름 TTM = 최근 FY + 당기누적 − 전년동기누적. */
export function ttmOf(entries: FactUnitEntry[]): number | null {
  const annuals = entries
    .filter((e) => e.fp === "FY" && isFullYearDuration(e) && ANNUAL_FORMS.includes(e.form))
    .sort((a, b) => b.end.localeCompare(a.end) || vintageOrder(a, b));
  const fy = annuals[0];
  if (!fy?.start) return null;
  // 태그를 중단한 개념의 옛 연간값을 "최근 12개월"로 쓰지 않는다(감사 2026-09-23:
  // GE 는 OperatingIncomeLoss 를 몇 년 전에 끊었는데 그 마지막 연간값이 LTM 으로
  // 잡혀 EBITDA 가 3배로 나왔다). 최근 사업연도 종료가 550일보다 오래됐으면 없음.
  if (isStaleAnnual(fy.end)) return null;
  const interims = entries.filter((e) => e.start && LTM_INTERIM_FORMS.includes(e.form));
  const cur = interims
    .filter((e) => Math.abs(days(fy.end, e.start!)) <= 12 && e.end > fy.end)
    .sort((a, b) => b.end.localeCompare(a.end) || vintageOrder(a, b))[0];
  if (!cur?.start) return ttmCombine(fy);
  const wS = shiftYear(cur.start, -1);
  const wE = shiftYear(cur.end, -1);
  const prior = interims
    .filter(
      (e) =>
        e.start &&
        Math.abs(days(wS, e.start)) <= 12 &&
        Math.abs(days(wE, e.end)) <= 12,
    )
    .sort((a, b) => Math.abs(days(wE, a.end)) - Math.abs(days(wE, b.end)) || vintageOrder(a, b, cur.filed))[0];
  if (!prior) return ttmCombine(fy);
  return ttmCombine(fy, cur, prior);
}

/** 매출원가 후보 태그(기본 우선순위) */
export const COGS_CONCEPTS = ["CostOfGoodsAndServicesSold", "CostOfRevenue", "CostOfGoodsSold"];
const GP_CHECK_REVENUE = [
  "Revenues",
  "RevenueFromContractWithCustomerExcludingAssessedTax",
  "RevenueFromContractWithCustomerIncludingAssessedTax",
];

/**
 * 매출원가 태그 순서 — 매출총이익 태그가 있으면 **"매출 − 매출원가 = 매출총이익"이 성립하는 태그를 앞으로**.
 * BE 는 CostOfGoodsAndServicesSold 를 주석의 일부 항목(FY2025 1,800만 달러)에만 달고 본표 매출원가는 CostOfRevenue
 * (14.37억)로 공시해, 기본 우선순위로는 매출원가 행이 1,800만 달러 · LTM 매출총이익 ≠ 매출 − 매출원가가 됐다(검증 D층
 * 2026-09-25). 판정은 세 값이 다 있는 가장 최근 사업연도 기준(0.5% 안), 성립하는 태그가 없으면 기본 순서.
 */
export function cogsConcepts(facts: CompanyFacts): string[] {
  const gp = annualByYear(entriesOf(facts, "GrossProfit"));
  if (!gp.size) return COGS_CONCEPTS;
  const revs = GP_CHECK_REVENUE.map((c) => annualByYear(entriesOf(facts, c)));
  const fits = (c: string): boolean | null => {
    const cg = annualByYear(entriesOf(facts, c));
    const years = [...cg.keys()].filter((y) => gp.has(y) && revs.some((r) => r.has(y))).sort((a, b) => b - a);
    if (!years.length) return null;
    const y = years[0];
    return revs.some((r) => {
      const rv = r.get(y);
      return rv != null && Math.abs(rv - cg.get(y)! - gp.get(y)!) <= Math.abs(rv) * 0.005;
    });
  };
  const ok = COGS_CONCEPTS.filter((c) => fits(c) === true);
  return ok.length ? [...ok, ...COGS_CONCEPTS.filter((c) => !ok.includes(c))] : COGS_CONCEPTS;
}
