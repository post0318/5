// 사용: tsx dbg2.mts <티커> [공시 수] — 재무활동 말단 줄마다 개념·라벨·앱 성격·검증기 성격(라벨)·가중치
import { debtCat } from "@/lib/markets/us/edgar-cf-debt";
import { readFileSync } from "node:fs";
const UA = { "user-agent": "global-market-research (personal use) contact@example.com" };
const get = async (u: string) => { await new Promise((r) => setTimeout(r, 150)); const r = await fetch(u, { headers: UA }); return r.text(); };
// 검증기 라벨 규칙을 그대로 가져온다(scripts/verify-financials.mjs vDebtLabel)
const src = readFileSync("scripts/verify-financials.mjs", "utf8");
const fnSrc = src.slice(src.indexOf("function vDebtLabel("), src.indexOf("/** 공시 한 건의 현금흐름표 재무활동 차입 줄 — 줄 목록"));
const vDebtLabel = new Function(`${fnSrc}; return vDebtLabel;`)() as (l: string, id?: string) => { cat: string | null; cand: boolean };
const [tk, nS] = process.argv.slice(2);
const map = JSON.parse(await get("https://www.sec.gov/files/company_tickers.json"));
const cik = (Object.values(map) as { ticker: string; cik_str: number }[]).find((x) => x.ticker === tk)!.cik_str;
const sub = JSON.parse(await get(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`));
const rc = sub.filings.recent;
let n = 0;
for (let i = 0; i < rc.form.length && n < Number(nS ?? 2); i++) {
  if (!/^10-[QK]$/.test(rc.form[i])) continue;
  n++;
  const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${rc.accessionNumber[i].replace(/-/g, "")}`;
  const names: string[] = JSON.parse(await get(`${base}/index.json`)).directory.item.map((x: { name: string }) => x.name);
  const xsd = names.find((x) => /\.xsd$/i.test(x));
  const cal = await get(`${base}/${names.find((x) => /_cal\.xml$/i.test(x)) ?? xsd}`);
  const lab = await get(`${base}/${names.find((x) => /_lab\.xml$/i.test(x)) ?? xsd}`);
  const loc = new Map<string, string>(), text = new Map<string, [string, string][]>(), labels = new Map<string, [string, string][]>();
  for (const l of lab.matchAll(/<(?:[\w-]+:)?loc\b([^>]*)\/?>/g)) { const id = /xlink:label="([^"]+)"/.exec(l[1])?.[1], h = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1]; if (id && h) loc.set(id, h); }
  for (const m of lab.matchAll(/<(?:[\w-]+:)?label\b([^>]*)>([^<]*)<\/(?:[\w-]+:)?label>/g)) { const id = /xlink:label="([^"]+)"/.exec(m[1])?.[1], role = /xlink:role="[^"]*\/(\w+)"/.exec(m[1])?.[1] ?? ""; if (id && !/documentation/i.test(role)) text.set(id, [...(text.get(id) ?? []), [role, m[2].trim()]]); }
  for (const a of lab.matchAll(/<(?:[\w-]+:)?labelArc\b([^>]*)\/?>/g)) { const f = loc.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? ""), t0 = text.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? ""); if (f && t0) labels.set(f, [...(labels.get(f) ?? []), ...t0]); }
  const pick = (id: string) => { const ls = labels.get(id) ?? []; return (ls.find(([r]) => /^terseLabel$/i.test(r)) ?? ls.find(([r]) => /^label$/i.test(r)) ?? ls[0] ?? [])[1] ?? "(라벨 없음)"; };
  console.log(`== ${rc.form[i]} ${rc.reportDate[i]} ${rc.accessionNumber[i]}`);
  for (const m of cal.matchAll(/<(?:[\w-]+:)?calculationLink\b[^>]*xlink:role="([^"]+)"[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?calculationLink>/g)) {
    if (!/CASHFLOW/i.test(m[1].replace(/[^A-Za-z]/g, "")) || /Parenth|Detail|Table|Polic|Supplement/i.test(m[1])) continue;
    const l2 = new Map<string, string>();
    for (const l of m[2].matchAll(/<(?:[\w-]+:)?loc\b([^>]*)\/?>/g)) { const id = /xlink:label="([^"]+)"/.exec(l[1])?.[1], h = /xlink:href="[^"#]*#([^"]+)"/.exec(l[1])?.[1]; if (id && h) l2.set(id, h); }
    const kids = new Map<string, [string, number][]>();
    for (const a of m[2].matchAll(/<(?:[\w-]+:)?calculationArc\b([^>]*)\/?>/g)) { const fr = l2.get(/xlink:from="([^"]+)"/.exec(a[1])?.[1] ?? ""), to = l2.get(/xlink:to="([^"]+)"/.exec(a[1])?.[1] ?? ""); const w = Number(/weight="([^"]+)"/.exec(a[1])?.[1] ?? "1"); if (fr && to) kids.set(fr, [...(kids.get(fr) ?? []), [to, w]]); }
    const root = [...kids.keys()].find((k) => /_NetCashProvidedByUsedInFinancingActivities(ContinuingOperations)?$/.test(k));
    if (!root) continue;
    const walk = (k: string, wk: number, d: number) => { for (const [c, w] of kids.get(k) ?? []) { const lb = pick(c); const v = vDebtLabel(lb, c); console.log(`${"  ".repeat(d + 1)}${c}${kids.has(c) ? " (소계)" : ""} w=${wk * w} 앱=${debtCat(c, lb)} 검증기=${v.cat}${v.cand ? "(후보)" : ""} 「${lb}」`); if (kids.has(c)) walk(c, wk * w, d + 1); } };
    walk(root, 1, 0);
  }
}
process.exit(0);
