/**
 * 한국 정규화 항목(설계 10 §5.2) — fnltt·alotMatter·stockTotqySttus RawFact → Item(보고서별). 판본 선택·계산은 ④.
 * 계정 식별(R-KR4): account_id 우선, 표준코드가 없으면(-표준계정코드 미사용-) 계정명(공백·괄호·로마숫자 머리 제거)으로.
 * 한 보고서·기간에 같은 키 후보가 여럿이면 ambiguous — 단 현금은 같은 보고서 현금흐름표 기말 현금과 정확히 같을 때 합(카카오 2021~2023).
 */
import { BLANK, item, normNum } from "../common/rawfact.mjs";

export const factId = (f) => `${f.locator.source}|${f.filing.id}|${f.locator.fs_div ?? ""}|${f.locator.sj_div ?? ""}|${f.concept.id}|${f.concept.label}|${f.period.start ?? ""}|${f.period.end}|${f.locator.field ?? ""}`;
const pk = (f) => `${f.period.kind}|${f.period.start ?? ""}|${f.period.end}`;
const normName = (s) => String(s ?? "").replace(/^[\s\dⅠ-ⅩIVX.()·\-]+/, "").replace(/[\s()（）\[\]]/g, "");

/** 키 → { ids(순서), names(계정명 정규식 — 표준코드 없는 행만), stmt, kind } (사전 P-부품 한국 원천 칸) */
export const CHAINS = {
  revenue: { ids: ["ifrs-full_Revenue"], names: /^(매출액|수익\(?매출액\)?|영업수익|매출)$/, stmt: ["is", "ci"], kind: "duration" },
  oi: { ids: ["dart_OperatingIncomeLoss", "ifrs-full_ProfitLossFromOperatingActivities"], names: /^영업이익(\(손실\))?$/, stmt: ["is", "ci"], kind: "duration", part: "P12" },
  pretax: { ids: ["ifrs-full_ProfitLossBeforeTax"], names: /^법인세비용차감전(순이익|계속영업이익)?(\(손실\))?$/, stmt: ["is", "ci"], kind: "duration" },
  ni_total: { ids: ["ifrs-full_ProfitLoss"], names: /^당기순이익(\(손실\))?$/, stmt: ["is", "ci"], kind: "duration", part: "P2(ROA 연결)" },
  ni_parent: { ids: ["ifrs-full_ProfitLossAttributableToOwnersOfParent"], stmt: ["is", "ci"], kind: "duration", part: "P2" },
  ni_nci: { ids: ["ifrs-full_ProfitLossAttributableToNoncontrollingInterests"], stmt: ["is", "ci"], kind: "duration", part: "P2" },
  assets: { ids: ["ifrs-full_Assets"], stmt: ["bs"], kind: "instant" },
  liabilities: { ids: ["ifrs-full_Liabilities"], stmt: ["bs"], kind: "instant" },
  current_assets: { ids: ["ifrs-full_CurrentAssets"], stmt: ["bs"], kind: "instant" },
  current_liabilities: { ids: ["ifrs-full_CurrentLiabilities"], stmt: ["bs"], kind: "instant" },
  equity_total: { ids: ["ifrs-full_Equity"], stmt: ["bs"], kind: "instant", part: "P3②" },
  equity_parent: { ids: ["ifrs-full_EquityAttributableToOwnersOfParent"], stmt: ["bs"], kind: "instant", part: "P3①" },
  nci_equity: { ids: ["ifrs-full_NoncontrollingInterests"], stmt: ["bs"], kind: "instant", part: "P8" },
  cash_and_equivalents: { ids: ["ifrs-full_CashAndCashEquivalents"], names: /^현금및현금성자산$/, stmt: ["bs"], kind: "instant", part: "P9" },
  ocf: { ids: ["ifrs-full_CashFlowsFromUsedInOperatingActivities"], stmt: ["cf"], kind: "duration", part: "P17" },
  icf: { ids: ["ifrs-full_CashFlowsFromUsedInInvestingActivities"], stmt: ["cf"], kind: "duration" },
  fcf_financing: { ids: ["ifrs-full_CashFlowsFromUsedInFinancingActivities"], stmt: ["cf"], kind: "duration" },
  cash_cf_end: { ids: ["dart_CashAndCashEquivalentsAtEndOfPeriodCf", "ifrs-full_CashAndCashEquivalents"], stmt: ["cf"], kind: "instant_or_duration" },
  dividends_paid_cf: { ids: ["ifrs-full_DividendsPaidClassifiedAsFinancingActivities", "ifrs-full_DividendsPaidClassifiedAsOperatingActivities"], stmt: ["cf"], kind: "duration", part: "현금흐름 배당(배당성향 분자 아님 — R-KR8)" },
};

/** (가) 계정 사슬 — 보고서·범위·기간마다 */
export function chainItems(facts) {
  const rows = facts.filter((f) => f.locator.source === "fnltt" && f.value.num != null);
  const out = [];
  for (const [key, ch] of Object.entries(CHAINS)) {
    const cand = rows.filter((f) => ch.stmt.includes(f.placement.stmts[0].stmt) && !f.scope.dims.length
      && (ch.kind === "instant_or_duration" || f.period.kind === ch.kind));
    const by = new Map();
    for (const f of cand) {
      const idIdx = ch.ids.indexOf(f.concept.id);
      const byName = idIdx < 0 && !f.concept.standard && ch.names?.test(normName(f.concept.label));
      if (idIdx < 0 && !byName) continue;
      const k = `${f.filing.id}|${f.scope.consolidation}|${pk(f)}|${f.locator.field}`;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push({ f, rank: idIdx < 0 ? 99 : idIdx, how: idIdx < 0 ? "name" : "id" });
    }
    for (const arr of by.values()) {
      arr.sort((a, b) => a.rank - b.rank);
      const top = arr.filter((x) => x.rank === arr[0].rank);
      const vals = new Set(top.map((x) => x.f.value.num));
      const f = top[0].f;
      const flags = {};
      if (vals.size > 1) {
        out.push(item({ key, period: f.period, scope: f.scope, value: null, blank_reason: BLANK.ambiguous, blank_detail: { candidates: top.map((x) => ({ id: x.f.concept.id, nm: x.f.concept.label, v: x.f.value.num })) }, rule: { id: "R-KR4", part: ch.part ?? null }, vintage_basis: vbOf(f) }));
        continue;
      }
      out.push(item({
        key, period: f.period, scope: f.scope, value: f.value.num, facts: top.map((x) => factId(x.f)),
        rule: { id: "R-KR4", part: ch.part ?? null, account_id: f.concept.id, account_nm: f.concept.label, how: top[0].how, field: f.locator.field },
        vintage_basis: vbOf(f), flags,
      }));
    }
  }
  return out;
}

/**
 * 주당이익 줄 분류(P4) — 계정명과 태그가 어긋나는 공시가 많다(00113207 중단영업 태그에 「기본주당순이익」, 373220 전체 태그에 「…계속영업이익」).
 * 계정명이 계속·중단·기본·희석·주식 종류를 말하면 계정명을 따르고, 말하지 않는 부분만 태그로 정한다. 어긋남은 flags.tag_name_mismatch 로 남긴다.
 * 키: eps_{basic|diluted}_{total|cont|disc}(보통주), 우선주는 eps_*_*_pref. 「기본 및 희석」 한 줄이면 basic·diluted 두 Item.
 */
const EPS_ID = /^ifrs-full_(Basic|Diluted|BasicAndDiluted)EarningsLossPerShare(FromContinuingOperations|FromDiscontinuedOperations)?$/;
export function epsItems(facts) {
  const rows = facts.filter((f) => f.locator.source === "fnltt" && ["is", "ci"].includes(f.placement.stmts[0].stmt) && f.period.kind === "duration" && f.value.num != null && !f.scope.dims.length
    && (EPS_ID.test(f.concept.id) || /주당.*(이익|손실|손익)/.test(f.concept.label ?? "")));
  const out = [];
  const by = new Map();
  for (const f of rows) {
    const nm = String(f.concept.label ?? "").replace(/\(단위[^)]*\)/g, "").replace(/\s/g, "");
    const idm = EPS_ID.exec(f.concept.id);
    const nmBoth = /기본및희석|기본·희석|기본ㆍ희석/.test(nm);
    const nmBasic = !nmBoth && /기본/.test(nm), nmDil = !nmBoth && /희석/.test(nm);
    const idKind = idm ? (idm[1] === "BasicAndDiluted" ? "both" : idm[1].toLowerCase()) : null;
    const kinds = nmBoth ? ["basic", "diluted"] : nmBasic ? ["basic"] : nmDil ? ["diluted"] : idKind === "both" ? ["basic", "diluted"] : idKind ? [idKind] : [];
    if (!kinds.length) continue;
    const nmTotal = /계속영업과중단영업|계속및중단/.test(nm);
    const nmCont = !nmTotal && /계속/.test(nm), nmDisc = !nmTotal && /중단/.test(nm);
    const idOps = idm ? (idm[2] === "FromContinuingOperations" ? "cont" : idm[2] === "FromDiscontinuedOperations" ? "disc" : "total") : null;
    const ops = nmTotal ? "total" : nmCont ? "cont" : nmDisc ? "disc" : !idm ? "total" : idOps === "disc" && /순이익|순손익|순손실/.test(nm) ? "total" : idOps;
    const pref = /우선주/.test(nm);
    const mismatch = idm && ((nmCont || nmDisc || nmTotal) && ops !== idOps || (idKind && idKind !== "both" && (nmBasic || nmDil) && !kinds.includes(idKind)) || (idOps === "disc" && ops === "total"));
    for (const k of kinds) {
      const key = `eps_${k}_${ops}${pref ? "_pref" : ""}`;
      const gk = `${key}|${f.filing.id}|${f.scope.consolidation}|${pk(f)}|${f.locator.field}`;
      if (!by.has(gk)) by.set(gk, { key, list: [] });
      by.get(gk).list.push({ f, mismatch, nm });
    }
  }
  for (const { key, list } of by.values()) {
    const f = list[0].f;
    const vals = new Set(list.map((x) => x.f.value.num));
    if (vals.size > 1) {
      out.push(item({ key, period: f.period, scope: f.scope, value: null, blank_reason: BLANK.ambiguous, blank_detail: { candidates: list.map((x) => ({ id: x.f.concept.id, nm: x.nm, v: x.f.value.num })) }, rule: { id: "R-KR-EPS" }, vintage_basis: vbOf(f) }));
      continue;
    }
    out.push(item({
      key, period: f.period, scope: f.scope, value: f.value.num, facts: list.map((x) => factId(x.f)),
      rule: { id: "R-KR-EPS", part: "P4", account_id: f.concept.id, account_nm: f.concept.label, field: f.locator.field },
      vintage_basis: vbOf(f), flags: list.some((x) => x.mismatch) ? { tag_name_mismatch: true } : {},
    }));
  }
  return out;
}

/** R-KR5 유형자산 취득 줄 — 표준 ID 또는 계정명. 「유ㆍ무형자산의 취득」 한 줄이면 그 줄 + mixed_with_intangible */
const PPE_ID = "ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities";
const PPE_NAME = /^(투자활동으로분류된)?유형자산의?취득(으로인한현금유출)?$/;
const MIXED_NAME = /^유[ㆍ·.,및과]?무형자산의?취득/;
export function capexItems(facts) {
  const rows = facts.filter((f) => f.locator.source === "fnltt" && f.placement.stmts[0].stmt === "cf" && f.period.kind === "duration" && f.value.num != null && !f.scope.dims.length);
  const by = new Map();
  for (const f of rows) {
    const n = normName(f.concept.label);
    const hit = f.concept.id === PPE_ID ? "id" : PPE_NAME.test(n) ? "name" : MIXED_NAME.test(n) ? "mixed" : null;
    if (!hit) continue;
    const k = `${f.filing.id}|${f.scope.consolidation}|${pk(f)}|${f.locator.field}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push({ f, hit });
  }
  const out = [];
  for (const arr of by.values()) {
    const pure = arr.filter((x) => x.hit !== "mixed");
    const use = pure.length ? pure : arr;
    const vals = new Set(use.map((x) => x.f.value.num));
    const f = use[0].f;
    if (vals.size > 1) {
      out.push(item({ key: "capex_ppe_line", period: f.period, scope: f.scope, value: null, blank_reason: BLANK.ambiguous, blank_detail: { candidates: use.map((x) => ({ nm: x.f.concept.label, v: x.f.value.num })) }, rule: { id: "R-KR5" }, vintage_basis: vbOf(f) }));
      continue;
    }
    out.push(item({
      key: "capex_ppe_line", period: f.period, scope: f.scope, value: f.value.num, facts: use.map((x) => factId(x.f)),
      rule: { id: "R-KR5", account_id: f.concept.id, account_nm: f.concept.label, how: use[0].hit }, vintage_basis: vbOf(f),
      flags: { mixed_with_intangible: !pure.length },
    }));
  }
  return out;
}

/**
 * R-KR8 배당(alotMatter) — 보고서 하나의 행 → Item: dps_common(주당 현금배당금 보통주), dividends_declared_parent(현금배당금총액, 백만원 → 원),
 * payout_ratio_reported(연결 현금배당성향). 열: thstrm 당기·frmtrm 전기·lwfr 전전기.
 */
export function alotItems(j, { rcept, year, fetch }) {
  if (j.status !== "000") return [];
  const out = [];
  const cols = [["thstrm", 0], ["frmtrm", -1], ["lwfr", -2]];
  for (const r of j.list ?? []) {
    const se = String(r.se ?? "").replace(/\s/g, "");
    const kind = String(r.stock_knd ?? "").trim();
    let key = null, scale = 0;
    if (/^주당현금배당금\(원\)$/.test(se) && (kind === "보통주" || kind === "-")) key = "dps_common";
    else if (/^\(연결\)?현금배당금총액\(백만원\)$/.test(se) || /^현금배당금총액\(백만원\)$/.test(se)) { key = "dividends_declared_parent"; scale = 6; }
    else if (/^\(연결\)현금배당성향\(%\)$/.test(se)) key = "payout_ratio_reported";
    if (!key) continue;
    for (const [c, off] of cols) {
      const raw = r[c];
      const num = normNum(raw === "-" ? null : raw);
      const y = year + off;
      const period = { kind: "duration", start: `${y}-01-01`, end: `${y}-12-31`, months: 12, fy_key: y, fp: "11011", column: c };
      const value = num == null ? null : scale ? scaleStr(num, scale) : num;
      out.push(item({
        key, period, value: value ?? null, ...(value == null ? { blank_reason: BLANK.confirmed_absent, blank_detail: { raw } } : {}),
        facts: [`alot|${rcept}|${se}|${kind}|${c}`], rule: { id: "R-KR8", se: r.se, stock_knd: r.stock_knd, raw },
        vintage_basis: { filing: rcept, form: "11011", data_rcept: r.rcept_no ?? null }, flags: { scale_from_million: scale === 6, nonDecFyAssumed: false },
      }));
    }
  }
  return out;
}
function scaleStr(num, k) {
  const neg = num.startsWith("-");
  const [ip, fp = ""] = num.replace(/^-/, "").split(".");
  if (fp.length > k) return null;
  const s = (ip + fp.padEnd(k, "0")).replace(/^0+(?=\d)/, "");
  return neg && s !== "0" ? `-${s}` : s;
}

/** 주식 총수(stockTotqySttus) → Item: shares_issued_*, treasury_*, shares_outstanding_* (보통주·우선주별 — D20 분모 재료) */
export function stockItems(j, { rcept, year, code, periodEnd }) {
  if (j.status !== "000") return [];
  const out = [];
  for (const r of j.list ?? []) {
    const se = String(r.se ?? "").replace(/\s/g, "");
    const cls = /보통/.test(se) ? "common" : /우선/.test(se) ? "preferred" : /합계/.test(se) ? "total" : null;
    if (!cls) continue;
    const period = { kind: "instant", start: null, end: periodEnd, months: null, fy_key: Number(periodEnd.slice(0, 4)), fp: code, column: "기말" };
    for (const [fld, key] of [["istc_totqy", `shares_issued_${cls}`], ["tesstk_co", `treasury_${cls}`], ["distb_stock_co", `shares_outstanding_${cls}`]]) {
      const num = normNum(r[fld] === "-" ? null : r[fld]);
      out.push(item({
        key, period, value: num, ...(num == null ? { blank_reason: BLANK.confirmed_absent, blank_detail: { raw: r[fld] } } : {}),
        facts: [`stock|${rcept}|${se}|${fld}`], rule: { id: "R-KR-SHARES", se: r.se, field: fld }, vintage_basis: { filing: rcept, form: code },
      }));
    }
  }
  return out;
}

function vbOf(f) {
  return { filing: f.filing.id, form: f.filing.form, data_rcept: f.filing.data_rcept, field: f.locator.field, consolidation: f.scope.consolidation, is_original: f.vintage?.is_original, is_latest: f.vintage?.is_latest };
}
