import "server-only";
import type { CompanyFacts, FactUnitEntry } from "./edgar";

/**
 * **20-F 발행사 LTM 최신 분기 — 인포맥스(FactSet) 분기** (오너 결정 2026-09-25, Yahoo 분기 보강을 대체).
 * 20-F 발행사(TSM·ASML·SPOT 등)는 SEC 에 분기 XBRL 이 없어 LTM 이 최근 사업연도(FY)에 머물렀다.
 *
 * 방식 — **LTM 전체 = 인포맥스 최근 4개 분기 합**(USD, FactSet 환율 그대로, 앱 환산 안 함).
 *   "SEC FY(앱 환산) + 인포맥스 이후 분기 − 인포맥스 전년 동기" 조합은 한 LTM 안에 환율 원천 두 개(앱 연평균 · FactSet
 *   분기)가 섞여 택하지 않았다(두 방식 대조는 작업 보고 참고). 구현은 LTM 조합(edgar-series.ttmCombine: FY + 당기누적
 *   − 전년동기누적)을 그대로 쓰되, 세 구성요소의 LTM 전용 값(ltmQ)을 인포맥스 분기 합으로 둔다:
 *     FY.ltmQ = 인포맥스 FY 4개 분기 합, 당기누적 = FY 이후 분기 합, 전년동기누적 = FY 의 같은 위치 분기 합
 *   → 조합 결과 = 인포맥스 최근 4개 분기 합(항등식). 표시·연도 열 값(val)은 SEC 그대로.
 *
 * 정의 차이 표기(차단 사유 아님 — 오너 결정 2026-09-25): 매출·영업이익·순이익의 인포맥스 연간(y_report) ÷ 앱 SEC FY
 *   비율에서 **공통 환율분**(세 비율의 중앙값)을 뺀 나머지가 0.1% 를 넘는 항목은 "LTM 은 FactSet 정의 — SEC 연도 열 대비
 *   정의 차 x%"로 화면에 적는다(TSM 순이익 +1.19%, SPOT 영업이익 +0.36% 실측).
 * 차단 조건(불성립이면 전 항목 보강 안 함 — FY 유지 + 사유. 항목마다 기간이 섞이지 않게):
 *   1. 인포맥스 FY 연간이 있음(정의 차이 계산용)
 *   2. 인포맥스 분기가 SEC FY 이후 1~3개 연속, FY 4개 분기 모두 있음
 * 감가상각비 = 인포맥스 EBITDA − 영업이익(FactSet). 재무상태표(최신 분기 BS)는 보강하지 않는다 — EV 차입금은 여러 태그의
 * 본표 구조 합(edgar-bs-structure·edgar-ev)이라 인포맥스 한 값과 태그 단위로 대응시킬 수 없다.
 * 인포맥스: globalmonitor.einfomax.co.kr 종목분석 공개 API(current-shares.ts 와 같은 도메인, 로그인 불필요, 백만 달러).
 */

export const INFOMAX_Q_FORM = "INFOMAX-Q";
const IM_BASE = "https://globalmonitor.einfomax.co.kr";

interface ImRow {
  end: string;
  rev: number | null;
  op: number | null;
  ni: number | null;
  ebitda: number | null;
}
export interface InfomaxQuarters {
  code: string;
  annual: ImRow[];
  quarterly: ImRow[];
}

async function imPost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(IM_BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", referer: `${IM_BASE}/sss.html` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`인포맥스 ${path} HTTP ${r.status}`);
  return (await r.json()) as T;
}

/** 인포맥스 연간·분기 재무(백만 달러 → 달러). 종목 없음 = null, 조회 실패 = 예외 */
export async function loadInfomaxQuarters(ticker: string): Promise<InfomaxQuarters | null> {
  const t = await imPost<{ _source?: { 인포맥스코드?: string; 티커?: string } }>("/facset/tickerlist/usa", { ticker });
  const src = t?._source;
  if (!src?.인포맥스코드 || src.티커?.toUpperCase() !== ticker.toUpperCase()) return null;
  const k = await imPost<{ y_report?: Record<string, unknown>[]; q_report?: Record<string, unknown>[] }>("/facset/getKeyData", { param: src.인포맥스코드 });
  const M = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v * 1e6 : null);
  const row = (r: Record<string, unknown>): ImRow => ({
    end: String(r["결산년월"]).slice(0, 10),
    rev: M(r["매출"]),
    op: M(r["영업이익"]),
    ni: M(r["당기순익"]),
    ebitda: M(r["ebitda"]),
  });
  return { code: src.인포맥스코드, annual: (k.y_report ?? []).map(row), quarterly: (k.q_report ?? []).map(row) };
}

type Units = Record<string, FactUnitEntry[]>;
type Ns = Record<string, { label?: string; description?: string; units: Units }>;

const DAY = 864e5;
const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / DAY;
const monthEndShift = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + n + 1, 0)).toISOString().slice(0, 10);
};
const isMonthEnd = (d: string) => monthEndShift(d, 0) === d;

/** 항목 → 후보 us-gaap 개념(외화·IFRS 정규화 후). SEC 최근 FY 가 있는 첫 개념에 붙인다 */
const ITEMS: { key: "rev" | "op" | "ni" | "da"; label: string; concepts: string[]; defCheck: boolean }[] = [
  { key: "rev", label: "매출", concepts: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "RevenueFromContractWithCustomerIncludingAssessedTax"], defCheck: true },
  { key: "op", label: "영업이익", concepts: ["OperatingIncomeLoss"], defCheck: true },
  { key: "ni", label: "순이익", concepts: ["NetIncomeLoss"], defCheck: true },
  // 감가상각비 합계 태그 — 있는 것 전부에 같은 값(LTM 감가상각비 규칙이 합계 태그 중 최댓값을 쓰므로 섞이지 않게)
  { key: "da", label: "감가상각비", concepts: ["DepreciationDepletionAndAmortization", "DepreciationAndAmortization", "DepreciationAmortizationAndAccretionNet"], defCheck: false },
];

export type InfomaxLtmResult =
  | {
      source: "infomax";
      through: string;
      items: string[];
      ratios: Record<string, number>;
      /** 공통 환율분을 뺀 정의 차(인포맥스 ÷ SEC − 1, 0.1% 초과 항목만) — 화면 표기용 */
      definitionDiffs: { label: string; pct: number }[];
    }
  | { source: "none"; reason: string; ratios: Record<string, number> };

/** 정규화(USD) 이후의 facts 에 인포맥스 분기 LTM 을 붙인다 */
export function withInfomaxLtm(facts: CompanyFacts, im: InfomaxQuarters): { facts: CompanyFacts; result: InfomaxLtmResult } {
  const gaap = (facts.facts["us-gaap"] ?? {}) as Ns;
  const ratios: Record<string, number> = {};
  const fail = (reason: string) => ({ facts, result: { source: "none" as const, reason, ratios } });
  const imVal = (r: ImRow | undefined, key: "rev" | "op" | "ni" | "da") =>
    !r ? null : key === "da" ? (r.ebitda != null && r.op != null ? r.ebitda - r.op : null) : r[key];

  // 항목별 SEC 최근 FY 개념
  const plan: { key: "rev" | "op" | "ni" | "da"; label: string; concepts: string[]; fy: FactUnitEntry }[] = [];
  for (const it of ITEMS) {
    const found: { c: string; fy: FactUnitEntry }[] = [];
    for (const c of it.concepts) {
      const fy = (gaap[c]?.units?.USD ?? [])
        .filter((e) => e.start && /^(20-F|10-K)/.test(e.form) && e.fp === "FY" && days(e.start, e.end) > 350 && days(e.start, e.end) < 380)
        .sort((a, b) => b.end.localeCompare(a.end) || (b.filed ?? "").localeCompare(a.filed ?? ""))[0];
      if (fy) found.push({ c, fy });
    }
    if (!found.length) {
      if (it.key !== "da") return fail(`SEC 연간 ${it.label} 없음`);
      continue; // 감가상각비 합계 태그가 없는 회사 — EBITDA LTM 은 기존 규칙
    }
    const E = found.map((f) => f.fy.end).sort().pop()!;
    plan.push({ key: it.key, label: it.label, concepts: found.filter((f) => f.fy.end === E).map((f) => f.c), fy: found.find((f) => f.fy.end === E)!.fy });
  }
  const E = plan[0].fy.end;
  if (plan.some((p) => p.fy.end !== E)) return fail("항목마다 SEC 최근 FY 가 다름");
  if (!isMonthEnd(E)) return fail("달 말 결산 아님");

  // 조건 1 — 정의가 같은 항목의 인포맥스 연간 ÷ SEC FY 비율이 항목 공통(환율 원천 차이뿐)
  const imFy = im.annual.find((r) => Math.abs(days(r.end, E)) <= 10);
  if (!imFy) return fail(`인포맥스 FY${E.slice(0, 4)} 연간 없음`);
  for (const p of plan) {
    if (!ITEMS.find((i) => i.key === p.key)!.defCheck) continue;
    const v = imVal(imFy, p.key);
    if (v == null || !p.fy.val) return fail(`인포맥스 FY${E.slice(0, 4)} ${p.label} 없음`);
    ratios[p.label] = v / p.fy.val;
  }
  // 공통 환율분 = 세 비율의 중앙값. 나머지(정의 차)가 0.1% 를 넘는 항목은 표기
  const rs = Object.values(ratios).sort((a, b) => a - b);
  const common = rs[Math.floor(rs.length / 2)];
  const definitionDiffs = Object.entries(ratios)
    .map(([label, r]) => ({ label, pct: (r / common - 1) * 100 }))
    .filter((d) => Math.abs(d.pct) > 0.1);

  // 조건 2 — 분기
  const qByEnd = new Map(im.quarterly.map((r) => [r.end, r]));
  const fyQ = [-9, -6, -3, 0].map((k) => monthEndShift(E, k));
  if (fyQ.some((d) => !qByEnd.has(d))) return fail(`인포맥스 FY${E.slice(0, 4)} 분기 누락`);
  const newQ: string[] = [];
  for (let i = 1; i <= 4 && qByEnd.has(monthEndShift(E, 3 * i)); i++) newQ.push(monthEndShift(E, 3 * i));
  if (!newQ.length) return fail(`SEC FY${E.slice(0, 4)} 이후 인포맥스 분기 없음`);
  if (newQ.length >= 4) return fail("인포맥스 분기가 SEC 연간보다 1년 이상 앞섬 — 새 연간 공시 대기");
  // 모든 항목이 모든 분기에 값이 있어야 한다(항목마다 기간이 달라지지 않게)
  for (const p of plan) for (const d of [...fyQ, ...newQ]) if (imVal(qByEnd.get(d), p.key) == null) return fail(`인포맥스 ${d} ${p.label} 없음`);

  const today = new Date().toISOString().slice(0, 10);
  const last = newQ[newQ.length - 1];
  const priorQ = fyQ.slice(0, newQ.length);
  const out: Ns = { ...gaap };
  for (const p of plan) {
    const sum = (ds: string[]) => ds.reduce((a, d) => a + imVal(qByEnd.get(d), p.key)!, 0);
    const fySum = sum(fyQ), curSum = sum(newQ), priorSum = sum(priorQ);
    const base = { fy: Number(E.slice(0, 4)) + 1, fp: "Q", form: INFOMAX_Q_FORM, filed: today };
    for (const c of p.concepts) {
      const arr = out[c].units.USD.map((e) =>
        e.start === p.fy.start && e.end === E && /^(20-F|10-K)/.test(e.form) && e.fp === "FY" ? { ...e, ltmQ: fySum } : e,
      );
      arr.push(
        { ...base, start: new Date(Date.parse(`${E}T00:00:00Z`) + DAY).toISOString().slice(0, 10), end: last, val: curSum, ltmQ: curSum },
        { ...base, start: p.fy.start!, end: priorQ[priorQ.length - 1], val: priorSum, ltmQ: priorSum },
      );
      out[c] = { ...out[c], units: { ...out[c].units, USD: arr } };
    }
  }
  return {
    facts: { ...facts, facts: { ...facts.facts, "us-gaap": out } } as CompanyFacts,
    result: { source: "infomax", through: last, items: plan.map((p) => p.label), ratios, definitionDiffs },
  };
}
