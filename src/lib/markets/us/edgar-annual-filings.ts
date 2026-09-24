import "server-only";
import { fetchJson } from "../http";
import type { RecentFilings } from "./edgar-gapfill";

/**
 * 최근 사업연도 10-K 목록 — SEC 제출 목록의 `recent` 는 최근 1,000건만 담아 임원 지분 공시(Form 4)가 많은 회사
 * (WMT·META)는 2~3년 전 10-K 가 빠진다(검증 2026-09-24: WMT FY2022·2023 10-K 를 못 찾아 연말 주식수를 근사). 모자라면
 * SEC 가 나눠 주는 과거 목록 파일(`filings.files`)까지 읽는다.
 */
export interface AnnualFiling { accn: string; form: string; filed: string; doc: string; report: string }

const UA = process.env.SEC_USER_AGENT ?? "global-market-research (personal use) contact@example.com";
const H = { "user-agent": UA, "accept-encoding": "gzip, deflate" };

type Page = { accessionNumber: string[]; form: string[]; filingDate: string[]; primaryDocument: string[]; reportDate?: string[] };

const take = (p: Page, out: AnnualFiling[], n: number) => {
  for (let i = 0; i < p.form.length && out.length < n; i++)
    if (p.form[i] === "10-K" && !out.some((x) => x.accn === p.accessionNumber[i]))
      out.push({ accn: p.accessionNumber[i], form: p.form[i], filed: p.filingDate[i], doc: p.primaryDocument[i], report: p.reportDate?.[i] ?? "" });
};

export async function recentAnnualFilings(cik: string, recent: RecentFilings, n = 5): Promise<AnnualFiling[]> {
  const out: AnnualFiling[] = [];
  take(recent as Page, out, n);
  if (out.length >= n) return out;
  const sub = await fetchJson<{ filings: { files?: { name: string }[] } }>(
    `https://data.sec.gov/submissions/CIK${cik.padStart(10, "0")}.json`,
    { headers: H, revalidate: 60 * 60 * 24 },
  ).catch(() => null);
  for (const f of sub?.filings.files ?? []) {
    if (out.length >= n) break;
    const page = await fetchJson<Page>(`https://data.sec.gov/submissions/${f.name}`, { headers: H, revalidate: 60 * 60 * 24 }).catch(() => null);
    if (page) take(page, out, n);
  }
  return out;
}
