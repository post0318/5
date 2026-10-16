/**
 * 한국 어댑터 실행(종목 하나) — corpCode → 정기공시 목록 → 보고서별 fnltt(연결, 없음 확인 시 별도)·배당·주식 총수 → RawFact·Item.
 * 실패는 사유 코드로 남긴다. 하루 상한·020(quota_stop)은 던진다(남은 종목 중단).
 */
import { alotItems, capexItems, chainItems, epsItems, stockItems } from "./items.mjs";
import { corpMap, fnlttFacts, markVintage, reportIndex, reportPeriods } from "./read.mjs";
import { interestItems } from "./interest.mjs";
import { krXbrlFacts } from "./xbrlfacts.mjs";
import { krEvents } from "./events.mjs";
import { daDocItems } from "./da.mjs";
import { BLANK, item } from "../common/rawfact.mjs";

let corpCache = null;

/**
 * @param {ReturnType<import("./dart.mjs").makeDart>} dart
 * @param {{sym:string, years?:number, quarters?:number, now?:()=>Date}} o
 */
export async function runKr(dart, { sym, years = 7, quarters = 5, withInterest = true, now = () => new Date() }) {
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
  // R-KR6 이자비용 — 보고서별(당기·전기). XBRL 주석은 FY2023 보고서부터, 원문은 모든 사업보고서(IE 표 확인·옛 연도 판독)
  if (withInterest) {
    for (const r of annual) {
      let docBuf = null, xbrlBuf = null, docErr = null, xbrlErr = null;
      // 조회 실패는 이자 Item 빈칸 사유뿐 아니라 실행 failures 에도 남긴다(감사 10-16 2차 ③-4 — XBRL·원문 실패가 흔적 없이 리스 주석·감가상각 원문 Item 을 지웠다)
      try { docBuf = (await dart.document(r.latest)).buf; } catch (e) { fail("document", e, { year: r.year, rcept: r.latest }); docErr = String(e.message).slice(0, 160); }
      // XBRL 은 2021 사업보고서부터 받아 사실 전부를 RawFact 로(주석 태그는 FY2023 보고서부터 — 이자 Item 은 그 해부터 XBRL 을 쓴다)
      if (r.year >= 2021) {
        try { xbrlBuf = (await dart.xbrl(r.latest, "11011", c.corp)).buf; } catch (e) { fail("xbrl", e, { year: r.year, rcept: r.latest }); xbrlErr = String(e.message).slice(0, 160); }
        if (xbrlBuf) {
          try {
            const xf = krXbrlFacts(xbrlBuf, { sym, corp: c.corp, rcept: r.latest });
            res.rawFacts.push(...xf.facts);
            res.items.push(...leaseNoteItems(xf.facts, r.latest));
          } catch (e) { fail("xbrl-facts", e, { year: r.year }); }
        }
      }
      try {
        res.items.push(...interestItems({ rcept: r.latest, year: r.year, docBuf, xbrlBuf: r.year >= 2023 ? xbrlBuf : null, docErr, xbrlErr }));
      } catch (e) {
        fail("interest", e, { year: r.year });
      }
      // R-KR11 감가상각 원문 후보(성격별·현금흐름 조정·투자부동산 변동표)
      if (docBuf) {
        try { res.items.push(...daDocItems(docBuf, { rcept: r.latest, year: r.year, code: "11011" })); } catch (e) { fail("da-doc", e, { year: r.year }); }
      }
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
  // R-KR9 주식 사건
  try {
    const ev = await krEvents(dart, c.corp, { fromYear: cy - years, annualReports: annual.slice(-3) });
    res.events = ev.events;
    for (const f of ev.failures) res.failures.push({ ...f, stage: `events:${f.stage}` });
  } catch (e) {
    fail("events", e);
  }
  res.fetchLog = { ...dart.log };
  return res;
}

/**
 * 리스부채 주석(B16 — 본표에 리스 줄이 없을 때 주석 장부금액) 후보 — 연결·차원 없는 ifrs-full:LeaseLiabilities 시점값. 값이 갈리면 ambiguous(후보 목록).
 * 단위 오류(079550 2024 보고서 천원 숫자를 원 단위로 태깅) 판정은 이웃 보고서 대조가 필요해 ④(값·decimals 를 그대로 남긴다).
 * 「보고 금액」 차원(CarryingAmount…Axis = dart:ReportedAmountMember)만 붙은 칸도 차원 없는 칸과 같이 본다 — 보관된 사업보고서 216건 중
 * 리스부채가 그 차원에만 달린 보고서가 있다(이자 DIE 와 같은 결함, 329180).
 */
const reportedOnly = (dims) => dims.every((d) => /CarryingAmountAccumulatedDepreciationAmortisationAndImpairmentAndGrossCarryingAmountAxis$/.test(d.axis) && /ReportedAmountMember$/.test(d.member));
function leaseNoteItems(facts, rcept) {
  const c = facts.filter((f) => f.concept.id === "ifrs-full:LeaseLiabilities" && f.scope.consolidation !== "separate" && reportedOnly(f.scope.dims) && f.period.kind === "instant" && f.value.num != null && !f.value.less_precise_duplicate);
  const by = new Map();
  for (const f of c) { if (!by.has(f.period.end)) by.set(f.period.end, []); by.get(f.period.end).push(f); }
  const out = [];
  for (const [end, arr] of by) {
    const vals = [...new Set(arr.map((f) => f.value.num))];
    const p = arr[0].period;
    out.push(item({
      key: "lease_liabilities_note", period: p, scope: arr[0].scope, value: vals.length === 1 ? vals[0] : null,
      ...(vals.length === 1 ? {} : { blank_reason: BLANK.ambiguous, blank_detail: { candidates: arr.map((f) => ({ ctx: f.locator.contextRef, v: f.value.num, decimals: f.value.decimals })) } }),
      facts: arr.map((f) => `dart-xbrl|${rcept}|${f.locator.contextRef}`), rule: { id: "R-KR-LEASE", decimals: [...new Set(arr.map((f) => f.value.decimals))], end },
      vintage_basis: { filing: rcept, form: "11011" },
    }));
  }
  return out;
}
