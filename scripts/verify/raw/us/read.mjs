/**
 * 미국 판독(설계 10 §4.2 R-US1·R-US3·R-US4) — SEC 원본 → Filing·RawFact·본표 구조.
 *  - companyfacts: 표준 개념(us-gaap·ifrs-full·dei·srt) 사실 전부. 같은 (개념·단위·기간)의 서류별 값을 모두 남기고 판본 표시
 *    (is_original = 가장 이른 제출, is_latest = 가장 늦은 제출, restated = 처음 공시값과 비교). 반올림 재태깅은 표시만(지우지 않음).
 *  - 인스턴스: 회사 고유 태그·차원·decimals 까지 — 본표 구조(_pre·_cal·_lab)로 본표 여부·구역·부모·표시 순서·부호 반전 라벨을 붙인다.
 * 판본 선택·계산은 하지 않는다(④).
 */
import { calculationMap, idToQName, parseFacts, parseLabels, parseLinkbase, presentationTree } from "../common/xbrl.mjs";
import { fyKey, markPrecisionDuplicates, markPresentationCurrency, monthsBetween, normNum, rawFact, roundedRetagUnit } from "../common/rawfact.mjs";

const pad10 = (cik) => String(cik).replace(/^0+/, "").padStart(10, "0");
const a18 = (accn) => String(accn).replace(/-/g, "");
const dashed = (a) => `${a.slice(0, 10)}-${a.slice(10, 12)}-${a.slice(12)}`;

/** 서류 목록(정정 포함). recent + 과거 목록 파일 전부 */
export async function filings(sec, cik) {
  const sub = await sec.submissions(cik);
  const rows = [];
  const take = (r) => {
    for (let i = 0; i < r.accessionNumber.length; i++) {
      rows.push({
        id: r.accessionNumber[i], a18: a18(r.accessionNumber[i]), form: r.form[i], filed_at: r.filingDate[i],
        period_end: r.reportDate?.[i] || null, primary: r.primaryDocument?.[i] ?? null,
        is_xbrl: r.isXBRL ? !!r.isXBRL[i] : null, amends: /\/A$/.test(r.form[i]) ? "(원 서류 — 같은 기간 원 form)" : null,
      });
    }
  };
  take(sub.json.filings.recent);
  for (const f of sub.json.filings.files ?? []) take((await sec.submissionsPage(f.name)).json);
  return { list: rows, name: sub.json.name, sic: sub.json.sic, fiscalYearEnd: sub.json.fiscalYearEnd, fetch: { version: sub.version, sha256: sub.sha256 } };
}

/**
 * companyfacts → RawFact[] (차원 없는 사실 — companyfacts 는 차원 사실을 싣지 않는다)
 * @param {object} cf companyfacts JSON
 * @param {Map<string, object>} filingByAccn
 */
export function companyfactsFacts(cf, { cik, sym, filingByAccn, fetch }) {
  const out = [];
  const groups = new Map(); // 개념·단위·기간 → [fact]
  for (const [ns, concepts] of Object.entries(cf.facts ?? {})) {
    for (const [name, c] of Object.entries(concepts)) {
      for (const [unit, list] of Object.entries(c.units ?? {})) {
        for (const e of list) {
          const f = filingByAccn.get(e.accn) ?? null;
          const isDur = e.start != null;
          const rf = rawFact({
            market: "us",
            entity: { sym, cik: pad10(cik) },
            filing: { id: e.accn, form: e.form, filed_at: e.filed, period_end: f?.period_end ?? null, amends: /\/A$/.test(e.form ?? "") ? "amendment" : null },
            concept: { id: `${ns}:${name}`, label: c.label ?? null, standard: true },
            placement: null,
            period: {
              kind: isDur ? "duration" : "instant", start: e.start ?? null, end: e.end, months: isDur ? monthsBetween(e.start, e.end) : null,
              fy_key: fyKey("us", e.end), fp: e.fp ?? null, column: e.frame ?? null, filer_fy: e.fy ?? null,
            },
            scope: { consolidation: "consolidated", attribution: attributionOf(name), ops: opsOf(name), dims: [] },
            value: { raw: String(e.val), num: normNum(String(e.val)), unit, decimals: null, sign: null, nil: false },
            locator: { source: "companyfacts", concept: `${ns}:${name}`, unit, accn: e.accn, frame: e.frame ?? null },
            fetch,
          });
          out.push(rf);
          const k = `${ns}:${name}|${unit}|${e.start ?? ""}|${e.end}`;
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(rf);
        }
      }
    }
  }
  markPresentationCurrency(out);
  // 판본 표시
  for (const g of groups.values()) {
    g.sort((a, b) => (a.filing.filed_at ?? "").localeCompare(b.filing.filed_at ?? "") || a.filing.id.localeCompare(b.filing.id));
    const first = g[0], last = g[g.length - 1];
    for (const r of g) {
      const restated = r === first ? "same" : r.value.num === first.value.num ? "same" : "different";
      const rounded = r !== first && restated === "different" ? roundedRetagUnit(first.value.num, r.value.num) : null;
      r.vintage = {
        is_original: r === first, is_latest: r === last, restated,
        first_value: first.value.num, versions: g.length,
        ...(rounded ? { rounded_retag_of_first: rounded } : {}),
      };
    }
  }
  return out;
}

function attributionOf(name) {
  if (/AttributableToNoncontrollingInterest|MinorityInterest/.test(name)) return "nci";
  if (/^NetIncomeLoss$|AttributableToParent|StockholdersEquity$|AvailableToCommonStockholders/.test(name)) return "parent";
  if (/^ProfitLoss$|IncludingPortionAttributableToNoncontrollingInterest/.test(name)) return "total";
  return "none";
}
function opsOf(name) {
  if (/DiscontinuedOperation/.test(name)) return "discontinued";
  if (/ContinuingOperations/.test(name)) return "continuing";
  return "none";
}

// ── 공시 한 건의 본표 구조 ────────────────────────────────────────
const EXCLUDE_ROLE = /Parenth|Detail|Table|Polic|Narrative|Schedule|Disclosure|Note[s]?\b|Supplement/i;
/** 역할의 줄 이름(QName 로컬)으로 본표 종류 판정 */
function stmtKind(roleUri, names) {
  if (EXCLUDE_ROLE.test(roleUri.split("/").pop() ?? "")) return null;
  const has = (re) => names.some((n) => re.test(n));
  // us-gaap 과 ifrs-full(20-F) 이름 모두
  if (has(/^(NetCashProvidedByUsedIn|CashFlowsFromUsedIn)(Operating|Investing|Financing)Activities/)) return "cf";
  if (has(/^(Assets|LiabilitiesAndStockholdersEquity|EquityAndLiabilities)$/) && has(/^(Liabilities|LiabilitiesAndStockholdersEquity|StockholdersEquity|EquityAndLiabilities|Equity)$/)) return "bs";
  if (has(/^(StockholdersEquity|StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest)$/) && has(/^(StockIssuedDuringPeriod|DividendsCommonStock|TreasuryStock|StockRepurchased)/) && !has(/^Assets$/)) return "eq";
  // 당기순이익 줄 — 지배주주 귀속만 둔 IFRS 손익계산서(SPOT 「ProfitLossAttributableToOwnersOfParent」 — 감사 10-16 2차 ③-5)도
  if (has(/^(NetIncomeLoss|ProfitLoss|ProfitLossAttributableToOwnersOfParent|NetIncomeLossAvailableToCommonStockholdersBasic)$/) && has(/^(Revenues?|RevenueFromContractWithCustomer|SalesRevenueNet|CostOfRevenue|CostOfSales|OperatingIncomeLoss|ProfitLossFromOperatingActivities|IncomeLossFromContinuingOperationsBeforeIncomeTaxes|ProfitLossBeforeTax|InterestExpense|EarningsPerShare|BasicEarningsLossPerShare)/)) {
    return has(/^(ComprehensiveIncome|OtherComprehensiveIncome)/) && !has(/^(EarningsPerShare|BasicEarningsLossPerShare)/) ? "ci" : "is";
  }
  if (has(/^ComprehensiveIncomeNetOfTax/)) return "ci";
  return null;
}

/** 현금흐름 구역 — 계산 구조 조상 또는 표시 구조 조상 이름으로 */
function cfSection(chain) {
  for (const id of chain) {
    const n = idToQName(id).split(":").pop();
    if (/OperatingActivities/.test(n)) return "operating";
    if (/InvestingActivities/.test(n)) return "investing";
    if (/FinancingActivities/.test(n)) return "financing";
  }
  return null;
}
function bsSection(chain) {
  for (const id of chain) {
    const n = idToQName(id).split(":").pop();
    if (/^(AssetsCurrent|CurrentAssets)(Abstract)?$/.test(n)) return "current_assets";
    if (/^(LiabilitiesCurrent|CurrentLiabilities)(Abstract)?$/.test(n)) return "current_liabilities";
    if (/^(AssetsNoncurrent|NoncurrentAssets)(Abstract)?$/.test(n)) return "noncurrent_assets";
    if (/^(LiabilitiesNoncurrent|NoncurrentLiabilities)(Abstract)?$/.test(n)) return "noncurrent_liabilities";
    if (/StockholdersEquity|Equity/.test(n)) return "equity";
    if (/^Liabilities(Abstract)?$/.test(n)) return "liabilities";
    if (/^Assets(Abstract)?$/.test(n)) return "assets";
  }
  return null;
}

/**
 * 서류 한 건의 파일 목록·본표 구조.
 * → { files, instanceFile, roles: [{ role, stmt, lines: [{id, qname, parent, depth, order, preferredLabel, negated, calParent, calWeight, section}] }], labels }
 */
export async function filingStructure(sec, cik, accn) {
  const A = a18(accn);
  const idx = JSON.parse((await sec.archive(cik, A, "index.json")).buf.toString("utf8"));
  const names = (idx.directory?.item ?? []).map((x) => x.name);
  const pick = (re) => names.find((n) => re.test(n)) ?? null;
  const pre = pick(/_pre\.xml$/i), cal = pick(/_cal\.xml$/i), lab = pick(/_lab\.xml$/i);
  const instanceFile = pick(/_htm\.xml$/i) ?? names.find((n) => /\.xml$/i.test(n) && !/_(pre|cal|lab|def)\.xml$|FilingSummary|^R\d+\.xml$|MetaLinks/i.test(n)) ?? null;
  const out = { accn: dashed(A), files: { pre, cal, lab, instance: instanceFile, xsd: pick(/\.xsd$/i) }, roles: [], labels: new Map(), missing: [] };
  const read = async (f) => (f ? (await sec.archive(cik, A, f)).buf.toString("utf8") : null);
  let preX = await read(pre), calX = await read(cal);
  const labX = await read(lab);
  // 링크베이스가 .xsd 에 내장된 서류(MSFT·ORCL·IBM 2026~) — 따로 파일이 없으면 xsd 에서 읽는다
  if ((!preX || !calX) && out.files.xsd) {
    const xsd = await read(out.files.xsd);
    preX ??= /presentationLink/.test(xsd) ? xsd : null;
    calX ??= /calculationLink/.test(xsd) ? xsd : null;
  }
  if (!preX) out.missing.push("presentation");
  if (!calX) out.missing.push("calculation");
  if (labX) out.labels = parseLabels(labX);
  else out.missing.push("label");
  const cals = calX ? parseLinkbase(calX, "calculation") : [];
  const calByRole = new Map(cals.map((r) => [r.role, calculationMap(r)]));
  const calParentOf = (role, id) => {
    const m = calByRole.get(role);
    if (!m) return null;
    for (const [p, kids] of m) { const k = kids.find((x) => x.to === id); if (k) return { parent: p, weight: k.weight }; }
    return null;
  };
  for (const r of preX ? parseLinkbase(preX, "presentation") : []) {
    const tree = presentationTree(r);
    const names = tree.map((t) => idToQName(t.id).split(":").pop());
    const stmt = stmtKind(r.role, names);
    if (!stmt) continue;
    const STD = "http://www.xbrl.org/2003/role/label";
    const labelOf = (id, pl) => {
      const ls = out.labels.get(id) ?? [];
      return ls.find((l) => l.role === (pl ?? STD))?.text ?? ls.find((l) => l.role === STD)?.text ?? ls[0]?.text ?? null;
    };
    const lines = tree.map((t) => {
      const cp = calParentOf(r.role, t.id);
      const calChain = [];
      for (let p = cp?.parent, guard = 0; p && guard < 30; guard++) { calChain.push(p); p = calParentOf(r.role, p)?.parent; }
      const chain = [...calChain, ...[...t.path].reverse()];
      return {
        id: t.id, qname: idToQName(t.id), parent: t.parent, depth: t.depth, order: t.order, preferredLabel: t.preferredLabel,
        negated: /negated/i.test(t.preferredLabel ?? ""), calParent: cp?.parent ?? null, calWeight: cp?.weight ?? null,
        section: stmt === "cf" ? cfSection(chain) : stmt === "bs" ? bsSection(chain) : null,
        abstract: /Abstract$/.test(t.id),
        label: labelOf(t.id, t.preferredLabel),
        parentLabel: t.parent ? labelOf(t.parent, null) : null,
      };
    });
    out.roles.push({ role: r.role, stmt, lines });
  }
  return out;
}

/**
 * 인스턴스 사실 → RawFact[] (차원·decimals·회사 고유 태그 포함). 본표 구조가 있으면 placement 를 붙인다(차원 없는 사실만 본표 값 후보).
 */
export async function instanceFacts(sec, cik, accn, { sym, filing, structure }) {
  const A = a18(accn);
  const st = structure ?? (await filingStructure(sec, cik, accn));
  if (!st.files.instance) return { facts: [], structure: st, missing: ["instance"] };
  const got = await sec.archive(cik, A, st.files.instance, filing ? { form: filing.form, periodEnd: filing.period_end } : null);
  const { facts } = parseFacts(got.buf.toString("utf8"));
  // 본표 줄: QName → [{stmt, role, line}]
  const face = new Map();
  for (const r of st.roles) for (const l of r.lines) {
    if (l.abstract) continue;
    if (!face.has(l.qname)) face.set(l.qname, []);
    face.get(l.qname).push({ stmt: r.stmt, role: r.role, line: l });
  }
  const out = [];
  for (const f of facts) {
    if (!f.ctx) continue;
    const c = f.ctx;
    const isDur = !!c.start;
    const end = isDur ? c.end : c.instant;
    const dims = c.dims.map((d) => ({ axis: d.axis, member: d.member, typed: d.typed }));
    const pl = !dims.length ? face.get(f.concept) ?? [] : [];
    const placement = pl.length
      ? { face: true, stmts: pl.map((p) => ({ stmt: p.stmt, role: p.role.split("/").pop(), section: p.line.section, parent: p.line.calParent ?? p.line.parent, calWeight: p.line.calWeight, order: p.line.order, depth: p.line.depth, negated: p.line.negated, label: p.line.label, parentLabel: p.line.parentLabel })) }
      : { face: false };
    const ns = f.concept.split(":")[0];
    out.push(rawFact({
      market: "us",
      entity: { sym, cik: pad10(cik) },
      filing: { id: dashed(A), form: filing?.form ?? null, filed_at: filing?.filed_at ?? null, period_end: filing?.period_end ?? null, amends: null },
      concept: { id: f.concept, label: (st.labels.get(f.concept.replace(":", "_")) ?? [])[0]?.text ?? null, standard: /^(us-gaap|ifrs-full|dei|srt|country|currency|exch|stpr|naics|sic)$/.test(ns) },
      placement,
      period: { kind: isDur ? "duration" : "instant", start: c.start, end, months: isDur ? monthsBetween(c.start, end) : null, fy_key: fyKey("us", end), fp: null, column: f.contextRef },
      scope: { consolidation: "consolidated", attribution: attributionOf(f.concept.split(":")[1]), ops: opsOf(f.concept.split(":")[1]), dims },
      value: { raw: f.raw, num: f.nil ? null : normNum(f.raw), unit: f.unit, decimals: f.decimals, sign: null, nil: f.nil },
      locator: { source: "instance", file: st.files.instance, contextRef: f.contextRef, element: f.concept, id: f.id },
      fetch: { sha256: got.sha256, fromStore: got.fromStore },
    }));
  }
  markPrecisionDuplicates(out);
  markPresentationCurrency(out);
  return { facts: out, structure: st };
}
