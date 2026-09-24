import "server-only";
import { fetchJson, fetchText } from "../http";
import type { CompanyFacts, FactUnitEntry } from "./edgar";
import type { RecentFilings } from "./edgar-gapfill";
import { recentAnnualFilings } from "./edgar-annual-filings";

/**
 * **연말 유통주식수 — 자본변동표 보통주 차원**(10-K 원본). 차원 없는 유통·발행주식수 태그가 없는 회사(WMT·BE·META)는
 * 자본변동표에 `CommonStockSharesOutstanding`/`SharesOutstanding` 을 `StatementEquityComponentsAxis=CommonStockMember`
 * 한 차원으로만 달아 companyfacts 에서 빠진다. 앱은 표지(제출일 기준)·가중평균으로 근사해 결산일 시가총액이 인포맥스
 * (FactSet)와 어긋났다(검증 2026-09-24: BE 2022 −9.6%, WMT 2022 +1.6%). 원본 값은 인포맥스와 정확히 일치
 * (BE 2022 205.66백만·META 2022 2,614백만·WMT 2023 8,080백만).
 *
 * 결산일마다 **그 해의 10-K** 값을 쓴다(공시 당시 기준) — 나중 10-K 의 과거 연도 값은 분할이 소급 반영돼(WMT 2024 3:1)
 * edgar-shares.ts 의 분할 환산과 겹친다. 보통주 구성요소 값이 없으면 클래스별 값(`StatementClassOfStockAxis`)을 합산.
 */

export const SYN_EQUITY_SHARES = "SharesOutstandingEquityStatementDerived";

const UA = process.env.SEC_USER_AGENT ?? "global-market-research (personal use) contact@example.com";
const H = { "user-agent": UA, "accept-encoding": "gzip, deflate" };
const CONCEPTS = ["CommonStockSharesOutstanding", "SharesOutstanding"];

/** 결산일 값 — 보통주 구성요소 한 차원 우선, 없으면 클래스별 합 */
function yearEndShares(xml: string, reportDate: string): number | null {
  const ctx = new Map<string, { inst: string; dims: [string, string][] }>();
  for (const m of xml.matchAll(/<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g)) {
    const inst = /<(?:xbrli:)?instant>\s*([^<\s]+)/.exec(m[2])?.[1];
    if (inst !== reportDate) continue;
    const dims = [...m[2].matchAll(/dimension="([^"]+)"[^>]*>([^<]+)</g)].map((d) => [d[1].split(":").pop() ?? "", d[2].split(":").pop() ?? ""] as [string, string]);
    ctx.set(m[1], { inst, dims });
  }
  let component: number | null = null;
  const byClass = new Map<string, number>();
  for (const c of CONCEPTS) {
    for (const m of xml.matchAll(new RegExp(`<us-gaap:${c}\\b([^>]*)>\\s*([\\d.]+)\\s*<`, "g"))) {
      const cx = ctx.get(/contextRef="([^"]+)"/.exec(m[1])?.[1] ?? "");
      if (!cx || cx.dims.length !== 1) continue;
      const [axis, member] = cx.dims[0];
      const v = Number(m[2]);
      if (axis === "StatementEquityComponentsAxis" && member === "CommonStockMember") component ??= v;
      // 우선주 클래스는 보통주 합에서 뺀다(재감사 LOW)
      else if (axis === "StatementClassOfStockAxis" && !/Preferred/i.test(member) && !byClass.has(member)) byClass.set(member, v);
    }
  }
  if (component != null) return component;
  return byClass.size ? [...byClass.values()].reduce((s, v) => s + v, 0) : null;
}

export async function withEquityStatementShares(cik: string, facts: CompanyFacts, recent: RecentFilings | null): Promise<CompanyFacts> {
  if (!recent) return facts;
  const g = facts.facts["us-gaap"] ?? {};
  // 그 결산일에 차원 없는 유통·발행주식수가 있으면 그 연도는 원본을 받지 않는다(수 MB) — 옛 공시에만 태그가 있는
  // 회사(WMT·BE·META 는 2010년대엔 차원 없이 달았다)도 최근 연도는 대상이 되도록 날짜 단위로 판정
  const hasAt = (d: string) =>
    ["CommonStockSharesOutstanding", "SharesOutstanding", "CommonStockSharesIssued"].some((c) =>
      (g[c]?.units?.shares ?? []).some((e) => !e.start && Math.abs(Date.parse(e.end) - Date.parse(d)) <= 7 * 864e5),
    );
  const out: FactUnitEntry[] = [];
  // 최근 10-K 6건 — recent 목록이 모자라면 과거 목록 파일까지(WMT·META)
  for (const f of await recentAnnualFilings(cik, recent, 6)) {
    const report = f.report;
    if (!report || hasAt(report)) continue;
    try {
      const base = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${f.accn.replace(/-/g, "")}`;
      const idx = await fetchJson<{ directory: { item: { name: string }[] } }>(`${base}/index.json`, { headers: H, revalidate: 60 * 60 * 24 });
      const inst = idx.directory.item.map((x) => x.name).find((n) => /_htm\.xml$/i.test(n));
      if (!inst) continue;
      const xml = await fetchText(`${base}/${inst}`, { headers: H, revalidate: false, timeoutMs: 30_000 });
      const v = yearEndShares(xml, report);
      if (v != null) out.push({ end: report, val: v, fy: 0, fp: "FY", form: "10-K", filed: f.filed });
    } catch {
      /* 이 연도만 건너뜀 — 기존 근사로 */
    }
  }
  if (!out.length) return facts;
  return { ...facts, facts: { ...facts.facts, "us-gaap": { ...g, [SYN_EQUITY_SHARES]: { units: { shares: out } } } } } as CompanyFacts;
}
