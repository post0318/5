/**
 * 미국 정규화 항목(설계 10 §2.2·§4.2) — RawFact → Item(서류별). 계산·판본 선택은 하지 않는다(④).
 *
 * 두 종류:
 *  (가) 개념 사슬 — companyfacts 사실에서 서류·기간마다 사슬의 첫 개념(사전 P-부품 원천 순서). 값은 그 서류가 공시한 값 그대로.
 *  (나) 본표 줄 — 인스턴스 + 본표 구조로 줄을 고른다(R-US5 CapEx·R-US6 이자·현금흐름 감가상각 줄). 줄 선택은 태그 이름이 아니라
 *       본표 위치와 회사 라벨, 라벨이 없으면 태그 정의 + label_missing.
 */
import { item, BLANK } from "../common/rawfact.mjs";

export const factId = (f) => `${f.locator.source}|${f.filing.id}|${f.concept.id}|${f.value.unit}|${f.period.start ?? ""}|${f.period.end}|${f.locator.contextRef ?? ""}`;
const periodKey = (f) => `${f.period.kind}|${f.period.start ?? ""}|${f.period.end}`;

// 통화는 원통화 그대로(20-F 는 EUR·TWD 등 — 환산은 ④, R-US8). 단위 = ISO 통화 3자리
const MONEY = /^[A-Z]{3}$/;
const PER_SHARE = /^[A-Z]{3}\/shares$/;

/** (가) 개념 사슬 정의 — 키 → { concepts, unit(정규식), kind, attribution 등 } (사전 P2·P3·P4·P6·P16·P17 원천 칸) */
export const CHAINS = {
  ni_parent: { concepts: ["us-gaap:NetIncomeLoss", "ifrs-full:ProfitLossAttributableToOwnersOfParent"], unit: MONEY, kind: "duration", part: "P2" },
  ni_total: { concepts: ["us-gaap:ProfitLoss", "ifrs-full:ProfitLoss"], unit: MONEY, kind: "duration", part: "P2(ROA 연결)" },
  ni_nci: { concepts: ["us-gaap:NetIncomeLossAttributableToNoncontrollingInterest", "ifrs-full:ProfitLossAttributableToNoncontrollingInterests"], unit: MONEY, kind: "duration", part: "P2" },
  ni_common: { concepts: ["us-gaap:NetIncomeLossAvailableToCommonStockholdersBasic"], unit: MONEY, kind: "duration", part: "P2·P5" },
  equity_parent: { concepts: ["us-gaap:StockholdersEquity", "ifrs-full:EquityAttributableToOwnersOfParent"], unit: MONEY, kind: "instant", part: "P3①" },
  equity_total: { concepts: ["us-gaap:StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", "ifrs-full:Equity"], unit: MONEY, kind: "instant", part: "P3②" },
  nci_equity: { concepts: ["us-gaap:MinorityInterest", "ifrs-full:NoncontrollingInterests"], unit: MONEY, kind: "instant", part: "P8" },
  assets: { concepts: ["us-gaap:Assets", "ifrs-full:Assets"], unit: MONEY, kind: "instant" },
  liabilities: { concepts: ["us-gaap:Liabilities", "ifrs-full:Liabilities"], unit: MONEY, kind: "instant" },
  eps_diluted_total: { concepts: ["us-gaap:EarningsPerShareDiluted", "ifrs-full:DilutedEarningsLossPerShare"], unit: PER_SHARE, kind: "duration", part: "P4" },
  eps_basic_total: { concepts: ["us-gaap:EarningsPerShareBasic", "ifrs-full:BasicEarningsLossPerShare"], unit: PER_SHARE, kind: "duration", part: "P4" },
  eps_basic_diluted_total: { concepts: ["us-gaap:EarningsPerShareBasicAndDiluted"], unit: PER_SHARE, kind: "duration", part: "P4" },
  eps_diluted_cont: { concepts: ["us-gaap:IncomeLossFromContinuingOperationsPerDilutedShare"], unit: PER_SHARE, kind: "duration", part: "P4" },
  eps_diluted_disc: { concepts: ["us-gaap:IncomeLossFromDiscontinuedOperationsNetOfTaxPerDilutedShare"], unit: PER_SHARE, kind: "duration", part: "P4" },
  eps_basic_cont: { concepts: ["us-gaap:IncomeLossFromContinuingOperationsPerBasicShare"], unit: PER_SHARE, kind: "duration", part: "P4" },
  eps_basic_disc: { concepts: ["us-gaap:IncomeLossFromDiscontinuedOperationsNetOfTaxPerBasicShare"], unit: PER_SHARE, kind: "duration", part: "P4" },
  shares_wavg_basic: { concepts: ["us-gaap:WeightedAverageNumberOfSharesOutstandingBasic", "ifrs-full:WeightedAverageShares"], unit: /^shares$/, kind: "duration", part: "P6" },
  shares_wavg_diluted: { concepts: ["us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding", "ifrs-full:AdjustedWeightedAverageShares"], unit: /^shares$/, kind: "duration", part: "P6" },
  shares_cover: { concepts: ["dei:EntityCommonStockSharesOutstanding"], unit: /^shares$/, kind: "instant", part: "P6(표지·기준일)" },
  shares_outstanding_bs: { concepts: ["us-gaap:CommonStockSharesOutstanding"], unit: /^shares$/, kind: "instant", part: "P6(결산일)" },
  revenue_total: { concepts: ["us-gaap:Revenues", "ifrs-full:Revenue"], unit: MONEY, kind: "duration" },
  revenue_contract: { concepts: ["us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", "us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax"], unit: MONEY, kind: "duration" },
  oi: { concepts: ["us-gaap:OperatingIncomeLoss", "ifrs-full:ProfitLossFromOperatingActivities"], unit: MONEY, kind: "duration", part: "P12(공시 소계)" },
  // 세전이익 두 정의를 따로 낸다(어느 쪽을 쓸지는 ④): 지분법 이익 포함 / 지분법 이익 차감 전 소계
  pretax_incl_equity_method: { concepts: ["us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", "ifrs-full:ProfitLossBeforeTax"], unit: MONEY, kind: "duration", part: "P12" },
  pretax_before_equity_method: { concepts: ["us-gaap:IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments"], unit: MONEY, kind: "duration", part: "P12" },
  cash_incl_discontinued: { concepts: ["us-gaap:CashAndCashEquivalentsAtCarryingValueIncludingDiscontinuedOperations"], unit: MONEY, kind: "instant", part: "P9" },
  cash_incl_restricted: { concepts: ["us-gaap:CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"], unit: MONEY, kind: "instant", part: "P9(현금흐름표 기말)" },
  ocf: { concepts: ["us-gaap:NetCashProvidedByUsedInOperatingActivities", "us-gaap:NetCashProvidedByUsedInOperatingActivitiesContinuingOperations", "ifrs-full:CashFlowsFromUsedInOperatingActivities"], unit: MONEY, kind: "duration", part: "P17" },
  cash_and_equivalents: { concepts: ["us-gaap:CashAndCashEquivalentsAtCarryingValue", "ifrs-full:CashAndCashEquivalents"], unit: MONEY, kind: "instant", part: "P9" },
  dps_declared: { concepts: ["us-gaap:CommonStockDividendsPerShareDeclared"], unit: PER_SHARE, kind: "duration", part: "P16" },
  dps_paid: { concepts: ["us-gaap:CommonStockDividendsPerShareCashPaid"], unit: PER_SHARE, kind: "duration", part: "P16" },
  dividends_declared_common: { concepts: ["us-gaap:DividendsCommonStock", "us-gaap:DividendsCommonStockCash"], unit: MONEY, kind: "duration", part: "P16 배당성향 분자(D21)" },
  dividends_paid_common: { concepts: ["us-gaap:PaymentsOfDividendsCommonStock", "us-gaap:PaymentsOfOrdinaryDividends", "ifrs-full:DividendsPaidClassifiedAsFinancingActivities", "ifrs-full:DividendsPaidClassifiedAsOperatingActivities"], unit: MONEY, kind: "duration", part: "P17·총주주환원" },
};

/**
 * (가) 개념 사슬 Item — 서류·기간마다(서류에 그 기간 값이 있을 때만). 사슬 앞 개념이 그 서류·기간에 없을 때만 다음 개념.
 * @param {import("../common/rawfact.mjs")} facts companyfacts RawFact[]
 */
export function chainItems(facts) {
  const by = new Map(); // 개념 → [fact]
  for (const f of facts) {
    if (!by.has(f.concept.id)) by.set(f.concept.id, []);
    by.get(f.concept.id).push(f);
  }
  const out = [];
  for (const [key, ch] of Object.entries(CHAINS)) {
    const seen = new Set(); // 서류|기간
    for (let ci = 0; ci < ch.concepts.length; ci++) {
      for (const f of by.get(ch.concepts[ci]) ?? []) {
        if (f.period.kind !== ch.kind || !ch.unit.test(f.value.unit ?? "")) continue;
        const k = `${f.filing.id}|${periodKey(f)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(item({
          key, period: f.period, scope: f.scope, value: f.value.num, facts: [factId(f)],
          rule: { id: "R-US-CHAIN", part: ch.part ?? null, concept: f.concept.id, chainIndex: ci },
          vintage_basis: { filing: f.filing.id, form: f.filing.form, filed_at: f.filing.filed_at, is_original: f.vintage?.is_original, is_latest: f.vintage?.is_latest },
          flags: f.vintage?.rounded_retag_of_first ? { rounded_retag_of_first: f.vintage.rounded_retag_of_first } : {},
        }));
      }
    }
  }
  return out;
}

// ── (나) 본표 줄 ─────────────────────────────────────────────────
const faceIn = (f, stmt, section) => !f.value.less_precise_duplicate && f.placement?.face && f.placement.stmts.some((s) => s.stmt === stmt && (!section || s.section === section));
const lineOf = (f, stmt) => f.placement.stmts.find((s) => s.stmt === stmt);
const local = (id) => id.split(":").pop();

/** R-US5 유형자산 취득 줄 판정 — 라벨 우선, 없으면 태그 정의 */
const PPE_TAGS = new Set(["PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities", "PurchaseOfPropertyPlantAndEquipment", "PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets", "PaymentsForCapitalImprovements", "PaymentsToAcquireOtherPropertyPlantAndEquipment", "PaymentsToAcquireFlightEquipment", "PaymentsForFlightEquipment"]);
const PPE_WORD = /propert(y|ies)|premises|plant|equipment|fixed assets|PP&E|capital assets|facilities|capital expenditure|capex/i;
const PPE_VERB = /(purchase|acquisition|addition|payment|expenditure|investment|spend)s?\b|capital expenditure|capex/i;
// 제외: 매각·수취, 사업 인수, 임대 장비, 배출권, 증권 — "excluding …" 뒤는 판정에서 뺀다(CAT "Capital expenditures – excluding equipment leased to others")
const NOT_PPE = /\b(sale|sold|proceeds|disposal|disposition|collection)s?\b|business(es)?\b|net of cash acquired|restaurant|leased equipment|equipment on lease|equipment leased to others|rental equipment|emission|allowance|securities|marketable|finance receivable/i;
const INTANG_ONLY = /software|intangible|internal-use|content/i;
const MIXED_LABEL = /intangible|software|technology|internal-use/i;
// "excluding …"·"net of sales …"(AXP "Purchase of premises and equipment, net of sales: 2025, $1") 뒤는 판정에서 뺀다
const beforeExcluding = (s) => s.split(/\bexcluding\b|\bexcl\.\b|\bother than\b|,?\s*net of\b/i)[0];

/** 줄 하나가 유형자산 취득 줄인가 → { ppe, how } */
export function ppeLine(tag, label, parentLabel) {
  if (!label) return { ppe: PPE_TAGS.has(tag), how: "tag(label_missing)" };
  const lab = beforeExcluding(label);
  if (NOT_PPE.test(lab)) return { ppe: false, how: "label-excluded" };
  if (INTANG_ONLY.test(lab) && !PPE_WORD.test(lab)) return { ppe: false, how: "label-intangible-only" };
  if (PPE_WORD.test(lab) && (PPE_VERB.test(lab) || PPE_VERB.test(parentLabel ?? ""))) return { ppe: true, how: "label" };
  // 부모 묶음 이름이 유형자산 취득("Property and equipment additions:") 이고 줄 이름이 자산 종류(Flight equipment …)
  if (parentLabel && PPE_WORD.test(parentLabel) && PPE_VERB.test(parentLabel) && PPE_WORD.test(lab)) return { ppe: true, how: "parent-label" };
  if (PPE_TAGS.has(tag)) return { ppe: true, how: "tag+label" };
  return { ppe: false, how: "label-not-ppe" };
}

export function capexItems(instFacts, filing) {
  const cf = instFacts.filter((f) => faceIn(f, "cf", "investing") && f.period.kind === "duration" && MONEY.test(f.value.unit ?? ""));
  const byPeriod = groupBy(cf, periodKey);
  const out = [];
  for (const [, fs] of byPeriod) {
    const lines = [];
    const rejected = [];
    for (const f of fs) {
      const n = local(f.concept.id);
      if (/^NetCashProvidedByUsedIn/.test(n)) continue;
      const ln = lineOf(f, "cf");
      const lab = ln?.label ?? null;
      const { ppe, how } = ppeLine(n, lab, ln?.parentLabel ?? null);
      if (ppe) lines.push({ f, lab, how, mixed: !!lab && MIXED_LABEL.test(beforeExcluding(lab)) });
      else rejected.push({ concept: f.concept.id, label: lab, how });
    }
    const p = fs[0].period;
    if (!lines.length) {
      out.push(item({ key: "capex_ppe_line", period: p, value: null, blank_reason: BLANK.confirmed_absent, blank_detail: { investing_lines: rejected }, rule: { id: "R-US5" }, vintage_basis: vb(filing) }));
      continue;
    }
    // 같은 개념이 문맥 ID 만 달리 두 번(같은 값) — 하나로
    const uniq = new Map();
    for (const l of lines) uniq.set(l.f.concept.id, l);
    const ls = [...uniq.values()];
    if (ls.some((l) => l.f.value.inconsistent_duplicate)) {
      out.push(item({ key: "capex_ppe_line", period: p, value: null, blank_reason: BLANK.ambiguous, blank_detail: { why: "같은 줄 같은 정밀도 다른 값", lines: ls.map((l) => l.f.concept.id) }, rule: { id: "R-US5" }, vintage_basis: vb(filing) }));
      continue;
    }
    const sum = ls.reduce((t, l) => t + big(l.f), 0n);
    out.push(item({
      key: "capex_ppe_line", period: p, value: String(sum), facts: ls.map((l) => factId(l.f)),
      rule: { id: "R-US5", lines: ls.map((l) => ({ concept: l.f.concept.id, label: l.lab, how: l.how })) },
      vintage_basis: vb(filing),
      flags: { mixed_with_intangible: ls.some((l) => l.mixed), multiple_lines: ls.length > 1, label_missing: ls.some((l) => !l.lab), excluded_lines: rejected },
    }));
  }
  return out;
}

/** R-US6 이자비용(손익 발생주의) — 본표 줄 → 주석(차원 없는 같은 개념) */
const INT_TAGS = ["InterestExpense", "InterestExpenseOnBorrowings", "InterestExpenseNonoperating", "InterestExpenseOperating", "InterestAndDebtExpense", "InterestExpenseNet", "InterestExpenseDebt"];
export function interestItems(instFacts, filing) {
  const cands = instFacts.filter((f) => !f.value.less_precise_duplicate && f.period.kind === "duration" && MONEY.test(f.value.unit ?? "") && !f.scope.dims.length && INT_TAGS.includes(local(f.concept.id)) && /^(us-gaap|ifrs-full):/.test(f.concept.id));
  const out = [];
  for (const [, fs] of groupBy(cands, periodKey)) {
    const face = fs.filter((f) => faceIn(f, "is"));
    const pick = (arr) => { for (const t of INT_TAGS) { const x = arr.find((f) => local(f.concept.id) === t); if (x) return x; } return null; };
    const f = pick(face) ?? pick(fs);
    if (fs.some((x) => x.concept.id === f.concept.id && x.value.inconsistent_duplicate)) {
      out.push(item({ key: "interest_expense_pl", period: f.period, value: null, blank_reason: BLANK.ambiguous, blank_detail: { why: "같은 개념 같은 정밀도 다른 값", concept: f.concept.id }, rule: { id: "R-US6" }, vintage_basis: vb(filing) }));
      continue;
    }
    out.push(item({
      key: "interest_expense_pl", period: f.period, value: f.value.num, facts: [factId(f)],
      rule: { id: "R-US6", concept: f.concept.id, placement: face.includes(f) ? "face" : "note" },
      vintage_basis: vb(filing),
    }));
  }
  return out;
}

/**
 * 손익계산서 본표의 세전이익 줄(회사 고유 태그 포함 — MCD·ORCL 은 표준 세전이익 태그 없이 고유 태그). 줄이 여럿이면(지분법 전·후) 모두 낸다.
 */
const PRETAX_NAME = /BeforeIncomeTax/;
const PRETAX_LABEL = /(income|earnings|profit|loss)[^.]*before[^.]*(provision for |)income tax|pre-?tax (income|earnings|profit)|before taxes/i;
export function pretaxFaceItems(instFacts, filing) {
  const isF = instFacts.filter((f) => faceIn(f, "is") && f.period.kind === "duration" && MONEY.test(f.value.unit ?? ""));
  const out = [];
  for (const [, fs] of groupBy(isF, periodKey)) {
    const uniq = new Map();
    for (const f of fs) {
      const n = local(f.concept.id);
      const lab = lineOf(f, "is")?.label ?? "";
      if (/IncomeTaxExpense|IncomeTaxesPaid|NetOfTax/.test(n)) continue;
      if (PRETAX_NAME.test(n) || PRETAX_LABEL.test(lab)) uniq.set(f.concept.id, { f, lab });
    }
    const ls = [...uniq.values()];
    if (!ls.length) continue;
    for (const { f, lab } of ls) {
      out.push(item({
        key: "pretax_face_line", period: f.period, value: f.value.inconsistent_duplicate ? null : f.value.num,
        ...(f.value.inconsistent_duplicate ? { blank_reason: BLANK.ambiguous } : {}),
        facts: [factId(f)], rule: { id: "R-US-PRETAX", concept: f.concept.id, label: lab, std: f.concept.standard },
        vintage_basis: vb(filing), flags: { lines_in_period: ls.length, equity_method: /EquityMethod/.test(f.concept.id) ? "before" : null },
      }));
    }
  }
  return out;
}

/**
 * 현금흐름표 영업활동 본표의 감가상각·상각 줄(P13 원천) — 줄마다 포함/제외와 사유를 남긴다(판정 = CLAUDE.md 미국 감가상각 정의를 규칙 문장으로 따로 짬).
 * 제외: 사채할인·발행비, 주식보상, 운용리스 사용권자산 상각, 계약획득원가·고객 인센티브, 재고 공정가치 조정, 연금 상각.
 */
const DA_NAME = /Depreciation|Amorti[sz]ation|Depletion/i;
const DA_EXCLUDE = /Inventory|AcquisitionCost|DebtIssuance|DebtDiscount|DeferredFinancing|FinancingCost|ShareBased|StockBased|OperatingLease|RightOfUse|ContractCost|CostToObtain|Incentive|InventoryStepUp|FairValueAdjustmentInventory|Pension|PostretirementBenefit|DefinedBenefit|Premium|AboveMarket|BelowMarket/i;
const DA_LABEL_EXCLUDE = /inventory|acquisition cost|debt (issuance|discount)|financing cost|stock[- ]based|share[- ]based|operating lease|right[- ]of[- ]use|contract (cost|acquisition)|incentive|inventory step|pension|premium/i;
const DA_LABEL_KEEP = /^(depreciation|amortization of (intangible|acquired)|depreciation, amortization)/i;
export function daItems(instFacts, filing) {
  const cf = instFacts.filter((f) => faceIn(f, "cf", "operating") && f.period.kind === "duration" && MONEY.test(f.value.unit ?? ""));
  const out = [];
  for (const [, fs] of groupBy(cf, periodKey)) {
    const inc = [], exc = [];
    const uniq = new Map();
    for (const f of fs) uniq.set(f.concept.id, f);
    for (const f of uniq.values()) {
      const n = local(f.concept.id);
      const lab = lineOf(f, "cf")?.label ?? "";
      const std = f.concept.standard;
      const nameHit = DA_NAME.test(n);
      const labHit = /depreciation|amortization|depletion/i.test(lab);
      if (!nameHit && !(labHit && !std)) continue;
      let keep;
      // IFRS(20-F)는 리스가 차입금에 들어가므로 사용권자산 상각을 감가상각에 둔다 — 운용리스(ASC 842) 제외는 us-gaap 개념에만
      if (std) keep = f.concept.id.startsWith("ifrs-full:") ? !DA_EXCLUDE.test(n.replace(/RightofuseAssets?|RightOfUseAssets?/i, "")) : !DA_EXCLUDE.test(n);
      else keep = DA_LABEL_KEEP.test(lab) || !DA_LABEL_EXCLUDE.test(lab);
      (keep ? inc : exc).push({ f, lab });
    }
    if (!inc.length && !exc.length) continue;
    const p = fs[0].period;
    if (!inc.length) {
      out.push(item({ key: "da_cf_lines", period: p, value: null, blank_reason: BLANK.confirmed_absent, blank_detail: { excluded: exc.map((x) => ({ concept: x.f.concept.id, label: x.lab })) }, rule: { id: "R-US-DA" }, vintage_basis: vb(filing) }));
      continue;
    }
    if (inc.some((x) => x.f.value.inconsistent_duplicate)) {
      out.push(item({ key: "da_cf_lines", period: p, value: null, blank_reason: BLANK.ambiguous, blank_detail: { why: "같은 줄 같은 정밀도 다른 값" }, rule: { id: "R-US-DA" }, vintage_basis: vb(filing) }));
      continue;
    }
    // 중단영업 감가상각(본표 밖 주석 태그 또는 중단영업 차원) — 현금흐름표가 중단영업을 포함하는지 판단할 재료(④)
    const disc = instFacts.filter((f) => !f.value.less_precise_duplicate && periodKey(f) === periodKey(fs[0]) && MONEY.test(f.value.unit ?? "")
      && (/DepreciationAndAmortizationDiscontinuedOperations|DiscontinuedOperationDepreciation/.test(f.concept.id)
        || (DA_NAME.test(local(f.concept.id)) && f.scope.dims.some((d) => /Discontinued/i.test(`${d.axis} ${d.member}`)))));
    out.push(item({
      key: "da_cf_lines", period: p, value: String(inc.reduce((t, x) => t + big(x.f), 0n)), facts: inc.map((x) => factId(x.f)),
      rule: { id: "R-US-DA", lines: inc.map((x) => ({ concept: x.f.concept.id, label: x.lab })) },
      vintage_basis: vb(filing),
      flags: {
        excluded_lines: exc.map((x) => ({ concept: x.f.concept.id, label: x.lab, value: x.f.value.num })), multiple_lines: inc.length > 1,
        discontinued_da: disc.length ? disc.map((f) => ({ concept: f.concept.id, dims: f.scope.dims, value: f.value.num, fact: factId(f) })) : null,
      },
    }));
  }
  return out;
}

/** 금액 정수 문자열 → BigInt. 정수가 아니면 던진다(금액 사실이 소수 — 판독 오류 신호) */
function big(f) {
  if (!/^-?\d+$/.test(f.value.num ?? "")) throw new Error(`금액이 정수가 아님 ${f.concept.id} ${f.value.raw} (${f.locator.contextRef ?? ""})`);
  return BigInt(f.value.num);
}

/**
 * 판본 표시(서류별 Item 끼리) — 같은 키·기간 Item 을 제출일 순으로 놓고 처음 공시·최신·재작성·반올림 재태깅(R-US1)을 표시.
 * 본표 줄 Item(인스턴스)은 companyfacts 판본 표시가 없어서 여기서 붙인다. 고르지는 않는다(④).
 */
export function markItemVintage(items) {
  const g = new Map();
  for (const it of items) {
    if (it.value == null || !it.vintage_basis?.filed_at) continue;
    const k = `${it.key}|${it.period.kind}|${it.period.start ?? ""}|${it.period.end}`;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(it);
  }
  for (const arr of g.values()) {
    arr.sort((a, b) => a.vintage_basis.filed_at.localeCompare(b.vintage_basis.filed_at) || a.vintage_basis.filing.localeCompare(b.vintage_basis.filing));
    const first = arr[0];
    for (const it of arr) {
      it.vintage_basis.item_is_original = it === first;
      it.vintage_basis.item_is_latest = it === arr[arr.length - 1];
      if (it !== first && it.value !== first.value) {
        it.vintage_basis.item_restated = true;
        const v0 = Number(first.value), v = Number(it.value);
        // 설계 R-US1 1억·10억·100억(감사 10-16 ③-7 — 1e5~1e10 으로 넓었다)
        for (const u of [1e8, 1e9, 1e10]) if (Math.abs(v0) >= u && v !== v0 && v === Math.round(v0 / u) * u) { it.flags.rounded_retag_of_first = u; break; }
      }
    }
  }
  return items;
}

function vb(filing) {
  return { filing: filing.id, form: filing.form, filed_at: filing.filed_at };
}
function groupBy(arr, fn) {
  const m = new Map();
  for (const x of arr) {
    const k = fn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}
