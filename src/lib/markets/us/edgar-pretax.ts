import "server-only";
import { fetchJson, fetchText } from "../http";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import type { RecentFilings } from "./edgar-gapfill";
import { filingsForDa, instanceFacts } from "./edgar-cf-structure";

/**
 * **세전이익 = 손익계산서 본표의 세전이익 소계**(오너 원칙 "본표 기준", 2026-09-28 블룸버그 대조로 발견).
 *
 * 앱 모듈들은 세전이익을 `…BeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest`(지분법 이익 포함) 태그부터 읽는다.
 * 그런데 지분법 이익을 법인세 아래에 두는 회사(AMD: "Income before income taxes and equity income")는 본표 세전이익을
 * `…BeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments`(지분법 이익 차감 전)로 달고, 앞의 태그는
 * 법인세 주석(국내 + 해외)에만 싣는다 — 앱이 주석 값을 세전이익으로 썼다(AMD 2021 3,675 vs 본표 3,669 = 블룸버그,
 * 차이 = 지분법 이익 6).
 *
 * 최신 10-K 손익계산서 계산 구조의 세전이익 소계가 뒤의 태그(지분법 차감 전)이고 앞의 태그는 본표에 없으면, 앞의 태그 값을
 * 기간마다 뒤의 태그 값으로 바꾼다(항목은 두고 값만 — 모든 모듈이 같은 본표 값을 읽게). 뒤의 태그가 없는 기간은 그대로.
 */
const PT_ALL = "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest";
const PT_BEFORE_EQ = "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments";

const UA = process.env.SEC_USER_AGENT ?? "global-market-research (personal use) contact@example.com";
const H = { "user-agent": UA, "accept-encoding": "gzip, deflate" };

/** 최신 10-K 손익계산서 계산 구조에서 세전이익 소계가 지분법 차감 전 태그인가 */
async function faceUsesBeforeEquity(cik: string, recent: RecentFilings): Promise<boolean> {
  const i = recent.form.findIndex((f) => f === "10-K");
  if (i < 0) return false;
  const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${recent.accessionNumber[i].replace(/-/g, "")}`;
  const idx = await fetchJson<{ directory: { item: { name: string }[] } }>(`${base}/index.json`, { headers: H, revalidate: 60 * 60 * 24 });
  const names = idx.directory.item.map((x) => x.name);
  const calName = names.find((n) => /_cal\.xml$/i.test(n)) ?? names.find((n) => /\.xsd$/i.test(n));
  if (!calName) return false;
  const cal = await fetchText(`${base}/${calName}`, { headers: H, revalidate: 60 * 60 * 24, timeoutMs: 30_000 });
  for (const m of cal.matchAll(/<(?:link:)?calculationLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/(?:link:)?calculationLink>/g)) {
    const role = m[1].split("/").pop() ?? "";
    if (!/INCOME|OPERATIONS|EARNINGS/i.test(role) || /Detail|Table|Parenth|Tax|Segment/i.test(role)) continue;
    const hasBefore = m[2].includes(`#us-gaap_${PT_BEFORE_EQ}"`);
    const hasAll = m[2].includes(`#us-gaap_${PT_ALL}"`);
    if (hasBefore || hasAll) return hasBefore && !hasAll;
  }
  return false;
}

/** 표준 세전이익 개념(앱 모듈들이 읽는 순서) */
const PT_STD = [PT_ALL, PT_BEFORE_EQ, "IncomeLossFromContinuingOperationsBeforeIncomeTaxesAndExtraordinaryItemsNoncontrollingInterest", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndEquityMethodInvestments"];

/**
 * **본표 세전이익 소계가 회사 고유 태그인 공시**(2026-10-09, 검증기 전체 모드 — MCD `mcd_IncomeLossFromContinuingOperationsBeforeIncomeTaxes`,
 * ORCL 2019 이후, MRVL 10-Q): 손익계산서에 "Income before provision for income taxes" 줄이 있는데 표준 태그가 아니라 companyfacts 에 값이 없고,
 * 앱 손익계산서 세전이익이 "세전이익 공시 없음" 빈칸이었다(본표에 줄이 있는데 빈칸 — 오너 원칙 위반).
 * 정기공시(10-K 5건 + 최근 10-Q)마다 손익계산서 계산 구조에서 법인세(IncomeTaxExpenseBenefit)와 형제인 "…BeforeIncomeTax…" 회사 고유 개념을 찾아
 * 그 공시 원본(인스턴스)의 차원 없는 기간 값을 표준 세전이익 개념(PT_ALL)으로 넣는다. 표준 세전이익 값이 이미 있는 기간은 건드리지 않는다.
 * 기간·제출 정보는 같은 공시의 법인세 사실에서 그대로 가져온다(같은 표의 같은 열).
 */
export async function withCustomFacePretax(cik: string, facts: CompanyFacts, recent: RecentFilings | null): Promise<CompanyFacts> {
  const g = facts.facts["us-gaap"];
  const tax = g?.IncomeTaxExpenseBenefit?.units?.USD ?? [];
  if (!recent || !g || !tax.length) return facts;
  const have = new Set<string>();
  for (const c of PT_STD) for (const e of g[c]?.units?.USD ?? []) if (e.start) have.add(`${e.start}|${e.end}`);
  // 법인세는 있는데 표준 세전이익이 없는 기간이 하나도 없으면 원본을 읽지 않는다(대부분 회사)
  if (!tax.some((e) => e.start && !have.has(`${e.start}|${e.end}`))) return facts;
  const opt = { headers: H, revalidate: 60 * 60 * 24, timeoutMs: 30_000 };
  const synth: FactUnitEntry[] = [];
  // 공시마다 그 공시의 열(같은 기간이 여러 공시에 실리면 공시마다 한 건 — 판본 선택·반올림 재태깅 제거는 다른 개념과 같이 로더가 한다)
  for (const f of filingsForDa(recent)) {
    const todo = tax.filter((e) => e.start && e.filed === f.filed && e.form === f.form && !have.has(`${e.start}|${e.end}`));
    if (!todo.length) continue;
    const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${f.accn.replace(/-/g, "")}`;
    const idx = await fetchJson<{ directory: { item: { name: string }[] } }>(`${base}/index.json`, opt);
    const names = idx.directory.item.map((i) => i.name);
    const calName = names.find((n) => /_cal\.xml$/i.test(n)) ?? names.find((n) => /\.xsd$/i.test(n));
    const instName = names.find((n) => /_htm\.xml$/i.test(n));
    if (!calName || !instName) continue;
    const cal = await fetchText(`${base}/${calName}`, opt);
    let pt: string | null = null;
    for (const m of cal.matchAll(/<(?:[\w-]+:)?calculationLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?calculationLink>/g)) {
      const role = m[1].split("/").pop() ?? "";
      if (!/INCOME|OPERATIONS|EARNINGS/i.test(role) || /Detail|Table|Parenth|Tax|Segment|Comprehensive|Polic/i.test(role)) continue;
      const loc = new Map<string, string>();
      for (const l of m[2].matchAll(/<(?:[\w-]+:)?loc\b([^>]*)\/?>/g)) {
        const id = /xlink:label="([^"]+)"/.exec(l[1])?.[1], h = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1];
        if (id && h) loc.set(id, h);
      }
      const kids = new Map<string, string[]>();
      for (const a of m[2].matchAll(/<(?:[\w-]+:)?calculationArc\b([^>]*)\/?>/g)) {
        const fr = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? ""), to = loc.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? "");
        if (fr && to) kids.set(fr, [...(kids.get(fr) ?? []), to]);
      }
      for (const ks of kids.values()) {
        if (!ks.includes("us-gaap_IncomeTaxExpenseBenefit")) continue;
        // 회사 고유 "…BeforeIncomeTax…" 또는 표준 개념 중 정의가 세전인 IncomeLossAttributableToParent("Income (Loss) Attributable to Parent, before Tax" —
        // MRVL 10-Q 가 본표 "Income before income taxes" 줄에 단 개념)
        const c = ks.find((k) => (!k.startsWith("us-gaap_") && !k.startsWith("ifrs-full_") && /BeforeIncomeTax/i.test(k)) || k === "us-gaap_IncomeLossAttributableToParent");
        if (c) { pt = c; break; }
      }
      if (pt) break;
    }
    if (!pt) continue;
    const xml = await fetchText(`${base}/${instName}`, { headers: H, revalidate: false, timeoutMs: 30_000 });
    const vals = instanceFacts(xml, (id) => id === pt).filter((x) => x.dims.length === 0);
    for (const e of todo) {
      const v = vals.find((x) => x.period === `${e.start}|${e.end}`);
      if (v) synth.push({ ...e, val: v.val });
    }
  }
  if (!synth.length) return facts;
  const cur = g[PT_ALL] ?? { label: "Income (loss) before income taxes", units: {} };
  return { ...facts, facts: { ...facts.facts, "us-gaap": { ...g, [PT_ALL]: { ...cur, units: { ...cur.units, USD: [...(cur.units?.USD ?? []), ...synth] } } } } };
}

export async function withFacePretax(cik: string, facts: CompanyFacts, recent: RecentFilings | null): Promise<CompanyFacts> {
  const g = facts.facts["us-gaap"];
  const all = g?.[PT_ALL]?.units?.USD, before = g?.[PT_BEFORE_EQ]?.units?.USD;
  if (!recent || !all?.length || !before?.length) return facts;
  if (!(await faceUsesBeforeEquity(cik, recent))) return facts;
  const latest = new Map<string, FactUnitEntry>();
  for (const e of before) {
    const k = `${e.start ?? ""}|${e.end}`;
    const p = latest.get(k);
    if (!p || (e.filed ?? "") > (p.filed ?? "")) latest.set(k, e);
  }
  const fixed = all.map((e) => {
    const b = latest.get(`${e.start ?? ""}|${e.end}`);
    return b && b.val !== e.val ? { ...e, val: b.val } : e;
  });
  return { ...facts, facts: { ...facts.facts, "us-gaap": { ...g, [PT_ALL]: { ...g![PT_ALL], units: { ...g![PT_ALL].units, USD: fixed } } } } };
}
