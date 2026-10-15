/**
 * 한국 이자비용(설계 10 R-KR6, 결정 Q2 ①~④·D27) — 보고서별 Item `interest_expense_pl`. 어느 보고서를 쓸지(영업이익과 같은 보고서,
 * 최신부터 거슬러 둘 다 있는 첫 보고서)는 ④.
 *  - 범위 = 손익에 잡힌 모든 이자 합계(차입금·사채·리스). 같은 표에 따로 적은 이자 행(리스이자비용 등)을 더한다.
 *  - 출처 = 금융원가(금융비용) 주석 표. 현금흐름 조정·부문 합계·금융상품 범주별 표는 쓰지 않는다.
 *  - XBRL(FY2023 보고서 이후): dart:InterestExpenseFinanceExpense(DIE) — 연결 차원 칸. ifrs-full:InterestExpense(IE)는 원문 금융원가 표의
 *    이자 행 값과 같을 때만(부문·범주별 표에도 무차원으로 쓰여 범위가 섞임).
 *  - 원문(FY2021·22 — XBRL 주석 미태깅): 금융원가 주석 표 「이자비용」 행의 당기·전기 + 같은 표의 다른 이자 행.
 *  - 「없음」의 종류(D27): 표에 이자 행 없음 → confirmed_absent(interest_row_absent), 「금융비용」 합계만 → confirmed_absent(interest_not_separated),
 *    0 이 적혀 있으면 0, 판독 실패·모호 → parse_failed·ambiguous.
 */
import { BLANK, item } from "../common/rawfact.mjs";
import { parseFacts } from "../common/xbrl.mjs";
import { unzipEntries } from "../common/format.mjs";
import { cellNum, cells, consolidatedNoteRegions, docFiles, headings, noteTitle, tableContext, toWon, unitAt } from "./doc.mjs";

const NOTE_OK = /금융\s*원가|금융\s*비용|금융\s*손익|금융\s*수익|영업외/;
const NOTE_NO = /범주|공정가치|위험|부문|현금흐름|리스|차입|사채|특수관계|법인세|비용의\s*성격|성격별|종업원|충당/;
const LBL = /이\s*자.*(비\s*용|원\s*가)|^(\d+\.\s*)?(사채|차입금|리스부채?)\s*이자$/;
const LBL_NO = /수익|수취|지급|받을|미지급|자본화|기타포괄|순확정|확정급여|순이자|증가|감소|현금|조정|수령|퇴직/;
const CTX_OK = /금융\s*원가|금융\s*비용|금융\s*수익|금융\s*손익/;
const CTX_NO = /범주|공정가치|민감도|이자율\s*위험|현금흐름|특수관계|자본화|퇴직|확정급여|차입원가|리스부채의\s*(변동|증감)|부문/;
const CORE = /^(\(?\d+\)?\.?\s*)?이\s*자\s*비\s*용(\s*\(.*\))?(\(\*\d*\))?$|^금융원가\s*\(이자비용\)$/;

/** 원문에서 금융원가 주석 표의 이자 행들 → { status, tables:[{title, ctx, unit, rows:[{label, nums}]}], src } */
export function readFinanceCostTables(zipBuf) {
  const fs = docFiles(zipBuf);
  const regs = consolidatedNoteRegions(fs);
  if (!regs.length) return { status: "no_region", docs: fs.map((f) => f.docName) };
  const byName = new Map(fs.map((f) => [f.name, f]));
  const other = [];
  for (const g of regs) {
    const f = byName.get(g.file);
    const x = f.x;
    const hs = headings(x, g.a, g.b);
    const hits = [];
    for (const tm of x.slice(g.a, g.b).matchAll(/<TABLE\b[^>]*>([\s\S]*?)<\/TABLE>/gi)) {
      const tpos = g.a + tm.index;
      const ctx = tableContext(x, g.a, tpos);
      const rows = [...tm[1].matchAll(/<TR[^>]*>([\s\S]*?)<\/TR>/gi)].map((r) => cells(r[1])).filter((r) => r.length);
      const parsed = [];
      for (const r of rows) {
        const i = r.slice(0, 3).findIndex((c) => LBL.test(c) && !LBL_NO.test(c));
        if (i < 0) continue;
        const nums = r.slice(i + 1).map(cellNum).filter((v) => v != null);
        if (nums.length) parsed.push({ label: r[i], nums, row: r.join(" | ").slice(0, 160) });
      }
      // 「금융원가는 전액 이자비용」(삼성전기) — 표 합계 행
      if (!parsed.length && /전액\s*이자\s*비용/.test(ctx)) {
        for (const r of rows) if (/^(계|합\s*계|소\s*계)$/.test(r[0])) {
          const nums = r.slice(1).map(cellNum).filter((v) => v != null);
          if (nums.length) parsed.push({ label: "금융원가 계(전액 이자비용)", nums, row: r.join(" | ").slice(0, 160), wholeIsInterest: true });
        }
      }
      if (!parsed.length) continue;
      const title = noteTitle(hs, tpos);
      const tbad = NOTE_NO.test(title);
      const ok = !CTX_NO.test(ctx) && (CTX_OK.test(ctx) || (NOTE_OK.test(title) && !tbad));
      const t = { title, ctx: ctx.slice(-160), unit: unitAt(x, tpos + 1, tm[1]), rows: parsed, file: g.file, pos: tpos };
      if (ok) hits.push(t);
      else other.push({ src: g.src, ...t });
    }
    if (hits.length) return { status: "read", src: g.src, tables: hits, enc: f.enc };
  }
  return { status: "no_interest_row", other: other.slice(0, 12) };
}

/** 표 판독 → 당기·전기 이자(원) — 핵심 행 + 같은 표의 다른 이자 행 합 */
export function chooseInterest(rep) {
  if (rep.status !== "read") return null;
  const ts = rep.tables;
  for (let ti = 0; ti < ts.length; ti++) {
    const t = ts[ti];
    const core = t.rows.filter((r) => (CORE.test(r.label) || r.wholeIsInterest) && (r.nums.length === 1 || r.nums.length === 2));
    if (!core.length) continue;
    const r = core[0];
    const abs = (v) => v?.replace(/^-/, "") ?? null;
    let cur = abs(r.nums[0]), prior = null, layout;
    let priorUnit = t.unit;
    if (r.nums.length === 2) { prior = abs(r.nums[1]); layout = "당기·전기 한 표"; }
    else {
      const nxt = ts.slice(ti + 1).find((u) => u.rows.some((z) => CORE.test(z.label) && z.nums.length === 1));
      prior = nxt ? abs(nxt.rows.find((z) => CORE.test(z.label) && z.nums.length === 1).nums[0]) : null;
      priorUnit = nxt?.unit ?? null;
      layout = "당기 표·전기 표 따로";
    }
    const extra = t.rows.filter((x) => x !== r && x.nums.length === r.nums.length && !CORE.test(x.label));
    const won = (v, u) => toWon(v, u);
    const sum = (i, base, u) => {
      if (base == null) return null;
      const w0 = won(base, u);
      if (w0 == null) return null;
      let s = BigInt(w0);
      for (const x of extra) { const w = won(abs(x.nums[i]), u); if (w == null) return null; s += BigInt(w); }
      return String(s);
    };
    if (t.unit == null) return { error: "unit_unknown", title: t.title };
    const curW = won(cur, t.unit), priorW = prior == null ? null : won(prior, priorUnit);
    return {
      title: t.title, ctx: t.ctx, unit: t.unit, label: r.label, row: r.row, layout, file: t.file,
      cur: extra.length ? sum(0, cur, t.unit) : curW, prior: prior == null ? null : extra.length && r.nums.length === 2 ? sum(1, prior, t.unit) : priorW,
      coreCur: curW, corePrior: priorW, extraRows: extra.map((x) => x.row), ncore: core.length,
    };
  }
  return { error: "no_core_row", rows: ts[0]?.rows.map((x) => x.row) };
}

/** XBRL zip → 연결(또는 별도) 이자 사실 { DIE: [{period, v}], IE: [...] } */
export function xbrlInterestFacts(zipBuf, { consolidated = true } = {}) {
  const inst = unzipEntries(zipBuf).find((e) => /\.xbrl$/.test(e.name));
  if (!inst) return null;
  const { facts } = parseFacts(inst.data.toString("utf8"));
  const out = { DIE: [], IE: [] };
  for (const f of facts) {
    const tag = f.concept === "dart:InterestExpenseFinanceExpense" ? "DIE" : f.concept === "ifrs-full:InterestExpense" ? "IE" : null;
    if (!tag || !f.ctx?.start || f.nil) continue;
    const memb = f.ctx.dims.map((d) => d.member);
    const isCons = memb.some((m) => /ConsolidatedMember$/.test(m)) || !memb.some((m) => /SeparateMember$/.test(m));
    const otherDims = f.ctx.dims.filter((d) => !/ConsolidatedAndSeparateFinancialStatementsAxis/.test(d.axis));
    if (isCons !== consolidated || otherDims.length) continue;
    out[tag].push({ start: f.ctx.start, end: f.ctx.end, v: f.raw?.replace(/^-/, "") ?? null, decimals: f.decimals, contextRef: f.contextRef });
  }
  return out;
}

/**
 * 보고서 하나의 이자 Item(당기·전기 열). docBuf 는 원문 zip(있으면), xbrlBuf 는 XBRL zip(있으면).
 * @param {{rcept, year, docBuf?, xbrlBuf?, xbrlErr?, docErr?}} o
 */
export function interestItems(o) {
  const out = [];
  const per = (y) => ({ kind: "duration", start: `${y}-01-01`, end: `${y}-12-31`, months: 12, fy_key: y, fp: "11011", column: y === o.year ? "당기" : "전기" });
  const vb = { filing: o.rcept, form: "11011" };
  const doc = o.docBuf ? readFinanceCostTables(o.docBuf) : null;
  const pick = doc ? chooseInterest(doc) : null;
  const xf = o.xbrlBuf ? xbrlInterestFacts(o.xbrlBuf) : null;
  for (const [y, which] of [[o.year, "cur"], [o.year - 1, "prior"]]) {
    const p = per(y);
    const die = xf?.DIE.filter((f) => f.start === p.start && f.end === p.end) ?? [];
    const ie = xf?.IE.filter((f) => f.start === p.start && f.end === p.end) ?? [];
    const dieVals = [...new Set(die.map((f) => f.v))];
    if (dieVals.length === 1) {
      // 원문 표 값과 대조(R-KR7 — 판독기가 맞는지 확인하는 신호). 다르면 표시만(값은 XBRL): 표 단위·행 판독 오류 또는 합산 범위 차이
      const docV = pick && !pick.error ? pick[which] : null;
      const docCore = pick && !pick.error ? pick[which === "cur" ? "coreCur" : "corePrior"] : null;
      const flags = docV == null ? {} : { doc_value: docV, doc_xbrl_mismatch: docV !== dieVals[0] && docCore !== dieVals[0] };
      out.push(item({ key: "interest_expense_pl", period: p, value: dieVals[0], facts: die.map((f) => `xbrl|${o.rcept}|DIE|${f.contextRef}`), rule: { id: "R-KR6", source: "xbrl", tag: "dart:InterestExpenseFinanceExpense" }, vintage_basis: vb, flags }));
      continue;
    }
    if (dieVals.length > 1) {
      // DIE 가 여러 표에 달림(HD현대중공업 FY2023 128,411 범주별 표 / 131,890 금융비용 주석) — 원문 금융원가 주석 표 이자 행 값과 같은 하나만
      const docV = pick && !pick.error ? pick[which] : null;
      const docCore = pick && !pick.error ? pick[which === "cur" ? "coreCur" : "corePrior"] : null;
      const hit = dieVals.filter((v) => v === docV || v === docCore);
      if (hit.length === 1) {
        out.push(item({ key: "interest_expense_pl", period: p, value: docV ?? hit[0], facts: die.filter((f) => f.v === hit[0]).map((f) => `xbrl|${o.rcept}|DIE|${f.contextRef}`), rule: { id: "R-KR6", source: "xbrl DIE 여럿 → 원문 금융원가 표로 선택", table: pick.title, unit: pick.unit }, vintage_basis: vb, flags: { die_candidates: dieVals, extra_rows: pick.extraRows } }));
      } else {
        out.push(item({ key: "interest_expense_pl", period: p, value: null, blank_reason: BLANK.ambiguous, blank_detail: { DIE: dieVals, doc: docV }, rule: { id: "R-KR6", source: "xbrl" }, vintage_basis: vb }));
      }
      continue;
    }
    // IE 는 원문 금융원가 표 이자 행 값과 같을 때만
    const docV = pick && !pick.error ? pick[which] : null;
    const ieMatch = ie.find((f) => docV != null && (f.v === docV || f.v === pick[which === "cur" ? "coreCur" : "corePrior"]));
    if (ieMatch) {
      out.push(item({ key: "interest_expense_pl", period: p, value: docV, facts: [`xbrl|${o.rcept}|IE|${ieMatch.contextRef}`, `doc|${o.rcept}|${pick.file}`], rule: { id: "R-KR6", source: "xbrl IE + 원문 표 확인", table: pick.title, unit: pick.unit, layout: pick.layout }, vintage_basis: vb, flags: { extra_rows: pick.extraRows } }));
      continue;
    }
    if (docV != null) {
      out.push(item({ key: "interest_expense_pl", period: p, value: docV, facts: [`doc|${o.rcept}|${pick.file}`], rule: { id: "R-KR6", source: "doc", table: pick.title, unit: pick.unit, layout: pick.layout, row: pick.row }, vintage_basis: vb, flags: { extra_rows: pick.extraRows, ie_unmatched: ie.map((f) => f.v) } }));
      continue;
    }
    // 빈칸 — 사유 구분
    let reason = BLANK.parse_failed, detail = {};
    if (!o.docBuf && !o.xbrlBuf) { reason = BLANK.fetch_failed; detail = { docErr: o.docErr ?? null, xbrlErr: o.xbrlErr ?? null }; }
    else if (doc?.status === "no_interest_row") { reason = BLANK.confirmed_absent; detail = { why: "interest_row_absent", other: doc.other?.map((t) => t.title) }; }
    else if (pick?.error === "no_core_row") { reason = BLANK.confirmed_absent; detail = { why: "interest_not_separated", rows: pick.rows }; }
    else if (pick?.error === "unit_unknown") { reason = BLANK.parse_failed; detail = { why: "unit_unknown", table: pick.title }; }
    else if (doc?.status === "no_region") { reason = BLANK.parse_failed; detail = { why: "consolidated_note_region_not_found", docs: doc.docs }; }
    out.push(item({ key: "interest_expense_pl", period: p, value: null, blank_reason: reason, blank_detail: detail, rule: { id: "R-KR6" }, vintage_basis: vb }));
  }
  return out;
}
