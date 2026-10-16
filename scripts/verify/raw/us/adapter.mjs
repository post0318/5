/**
 * 미국 어댑터 실행(종목 하나) — 서류 목록 → companyfacts RawFact → 최근 정기공시 인스턴스 RawFact(본표 구조) → Item.
 * 실패는 사유 코드로 남기고 던지지 않는다(호출부가 결과의 failures 를 보고 종료코드를 정함). 단 하루 상한(quota_stop)은 던진다.
 */
import { chainItems, capexItems, daItems, factId, interestItems, markItemVintage, pretaxFaceItems } from "./items.mjs";
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
  const cfCells = new Set(); // companyfacts 가 만든 Item 칸 「서류|키|기간 종류|끝|개월」 — R-US2 칸 단위 보강용
  try {
    const cf = await sec.companyfacts(cik);
    const facts = companyfactsFacts(cf.json, { cik, sym, filingByAccn: byAccn, fetch: { version: cf.version, sha256: cf.sha256 } });
    for (const f of facts) cfAccns.add(f.filing.id);
    res.rawFacts.push(...facts);
    const cfItems = chainItems(facts);
    for (const it of cfItems) cfCells.add(`${it.vintage_basis?.filing}|${it.key}|${it.period.kind}|${it.period.end}|${it.period.months ?? ""}`);
    res.items.push(...cfItems);
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
      // R-US2: companyfacts 에 없는 칸(BE 2분기·XOM CIK 변경 — 서류 통째, TSM 2025 20-F — dei 주식수 등 2개만 있고 재무 사실 없음) — 인스턴스 사실로
      // 개념 사슬 Item 을 만든다. 서류 단위가 아니라 칸 단위(감사 10-16 ③-2: 사실 2개 때문에 「통째로 없음」이 아니라고 보고 보강하지 않았다)
      {
        const plain = inst.facts.filter((x) => !x.scope.dims.length && !x.value.less_precise_duplicate);
        const extra = chainItems(plain).filter((it) => !cfCells.has(`${it.vintage_basis?.filing}|${it.key}|${it.period.kind}|${it.period.end}|${it.period.months ?? ""}`));
        for (const it of extra) it.flags.source = cfAccns.has(f.id) ? "instance(companyfacts 칸 누락 — R-US2)" : "instance(companyfacts 서류 누락 — R-US2)";
        res.items.push(...extra);
        if (extra.length) res.gapFilled = [...(res.gapFilled ?? []), { accn: f.id, form: f.form, items: extra.length, whole: !cfAccns.has(f.id) }];
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
      const negSets = new Map(); // 개념 → Set(부호 반전 여부) — 본표 줄마다
      const conceptStmts = new Map(); // 개념 → { stmts, sections } — 6-K 줄을 같은 본표 종류·구역에서만 읽게
      for (const r of st?.roles ?? []) for (const l of r.lines) {
        if (l.abstract) continue;
        if (!negSets.has(l.qname)) negSets.set(l.qname, new Set());
        negSets.get(l.qname).add(!!l.negated);
        if (!conceptStmts.has(l.qname)) conceptStmts.set(l.qname, { stmts: new Set(), sections: new Set() });
        const cs = conceptStmts.get(l.qname);
        cs.stmts.add(r.stmt === "ci" ? "is" : r.stmt === "eq" ? "equity" : r.stmt); // 6-K 손익 구역 = 손익·포괄손익
        if (r.stmt === "bs" && /^(current|noncurrent)_(assets|liabilities)$/.test(l.section ?? "")) cs.sections.add(l.section);
        const ls = (st.labels.get(l.id) ?? []).map((x) => x.text).filter((x) => x && x.length > 3 && x.length < 120);
        if (ls.length) labelsByConcept.set(l.qname, [...new Set(ls)]);
      }
      // 개념의 기간 종류 = 그 20-F 인스턴스(차원 없는 사실)에서 쓰인 종류 — 하나일 때만
      const kinds = new Map();
      for (const x of res.rawFacts) {
        if (x.filing.id !== last20F.id || x.locator?.source !== "instance" || x.scope.dims.length) continue;
        if (!kinds.has(x.concept.id)) kinds.set(x.concept.id, new Set());
        kinds.get(x.concept.id).add(x.period.kind);
      }
      const periodKind = new Map([...kinds].filter(([, v]) => v.size === 1).map(([k, v]) => [k, [...v][0]]));
      const negated = new Map([...negSets].map(([k, v]) => [k, v.size === 1 ? [...v][0] : null]));
      const since = last20F.period_end ?? last20F.filed_at;
      const until = new Date(Date.parse(since) + 400 * 864e5).toISOString().slice(0, 10);
      const sixKs = fl.list.filter((f) => f.form === "6-K" && f.filed_at > since && f.filed_at <= until);
      const cur = res.rawFacts.find((x) => x.filing.id === last20F.id && x.locator?.source === "instance" && x.value.presentation_currency)?.value.presentation_currency ?? null; // 20-F 표시 통화(R-US8)
      for (const f of sixKs) {
        try {
          const docs = await sixKDocs(sec, cik, f.id);
          const r6 = sixKFacts({ labelsByConcept, periodKind, negated, conceptStmts, cik, sym, filing: f, docs, currency: cur });
          if (r6.facts.length || r6.excluded.length || r6.coverage.length) res.sixK = [...(res.sixK ?? []), { accn: f.id, facts: r6.facts.length, ambiguous: r6.ambiguous.length, ambiguousList: r6.ambiguous, excluded: r6.excluded, coverage: r6.coverage }];
          res.rawFacts.push(...r6.facts);
          for (const c of r6.coverage) if (c.empty.length) res.failures.push({ stage: "6-K", code: "parse_failed", accn: f.id, message: `본표 구역(${c.empty.join("·")})이 있는데 읽은 사실 0건 — ${c.doc}` });
          if (r6.ambiguous.length) res.failures.push({ stage: "6-K", code: "ambiguous", accn: f.id, message: `라벨·기간 값 갈림 ${r6.ambiguous.length}건`, sample: r6.ambiguous.slice(0, 3) });
        } catch (e) {
          fail("6-K", e, { accn: f.id });
        }
      }
    } catch (e) {
      fail("6-K-labels", e, { accn: last20F.id });
    }
  }
  // 본표 줄 Item 의 통화 = 근거 사실의 단위(하나일 때) — 사슬 Item 은 만들 때 붙였다
  {
    const unitOf = new Map(res.rawFacts.map((f) => [factId(f), f.value.unit]));
    for (const it of res.items) {
      if (it.flags.currency !== undefined || !it.facts.length) continue;
      const us = [...new Set(it.facts.map((id) => unitOf.get(id)))];
      it.flags.currency = us.length === 1 && /^[A-Z]{3}$/.test(us[0] ?? "") ? us[0] : null;
    }
  }
  markItemVintage(res.items);
  res.fetchLog = { ...sec.log };
  return res;
}
