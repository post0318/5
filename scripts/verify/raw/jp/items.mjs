/**
 * 일본 정규화 항목(설계 10 §6.2) — EDINET RawFact → Item(서류별). 판본 선택(J-A1 가장 나중 서류·D29 한 열 = 손익 서류)·계산은 ④.
 *  - 개념 사슬: J-GAAP(jppfs_cor)·IFRS(jpigp_cor) 표준 요소, 차원 없는 사실, 연결 우선(연결 재무제표가 없는 회사만 별도).
 *  - R-JP5 현금 = 현금흐름표 「現金及び現金同等物の期末残高」(CF 역할의 기말 줄). BS 현금으로 대체하지 않는다.
 *  - R-JP7 CapEx = 투자활동 본표의 유형 고정자산 취득 줄(합친 줄은 그대로 + mixed), 매각·임대자산 제외. 요소 이름 + 본표 위치 먼저, 고유 요소는 라벨.
 *  - R-JP10 EPS·DPS = 경영지표(SummaryOfBusinessResults). R-JP9 주식수 = 株式の総数等·自己株式等.
 */
import { BLANK, item } from "../common/rawfact.mjs";

export const factId = (f) => `edinet|${f.filing.id}|${f.concept.id}|${f.locator.contextRef}|${f.value.unit ?? ""}`;
const pk = (f) => `${f.period.kind}|${f.period.start ?? ""}|${f.period.end}`;
const local = (id) => id.split(":").pop();
const ok = (f) => f.value.num != null && !f.value.less_precise_duplicate;

export const CHAINS = {
  revenue: { ids: ["jpigp_cor:RevenueIFRS", "jpigp_cor:NetSalesIFRS", "jpigp_cor:OperatingRevenueIFRS", "jppfs_cor:NetSales", "jppfs_cor:OperatingRevenue1", "jppfs_cor:OperatingRevenue2", "jppfs_cor:Revenue", "jppfs_cor:NetSalesOfCompletedConstructionContracts"], kind: "duration" },
  oi: { ids: ["jpigp_cor:OperatingProfitLossIFRS", "jppfs_cor:OperatingIncome"], kind: "duration", part: "P12" },
  ordinary_income: { ids: ["jppfs_cor:OrdinaryIncome"], kind: "duration" },
  pretax: { ids: ["jpigp_cor:ProfitLossBeforeTaxIFRS", "jppfs_cor:IncomeBeforeIncomeTaxes"], kind: "duration" },
  ni_parent: { ids: ["jpigp_cor:ProfitLossAttributableToOwnersOfParentIFRS", "jppfs_cor:ProfitLossAttributableToOwnersOfParent"], kind: "duration", part: "P2" },
  ni_total: { ids: ["jpigp_cor:ProfitLossIFRS", "jppfs_cor:ProfitLoss"], kind: "duration", part: "P2(ROA 연결)" },
  ni_nci: { ids: ["jpigp_cor:ProfitLossAttributableToNonControllingInterestsIFRS", "jppfs_cor:ProfitLossAttributableToNonControllingInterests"], kind: "duration" },
  assets: { ids: ["jpigp_cor:AssetsIFRS", "jppfs_cor:Assets"], kind: "instant" },
  liabilities: { ids: ["jpigp_cor:LiabilitiesIFRS", "jppfs_cor:Liabilities"], kind: "instant" },
  equity_total: { ids: ["jpigp_cor:EquityIFRS", "jppfs_cor:NetAssets"], kind: "instant", part: "P3②" },
  equity_parent: { ids: ["jpigp_cor:EquityAttributableToOwnersOfParentIFRS"], kind: "instant", part: "P3①(J-GAAP 은 ④ 가 NetAssets − 비지배 − 新株予約権)" },
  nci_equity: { ids: ["jpigp_cor:NonControllingInterestsIFRS", "jppfs_cor:NonControllingInterests"], kind: "instant", part: "P8" },
  subscription_rights: { ids: ["jppfs_cor:SubscriptionRightsToShares"], kind: "instant" },
  cash_bs: { ids: ["jpigp_cor:CashAndCashEquivalentsIFRS", "jppfs_cor:CashAndDeposits", "jppfs_cor:CashAndCashEquivalents"], kind: "instant", stmt: "bs" },
  ocf: { ids: ["jpigp_cor:NetCashProvidedByUsedInOperatingActivitiesIFRS", "jppfs_cor:NetCashProvidedByUsedInOperatingActivities"], kind: "duration", part: "P17" },
  icf: { ids: ["jpigp_cor:NetCashProvidedByUsedInInvestingActivitiesIFRS", "jppfs_cor:NetCashProvidedByUsedInInvestmentActivities"], kind: "duration" },
  fcf_financing: { ids: ["jpigp_cor:NetCashProvidedByUsedInFinancingActivitiesIFRS", "jppfs_cor:NetCashProvidedByUsedInFinancingActivities"], kind: "duration" },
  eps_diluted_summary: { ids: ["jpcrp_cor:DilutedEarningsLossPerShareIFRSSummaryOfBusinessResults", "jpcrp_cor:DilutedEarningsPerShareSummaryOfBusinessResults", "jpcrp_cor:DilutedEarningsLossPerShareUSGAAPSummaryOfBusinessResults"], kind: "duration", part: "P4(R-JP10)", any: true },
  eps_basic_summary: { ids: ["jpcrp_cor:BasicEarningsLossPerShareIFRSSummaryOfBusinessResults", "jpcrp_cor:BasicEarningsLossPerShareSummaryOfBusinessResults", "jpcrp_cor:BasicEarningsLossPerShareUSGAAPSummaryOfBusinessResults"], kind: "duration", part: "P4(R-JP10)", any: true },
  dps_summary: { ids: ["jpcrp_cor:DividendPaidPerShareSummaryOfBusinessResults"], kind: "duration", part: "P16", any: true },
};

/** (가) 사슬 — 서류·범위·기간마다. 연결 사실이 있으면 연결만, 없으면 별도(연결 재무제표 없는 회사) */
export function chainItems(facts) {
  const out = [];
  const byConcept = new Map();
  for (const f of facts) {
    if (!ok(f) || f.scope.dims.length) continue;
    if (!byConcept.has(f.concept.id)) byConcept.set(f.concept.id, []);
    byConcept.get(f.concept.id).push(f);
  }
  for (const [key, ch] of Object.entries(CHAINS)) {
    const seen = new Set();
    ch.ids.forEach((id, ci) => {
      for (const f of byConcept.get(id) ?? []) {
        if (f.period.kind !== ch.kind) continue;
        if (ch.stmt && !(f.placement.face && f.placement.stmts.some((s) => s.stmt === ch.stmt))) continue;
        const k = `${f.filing.id}|${f.scope.consolidation}|${pk(f)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(item({
          key, period: f.period, scope: f.scope, value: f.value.inconsistent_duplicate ? null : f.value.num,
          ...(f.value.inconsistent_duplicate ? { blank_reason: BLANK.ambiguous } : {}),
          facts: [factId(f)], rule: { id: "R-JP-CHAIN", part: ch.part ?? null, concept: id, chainIndex: ci, face: f.placement.face },
          vintage_basis: vb(f),
        }));
      }
    });
  }
  return out;
}

/** R-JP5 현금흐름표 기말 현금(期末残高) — CF 역할 본표 줄의 시점값 */
export function cashCfEndItems(facts) {
  const out = [];
  const cands = facts.filter((f) => ok(f) && !f.scope.dims.length && f.period.kind === "instant" && /CashAndCashEquivalents/.test(local(f.concept.id))
    && f.placement.face && f.placement.stmts.some((s) => s.stmt === "cf"));
  const by = new Map();
  for (const f of cands) {
    const k = `${f.filing.id}|${f.scope.consolidation}|${f.period.end}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(f);
  }
  for (const arr of by.values()) {
    // 기말 줄(periodEndLabel)을 우선 — 같은 요소가 기초(periodStartLabel)로도 표시되므로 기간 끝 = 시점이면 기말
    const f = arr[0];
    const vals = new Set(arr.map((x) => x.value.num));
    out.push(item({
      key: "cash_cf_end", period: f.period, scope: f.scope, value: vals.size === 1 ? f.value.num : null,
      ...(vals.size === 1 ? {} : { blank_reason: BLANK.ambiguous }),
      facts: arr.map(factId), rule: { id: "R-JP5", concept: f.concept.id, preferredLabels: [...new Set(f.placement.stmts.filter((s) => s.stmt === "cf").map((s) => s.preferredLabel))] },
      vintage_basis: vb(f),
    }));
  }
  return out;
}

/** R-JP7 CapEx 줄 */
const PPE_STD = /^PurchaseOfPropertyPlantAndEquipment(InvCF|InvCFIFRS)?$|^PurchaseOfPropertyPlantAndEquipmentAndIntangibleAssets(InvCF|InvCFIFRS)$|^PaymentsForPurchaseOfPropertyPlantAndEquipment/;
const PPE_LABEL = /有形(固定)?資産|有形及び無形固定資産|固定資産の取得/;
const NOT_PPE_LABEL = /売却|譲渡|賃貸資産|リース資産|投資有価証券|子会社/;
const MIXED = /And(Intangible|Other)|無形/;
export function capexItems(facts) {
  const cf = facts.filter((f) => ok(f) && !f.scope.dims.length && f.period.kind === "duration" && f.placement.face && f.placement.stmts.some((s) => s.stmt === "cf" && s.section === "investing"));
  const by = new Map();
  for (const f of cf) {
    const n = local(f.concept.id);
    const lab = f.placement.stmts.find((s) => s.stmt === "cf")?.label ?? f.concept.label ?? "";
    let hit = null;
    if (f.concept.standard) { if (PPE_STD.test(n) && !/Sale|Proceeds/.test(n)) hit = "std"; }
    else if (PPE_LABEL.test(lab) && /取得|購入|支出/.test(lab) && !NOT_PPE_LABEL.test(lab)) hit = "label";
    if (!hit) continue;
    const k = `${f.filing.id}|${f.scope.consolidation}|${pk(f)}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push({ f, hit, lab, mixed: MIXED.test(n) || /無形/.test(lab) });
  }
  const out = [];
  for (const arr of by.values()) {
    const u = new Map();
    for (const x of arr) u.set(x.f.concept.id, x);
    const ls = [...u.values()];
    const f = ls[0].f;
    if (ls.some((x) => x.f.value.inconsistent_duplicate)) {
      out.push(item({ key: "capex_ppe_line", period: f.period, scope: f.scope, value: null, blank_reason: BLANK.ambiguous, rule: { id: "R-JP7" }, vintage_basis: vb(f) }));
      continue;
    }
    const sum = ls.reduce((t, x) => t + BigInt(x.f.value.num), 0n);
    out.push(item({
      key: "capex_ppe_line", period: f.period, scope: f.scope, value: String(sum), facts: ls.map((x) => factId(x.f)),
      rule: { id: "R-JP7", lines: ls.map((x) => ({ concept: x.f.concept.id, label: x.lab, how: x.hit })) }, vintage_basis: vb(f),
      flags: { mixed_with_intangible: ls.some((x) => x.mixed), multiple_lines: ls.length > 1 },
    }));
  }
  return out;
}

/** 매출 본표 줄(회사 고유 요소 포함 — 7203 ext:TotalNetRevenuesIFRS). 손익 역할에서 표시 순서 첫 매출성 줄 */
const REV_NAME = /Revenue|NetSales|OperatingRevenue|Sales$/;
const REV_LABEL = /売上高|営業収益|売上収益|収益合計|営業収入/;
export function revenueFaceItems(facts) {
  const is = facts.filter((f) => ok(f) && !f.scope.dims.length && f.period.kind === "duration" && f.placement.face && f.placement.stmts.some((s) => s.stmt === "is"));
  const by = new Map();
  for (const f of is) {
    const s = f.placement.stmts.find((x) => x.stmt === "is");
    const lab = s.label ?? f.concept.label ?? "";
    if (!(REV_NAME.test(local(f.concept.id)) || REV_LABEL.test(lab)) || /Cost|原価|Other|その他/.test(local(f.concept.id) + lab)) continue;
    const k = `${f.filing.id}|${f.scope.consolidation}|${pk(f)}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push({ f, s, lab });
  }
  const out = [];
  for (const arr of by.values()) {
    // 계산 구조의 합계 줄(다른 매출 줄의 부모)이 있으면 그것, 아니면 표시 깊이가 가장 얕고 순서가 앞선 줄
    const ids = new Set(arr.map((x) => x.f.concept.id.replace(":", "_")));
    const tops = arr.filter((x) => !ids.has(x.s.parent ?? ""));
    tops.sort((a, b) => (a.s.depth - b.s.depth) || (Number(a.s.order ?? 0) - Number(b.s.order ?? 0)));
    const x = tops[0] ?? arr[0];
    out.push(item({
      key: "revenue_face", period: x.f.period, scope: x.f.scope, value: x.f.value.num, facts: [factId(x.f)],
      rule: { id: "R-JP-REV", concept: x.f.concept.id, label: x.lab, candidates: arr.length }, vintage_basis: vb(x.f),
    }));
  }
  return out;
}

/** R-JP9 주식수 — 株式の総数等(기말 발행주식수·제출일 현재)·自己株式等(합계) */
export function shareItems(facts) {
  const out = [];
  const pick = [
    [/^TotalNumberOfIssuedSharesSummaryOfBusinessResults$/, "shares_issued_summary"],
    [/NumberOfIssuedSharesAsOfFiscalYearEndIssuedSharesTotalNumberOfSharesEtc$/, "shares_issued_fy_end"],
    [/NumberOfIssuedSharesAsOfFilingDateIssuedSharesTotalNumberOfSharesEtc$/, "shares_issued_filing_date"],
    [/^TotalNumberOfSharesHeldTreasuryStocksEtc$/, "treasury_shares_total"],
  ];
  for (const f of facts) {
    if (!ok(f)) continue;
    const n = local(f.concept.id);
    const p = pick.find(([re]) => re.test(n));
    if (!p) continue;
    out.push(item({ key: p[1], period: f.period, scope: f.scope, value: f.value.num, facts: [factId(f)], rule: { id: "R-JP9", concept: f.concept.id, dims: f.scope.dims }, vintage_basis: vb(f) }));
  }
  return out;
}

function vb(f) {
  return { filing: f.filing.id, form: f.filing.form, filed_at: f.filing.filed_at, amends: f.filing.amends, doc_type: f.filing.doc_type };
}
