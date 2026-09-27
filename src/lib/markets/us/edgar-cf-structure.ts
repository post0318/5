import "server-only";
import { fetchJson, fetchText } from "../http";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import type { RecentFilings } from "./edgar-gapfill";

/**
 * **감가상각비 = 현금흐름표 본표의 감가상각·상각 줄**(10-K·10-Q 계산 구조 `_cal.xml`, 영업활동 조정 항목).
 *
 * 표준 태그 조합(`DA_TOTAL` 최댓값 / 감가상각+무형상각)은 회사가 본표에 고유 태그를 쓰면 일부만 잡았다(검증
 * 2026-09-24, Yahoo·StockAnalysis 두 곳이 서로 같고 앱만 낮았던 사례):
 * - TSLA: 본표 줄 `tsla_DepreciationAmortizationAndImpairment`(2023 46.67억) → 앱은 `Depreciation` 33.30억만.
 * - AVGO 2022: 무형자산 상각 태그가 2023 부터만 있어 감가상각 5.29억만(본표 `avgo_Amortizationof…` 포함 약 50억).
 * - AMD·UBER: 본표 줄 구성과 태그 조합이 달랐다.
 * 18종목 실측에서 본표 합이 StockAnalysis 와 달러 단위까지 일치(TSLA·AMD·AVGO·UBER·AAPL·GOOG·META·NVDA·
 * WMT·KO·DIS·INTC). PEP·MU·IBM 은 본표 = 기존 앱 값(StockAnalysis 만 다름).
 *
 * 제외: 사채할인·발행비 상각, 주식보상, 운용리스 사용권자산 상각(임차료 성격), 콘텐츠 상각(NFLX — edgar-content.ts
 * 가 따로 더한다), 투자·계약원가 상각. 단 라벨이 "Depreciation…" 으로 시작하는 한 줄에 섞여 있으면(AMZN — "감가상각
 * 및 상각: 유형자산·자본화 콘텐츠·운용리스 자산·기타") 줄을 나눌 수 없어 그대로 쓴다(데이터 업체도 그 줄 전체).
 *
 * 계산 구조가 없는 공시(MSFT·ORCL)와 구조로 덮이지 않는 옛 기간은 edgar-ev.ts 의 태그 규칙 그대로.
 */

export const SYN_DA_CF = "DepreciationAmortizationCashFlowDerived";

const UA = process.env.SEC_USER_AGENT ?? "global-market-research (personal use) contact@example.com";
const H = { "user-agent": UA, "accept-encoding": "gzip, deflate" };

const DA = /deprecia|amortiz/i;
// 개념명(카멜케이스)·라벨(띄어쓰기) 둘 다에 맞도록 공백을 선택으로 둔다.
// 운용리스가 섞인 사용권자산 상각 줄은 제외(COST "Non-cash lease expense" = 운용+금융리스 합 303 — 운용리스 비용은
// 임차료 성격이라 EBITDA 에 이미 반영, 대차대조표 차입금의 운용·금융 혼합 리스 줄 제외와 같은 원칙). 금융리스 단독 줄은 포함.
const NOT_DA = /debt|discount|premium|issuance|financing ?costs?|deferred ?(financing|charges)|stock|share-?based|compensation|operating\w*lease|lease ?expense|content|contract ?(cost|acquisition)|capitalized ?software|investment|securities|bond|inventory|incentive|acquisition ?costs|defined ?benefit|pension|postretirement/i;
const OP_CF_ROOT = /^us-gaap_NetCashProvidedByUsedInOperatingActivities(ContinuingOperations)?$/;

interface Filing { accn: string; form: string; filed: string }

function locs(x: string): Map<string, string> {
  const loc = new Map<string, string>();
  for (const l of x.matchAll(/<(?:link:)?loc\b([^>]*)\/?>/g)) {
    const id = /xlink:label="([^"]+)"/.exec(l[1])?.[1];
    const href = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1];
    if (id && href) loc.set(id, href);
  }
  return loc;
}

/** 개념 id → 표시 라벨 목록(정의문 제외) */
function labels(lab: string): Map<string, string[]> {
  const loc = locs(lab);
  const text = new Map<string, string[]>();
  for (const m of lab.matchAll(/<(?:link:)?label\b([^>]*)>([^<]*)<\/(?:link:)?label>/g)) {
    const id = /xlink:label="([^"]+)"/.exec(m[1])?.[1];
    if (!id || /xlink:role="[^"]*documentation"/i.test(m[1])) continue;
    text.set(id, [...(text.get(id) ?? []), m[2].trim()]);
  }
  const out = new Map<string, string[]>();
  for (const a of lab.matchAll(/<(?:link:)?labelArc\b([^>]*)\/?>/g)) {
    const from = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? "");
    const t = text.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
    if (from && t) out.set(from, [...(out.get(from) ?? []), ...t]);
  }
  return out;
}

export interface CashFlowDaStructure {
  /** 감가상각·상각 줄 개념 id */
  lines: string[];
  /** 라벨·개념명에 손상(impairment)이 함께 묶인 줄(TSLA "Depreciation, amortization and impairment", XOM
   *  "Depreciation and depletion (includes impairments)") */
  impairLines: string[];
  /** 현금흐름표에 따로 있는 손상 줄(감가상각 줄과 별개) — 손상 금액 후보에서 뺀다 */
  separateImpair: string[];
  /** 감가상각 줄이 계속사업 소계 아래(또는 계속사업 이익에서 출발)에 있다 — 중단사업 감가상각이 이미 빠져 있다 */
  continuing: boolean;
}

/** 현금흐름표 영업활동 조정 항목 중 감가상각·상각 줄. 현금흐름표 역할이 없으면 null */
export function cashFlowDaLines(cal: string, lab: Map<string, string[]>): CashFlowDaStructure | null {
  for (const m of cal.matchAll(/<(?:link:)?calculationLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/(?:link:)?calculationLink>/g)) {
    const role = m[1].split("/").pop() ?? "";
    if (!/CASHFLOW/i.test(role) || /Detail|Table|Parenth|Supplement/i.test(role)) continue;
    const loc = locs(m[2]);
    const arcs: { from: string; to: string }[] = [];
    for (const a of m[2].matchAll(/<(?:link:)?calculationArc\b([^>]*)\/?>/g)) {
      const from = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? "");
      const to = loc.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
      if (from && to) arcs.push({ from, to });
    }
    const root = arcs.find((a) => OP_CF_ROOT.test(a.from))?.from;
    if (!root) continue;
    const out: string[] = [];
    const impairLines: string[] = [];
    const separateImpair: string[] = [];
    const contFlags: boolean[] = [];
    const seen = new Set<string>();
    const walk = (id: string, depth: number, cont: boolean) => {
      if (depth > 3) return;
      const children = arcs.filter((x) => x.from === id);
      // 계속사업 기준 판정 — 이 노드가 계속사업 소계이거나, 형제 줄에 중단사업 손익 차감·계속사업 이익 출발 줄이 있으면
      // (GE·EMR "Cash from operating activities – continuing operations", DD·BAX·HON "Income from continuing operations")
      // 중단사업 "처분이익"만 빼는 줄(JNJ "(Gain) on separation of Kenvue")은 중단사업 전체 손익 차감이 아니라 제외
      const childCont =
        cont ||
        /ContinuingOperations/.test(id) ||
        children.some((c) => /^us-gaap_(IncomeLossFromDiscontinuedOperations|DiscontinuedOperationIncomeLossFromDiscontinuedOperation|IncomeLossFromContinuingOperations)/.test(c.to));
      for (const a of children) {
        if (seen.has(a.to)) continue;
        seen.add(a.to);
        const concept = a.to.slice(a.to.indexOf("_") + 1);
        const labs = lab.get(a.to) ?? [];
        const impairText = /impair/i.test(`${concept} ${labs.join(" ")}`);
        // 표준 개념은 이름으로만 판정 — 회사 라벨 파일이 틀린 경우가 있다(AMD FY2024: 취득 무형자산 상각
        // AdjustmentForAmortization 에 "운용리스 사용권자산 상각" 라벨이 붙어 3,548 이 빠졌다). 회사 고유 개념만 라벨로.
        const std = a.to.startsWith("us-gaap_");
        const text = std ? concept : labs.join(" | ") || concept;
        // 회사 고유 줄의 주 라벨이 감가상각·무형자산 상각으로 시작하면 제외어가 섞여 있어도 포함(ISRG "Amortization of
        // intangible and other assets" — 표준 라벨의 "Contract Acquisition" 에 걸려 빠졌다, Yahoo 677.1 = 615 + 62)
        const leadsWithDep = !std && labs.some((l) => /^(depreciation|amortization of (acquired |acquisition-related )?intangible)/i.test(l));
        if (DA.test(text) && (!NOT_DA.test(text) || leadsWithDep)) {
          out.push(a.to);
          contFlags.push(childCont);
          // 손상 포함 여부는 라벨로도 본다 — XOM 은 표준 개념 DepreciationDepletionAndAmortization 에 회사 라벨
          // "(includes impairments)" 를 달았다. 손상 금액을 찾아 뺄 때만 쓰므로 라벨 오류의 영향은 없다(태그가 없으면 0).
          if (impairText) impairLines.push(a.to);
        } else {
          if (impairText && !/inventor/i.test(`${concept} ${labs.join(" ")}`)) separateImpair.push(a.to);
          walk(a.to, depth + 1, childCont);
        }
      }
    };
    walk(root, 0, /ContinuingOperations/.test(root));
    return { lines: out, impairLines, separateImpair, continuing: contFlags.length > 0 && contFlags.every(Boolean) };
  }
  return null;
}

// ── 감가상각 줄에 섞인 손상차손·중단사업 감가상각 (오너 결정 2026-09-24) ─────────────────────
// 원칙: EBITDA = 영업이익 + 감가상각비, 둘은 같은 범위여야 하고 감가상각비에 손상차손은 들어가지 않는다.
// ① 손상 포함 줄(TSLA·XOM): 그 공시 원본의 손상 태그 금액을 뺀다. TSLA 2022 3,747 − 디지털자산 손상 204 = 3,543,
//    XOM 2022 24,040 − (사할린 4,500 + 기타 업스트림 1,500 + 에너지제품 400) = 17,640 — StockAnalysis 와 일치, 10-K 본문
//    ("Other before-tax impairment charges … included $1.5 billion in Upstream and $0.4 billion in Energy Products")과도 일치.
//    손상이 공시되지 않은 기간(태그 없음 — XOM 2024 "immaterial")은 빼지 않는다.
// ② 중단사업(WDC 샌디스크 분사·MMM 솔벤텀·JNJ 켄뷰): 영업이익은 계속사업 기준인데 현금흐름표 감가상각 줄은 중단사업을
//    포함한다(현금흐름표가 전체 순이익에서 출발) → 같은 공시의 중단사업 감가상각 태그를 뺀다. WDC FY2025 451 − 115 = 336.
//    현금흐름표가 계속사업 소계로 나뉘어 있으면(GE·EMR·DD) 이미 계속사업 값이라 손대지 않는다.
// 금액을 공시 원본에서 확인하지 못한 기간(중단사업 손익은 있는데 중단사업 감가상각 태그가 없음, 손상 금액이 줄 전체
// 이상 등)은 줄 값을 그대로 둔다 — 추정으로 빼지 않는다. EBITDA 를 비우려면 영업이익 대체 경로(감가상각 없으면 영업이익
// 그대로·근사 표시)를 모든 화면에서 함께 막아야 해서 이번 범위에서 하지 않았다(검증 도구가 그 기간을 미결로 표시).

/** 인스턴스의 기간 값(차원 포함): 개념 id·기간·차원(축=멤버) 목록 */
interface InstFact { id: string; period: string; dims: [string, string][]; val: number }

function instanceFacts(xml: string, want: (id: string) => boolean): InstFact[] {
  const ctx = new Map<string, { period: string; dims: [string, string][] }>();
  for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
    const s = /<(?:xbrli:)?startDate>\s*([^<\s]+)/.exec(m[2])?.[1];
    const e = /<(?:xbrli:)?endDate>\s*([^<\s]+)/.exec(m[2])?.[1];
    if (!s || !e) continue;
    const dims = [...m[2].matchAll(/dimension="([^"]+)"[^>]*>\s*([^<\s]+)\s*</g)].map((d) => [d[1], d[2]] as [string, string]);
    ctx.set(m[1], { period: `${s}|${e}`, dims });
  }
  const out: InstFact[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*)>\s*(-?[\d.]+)\s*<\/\1:\2>/g)) {
    const id = `${m[1]}_${m[2]}`;
    if (!want(id) || !/unitRef="[^"]*usd/i.test(m[3])) continue;
    const c = ctx.get(/contextRef="([^"]+)"/.exec(m[3])?.[1] ?? "");
    if (!c) continue;
    const key = `${id}|${c.period}|${c.dims.map((d) => d.join("=")).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, period: c.period, dims: c.dims, val: Number(m[4]) });
  }
  return out;
}

const local = (id: string) => id.slice(id.indexOf("_") + 1);
// 손상차손 태그 — 유형·무형자산·영업권 손상. 재고·채권·투자·지분법·세후·누계·처분손익 결합·구조조정 결합은 제외
const IMPAIR = /Impairment|WriteDown|Writeoff|WriteOff/;
const IMPAIR_EXCL = /Inventor|Receivable|Loan|Credit|Securit|Investment|EquityMethod|OtherThanTemporary|Tax|Accumulated|Reversal|Recover|PerShare|Percent|Discontinued|Allowance|Debt|Contract|Unrealized|Gain|Restructuring|Deprecia|Amortiz|Number|Count/;
const isImpair = (id: string) => IMPAIR.test(local(id)) && !IMPAIR_EXCL.test(local(id));
// 중단사업 감가상각·상각 태그(WDC·MMM DepreciationAndAmortizationDiscontinuedOperations, JNJ
// DisposalGroupIncludingDiscontinuedOperationDepreciationAndAmortization). 상각만 있는 태그(DD 무형상각)는 일부라 제외
const isDiscDa = (id: string) => /Discontinued|DisposalGroup/.test(local(id)) && /Depreciation\w*Amortization/.test(local(id)) && !/Accumulated|PerShare/.test(local(id));
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * 1e-9);

/**
 * 한 기간의 손상차손 합(공시 원본). 개념마다: 차원 없는 값 N, 단일 축 차원 값은 축별 합.
 * - 어떤 축의 합이 N 과 같으면 N 의 내역 → N.
 * - 아니면 N + 축별 합(같은 합의 축은 한 번) — XOM 2023: N 3,300(산타이네즈) + 부문 "기타" 300·300·100 = 4,000,
 *   XOM 2025: 부문 1,600·100 + 본사 300 = 2,000(차원 값만). 10-K 본문 문장과 대조해 확인한 구조.
 * - 부문 합계 멤버(OperatingSegmentsMember)는 중복이라 뺀다.
 * 개념 사이(TSLA ImpairmentOfIntangibleAssetsExcludingGoodwill ⊇ …Indefinitelived…)는 포함관계라 최댓값.
 */
function impairmentOf(facts: InstFact[], period: string, exclude: Set<string>): number {
  const byConcept = new Map<string, { n?: number; axes: Map<string, Map<string, number>> }>();
  for (const f of facts) {
    if (f.period !== period || !isImpair(f.id) || exclude.has(f.id)) continue;
    const c: { n?: number; axes: Map<string, Map<string, number>> } = byConcept.get(f.id) ?? { axes: new Map() };
    if (f.dims.length === 0) c.n ??= f.val;
    else if (f.dims.length === 1 && !/OperatingSegmentsMember$/.test(f.dims[0][1])) {
      const ax = c.axes.get(f.dims[0][0]) ?? new Map<string, number>();
      if (!ax.has(f.dims[0][1])) ax.set(f.dims[0][1], f.val);
      c.axes.set(f.dims[0][0], ax);
    }
    byConcept.set(f.id, c);
  }
  let best = 0;
  for (const c of byConcept.values()) {
    const sums: number[] = [];
    for (const ax of c.axes.values()) {
      const s = [...ax.values()].reduce((a, b) => a + b, 0);
      if (!sums.some((x) => near(x, s))) sums.push(s);
    }
    const total = c.n != null && sums.some((s) => near(s, c.n!)) ? c.n : (c.n ?? 0) + sums.reduce((a, b) => a + b, 0);
    best = Math.max(best, total);
  }
  return best;
}

/** 한 기간의 중단사업 감가상각·상각(공시 원본). 차원 없는 값 우선, 없으면 처분그룹별 값의 합. 없으면 null */
function discontinuedDaOf(facts: InstFact[], period: string): number | null {
  let best: number | null = null;
  for (const id of new Set(facts.filter((f) => f.period === period && isDiscDa(f.id)).map((f) => f.id))) {
    const fs = facts.filter((f) => f.id === id && f.period === period);
    const n = fs.find((f) => f.dims.length === 0)?.val;
    let v = n;
    if (v == null) {
      // 처분그룹 축(…ByDisposalGroups…Axis) 멤버별 한 번씩 — 분류 축(DisposalGroupClassificationAxis)만 있으면 그 멤버별
      const byGroup = new Map<string, number>();
      for (const f of fs) {
        const g = f.dims.find((d) => /DisposalGroups?Including|ByDisposalGroup/i.test(d[0])) ?? f.dims[0];
        if (g && !byGroup.has(g[1])) byGroup.set(g[1], f.val);
      }
      v = byGroup.size ? [...byGroup.values()].reduce((a, b) => a + b, 0) : undefined;
    }
    if (v != null) best = Math.max(best ?? 0, v);
  }
  return best;
}

const DISC_NI = /^(IncomeLossFromDiscontinuedOperations\w*|DiscontinuedOperation(IncomeLoss|GainLoss)\w*)$/;

/** 인스턴스의 차원 없는 기간 값: id → "start|end" → 값 */
function durationValues(xml: string, ids: Set<string>): Map<string, Map<string, number>> {
  const ctx = new Map<string, string>();
  for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
    if (/dimension="/.test(m[2])) continue;
    const s = /<(?:xbrli:)?startDate>\s*([^<\s]+)/.exec(m[2])?.[1];
    const e = /<(?:xbrli:)?endDate>\s*([^<\s]+)/.exec(m[2])?.[1];
    if (s && e) ctx.set(m[1], `${s}|${e}`);
  }
  const out = new Map<string, Map<string, number>>();
  for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*)>\s*(-?[\d.]+)\s*<\/\1:\2>/g)) {
    const id = `${m[1]}_${m[2]}`;
    if (!ids.has(id)) continue;
    const k = ctx.get(/contextRef="([^"]+)"/.exec(m[3])?.[1] ?? "");
    if (!k || !/unitRef="[^"]*usd/i.test(m[3])) continue;
    const byPeriod = out.get(id) ?? new Map<string, number>();
    if (!byPeriod.has(k)) byPeriod.set(k, Number(m[4]));
    out.set(id, byPeriod);
  }
  return out;
}

/**
 * 감가상각비 본표 판독 대상 정기공시(최신순) — 10-K 최근 `nK` 건 + 두 번째 최근 10-K 이후 제출된 10-Q 전부.
 * 분기 열 5개(최신 분기가 1분기여도 직전 사업연도 1분기까지)와 그 누적 차감·Q4(사업연도 − 9개월)·LTM 전년 동기 누적이 모두
 * 이 범위의 10-Q(당기 누적 + 전년 동기 비교 누적)에 실린다. 콘텐츠 상각(edgar-content.ts)도 같은 범위를 쓴다.
 */
export function filingsForDa(recent: RecentFilings, nK = 5): Filing[] {
  const out: Filing[] = [];
  let k10 = 0;
  for (let i = 0; i < recent.form.length && k10 < nK; i++) {
    const form = recent.form[i];
    if (form === "10-K") k10++;
    else if (!(form === "10-Q" && k10 <= 1)) continue;
    out.push({ accn: recent.accessionNumber[i], form, filed: recent.filingDate[i] });
  }
  return out;
}

export async function withCashFlowDa(cik: string, facts: CompanyFacts, recent: RecentFilings | null): Promise<CompanyFacts> {
  // 콘텐츠 상각 회사(NFLX)는 edgar-content.ts 합성값이 감가상각비 — 본표 줄과 섞지 않는다
  if (!recent || (facts as CompanyFacts & { contentAmortization?: boolean }).contentAmortization) return facts;
  const g = facts.facts["us-gaap"] ?? {};
  const filings: (Filing & { instName: string; base: string; lines: CashFlowDaStructure | null })[] = [];
  // 10-K 5건 + **두 번째 최근 10-K 이후의 10-Q 전부**(2026-09-27) — 분기 열(최근 5개, Q4 = 사업연도 − 9개월)·LTM 이 연간과 같은
  // 본표 규칙으로 계산되도록 각 분기를 담은 10-Q(누적)를 모두 읽는다. 예전엔 최신 10-Q 1건만 읽어 나머지 분기가 태그 규칙으로
  // 대체됐다(PEP 2025 Q4 1,192 vs 본표 1,136 · XOM 2025 Q4 손상 2,000 미조정 · AVGO 분기마다 약 34 — 검증기 --metric=da)
  const periodicFilings = filingsForDa(recent);
  for (const p of periodicFilings) filings.push({ ...p, instName: "", base: "", lines: null });
  if (!filings.length) return facts;
  const opt = { headers: H, revalidate: 60 * 60 * 24, timeoutMs: 30_000 };
  // 조회 실패는 올린다(로더가 감가상각비를 공란 + 사유로 — sec-unavailable.ts). 예전엔 삼키고 태그 규칙으로 조용히 대체했다
  for (const f of filings) {
    f.base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${f.accn.replace(/-/g, "")}`;
    const idx = await fetchJson<{ directory: { item: { name: string }[] } }>(`${f.base}/index.json`, opt);
    const names = idx.directory.item.map((i) => i.name);
    // 계산 구조·라벨을 스키마(.xsd) 안에 넣어 제출하는 회사(MSFT·ORCL 2026~)는 .xsd 에서 읽는다
    const xsd = names.find((n) => /\.xsd$/i.test(n));
    const cal = names.find((n) => /_cal\.xml$/i.test(n)) ?? xsd;
    const lab = names.find((n) => /_lab\.xml$/i.test(n)) ?? xsd;
    f.instName = names.find((n) => /_htm\.xml$/i.test(n)) ?? "";
    if (!cal || !lab) continue;
    const [c, l] = await Promise.all([fetchText(`${f.base}/${cal}`, opt), fetchText(`${f.base}/${lab}`, opt)]);
    f.lines = cashFlowDaLines(c, labels(l));
  }

  const cfVal = (concept: string, start: string, end: string): number | undefined => {
    let best: FactUnitEntry | undefined;
    for (const e of g[concept]?.units?.USD ?? [])
      if (e.start === start && e.end === end && (!best || (e.filed ?? "") > (best.filed ?? ""))) best = e;
    return best?.val;
  };
  const out: FactUnitEntry[] = [];
  const done = new Set<string>();
  /** 기간별 조정 미확인 사유 — 손상(imp)·중단사업 감가상각(disc) */
  const unresolvedOf = new Map<FactUnitEntry, "imp" | "disc" | null>();
  /** 중단사업 감가상각을 차감한 기간이 있었는가 */
  let discAdjusted = false;
  /** 판독한 구조(공시별 감가상각 줄·현금흐름표 기간·그 공시 현금흐름표의 줄 값) — 기준 혼합 판정용 */
  const structs: { accn: string; lines: string[]; periods: Set<string>; vals: Map<string, number> }[] = [];
  for (const f of filings) {
    const struct = f.lines;
    const lines = struct?.lines;
    if (!struct || !lines?.length) continue;
    // 이 공시의 현금흐름표 기간 — 같은 날 제출된 영업활동 현금흐름(당기·전기, 10-Q 는 누적)
    const periods = new Set<string>();
    for (const e of g.NetCashProvidedByUsedInOperatingActivities?.units?.USD ?? [])
      if (e.start && e.filed === f.filed) periods.add(`${e.start}|${e.end}`);
    const cfComplete =
      periods.size > 0 &&
      lines.every((l) => l.startsWith("us-gaap_")) &&
      [...periods].every((p) => lines.every((l) => cfVal(l.slice(8), ...(p.split("|") as [string, string])) !== undefined));
    // 손상 포함 줄이 있거나, 현금흐름표가 중단사업을 포함한 채(계속사업 소계 없음) 이 공시에 중단사업 손익이 있으면
    // 공시 원본에서 손상·중단사업 감가상각 금액을 읽는다
    const discInFiling =
      !struct.continuing &&
      Object.entries(g).some(([k, c]) => DISC_NI.test(k) && !/Share/.test(k) && (c.units?.USD ?? []).some((e) => e.start && e.filed === f.filed && e.val !== 0));
    const needAdj = struct.impairLines.length > 0 || discInFiling;
    let inst: Map<string, Map<string, number>> | null = null;
    let adj: InstFact[] | null = null;
    if ((!cfComplete || needAdj) && f.instName) {
      const xml = await fetchText(`${f.base}/${f.instName}`, { headers: H, revalidate: false, timeoutMs: 30_000 });
      if (!cfComplete) {
        const roots = ["us-gaap_NetCashProvidedByUsedInOperatingActivities", "us-gaap_NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"];
        inst = durationValues(xml, new Set([...lines, ...roots]));
        // 현금흐름표 기간만(영업활동 현금흐름이 실린 기간) — 줄 개념이 주석에만 실은 기간(ISRG 10-Q 무형상각 3개월 값 3.2M)을
        // 감가상각 줄 합으로 쓰지 않는다(2026-09-27, 분기 열 확장 때 발견 — 3개월 값이 그 분기 감가상각비로 잡혔다)
        const cfPeriods = new Set(roots.flatMap((r) => [...(inst!.get(r)?.keys() ?? [])]));
        for (const l of lines) for (const p of inst.get(l)?.keys() ?? []) if (cfPeriods.has(p)) periods.add(p);
      }
      if (needAdj) adj = instanceFacts(xml, (id) => isImpair(id) || isDiscDa(id) || (DISC_NI.test(local(id)) && !/Share/.test(id)));
    } else if (needAdj) return facts; // 원본이 없으면 전체 미적용 — 기간마다 방식이 섞이지 않게
    // 이 공시 현금흐름표에 실린 줄 값(원본 또는 같은 공시의 companyfacts 값) — 주석 값·다른 공시 값은 쓰지 않는다
    const own = new Map<string, number>();
    for (const p of periods)
      for (const l of lines) {
        const [a, b] = p.split("|");
        const v =
          inst?.get(l)?.get(p) ??
          (l.startsWith("us-gaap_") ? (g[l.slice(8)]?.units?.USD ?? []).find((e) => e.start === a && e.end === b && e.filed === f.filed)?.val : undefined);
        if (v !== undefined) own.set(`${l}|${p}`, v);
      }
    structs.push({ accn: f.accn, lines, periods, vals: own });
    const exclude = new Set(struct.separateImpair);
    for (const p of periods) {
      if (done.has(p)) continue;
      const [start, end] = p.split("|");
      let sum = 0;
      let any = false;
      for (const l of lines) {
        const v = inst?.get(l)?.get(p) ?? (l.startsWith("us-gaap_") ? cfVal(l.slice(8), start, end) : undefined);
        if (v === undefined) continue;
        sum += v;
        any = true;
      }
      if (!any) continue;
      done.add(p);
      // 연간 집계(annualByYear·ttmOf)는 fp "FY" 인 1년 기간만 받는다
      const fullYear = (Date.parse(end) - Date.parse(start)) / 864e5 > 300;
      let unresolvedImp = false;
      let unresolvedDisc = false;
      if (adj) {
        // ① 손상 포함 줄: 그 기간 손상 금액을 뺀다(줄 합 이상이면 확인 불가 — 그대로 둔다)
        if (struct.impairLines.length) {
          const imp = impairmentOf(adj, p, exclude);
          if (imp > 0 && imp < sum) sum -= imp;
          else if (imp > 0) unresolvedImp = true;
        }
        // ② 중단사업 포함 현금흐름표: 중단사업 감가상각을 뺀다(태그가 없으면 확인 불가 — 그대로 둔다)
        if (!struct.continuing) {
          const disc = discontinuedDaOf(adj, p);
          if (disc != null && disc > 0 && disc < sum) {
            sum -= disc;
            discAdjusted = true;
          } else if (adj.some((x) => x.period === p && x.dims.length === 0 && x.val !== 0 && DISC_NI.test(local(x.id)))) unresolvedDisc = true;
        }
      }
      out.push({ start, end, val: sum, fy: 0, fp: fullYear ? "FY" : "Q", form: f.form, filed: f.filed, basis: f.accn });
      unresolvedOf.set(out[out.length - 1], unresolvedImp ? "imp" : unresolvedDisc ? "disc" : null);
    }
  }
  // 조정 금액을 확인하지 못한 **누적(분기) 기간**은 내보내지 않는다(2026-09-27) — 분기 열·LTM 은 누적 차라, 조정한 누적과 조정 못 한 누적을
  // 빼면 엉뚱한 값이 된다(WDC 2025 3분기 −7M: 9개월은 중단사업 감가상각 차감, 6개월은 태그 없어 미차감). 그 칸은 공란 + 사유(edgar-ev.ts
  // DA_QUARTER_NO_STRUCT). 중단사업은 **이 회사에 차감한 기간이 하나라도 있을 때만**(차감이 실제로 적용되는 회사) — 중단사업 손익만 조금
  // 있고 감가상각 차감이 어느 기간에도 없는 회사(IBM)는 모든 기간이 같은 기준(줄 값 그대로)이라 섞이지 않는다. 사업연도 값은 종전대로
  // 줄 값 그대로(연간 공란은 영업이익 대체 경로와 함께 봐야 해 범위 밖)
  const kept = out.filter((e) => {
    const u = unresolvedOf.get(e);
    return e.fp === "FY" || !(u === "imp" || (u === "disc" && discAdjusted));
  });
  if (!kept.length) return facts;
  // 구성 공시 간 감가상각 줄 기준 혼합(2026-09-27) — 줄 구성이 다른 두 구조를 두 구조의 줄이 모두 값을 가진 같은 현금흐름표 기간에서
  // 합으로 비교한다(매출원가 기준 혼합과 같은 원칙 — 합이 같은 개명은 허용). 다르면 두 구조의 값을 빼서 만든 열(누적 차·Q4·LTM)은
  // 공란(edgar-ev.ts daBasisMixed). 예: HLT 10-Q 는 계약획득원가 상각을 AmortizationOfIntangibleAssets(포함 개념)로, 10-K 는
  // AmortizationOfAcquisitionCosts(제외 개념)로 태깅 — 2025 9개월에서 10-K 기준 130 vs 10-Q 기준 172 → 혼합(Q4 = 177 − 172 = 5 가 나왔다)
  // 줄 값은 **그 줄을 현금흐름표에 실은 공시**의 그 기간 값만(최신 공시 우선) — 주석 전용 값(AMD 무형상각 주석 합계 2,300 ↔ 현금흐름표
  // 2,254)을 비교에 섞지 않는다
  const valAt = (id: string, p: string): number | undefined => {
    for (const x of structs) {
      const v = x.vals.get(`${id}|${p}`);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const unit = (v: number) => {
    let u = 1;
    while (u < 1e6 && v % (u * 10) === 0) u *= 10;
    return u;
  };
  const mix: string[] = [];
  const allPeriods = [...new Set(structs.flatMap((x) => [...x.periods]))];
  for (let i = 0; i < structs.length; i++)
    for (let j = i + 1; j < structs.length; j++) {
      const A = structs[i], B = structs[j];
      if (A.lines.length === B.lines.length && A.lines.every((l) => B.lines.includes(l))) continue;
      for (const p of allPeriods) {
        const va = A.lines.map((l) => valAt(l, p));
        const vb = B.lines.map((l) => valAt(l, p));
        if (va.some((v) => v === undefined) || vb.some((v) => v === undefined)) continue;
        const sa = (va as number[]).reduce((x, y) => x + y, 0);
        const sb = (vb as number[]).reduce((x, y) => x + y, 0);
        const tol = Math.max(...[...va, ...vb].map((v) => unit(Math.abs(v as number)))) * (A.lines.length + B.lines.length);
        if (Math.abs(sa - sb) > tol) {
          mix.push([A.accn, B.accn].sort().join("|"));
          break;
        }
      }
    }
  return {
    ...facts,
    ...(mix.length ? { daBasisMix: mix } : {}),
    facts: { ...facts.facts, "us-gaap": { ...g, [SYN_DA_CF]: { units: { USD: kept } } } },
  } as CompanyFacts;
}
