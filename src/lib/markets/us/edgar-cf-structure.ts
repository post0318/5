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
// 개념명(카멜케이스)·라벨(띄어쓰기) 둘 다에 맞도록 공백을 선택으로 둔다
const NOT_DA = /debt|discount|premium|issuance|financing ?costs?|deferred ?(financing|charges)|stock|share-?based|compensation|operating ?lease|content|contract ?(cost|acquisition)|capitalized ?software|investment|securities|bond|inventory|incentive|acquisition ?costs|defined ?benefit|pension|postretirement/i;
const OP_CF_ROOT = /^us-gaap_NetCashProvidedByUsedInOperatingActivities(ContinuingOperations)?$/;

interface Filing { accn: string; form: string; filed: string }

function locs(x: string): Map<string, string> {
  const loc = new Map<string, string>();
  for (const l of x.matchAll(/<link:loc\b([^>]*)\/?>/g)) {
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
  for (const m of lab.matchAll(/<link:label\b([^>]*)>([^<]*)<\/link:label>/g)) {
    const id = /xlink:label="([^"]+)"/.exec(m[1])?.[1];
    if (!id || /xlink:role="[^"]*documentation"/i.test(m[1])) continue;
    text.set(id, [...(text.get(id) ?? []), m[2].trim()]);
  }
  const out = new Map<string, string[]>();
  for (const a of lab.matchAll(/<link:labelArc\b([^>]*)\/?>/g)) {
    const from = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? "");
    const t = text.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
    if (from && t) out.set(from, [...(out.get(from) ?? []), ...t]);
  }
  return out;
}

/** 현금흐름표 영업활동 조정 항목 중 감가상각·상각 줄. 현금흐름표 역할이 없으면 null */
export function cashFlowDaLines(cal: string, lab: Map<string, string[]>): string[] | null {
  for (const m of cal.matchAll(/<link:calculationLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/link:calculationLink>/g)) {
    const role = m[1].split("/").pop() ?? "";
    if (!/CASHFLOW/i.test(role) || /Detail|Table|Parenth|Supplement/i.test(role)) continue;
    const loc = locs(m[2]);
    const arcs: { from: string; to: string }[] = [];
    for (const a of m[2].matchAll(/<link:calculationArc\b([^>]*)\/?>/g)) {
      const from = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? "");
      const to = loc.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
      if (from && to) arcs.push({ from, to });
    }
    const root = arcs.find((a) => OP_CF_ROOT.test(a.from))?.from;
    if (!root) continue;
    const out: string[] = [];
    const seen = new Set<string>();
    const walk = (id: string, depth: number) => {
      if (depth > 3) return;
      for (const a of arcs.filter((x) => x.from === id)) {
        if (seen.has(a.to)) continue;
        seen.add(a.to);
        const concept = a.to.slice(a.to.indexOf("_") + 1);
        const labs = lab.get(a.to) ?? [];
        // 표준 개념은 이름으로만 판정 — 회사 라벨 파일이 틀린 경우가 있다(AMD FY2024: 취득 무형자산 상각
        // AdjustmentForAmortization 에 "운용리스 사용권자산 상각" 라벨이 붙어 3,548 이 빠졌다). 회사 고유 개념만 라벨로.
        const std = a.to.startsWith("us-gaap_");
        const text = std ? concept : labs.join(" | ") || concept;
        // 회사 고유 줄의 주 라벨이 감가상각·무형자산 상각으로 시작하면 제외어가 섞여 있어도 포함(ISRG "Amortization of
        // intangible and other assets" — 표준 라벨의 "Contract Acquisition" 에 걸려 빠졌다, Yahoo 677.1 = 615 + 62)
        const leadsWithDep = !std && labs.some((l) => /^(depreciation|amortization of (acquired |acquisition-related )?intangible)/i.test(l));
        if (DA.test(text) && (!NOT_DA.test(text) || leadsWithDep)) out.push(a.to);
        else walk(a.to, depth + 1);
      }
    };
    walk(root, 0);
    return out;
  }
  return null;
}

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

export async function withCashFlowDa(cik: string, facts: CompanyFacts, recent: RecentFilings | null): Promise<CompanyFacts> {
  // 콘텐츠 상각 회사(NFLX)는 edgar-content.ts 합성값이 감가상각비 — 본표 줄과 섞지 않는다
  if (!recent || (facts as CompanyFacts & { contentAmortization?: boolean }).contentAmortization) return facts;
  const g = facts.facts["us-gaap"] ?? {};
  const filings: (Filing & { instName: string; base: string; lines: string[] | null })[] = [];
  let k10 = 0;
  for (let i = 0; i < recent.form.length && k10 < 5; i++) {
    const form = recent.form[i];
    if (form === "10-K") k10++;
    else if (!(form === "10-Q" && k10 === 0 && !filings.some((x) => x.form === "10-Q"))) continue;
    filings.push({ accn: recent.accessionNumber[i], form, filed: recent.filingDate[i], instName: "", base: "", lines: null });
  }
  if (!filings.length) return facts;
  const opt = { headers: H, revalidate: 60 * 60 * 24, timeoutMs: 30_000 };
  for (const f of filings) {
    try {
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
    } catch {
      return facts; // 하나라도 못 읽으면 전체 미적용 — 기간마다 방식이 섞이지 않게
    }
  }

  const cfVal = (concept: string, start: string, end: string): number | undefined => {
    let best: FactUnitEntry | undefined;
    for (const e of g[concept]?.units?.USD ?? [])
      if (e.start === start && e.end === end && (!best || (e.filed ?? "") > (best.filed ?? ""))) best = e;
    return best?.val;
  };
  const out: FactUnitEntry[] = [];
  const done = new Set<string>();
  for (const f of filings) {
    const lines = f.lines;
    if (!lines?.length) continue;
    // 이 공시의 현금흐름표 기간 — 같은 날 제출된 영업활동 현금흐름(당기·전기, 10-Q 는 누적)
    const periods = new Set<string>();
    for (const e of g.NetCashProvidedByUsedInOperatingActivities?.units?.USD ?? [])
      if (e.start && e.filed === f.filed) periods.add(`${e.start}|${e.end}`);
    const cfComplete =
      periods.size > 0 &&
      lines.every((l) => l.startsWith("us-gaap_")) &&
      [...periods].every((p) => lines.every((l) => cfVal(l.slice(8), ...(p.split("|") as [string, string])) !== undefined));
    let inst: Map<string, Map<string, number>> | null = null;
    if (!cfComplete && f.instName) {
      const xml = await fetchText(`${f.base}/${f.instName}`, { headers: H, revalidate: false, timeoutMs: 30_000 }).catch(() => null);
      if (!xml) return facts;
      inst = durationValues(xml, new Set(lines));
      for (const l of lines) for (const p of inst.get(l)?.keys() ?? []) periods.add(p);
    }
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
      out.push({ start, end, val: sum, fy: 0, fp: fullYear ? "FY" : "Q", form: f.form, filed: f.filed });
    }
  }
  if (!out.length) return facts;
  return { ...facts, facts: { ...facts.facts, "us-gaap": { ...g, [SYN_DA_CF]: { units: { USD: out } } } } } as CompanyFacts;
}
