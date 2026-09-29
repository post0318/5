// StockAnalysis(S&P 표준화) 미해결 칸 분해 — SA − 앱 = ±(후보 1~2개) 가 대조한 모든 연간 열에서 정확 성립하는 조합 탐색.
// 후보: S&P 표준화 손익 줄 전부 + 최근 10-K 3건 인스턴스의 사업연도 사실(무차원·손익 위치 차원 1개, 회사 고유 태그 포함).
// 사용: node scripts/reference/sa-decomp.mjs <검증 결과 json> <TICKER...>   (검증 스크립트 전용 도구 — 앱에 넣지 않음)
import fs from "node:fs";
import * as N from "./notes.mjs";
const [repPath, ...syms] = process.argv.slice(2);
const rep = JSON.parse(fs.readFileSync(repPath, "utf8"));
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const unflat = (arr) => { const memo = new Map(); const h = (i) => { if (i === -1) return; if (memo.has(i)) return memo.get(i); const v = arr[i]; if (v === null || typeof v !== "object") { memo.set(i, v); return v; } if (Array.isArray(v)) { const o = []; memo.set(i, o); for (const x of v) o.push(h(x)); return o; } const o = {}; memo.set(i, o); for (const [k, x] of Object.entries(v)) o[k] = h(x); return o; }; return h(0); };
const CACHE = ".cache/sa"; fs.mkdirSync(CACHE, { recursive: true });
async function sa(sym) {
  const f = `${CACHE}/${sym}-is.json`;
  if (!fs.existsSync(f)) { const r = await fetch(`https://stockanalysis.com/stocks/${sym.toLowerCase()}/financials/income-statement/__data.json?x-sveltekit-invalidated=001`, { headers: { "user-agent": UA } }); fs.writeFileSync(f, await r.text()); }
  const node = JSON.parse(fs.readFileSync(f, "utf8")).nodes.find((n) => n?.type === "data" && JSON.stringify(n.data).includes("financialData"));
  const d = unflat(node.data); return { fd: d.financialData, map: d.map };
}
const M = { 매출원가: "cor", 판관비: "sgna", 연구개발비: "rnd", 영업이익: "opinc", 감가상각비: "depAmorEbitda", 매출총이익: "gp" };
const dd = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;
for (const sym of syms) {
  const r = rep.results.find((x) => x.sym === sym); if (!r) continue;
  const { fd, map } = await sa(sym);
  const cik = await N.cikOf(sym);
  const fil = (await N.filings(cik)).filter((f) => f.form === "10-K").slice(0, 3);
  const facts = [];
  for (const f of fil) { try { const { facts: fs2 } = await N.instanceFacts(cik, f.accn); for (const x of fs2) facts.push({ ...x, filed: f.filed }); } catch (e) { console.error(sym, f.accn, String(e).slice(0, 80)); } }
  for (const [m, key] of Object.entries(M)) {
    const rows = r.review.filter((y) => /^\d{4}Y /.test(y.item) && y.item.endsWith(` ${m}`) && y.sources?.StockAnalysis != null && y.ours != null);
    if (!rows.some((y) => ["구성미분해", "③", "외부단독이탈"].includes(y.metricClass?.StockAnalysis))) continue;
    const cols = rows.map((y) => { const col = y.item.slice(0, 5); const k = fd.fiscalYear.findIndex((fy, i) => fd.datekey[i] !== "TTM" && `${fy}Y` === col); return { col, k, end: fd.datekey[k], d: y.sources.StockAnalysis - y.ours }; }).filter((c) => c.k >= 0);
    const cands = [];
    for (const row of map ?? []) { const vals = cols.map((c) => fd[row.id]?.[c.k] ?? 0); if (typeof vals[0] === "number" && vals.some((v) => v) && row.format !== "pershare" && !/EPS|Per Share|Shares|Margin|Growth|EBT|EBIT|Pretax|Net Income|Earnings From|Gross Profit|Operating Income|Revenue|Tax Rate|Free Cash/i.test(row.title) && !["revenue", "gp", "opinc", "cor", "sgna", "rnd", "opex", "pretax", "netinc", "ebitda", "ebit"].includes(row.id)) cands.push({ n: `S&P:${row.title}`, vals, sa: 1 }); }
    const byC = new Map();
    for (const x of facts) {
      if (!x.start || dd(x.start, x.end) < 300 || typeof x.val !== "number") continue;
      const dk = Object.entries(x.dims ?? {}); if (dk.length > 1 || (dk.length === 1 && !/IncomeStatementLocation|StatementOfIncomeLocation/.test(dk[0][0]))) continue;
      const id = `${x.ns}:${x.concept}${dk.length ? `[${dk[0][1]}]` : ""}`;
      const e = byC.get(id) ?? new Map(); const prev = e.get(x.end); if (!prev || prev.filed < x.filed) e.set(x.end, { v: x.val, filed: x.filed }); byC.set(id, e);
    }
    for (const [id, e] of byC) { const vals = cols.map((c) => { for (const [end, o] of e) if (dd(end, c.end) <= 7) return o.v; return 0; }); if (vals.filter((v) => v).length) cands.push({ n: `SEC:${id}`, vals, sa: 0 }); }
    const tol = (k) => 0.5e6 * (1 + k) + 1;
    const nz = cols.filter((c) => Math.abs(c.d) > 1e6).length;
    const hits = [];
    const test = (terms) => { const k = terms.reduce((a, t) => a + t.sa, 0); return cols.every((c, i) => Math.abs(c.d - terms.reduce((s, t) => s + t.s * t.vals[i], 0)) <= tol(k)); };
    // S&P 줄 1~3개(+ SEC 항목 0~1개) — 부호 조합 전부. 증거 연도(차이 ≥ 1백만) 2개 이상일 때만
    if (nz >= 2) {
      const sp = cands.filter((c) => c.sa), sec = [null, ...cands.filter((c) => !c.sa)];
      const combos = []; for (let i = 0; i < sp.length; i++) { combos.push([sp[i]]); for (let j = i + 1; j < sp.length; j++) { combos.push([sp[i], sp[j]]); for (let l = j + 1; l < sp.length; l++) combos.push([sp[i], sp[j], sp[l]]); } }
      outer: for (const cb of combos) for (let mask = 0; mask < 1 << cb.length; mask++) {
        const ts = cb.map((c, i) => ({ ...c, s: mask & (1 << i) ? -1 : 1 }));
        for (const x of sec) for (const sx of x ? [1, -1] : [1]) {
          const all = x ? [...ts, { ...x, s: sx }] : ts;
          if (test(all)) { hits.push(all.map((t) => `${t.s > 0 ? "+" : "−"}${t.n}`).join(" ")); if (hits.length >= 6) break outer; }
        }
      }
    }
    if (nz >= 2) for (let i = 0; i < cands.length && hits.length < 6; i++) for (const s1 of [1, -1]) {
      const a = { ...cands[i], s: s1 };
      if (test([a])) hits.push(`${s1 > 0 ? "+" : "−"}${a.n}`);
      for (let j = i + 1; j < cands.length && hits.length < 6; j++) for (const s2 of [1, -1]) { const b = { ...cands[j], s: s2 }; if (test([a, b])) hits.push(`${s1 > 0 ? "+" : "−"}${a.n} ${s2 > 0 ? "+" : "−"}${b.n}`); }
    }
    console.log(`\n${sym} ${m} (증거 연도 ${nz}/${cols.length}) SA−앱: ${cols.map((c) => `${c.col} ${(c.d / 1e6).toFixed(1)}`).join(" · ")} · 후보 ${cands.length}`);
    console.log(hits.length ? hits.map((h) => "   " + h).join("\n") : "   성립 없음");
  }
}
