/**
 * 일본 판독(설계 10 §6.2 R-JP1~R-JP4) — EDINET 원본 → Filing·RawFact.
 *  - 코드 목록(Edinetcode.zip, Shift_JIS CSV): 証券コード(티커 + "0") → EDINET 코드·결산일·連結の有無.
 *  - 서류 찾기: 보관소의 날짜별 목록(확정일)을 훑어 재무 서류(120 有報·130 訂正·140/150 四半期·160/170 半期, 펀드 제외)만,
 *    withdrawalStatus = 0·xbrlFlag = 1. 訂正은 parentDocID 로 원 서류에 잇는다.
 *  - 서류 zip(PublicDoc .xbrl·_pre·_cal·_lab) → RawFact: 문맥 날짜, NonConsolidatedMember = 별도, 본표 역할(연결/별도·종류)로 placement.
 * 판본 선택·계산은 ④.
 */
import { checkZip, unzipEntries } from "../common/format.mjs";
import { calculationMap, idToQName, parseFacts, parseLabels, parseLinkbase, presentationTree } from "../common/xbrl.mjs";
import { fyKey, markPrecisionDuplicates, monthsBetween, normNum, rawFact } from "../common/rawfact.mjs";

export const FIN_TYPES = new Set(["120", "130", "140", "150", "160", "170"]);

function csvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out;
}

/** 証券コード(5자리) → { edinetCode, name, fyEnd, consolidated } */
export async function edinetCodes(ed) {
  const r = await ed.codeList();
  const csv = unzipEntries(r.buf).find((e) => /\.csv$/i.test(e.name));
  if (!csv) throw new Error("EDINET 코드 목록에 CSV 없음");
  const text = new TextDecoder("shift_jis").decode(csv.data);
  const rows = text.split(/\r?\n/).map(csvLine);
  const head = rows.findIndex((x) => x.includes("ＥＤＩＮＥＴコード"));
  if (head < 0) throw new Error("EDINET 코드 목록 머리줄 없음");
  const h = rows[head];
  const col = (n) => h.indexOf(n);
  const [cE, cSec, cName, cFy, cCons] = [col("ＥＤＩＮＥＴコード"), col("証券コード"), col("提出者名"), col("決算日"), col("連結の有無")];
  if ([cE, cSec, cName, cFy].some((c) => c < 0)) throw new Error("EDINET 코드 목록 칸 이름 변경");
  const m = new Map();
  for (const x of rows.slice(head + 1)) if (x[cSec]) m.set(x[cSec], { edinetCode: x[cE], name: x[cName], fyEnd: x[cFy], consolidated: cCons >= 0 ? x[cCons] === "有" : null });
  return { map: m, version: r.version };
}

/**
 * 보관된 확정일 목록으로 회사별 재무 서류(날짜 범위). 범위 안 날짜가 보관소에 없으면 그 날짜를 missingDates 로 돌려준다(검증불가 사유 — 서류 없음으로 보지 않음).
 * @returns {{byCode: Map<string, any[]>, missingDates: string[]}}
 */
export async function findFilings(ed, codes, { from, to }) {
  const want = new Set(codes);
  const byCode = new Map();
  const missingDates = [];
  for (let d = to, g = 0; d >= from && g < 5000; g++) {
    let j = null;
    try {
      j = (await ed.dayList(d)).json;
    } catch (e) {
      if (e.code === "quota_stop") throw e;
      missingDates.push({ d, why: String(e.message).slice(0, 100) });
    }
    for (const r of j?.results ?? []) {
      if (!want.has(r.edinetCode) || !FIN_TYPES.has(String(r.docTypeCode ?? "")) || r.fundCode) continue;
      if (String(r.withdrawalStatus ?? "0") !== "0" || String(r.xbrlFlag ?? "0") !== "1") continue;
      if (!byCode.has(r.edinetCode)) byCode.set(r.edinetCode, new Map());
      byCode.get(r.edinetCode).set(r.docID, {
        id: r.docID, form: String(r.docTypeCode), filed_at: r.submitDateTime, period_start: r.periodStart, period_end: r.periodEnd,
        parent: r.parentDocID ?? null, edinetCode: r.edinetCode, description: r.docDescription, listDate: d,
      });
    }
    d = new Date(Date.parse(`${d}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);
  }
  const out = new Map();
  for (const [k, m] of byCode) {
    // 訂正(130·150·170)은 목록 periodEnd 가 비어 있다 — 원 서류(parentDocID)의 기간 끝을 이어 받아 신원 확인에 쓴다(감사 10-16 2차 ③-10: 6501 의 130 6건이 기간 확인을 건너뛰었다)
    for (const d of m.values()) {
      if (d.period_end || !d.parent) continue;
      const p = m.get(d.parent);
      if (p?.period_end) { d.period_end = p.period_end; d.period_end_from = "parent"; }
    }
    out.set(k, [...m.values()].sort((a, b) => (a.filed_at ?? "").localeCompare(b.filed_at ?? "")));
  }
  return { byCode: out, missingDates };
}

/** 역할 이름 → 본표 종류·연결 여부 */
function roleKind(uri) {
  const n = uri.split("/").pop() ?? "";
  if (!/^rol_/.test(n)) return null;
  const cons = /Consolidated/.test(n);
  if (/BusinessResultsOf(Group|ReportingCompany)/.test(n)) return { stmt: "summary", cons: /Group/.test(n) };
  if (/Notes|Note[A-Z]|Segment|Parenthetical/.test(n)) return null;
  if (/BalanceSheet|FinancialPosition/.test(n)) return { stmt: "bs", cons };
  if (/CashFlows/.test(n)) return { stmt: "cf", cons };
  if (/ChangesIn(Equity|NetAssets)/.test(n)) return { stmt: "eq", cons };
  if (/ComprehensiveIncome/.test(n) && !/ProfitOrLossAndComprehensiveIncome|IncomeAndComprehensiveIncome/.test(n)) return { stmt: "ci", cons };
  if (/Income|ProfitOrLoss|Operations/.test(n)) return { stmt: "is", cons };
  return null;
}
function bsSection(chain) {
  for (const id of chain) {
    const n = idToQName(id).split(":").pop();
    if (/^CurrentLiabilities(IFRS)?(Abstract)?$/.test(n)) return "current_liabilities";
    if (/^(NoncurrentLiabilities|NonCurrentLiabilitiesIFRS|NoncurrentLiabilitiesIFRS)(Abstract)?$/.test(n)) return "noncurrent_liabilities";
    if (/^CurrentAssets(IFRS)?(Abstract)?$/.test(n)) return "current_assets";
    if (/^(NoncurrentAssets|NonCurrentAssetsIFRS|NoncurrentAssetsIFRS)(Abstract)?$/.test(n)) return "noncurrent_assets";
    if (/^Liabilities(IFRS)?(Abstract)?$/.test(n)) return "liabilities";
    if (/^(NetAssets|EquityIFRS|Equity)(Abstract)?$/.test(n)) return "equity";
    if (/^Assets(IFRS)?(Abstract)?$/.test(n)) return "assets";
  }
  return null;
}
function cfSection(chain) {
  for (const id of chain) {
    const n = idToQName(id).split(":").pop();
    if (/OperatingActivities|OpeCF/.test(n)) return "operating";
    if (/Invest(ing|ment)Activities|InvCF/.test(n)) return "investing";
    if (/FinancingActivities|FinCF/.test(n)) return "financing";
  }
  return null;
}

/**
 * 서류 zip → { facts: RawFact[], dei, roles } — 문맥별 기간·연결 범위, 본표 줄 placement(연결 역할의 줄은 연결 사실에, 별도 역할은 별도 사실에)
 */
export function docFacts(buf, { sym, filing }) {
  const v = checkZip(buf);
  if (!v.ok) throw new Error(`EDINET zip 검사 실패 ${filing.id}: ${v.why}`);
  const ents = unzipEntries(buf).filter((e) => /PublicDoc\/[^/]+\.(xbrl|xml)$/.test(e.name));
  const inst = ents.find((e) => /\.xbrl$/.test(e.name));
  if (!inst) return { facts: [], dei: null, roles: [], missing: ["instance"] };
  const xml = inst.data.toString("utf8");
  const { facts } = parseFacts(xml);
  const deiVal = (n) => facts.find((f) => f.concept === `jpdei_cor:${n}`)?.raw ?? xml.match(new RegExp(`<jpdei_cor:${n}[^>]*>([^<]*)<`))?.[1] ?? null;
  const dei = {
    edinetCode: deiVal("EDINETCodeDEI"), securityCode: deiVal("SecurityCodeDEI"), standard: deiVal("AccountingStandardsDEI"),
    consolidated: deiVal("WhetherConsolidatedFinancialStatementsArePreparedDEI"), periodEnd: deiVal("CurrentPeriodEndDateDEI"),
    fyEnd: deiVal("CurrentFiscalYearEndDateDEI"), periodType: deiVal("TypeOfCurrentPeriodDEI"), docType: deiVal("DocumentType"),
  };
  const pre = ents.find((e) => /_pre\.xml$/.test(e.name));
  const cal = ents.find((e) => /_cal\.xml$/.test(e.name));
  const lab = ents.find((e) => /_lab\.xml$/.test(e.name));
  const labels = lab ? parseLabels(lab.data.toString("utf8")) : new Map();
  const cals = cal ? parseLinkbase(cal.data.toString("utf8"), "calculation") : [];
  const calByRole = new Map(cals.map((r) => [r.role, calculationMap(r)]));
  const calParent = (role, id) => {
    for (const [p, kids] of calByRole.get(role) ?? []) { const k = kids.find((x) => x.to === id); if (k) return { parent: p, weight: k.weight }; }
    return null;
  };
  const roles = [];
  const face = new Map(); // QName → [{stmt, cons, ...}]
  // 한 표 서식(連結包括利益計算書 하나에 손익까지 — 丸紅 8002): 같은 연결 범위에 손익 역할이 없고 包括利益 역할에 매출·당기순이익 줄이 있으면 그 역할을 손익으로 본다
  const preRoles = (pre ? parseLinkbase(pre.data.toString("utf8"), "presentation") : []).map((r) => ({ r, k: roleKind(r.role), tree: presentationTree(r) })).filter((x) => x.k);
  for (const x of preRoles) {
    if (x.k.stmt !== "ci" || preRoles.some((y) => y.k.stmt === "is" && y.k.cons === x.k.cons)) continue;
    const names = x.tree.map((t) => idToQName(t.id).split(":").pop());
    if (names.some((n) => /^(Revenue|NetSales|OperatingRevenue)/.test(n)) && names.some((n) => /^ProfitLoss(IFRS)?$/.test(n))) x.k = { ...x.k, stmt: "is", combined: true };
  }
  for (const { r, k, tree } of preRoles) {
    roles.push({ role: r.role.split("/").pop(), ...k, lines: tree.length });
    for (const t of tree) {
      if (/Abstract$|Heading$|Table$|LineItems$|Axis$|Member$/.test(t.id)) continue;
      const cp = calParent(r.role, t.id);
      const chain = [];
      for (let p = cp?.parent, g = 0; p && g < 30; g++) { chain.push(p); p = calParent(r.role, p)?.parent; }
      const q = idToQName(t.id);
      if (!face.has(q)) face.set(q, []);
      face.get(q).push({
        stmt: k.stmt, cons: k.cons, role: r.role.split("/").pop(), order: t.order, depth: t.depth,
        parent: cp?.parent ?? t.parent, calWeight: cp?.weight ?? null, preferredLabel: t.preferredLabel,
        section: k.stmt === "cf" ? cfSection([...chain, ...[...t.path].reverse()]) : k.stmt === "bs" ? bsSection([...chain, ...[...t.path].reverse()]) : null,
        ancestors: [...chain, ...[...t.path].reverse()].map((id) => idToQName(id).split(":").pop()),
        label: (labels.get(t.id) ?? []).find((l) => l.lang === "ja")?.text ?? null,
        parentLabel: t.parent ? (labels.get(t.parent) ?? []).find((l) => l.lang === "ja")?.text ?? null : null,
      });
    }
  }
  const consPrepared = String(dei.consolidated) === "true";
  const out = [];
  for (const f of facts) {
    if (!f.ctx || /^jpdei_cor:/.test(f.concept)) continue;
    const c = f.ctx;
    const isDur = !!c.start;
    const end = isDur ? c.end : c.instant;
    const nonCons = c.dims.some((d) => /NonConsolidatedMember$/.test(d.member));
    const dims = c.dims.filter((d) => !/NonConsolidatedMember$/.test(d.member)).map((d) => ({ axis: d.axis, member: d.member, typed: d.typed }));
    const consolidation = nonCons || !consPrepared ? "separate" : "consolidated";
    const pl = !dims.length ? (face.get(f.concept) ?? []).filter((p) => (p.stmt === "summary" ? true : p.cons === (consolidation === "consolidated"))) : [];
    out.push(rawFact({
      market: "jp",
      entity: { sym, edinetCode: dei.edinetCode },
      filing: { id: filing.id, form: filing.form, filed_at: filing.filed_at, period_end: dei.periodEnd, amends: filing.parent, doc_type: dei.docType },
      concept: { id: f.concept, label: (labels.get(f.concept.replace(":", "_")) ?? []).find((l) => l.lang === "ja")?.text ?? null, standard: /^(jppfs_cor|jpigp_cor|jpcrp_cor|jpdei_cor)$/.test(f.concept.split(":")[0]) },
      placement: pl.length ? { face: true, stmts: pl.map((p) => ({ stmt: p.stmt, role: p.role, section: p.section, ancestors: p.ancestors, parent: p.parent, calWeight: p.calWeight, order: p.order, depth: p.depth, preferredLabel: p.preferredLabel, label: p.label, parentLabel: p.parentLabel })) } : { face: false },
      period: { kind: isDur ? "duration" : "instant", start: c.start, end, months: isDur ? monthsBetween(c.start, end) : null, fy_key: fyKey("jp", end), fp: dei.periodType, column: f.contextRef },
      scope: { consolidation, attribution: /OwnersOfParent/.test(f.concept) ? "parent" : /NonControlling/.test(f.concept) ? "nci" : "none", ops: /Discontinued/.test(f.concept) ? "discontinued" : /Continuing/.test(f.concept) ? "continuing" : "none", dims },
      value: { raw: f.raw, num: f.nil ? null : normNum(f.raw), unit: f.unit, decimals: f.decimals, sign: null, nil: f.nil },
      locator: { source: "edinet", docID: filing.id, file: inst.name.split("/").pop(), contextRef: f.contextRef, element: f.concept, id: f.id },
      fetch: null,
    }));
  }
  markPrecisionDuplicates(out);
  return { facts: out, dei, roles };
}
