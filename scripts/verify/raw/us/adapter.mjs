/**
 * 미국 어댑터 실행(종목 하나) — 서류 목록 → companyfacts RawFact → 최근 정기공시 인스턴스 RawFact(본표 구조) → Item.
 * 실패는 사유 코드로 남기고 던지지 않는다(호출부가 결과의 failures 를 보고 종료코드를 정함). 단 하루 상한(quota_stop)은 던진다.
 */
import { chainItems, capexItems, daItems, interestItems, markItemVintage, pretaxFaceItems } from "./items.mjs";
import { companyfactsFacts, filings, filingStructure, instanceFacts } from "./read.mjs";

const PERIODIC = /^(10-K|10-Q|20-F|40-F|10-KT|10-QT)(\/A)?$/;

/**
 * @param {ReturnType<import("./sec.mjs").makeSec>} sec
 * @param {{sym:string, cik:string, maxAnnual?:number, maxQuarterly?:number}} o
 */
export async function runUs(sec, { sym, cik, maxAnnual = 6, maxQuarterly = 5 }) {
  const res = { market: "us", sym, cik, filings: [], rawFacts: [], items: [], structures: [], failures: [] };
  const fail = (stage, e, extra = {}) => {
    if (e?.code === "quota_stop") throw e;
    res.failures.push({ stage, code: e?.code ?? "parse_failed", message: String(e?.message ?? e).slice(0, 300), ...extra });
  };
  let fl;
  try {
    fl = await filings(sec, cik);
    res.filings = fl.list;
    res.meta = { name: fl.name, sic: fl.sic, fiscalYearEnd: fl.fiscalYearEnd };
  } catch (e) {
    fail("submissions", e);
    return res;
  }
  const byAccn = new Map(fl.list.map((f) => [f.id, f]));
  const cfAccns = new Set();
  try {
    const cf = await sec.companyfacts(cik);
    const facts = companyfactsFacts(cf.json, { cik, sym, filingByAccn: byAccn, fetch: { version: cf.version, sha256: cf.sha256 } });
    for (const f of facts) cfAccns.add(f.filing.id);
    res.rawFacts.push(...facts);
    res.items.push(...chainItems(facts));
  } catch (e) {
    fail("companyfacts", e);
  }
  // 최근 정기공시(정정 제외) — 연간 maxAnnual·분기 maxQuarterly 건
  const periodic = fl.list.filter((f) => PERIODIC.test(f.form) && !/\/A$/.test(f.form));
  const annual = periodic.filter((f) => /^(10-K|20-F|40-F|10-KT)$/.test(f.form)).slice(0, maxAnnual);
  const quarterly = periodic.filter((f) => /^(10-Q|10-QT)$/.test(f.form)).slice(0, maxQuarterly);
  for (const f of [...annual, ...quarterly]) {
    try {
      const st = await filingStructure(sec, cik, f.id);
      res.structures.push({ accn: f.id, form: f.form, files: st.files, missing: st.missing, roles: st.roles.map((r) => ({ role: r.role, stmt: r.stmt, lines: r.lines.length })) });
      const inst = await instanceFacts(sec, cik, f.id, { sym, filing: f, structure: st });
      res.rawFacts.push(...inst.facts);
      // R-US2: companyfacts 에 통째로 없는 정기공시(BE 2분기·XOM CIK 변경·TSM 2025 20-F) — 인스턴스 사실로 개념 사슬 Item 을 만든다
      if (!cfAccns.has(f.id)) {
        const plain = inst.facts.filter((x) => !x.scope.dims.length && !x.value.less_precise_duplicate);
        const extra = chainItems(plain);
        for (const it of extra) it.flags.source = "instance(companyfacts 누락 — R-US2)";
        res.items.push(...extra);
        res.gapFilled = [...(res.gapFilled ?? []), { accn: f.id, form: f.form, items: extra.length }];
      }
      for (const fn of [capexItems, interestItems, daItems, pretaxFaceItems]) {
        try {
          res.items.push(...fn(inst.facts, f));
        } catch (e) {
          fail(`items:${fn.name}`, e, { accn: f.id });
        }
      }
    } catch (e) {
      fail("instance", e, { accn: f.id, form: f.form });
    }
  }
  markItemVintage(res.items);
  res.fetchLog = { ...sec.log };
  return res;
}
