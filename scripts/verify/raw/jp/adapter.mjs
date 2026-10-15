/**
 * 일본 어댑터 실행 — 코드 목록 → 서류 찾기(보관된 날짜 목록) → 서류 zip → RawFact·Item.
 * 날짜 목록이 하루라도 없으면(받기 실패·미보관) 그 실행의 모든 종목에 사유를 단다(서류 없음으로 판정하지 않음 — R-JP §6.3).
 */
import { capexItems, cashCfEndItems, chainItems, debtItems, financialFormatOf, interestItems, revenueFaceItems, shareItems } from "./items.mjs";
import { docFacts, edinetCodes, findFilings } from "./read.mjs";

let codes = null;
let found = null;

/**
 * @param {ReturnType<import("./edinet.mjs").makeEdinet>} ed
 * @param {{syms:string[], from:string, to:string, maxAnnual?:number, maxInterim?:number}} o
 */
export async function prepareJp(ed, { syms, from, to }) {
  codes ??= await edinetCodes(ed);
  const want = syms.map((s) => [s, codes.map.get(`${s}0`) ?? null]);
  found = await findFilings(ed, want.filter(([, c]) => c).map(([, c]) => c.edinetCode), { from, to });
  return { want, missingDates: found.missingDates };
}

export async function runJp(ed, { sym, maxAnnual = 6, maxInterim = 2 }) {
  const res = { market: "jp", sym, filings: [], rawFacts: [], items: [], failures: [] };
  const fail = (stage, e, extra = {}) => {
    if (e?.code === "quota_stop") throw e;
    res.failures.push({ stage, code: e?.code ?? "parse_failed", message: String(e?.message ?? e).slice(0, 300), ...extra });
  };
  if (found.missingDates.length) res.failures.push({ stage: "list", code: "fetch_failed", message: `날짜 목록 ${found.missingDates.length}일 없음(서류 없음으로 보지 않음)`, dates: found.missingDates.slice(0, 10) });
  const c = codes.map.get(`${sym}0`);
  if (!c) {
    res.failures.push({ stage: "codes", code: "confirmed_absent", message: `EDINET 코드 목록에 ${sym}0 없음` });
    return res;
  }
  res.edinetCode = c.edinetCode;
  const docs = found.byCode.get(c.edinetCode) ?? [];
  res.filings = docs;
  const annual = docs.filter((d) => d.form === "120" || d.form === "130").slice(-maxAnnual - 2);
  const interim = docs.filter((d) => ["140", "150", "160", "170"].includes(d.form)).slice(-maxInterim);
  for (const d of [...annual, ...interim]) {
    try {
      const z = await ed.docZip(d.id, c.edinetCode);
      const r = docFacts(z.buf, { sym, filing: d });
      res.rawFacts.push(...r.facts);
      const financialFormat = financialFormatOf(r.facts);
      const usGaap = /US\s*GAAP/i.test(r.dei?.standard ?? "");
      res.items.push(...chainItems(r.facts), ...cashCfEndItems(r.facts), ...capexItems(r.facts), ...revenueFaceItems(r.facts), ...shareItems(r.facts),
        ...debtItems(r.facts), ...interestItems(r.facts, { financialFormat, usGaap }));
      if (financialFormat) res.financialFormat = true;
      res.docs = [...(res.docs ?? []), { id: d.id, form: d.form, dei: r.dei, roles: r.roles.length }];
    } catch (e) {
      fail("doc", e, { docID: d.id, form: d.form });
    }
  }
  res.fetchLog = { ...ed.log };
  return res;
}
