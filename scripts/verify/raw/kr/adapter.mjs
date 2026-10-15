/**
 * 한국 어댑터 실행(종목 하나) — corpCode → 정기공시 목록 → 보고서별 fnltt(연결, 없음 확인 시 별도)·배당·주식 총수 → RawFact·Item.
 * 실패는 사유 코드로 남긴다. 하루 상한·020(quota_stop)은 던진다(남은 종목 중단).
 */
import { alotItems, capexItems, chainItems, epsItems, stockItems } from "./items.mjs";
import { corpMap, fnlttFacts, markVintage, reportIndex, reportPeriods } from "./read.mjs";

let corpCache = null;

/**
 * @param {ReturnType<import("./dart.mjs").makeDart>} dart
 * @param {{sym:string, years?:number, quarters?:number, now?:()=>Date}} o
 */
export async function runKr(dart, { sym, years = 7, quarters = 5, now = () => new Date() }) {
  const res = { market: "kr", sym, filings: [], rawFacts: [], items: [], failures: [], fsUsed: {} };
  const fail = (stage, e, extra = {}) => {
    if (e?.code === "quota_stop") throw e;
    res.failures.push({ stage, code: e?.code ?? "parse_failed", message: String(e?.message ?? e).slice(0, 300), ...extra });
  };
  try {
    corpCache ??= await corpMap(dart);
  } catch (e) {
    fail("corpCode", e);
    return res;
  }
  const c = corpCache.map.get(sym);
  if (!c) {
    res.failures.push({ stage: "corpCode", code: "confirmed_absent", message: `corpCode.xml 에 종목코드 ${sym} 없음` });
    return res;
  }
  res.corp = c.corp;
  res.name = c.name;
  const cy = Number(new Date(now().getTime() + 9 * 3600e3).toISOString().slice(0, 4));
  let idx;
  try {
    idx = await reportIndex(dart, c.corp, { fromYear: cy - years - 2 });
  } catch (e) {
    fail("list", e);
    return res;
  }
  res.fyEndMonth = idx.fyEndMonth;
  res.filings = idx.reports;
  const annual = idx.reports.filter((r) => r.code === "11011").slice(-years);
  const interim = idx.reports.filter((r) => r.code !== "11011").slice(-quarters);
  for (const r of [...annual, ...interim]) {
    try {
      let fs = "CFS";
      let got = await dart.fnltt(c.corp, r.year, r.code, "CFS", r.latest);
      if (got.json.status === "013") {
        // 목록에 보고서가 있는데 연결 자료 없음 = 연결 재무제표 없음(별도만) — 확인된 해만 별도로(R-KR3)
        const ofs = await dart.fnltt(c.corp, r.year, r.code, "OFS", r.latest);
        if (ofs.json.status === "000") { got = ofs; fs = "OFS"; }
      }
      res.fsUsed[`${r.year}|${r.code}`] = got.json.status === "000" ? fs : "none(013)";
      const facts = fnlttFacts(got.json, { sym, corp: c.corp, year: r.year, code: r.code, fs, rcept: r.latest, fyEndMonth: idx.fyEndMonth ?? 12, fetch: { fromStore: got.fromStore, sha256: got.sha256 } });
      if (fs === "OFS") for (const f of facts) f.scope.no_consolidated = true;
      res.rawFacts.push(...facts);
    } catch (e) {
      fail("fnltt", e, { year: r.year, code: r.code, rcept: r.latest });
    }
  }
  markVintage(res.rawFacts);
  res.items.push(...chainItems(res.rawFacts), ...capexItems(res.rawFacts), ...epsItems(res.rawFacts));
  for (const r of annual) {
    try {
      const a = await dart.alot(c.corp, r.year, "11011", r.latest);
      res.items.push(...alotItems(a.json, { rcept: r.latest, year: r.year }));
    } catch (e) {
      fail("alot", e, { year: r.year });
    }
  }
  for (const r of [...annual.slice(-3), ...interim.slice(-1)]) {
    try {
      const s = await dart.stockTotqy(c.corp, r.year, r.code, r.latest);
      res.items.push(...stockItems(s.json, { rcept: r.latest, year: r.year, code: r.code, periodEnd: reportPeriods(r.year, r.code, idx.fyEndMonth ?? 12).qEnd }));
    } catch (e) {
      fail("stockTotqy", e, { year: r.year, code: r.code });
    }
  }
  res.fetchLog = { ...dart.log };
  return res;
}
