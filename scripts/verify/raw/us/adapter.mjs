/**
 * 미국 어댑터 실행(종목 하나) — 서류 목록 → companyfacts RawFact → 최근 정기공시 인스턴스 RawFact(본표 구조) → Item.
 * 실패는 사유 코드로 남기고 던지지 않는다(호출부가 결과의 failures 를 보고 종료코드를 정함). 단 하루 상한(quota_stop)은 던진다.
 */
import { chainItems, capexItems, daItems, interestItems, markItemVintage, pretaxFaceItems } from "./items.mjs";
import { companyfactsFacts, filings, filingStructure, instanceFacts } from "./read.mjs";
import { sixKDocs, sixKFacts } from "./sixk.mjs";

const PERIODIC = /^(10-K|10-Q|20-F|40-F|10-KT|10-QT)(\/A)?$/;

/**
 * @param {ReturnType<import("./sec.mjs").makeSec>} sec
 * @param {{sym:string, cik:string, maxAnnual?:number, maxQuarterly?:number}} o
 */
export async function runUs(sec, { sym, cik, maxAnnual = 6, maxQuarterly = 5, withSixK = true }) {
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
  // R-US7 20-F 회사의 분기 = 6-K 연결재무보고서 — 최근 20-F 본표 줄 라벨로 6-K 문서 글자를 읽는다(최근 20-F 결산일 뒤 13개월 안 6-K)
  const last20F = annual.find((f) => /^(20-F|40-F)$/.test(f.form));
  if (last20F && withSixK) {
    try {
      const st = res.structures.find((x) => x.accn === last20F.id) ? await filingStructure(sec, cik, last20F.id) : null;
      const labelsByConcept = new Map();
      for (const r of st?.roles ?? []) for (const l of r.lines) {
        if (l.abstract) continue;
        const ls = (st.labels.get(l.id) ?? []).map((x) => x.text).filter((x) => x && x.length > 3 && x.length < 120);
        if (ls.length) labelsByConcept.set(l.qname, [...new Set(ls)]);
      }
      const since = last20F.period_end ?? last20F.filed_at;
      const until = new Date(Date.parse(since) + 400 * 864e5).toISOString().slice(0, 10);
      const sixKs = fl.list.filter((f) => f.form === "6-K" && f.filed_at > since && f.filed_at <= until);
      const cur = res.rawFacts.find((x) => x.filing.id === last20F.id && /^[A-Z]{3}$/.test(x.value.unit ?? "") && x.value.unit !== "USD")?.value.unit ?? null;
      for (const f of sixKs) {
        try {
          const docs = await sixKDocs(sec, cik, f.id);
          const r6 = sixKFacts({ labelsByConcept, cik, sym, filing: f, docs, currency: cur });
          if (r6.facts.length) res.sixK = [...(res.sixK ?? []), { accn: f.id, facts: r6.facts.length, ambiguous: r6.ambiguous.length }];
          res.rawFacts.push(...r6.facts);
          if (r6.ambiguous.length) res.failures.push({ stage: "6-K", code: "ambiguous", accn: f.id, message: `라벨·기간 값 갈림 ${r6.ambiguous.length}건`, sample: r6.ambiguous.slice(0, 3) });
        } catch (e) {
          fail("6-K", e, { accn: f.id });
        }
      }
    } catch (e) {
      fail("6-K-labels", e, { accn: last20F.id });
    }
  }
  markItemVintage(res.items);
  res.fetchLog = { ...sec.log };
  return res;
}
