import "server-only";
import { fetchJson, fetchText } from "../http";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import { instanceUrl } from "./edgar-classfacts";
import type { RecentFilings } from "./edgar-gapfill";

/**
 * **일회성비용(구조조정·손상차손·위약금·합의금 등)** — 손익계산서 주석 행(오너 결정 2026-09-24:
 * "각각 구분하면 회사마다 달라 이상하니 한 줄로", "손익계산서 별도 줄만").
 *
 * 표준 태그를 더하면 안 된다(실측): DIS 는 같은 해 금액이 태그마다 3,836·3,892·3,128 로 서로 포함관계라 이중
 * 합산되고, NVDA Arm 인수 위약금(13.53억)은 회사 고유 태그(`nvda_BusinessCombinationAdvancedConsideration
 * WrittenOff`)라 표준 태그에 없다. 그래서 **10-K·10-Q 계산 구조(`_cal.xml`)의 손익계산서 줄 중** 개념명이나
 * 회사 라벨(`_lab.xml`, 모든 역할 — FOXA 는 기본 라벨이 "Other Operating Income (Expense), Net" 이고 표시
 * 라벨이 "Restructuring, impairment and other corporate matters")이 일회성 항목인 줄만 모은다. 손익계산서
 * 줄끼리는 겹치지 않아 이중 합산이 없다.
 *
 * 한계: 다른 비용 줄 안에 섞인 금액(WMT 오피오이드 소송 합의금 — 판관비 안)은 잡히지 않는다. 영업외 항목
 * (채무소멸손익 등)은 대상이 아니다. 이미 영업이익에 반영(차감)된 금액이다 — 주석 행이라 합계에 영향 없음.
 *
 * 금액: us-gaap 개념은 companyfacts(최근 제출분), 회사 고유 개념만 그 공시의 인스턴스에서 읽는다(인스턴스는
 * 수 MB 라 필요할 때만). 기간마다 그 기간을 담은 가장 최근 공시의 구조를 쓴다. 비용은 양수.
 */

export const SYN_ONE_OFF = "OneOffChargesDerived";

const ONE_OFF_TEXT =
  /restructur|impairment|litigation|legal (settlement|matters)|settlement|lawsuit|termination|severance|written off|write-?off|write-?down|acquisition[- ]related|merger[- ]related|transaction costs|corporate matters|opioid/i;
/** 이름·라벨이 걸려도 제외 — 영업외·세금·주당이익·누계 */
const EXCLUDE = /Tax|PerShare|Nonoperating|Interest|ExtinguishmentOfDebt|Accumulated|Pension|Postretirement/;
/** 일반 비용·합계 줄 — 라벨에 일회성 단어가 있어도 줄 자체는 아니다(KHC "판관비, 손상차손 제외"). 하위 줄은 계속 본다. */
const GENERAL_COST = /SellingGeneralAndAdministrative|^CostOf|^OperatingExpenses$|CostsAndExpenses|^GeneralAndAdministrativeExpense$|^ResearchAndDevelopmentExpense/;
/** 라벨의 부정 문맥("excluding impairment losses") 이후는 판정에서 뺀다 */
const NEGATED = /\b(excluding|excl\.?|exclusive of|other than|before)\b.*$/i;
/** 상각 줄 — 취득 무형자산 상각은 매년 반복되는 비용이지 일회성이 아니다(AMD·AVGO: "Amortization of acquisition-related
 *  intangibles" 가 "acquisition-related" 에 걸려 일회성비용 28억·110억으로 잡혔다, 검증 2026-09-24) */
const AMORTIZATION = /amortiz/i;
/** 매각손익 라벨 — 개념명이 손상차손이어도 회사가 매각손익 줄로 쓴 경우(DVN형) */
const SALE_GAIN = /\(gain\)|\bgains?\b[^|]*\b(sale|disposal|divest)/i;
const PRETAX = [
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
  "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
];

const UA = process.env.SEC_USER_AGENT ?? "global-market-research (personal use) contact@example.com";
const H = { "user-agent": UA, "accept-encoding": "gzip, deflate" };

interface Filing { accn: string; form: string; filed: string; doc: string; report: string }
interface Line { ns: string; concept: string; w: number } // w: 루트(세전이익·영업이익) 기준 부호

async function files(cik: number, f: Filing): Promise<{ cal: string; lab: string } | null> {
  const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${f.accn.replace(/-/g, "")}`;
  const idx = await fetchJson<{ directory: { item: { name: string }[] } }>(`${base}/index.json`, { headers: H, revalidate: 60 * 60 * 24 });
  const names = idx.directory.item.map((i) => i.name);
  const cal = names.find((n) => /_cal\.xml$/i.test(n));
  const lab = names.find((n) => /_lab\.xml$/i.test(n));
  if (!cal || !lab) return null;
  const opt = { headers: H, revalidate: 60 * 60 * 24, timeoutMs: 30_000 };
  return { cal: await fetchText(`${base}/${cal}`, opt), lab: await fetchText(`${base}/${lab}`, opt) };
}

/** 개념 id(ns_Concept) → 모든 역할의 라벨 텍스트 */
function labels(lab: string): Map<string, string[]> {
  const loc = new Map<string, string>();
  for (const l of lab.matchAll(/<link:loc\b([^>]*)\/?>/g)) {
    const id = /xlink:label="([^"]+)"/.exec(l[1])?.[1];
    const href = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1];
    if (id && href) loc.set(id, href);
  }
  const text = new Map<string, string>();
  for (const m of lab.matchAll(/<link:label\b([^>]*)>([^<]*)<\/link:label>/g)) {
    const id = /xlink:label="([^"]+)"/.exec(m[1])?.[1];
    // 정의문(documentation)은 표시 라벨이 아니다 — CI 투자손익 정의문의 "write-downs" 가 걸렸다
    if (!id || /xlink:role="[^"]*documentation"/i.test(m[1])) continue;
    text.set(id, (text.get(id) ?? "") + " | " + m[2].replace(NEGATED, ""));
  }
  const out = new Map<string, string[]>();
  for (const a of lab.matchAll(/<link:labelArc\b([^>]*)\/?>/g)) {
    const from = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? "");
    const t = text.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
    if (from && t) out.set(from, [...(out.get(from) ?? []), t]);
  }
  return out;
}

/** 손익계산서 계산 구조에서 일회성 줄(루트 기준 부호). 영업외·매출 노드 아래로는 내려가지 않는다. */
function oneOffLines(cal: string, lab: Map<string, string[]>): Line[] | null {
  for (const m of cal.matchAll(/<link:calculationLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/link:calculationLink>/g)) {
    const role = m[1].split("/").pop() ?? "";
    if (!/INCOME|OPERATIONS|EARNINGS/i.test(role) || /Detail|Table|Parenth|Tax|Segment/i.test(role)) continue;
    const loc = new Map<string, string>();
    for (const l of m[2].matchAll(/<link:loc\b([^>]*)\/?>/g)) {
      const id = /xlink:label="([^"]+)"/.exec(l[1])?.[1];
      const href = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1];
      if (id && href) loc.set(id, href);
    }
    const arcs: { from: string; to: string; w: number }[] = [];
    for (const a of m[2].matchAll(/<link:calculationArc\b([^>]*)\/?>/g)) {
      const from = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? "");
      const to = loc.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
      const w = Number(/weight="([^"]+)"/.exec(a[1])?.[1]);
      if (from && to && Number.isFinite(w)) arcs.push({ from, to, w });
    }
    const root = [...PRETAX.map((p) => `us-gaap_${p}`), "us-gaap_OperatingIncomeLoss"].find((r) => arcs.some((a) => a.from === r));
    if (!root) continue;
    const split = (id: string) => { const i = id.indexOf("_"); return { ns: id.slice(0, i), concept: id.slice(i + 1) }; };
    const out: Line[] = [];
    const seen = new Set<string>();
    const walk = (id: string, w: number, depth: number) => {
      if (depth > 6) return;
      for (const a of arcs.filter((x) => x.from === id)) {
        if (seen.has(a.to)) continue;
        seen.add(a.to);
        const c = split(a.to);
        if (EXCLUDE.test(c.concept) || /^Revenue/.test(c.concept)) continue;
        // 회사 라벨이 있으면 라벨로만 판정하고, 라벨이 없을 때만 개념명을 본다(회사가 표준 개념을 다른 뜻으로 쓴 경우)
        const labs = lab.get(a.to);
        const text = labs?.length ? labs.join(" ") : c.concept;
        if (!GENERAL_COST.test(c.concept) && !SALE_GAIN.test(text) && !AMORTIZATION.test(text) && ONE_OFF_TEXT.test(text)) out.push({ ...c, w: w * a.w });
        else walk(a.to, w * a.w, depth + 1);
      }
    };
    walk(root, 1, 0);
    return out;
  }
  return null;
}

/** 인스턴스에서 회사 고유 개념의 차원 없는 값 */
function instanceValues(xml: string, concepts: Set<string>, f: Filing): Map<string, FactUnitEntry[]> {
  const ctx = new Map<string, { start?: string; end?: string; dimmed: boolean }>();
  for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g))
    ctx.set(m[1], {
      start: /<(?:xbrli:)?startDate>([^<]+)</.exec(m[2])?.[1]?.trim(),
      end: /<(?:xbrli:)?endDate>([^<]+)</.exec(m[2])?.[1]?.trim(),
      dimmed: /dimension="/.test(m[2]),
    });
  const out = new Map<string, FactUnitEntry[]>();
  for (const m of xml.matchAll(/<([a-z0-9-]+):([A-Za-z0-9_]+)\b([^>]*)>(-?[\d.]+)<\/\1:\2>/g)) {
    const id = `${m[1]}_${m[2]}`;
    if (!concepts.has(id)) continue;
    const c = ctx.get(/contextRef="([^"]+)"/.exec(m[3])?.[1] ?? "");
    if (!c?.start || !c.end || c.dimmed || !/unitRef="[^"]*usd/i.test(m[3])) continue;
    const list = out.get(id) ?? [];
    if (!list.some((e) => e.start === c.start && e.end === c.end))
      list.push({ start: c.start, end: c.end, val: Number(m[4]), form: f.form, filed: f.filed, fy: 0, fp: "" });
    out.set(id, list);
  }
  return out;
}

export async function withOneOffCharges(cik: string, facts: CompanyFacts, recent: RecentFilings | null): Promise<CompanyFacts> {
  if (!recent) return facts;
  const g = facts.facts["us-gaap"] ?? {};
  const filings: Filing[] = [];
  let k10 = 0;
  for (let i = 0; i < recent.form.length && k10 < 3; i++) {
    const form = recent.form[i];
    if (form === "10-K") k10++;
    else if (!(form === "10-Q" && k10 === 0 && !filings.some((x) => x.form === "10-Q"))) continue;
    filings.push({ accn: recent.accessionNumber[i], form, filed: recent.filingDate[i], doc: recent.primaryDocument[i], report: recent.reportDate?.[i] ?? "" });
  }
  // 공시별 일회성 줄 — 하나라도 못 읽으면 전체 미적용(기간마다 정의가 섞이지 않게)
  const perFiling: { f: Filing; lines: Line[]; ext: Map<string, FactUnitEntry[]> }[] = [];
  for (const f of filings) {
    const fl = await files(Number(cik), f).catch(() => null);
    if (!fl) return facts;
    const lines = oneOffLines(fl.cal, labels(fl.lab));
    if (!lines) return facts;
    let ext = new Map<string, FactUnitEntry[]>();
    const extIds = new Set(lines.filter((l) => l.ns !== "us-gaap").map((l) => `${l.ns}_${l.concept}`));
    if (extIds.size) {
      const url = await instanceUrl(Number(cik), f.accn.replace(/-/g, ""), f.doc).catch(() => null);
      if (!url) return facts;
      const xml = await fetchText(url, { headers: H, revalidate: 60 * 60 * 24, timeoutMs: 30_000 }).catch(() => null);
      if (!xml) return facts;
      ext = instanceValues(xml, extIds, f);
    }
    perFiling.push({ f, lines, ext });
  }
  if (!perFiling.some((p) => p.lines.length)) return facts;

  // 기간 목록 = 세전이익이 있는 기간. 연간은 그 결산일을 담은 가장 최근 10-K(보고일 ≥ 결산일, 손익계산서가 담는 3개 연도 = 2.2년 안),
  // 분기·누적은 최신 10-Q(없으면 최신 10-K)의 구조
  const latestK = perFiling.find((p) => p.f.form === "10-K");
  const latestQ = perFiling.find((p) => p.f.form === "10-Q");
  const pickFor = (e: FactUnitEntry) => {
    const days = (Date.parse(e.end) - Date.parse(e.start ?? e.end)) / 864e5;
    if (days < 300) return latestQ ?? latestK;
    const ks = perFiling.filter((p) => p.f.form === "10-K" && p.f.report >= e.end && Date.parse(p.f.report) - Date.parse(e.end) < 2.2 * 365 * 864e5);
    return ks.length ? ks.reduce((a, b) => (a.f.report >= b.f.report ? a : b)) : undefined; // 그 기간을 담은 가장 최근 10-K
  };
  const usVal = (concept: string, e: FactUnitEntry): number | undefined => {
    let best: FactUnitEntry | undefined;
    for (const x of g[concept]?.units?.USD ?? [])
      if (x.start === e.start && x.end === e.end && (!best || (x.filed ?? "") > (best.filed ?? ""))) best = x;
    return best?.val;
  };
  const pretaxEntries = PRETAX.flatMap((p) => g[p]?.units?.USD ?? []).filter((e) => e.start);
  const out: FactUnitEntry[] = [];
  const done = new Set<string>();
  for (const e of pretaxEntries) {
    const k = `${e.start}|${e.end}|${e.form}|${e.fp}`;
    if (done.has(k)) continue;
    done.add(k);
    const p = pickFor(e);
    if (!p || !p.lines.length) continue;
    let cost = 0, any = false;
    for (const l of p.lines) {
      const v = l.ns === "us-gaap" ? usVal(l.concept, e) : p.ext.get(`${l.ns}_${l.concept}`)?.find((x) => x.start === e.start && x.end === e.end)?.val;
      if (v === undefined) continue;
      cost += -l.w * v; // 루트에서 빼는 줄(가중치 −1)의 양수 값 = 비용
      any = true;
    }
    if (any) out.push({ ...e, val: cost });
  }
  if (!out.length) return facts;
  return { ...facts, facts: { ...facts.facts, "us-gaap": { ...g, [SYN_ONE_OFF]: { units: { USD: out } } } } } as CompanyFacts;
}
