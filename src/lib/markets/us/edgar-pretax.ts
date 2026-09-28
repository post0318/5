import "server-only";
import { fetchJson, fetchText } from "../http";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import type { RecentFilings } from "./edgar-gapfill";

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
