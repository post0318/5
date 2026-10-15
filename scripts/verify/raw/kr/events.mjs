/**
 * 한국 주식 사건(설계 10 R-KR9, 결정 10-14 「액분은 수정기준」) — DART 주요사항보고서(B)·거래소공시(I) 목록 + 증자(감자) 현황(irdsSttus) → Event.
 *  - 목록: 보고서명에 주식분할·주식병합·무상증자·감자·주식배당(회사분할·합병 제외). 날짜 = 접수일(결정 공시일 — 효력일 아님).
 *  - 증자(감자) 현황: 효력일(isu_dcrs_de)·형태·수량·액면. 회사마다 적는 기간이 달라 보조(`07` A).
 *  - 무상감자처럼 주식수가 그대로인 것(대한전선 2022-01 — 액면만 줄임)은 kind 에 그대로 남기고 shares_unchanged 표시. 비율·보정 계수는 ④.
 */
const EVT = /주식분할|주식병합|무상증자|감자|주식배당/;
const NOT_EVT = /회사분할|합병|분할합병/;

export async function krEvents(dart, corp, { fromYear, annualReports }) {
  const out = [];
  const failures = [];
  for (const ty of ["B", "I"]) {
    for (let page = 1; page <= 20; page++) {
      let r;
      try {
        r = await dart.listPage(corp, fromYear, page, ty);
      } catch (e) {
        if (e?.code === "quota_stop") throw e;
        failures.push({ stage: `list-${ty}`, code: e?.code ?? "fetch_failed", message: String(e.message).slice(0, 160) });
        break;
      }
      if (r.json.status === "013") break;
      for (const x of r.json.list ?? []) {
        if (!EVT.test(x.report_nm) || NOT_EVT.test(x.report_nm)) continue;
        out.push({ date: `${x.rcept_dt.slice(0, 4)}-${x.rcept_dt.slice(4, 6)}-${x.rcept_dt.slice(6, 8)}`, date_kind: "공시 접수일", kind: (x.report_nm.match(EVT) ?? [])[0], name: x.report_nm, source: `DART 공시목록(${ty})`, rcept: x.rcept_no, amended: /정정/.test(x.report_nm) });
      }
      if (page >= Number(r.json.total_page ?? 1)) break;
    }
  }
  for (const rep of annualReports) {
    try {
      const j = (await dart.irds(corp, rep.year, "11011", rep.latest)).json;
      if (j.status !== "000") continue;
      for (const x of j.list ?? []) {
        const stle = String(x.isu_dcrs_stle ?? "");
        if (!EVT.test(stle) && !/분할|병합/.test(stle)) continue;
        const d = String(x.isu_dcrs_de ?? "").replace(/[^\d]/g, "");
        out.push({
          date: d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null, date_kind: "효력일(증자·감자 일자)", kind: stle, source: `증자(감자)현황(${rep.year}_11011)`, rcept: rep.latest,
          stock_kind: x.isu_dcrs_stock_knd ?? null, qty: x.isu_dcrs_qy ?? null, par: x.isu_dcrs_mstvdv_fval_amount ?? null, price: x.isu_dcrs_mstvdv_amount ?? null,
          shares_unchanged: /감자/.test(stle) && /^-?$/.test(String(x.isu_dcrs_qy ?? "").trim()),
        });
      }
    } catch (e) {
      if (e?.code === "quota_stop") throw e;
      failures.push({ stage: "irds", year: rep.year, code: e?.code ?? "fetch_failed", message: String(e.message).slice(0, 160) });
    }
  }
  // 같은 사건이 여러 보고서에 반복 — (날짜·형태·수량) 같으면 하나로
  const seen = new Set();
  const events = out.filter((e) => { const k = `${e.date}|${e.kind}|${e.qty ?? ""}|${e.source.startsWith("DART") ? e.rcept : ""}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { events, failures };
}
