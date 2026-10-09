/**
 * 일본 검증 층(1차 — A층 연간·B층 결산기, docs/verify-jp-design.md §4~§6). 검증기 독립 구현: 앱 src/lib/markets/jp/* 를 가져오지 않고,
 * EDINET 원본 XBRL(有価証券報告書·訂正)을 직접 읽어 앱 API 가 낸 값과 정확 대조한다.
 *
 * 열 출처 서류(검증기 규칙 J-A1): 사업연도 P·본표 종류 k 의 원자료 = 같은 회계기준 서류 중 **가장 나중에 제출된** 有報·訂正有報로,
 *   그 서류의 본표 역할 k 개념이 EDINET 표준 문맥(CurrentYear·Prior1Year — Duration/Instant)으로 P 값을 싣고 있는 것. 한 열 안에서 서류를 섞지 않는다.
 *   문맥 이름으로 판정하므로 현금흐름표 기초 잔액(전전기 말 현금)이 재무상태표 열로 잡히지 않는다.
 * 회계기준: 가장 나중 서류의 AccountingStandardsDEI 와 같은 서류만(기준이 바뀐 옛 해는 그 기준 서류가 P 를 실을 때만 열이 있다 — 없으면 기대 빈칸).
 *
 * 검사(층 A, 연간)
 *  A1 본표 줄 = EDINET 원본   앱 줄(accountId 의 개념)마다 그 열 출처 서류의 차원 없는 값(negatedLabel 이면 부호 반전, 기초·기말 잔액 줄은 시점 값)과 정확 대조.
 *                             앱만 값 → 실패, 원자료만 값 → 실패, 원자료 "－"(nil)·앱 빈칸 → 통과(기대 빈칸).
 *  A2 본표 줄 누락 없음       그 서류 본표 역할의 개념 중 그 열에 값(nil 아님)이 있는 것이 앱 화면에 줄로 있어야 한다.
 *  A3 주요 항목               매출·영업이익·경상이익(J-GAAP)·세전이익·순이익(지배)·자산·부채·자본·지배주주 자본·현금·영업/투자/재무 CF —
 *                             표준 요소(매출은 표준 요소가 없으면 계산 구조 규칙 J-A3)로 원자료를 정하고 앱 본표 줄·하이라이트 행과 대조.
 *  A4 EPS(하이라이트)          경영지표 희석 EPS("－"면 기본) — 그 사업연도를 경영지표에 실은 가장 나중 有報 값 ÷ 그 서류 제출일 뒤 분할 계수
 *                             (Yahoo 분할 이력 — 검증기 직접 조회). 앱은 손익 열 서류 값을 쓰므로 서로 다른 경로의 같은 값이어야 한다.
 *  A5 열 출처 서류            앱 출처 문구의 열별 서류 번호 = 검증기 판정(어긋나면 실패 — 같은 값이어도 다른 판본을 쓰는 것).
 * 층 B: 결산기 — 검증기 판정 최근 5개 사업연도(원자료) ↔ 앱 연도 열(결산일 정확 일치).
 */
import { dayList, docFiles, resolveTicker, redact, addDays } from "./edinet.mjs";
import { parseDoc, plainValue, ncValue } from "./xbrl.mjs";

const N_FY = 5;
const STD_CTX = /^(CurrentYear|Prior1Year)(Duration|Instant)$/;
// 반기(半期報告書 Interim…·옛 四半期報告書 第2四半期 CurrentYTD·CurrentQuarter…) 표준 문맥 — 당기·전년 같은 반기
const HALF_CTX = /^((Interim|Prior1Interim|CurrentYTD|Prior1YTD)Duration|(Interim|Prior1Interim|CurrentQuarter|Prior1Quarter)Instant)$/;

let scanFrom = "2021-04-01";
export function configureJpLayers(o) {
  if (o.from) scanFrom = o.from;
}

// ── 서류 목록(검증기 자체 색인 — EDINET 날짜 목록 디스크 캐시) ──
let allDocs = null;
async function docIndex() {
  if (allDocs) return allDocs;
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const out = [];
  const failed = [];
  for (let d = today; d >= scanFrom; d = addDays(d, -1)) {
    try { out.push(...(await dayList(d))); } catch (e) { failed.push(`${d} ${redact(e.message).slice(0, 80)}`); }
  }
  allDocs = { docs: out, failed };
  return allDocs;
}

const parsed = new Map();
async function loadDoc(row) {
  if (!parsed.has(row.docID)) parsed.set(row.docID, docFiles(row.docID).then((f) => ({ row, ...parseDoc(f) })));
  return parsed.get(row.docID);
}

// ── Yahoo 분할 이력(검증기 직접 — 앱 시세 모듈 안 씀) ──
const splitMemo = new Map();
async function yahooSplits(sym) {
  if (splitMemo.has(sym)) return splitMemo.get(sym);
  const p = (async () => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}.T?period1=0&period2=${Math.floor(Date.now() / 1000)}&interval=1mo&events=split`;
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`Yahoo 분할 이력 HTTP ${r.status}`);
    const j = await r.json();
    const ev = j?.chart?.result?.[0]?.events?.splits ?? {};
    if (!j?.chart?.result?.[0]) throw new Error("Yahoo 분할 이력 응답 형식 이상");
    return Object.values(ev).map((s) => ({ date: new Date(s.date * 1000 + 9 * 3600e3).toISOString().slice(0, 10), ratio: s.numerator / s.denominator }));
  })();
  splitMemo.set(sym, p);
  return p;
}

// ── 앱 화면 읽기 ──
const conceptOfId = (id) => {
  const m = /^(is|ci|bs|cf):(.+?)#(\d+)$/.exec(id ?? "");
  return m ? { kind: m[1], concept: m[2], occ: Number(m[3]) } : null;
};
function appLines(view) {
  const out = [];
  for (const s of view?.sections ?? []) for (const it of s.items ?? []) {
    const c = conceptOfId(it.accountId);
    if (c) out.push({ ...c, id: it.accountId, values: it.values ?? {}, notes: it.cellNotes ?? {}, sub: !!it.isSubtotal });
  }
  return out;
}
/** 앱 출처 문구 "손익 열 출처: FY2022 S100RAR0, …" → { "2022": docID } */
function appColSources(source, word) {
  const m = new RegExp(`${word} 열 출처: ([^·]+)`).exec(source ?? "");
  if (!m) return null;
  return Object.fromEntries([...m[1].matchAll(/FY(\d{4}) (S[0-9A-Z]{7}|없음)/g)].map((x) => [x[1], x[2]]));
}

// ── 원자료 판정 ──
/** 서류 d 가 본표 kind 로 기간 per 를 싣는가 — 그 역할 개념 중 EDINET 표준 문맥(CurrentYear·Prior1Year)으로 그 기간 값이 있는 것 */
const TOTAL_ASSETS = ["jpigp_cor:AssetsIFRS", "jppfs_cor:Assets"];
function carries(d, kind, per, re = STD_CTX) {
  const roles = [...d.roles.values()].filter((r) => r.kind === kind && r.cons === d.consUsed);
  // 재무상태표 = 그 시점 자산총계가 본표에 실렸을 때(문맥 이름 무관) — IFRS 소급 재작성 3열 재무상태표(소니 IFRS 17 전환일 Prior2YearInstant)는 잡고,
  // 현금흐름표 기초·전년 반기말 현금(Prior1InterimInstant 등 — 재무상태표 열 아님)은 잡지 않는다
  if (kind === "bs") {
    const ta = TOTAL_ASSETS.find((c) => roles.some((r) => r.concepts.has(c)));
    if (ta) return (d.facts.get(ta) ?? []).some((f) => { const x = d.ctx.get(f.ctx); return x && !x.dims.length && x.instant === per.end && f.v != null; });
  }
  for (const r of roles)
    for (const c of r.concepts) {
      for (const f of d.facts.get(c) ?? []) {
        if (!re.test(f.ctx)) continue;
        const x = d.ctx.get(f.ctx);
        if (!x || x.dims.length) continue;
        if (kind === "bs" ? x.instant === per.end : x.start === per.start && x.end === per.end) return true;
      }
    }
  return false;
}
const roleOf = (d, kind) => [...d.roles.values()].filter((r) => r.kind === kind && r.cons === d.consUsed);

/** 개념 값(그 서류 하나) — 기초·기말 잔액 줄 처리. pos: "s"|"e"|"" */
function valueIn(d, concept, kind, per, pos) {
  if (kind === "bs") return plainValue(d, concept, { instant: per.end });
  const dur = plainValue(d, concept, { start: per.start, end: per.end });
  if (dur !== undefined) return dur;
  if (pos === "s") return plainValue(d, concept, { instant: addDays(per.start, -1) });
  return plainValue(d, concept, { instant: per.end });
}

// 주요 항목 — 표준 요소(앞에서부터). 매출은 표준 요소가 없으면 계산 구조 규칙
const KEY = [
  ["매출", "is", ["jpigp_cor:RevenueIFRS", "jpigp_cor:NetSalesIFRS", "jpigp_cor:OperatingRevenueIFRS", "jpigp_cor:Revenue2IFRS", "jppfs_cor:NetSales", "jppfs_cor:OperatingRevenue1", "jppfs_cor:OperatingRevenue2", "jppfs_cor:OrdinaryIncomeBNK", "jppfs_cor:OperatingIncomeINS"], "revenue"],
  ["영업이익", "is", ["jpigp_cor:OperatingProfitLossIFRS", "jppfs_cor:OperatingIncome"], "opinc"],
  ["경상이익", "is", ["jppfs_cor:OrdinaryIncome"], null],
  ["세전이익", "is", ["jpigp_cor:ProfitLossBeforeTaxIFRS", "jppfs_cor:IncomeBeforeIncomeTaxes", "jppfs_cor:IncomeBeforeIncomeTaxesAndMinorityInterests"], null],
  ["순이익(지배)", "is", ["jpigp_cor:ProfitLossAttributableToOwnersOfParentIFRS", "jppfs_cor:ProfitLossAttributableToOwnersOfParent"], "ni"],
  ["자산총계", "bs", ["jpigp_cor:AssetsIFRS", "jppfs_cor:Assets"], null],
  ["부채총계", "bs", ["jpigp_cor:LiabilitiesIFRS", "jppfs_cor:Liabilities"], null],
  ["자본총계", "bs", ["jpigp_cor:EquityIFRS", "jppfs_cor:NetAssets"], null],
  ["지배주주 자본", "bs", ["jpigp_cor:EquityAttributableToOwnersOfParentIFRS"], null],
  ["현금(재무상태표)", "bs", ["jpigp_cor:CashAndCashEquivalentsIFRS", "jppfs_cor:CashAndDeposits", "jppfs_cor:CashAndDueFromBanksAssetsBNK", "jppfs_cor:CashAndDepositsAssetsINS"], null],
  ["영업활동 CF", "cf", ["jpigp_cor:NetCashProvidedByUsedInOperatingActivitiesIFRS", "jppfs_cor:NetCashProvidedByUsedInOperatingActivities"], "ocf"],
  ["투자활동 CF", "cf", ["jpigp_cor:NetCashProvidedByUsedInInvestingActivitiesIFRS", "jppfs_cor:NetCashProvidedByUsedInInvestmentActivities"], null],
  ["재무활동 CF", "cf", ["jpigp_cor:NetCashProvidedByUsedInFinancingActivitiesIFRS", "jppfs_cor:NetCashProvidedByUsedInFinancingActivities"], null],
];
const OPINC_ROOTS = ["jpigp_cor:OperatingProfitLossIFRS", "jppfs_cor:OperatingIncome"];

/**
 * 매출(검증기 규칙 J-A3) — 표준 매출 요소가 본표에 없을 때(도요타 営業収益合計 = 회사 고유 요소): 손익 본표 계산 구조에서 영업이익의 자식 중
 * 가중치 +1 이고 그 기간 값이 가장 큰 것을 따라 내려가, 자식이 모두 +1(구성 요소의 합)이거나 자식이 없는 노드를 매출로 본다.
 */
function revenueByCalc(d, per) {
  const role = roleOf(d, "is")[0];
  if (!role) return null;
  const arcs = d.calc.get(role.role) ?? [];
  const kids = (p) => arcs.filter((a) => a[0] === p);
  const val = (c) => plainValue(d, c, { start: per.start, end: per.end })?.v ?? null;
  let node = OPINC_ROOTS.find((r) => kids(r).length);
  for (let guard = 0; node && guard < 6; guard++) {
    const ks = kids(node);
    if (!ks.length || ks.every((a) => a[2] === 1)) return node === OPINC_ROOTS.find((r) => r === node) ? null : node;
    // 절댓값 기준(키옥시아 FY2024 — 売上総利益이 음수라 값 기준이면 その他の収益으로 샜다)
    const pos = ks.filter((a) => a[2] === 1 && val(a[1]) != null).sort((a, b) => Math.abs(val(b[1])) - Math.abs(val(a[1])));
    if (!pos.length) return null;
    node = pos[0][1];
  }
  return null;
}

/**
 * 종목 하나 — 층 A(연간)·B. add(layer, name, col, { status, note, app, src })
 */
/** 회사 서류(같은 회계기준) — rowOk(목록 행)로 고른 뒤 판독. { code, docs(전부, 최신순), same(최신 서류와 같은 기준), std } 또는 null */
const docsMemo = new Map();
function companyDocs(sym, hardErrors, rowOk, what) {
  const k = `${sym}|${what}`;
  if (!docsMemo.has(k)) docsMemo.set(k, companyDocs0(sym, hardErrors, rowOk, what));
  return docsMemo.get(k);
}
async function companyDocs0(sym, hardErrors, rowOk, what) {
  const code = await resolveTicker(sym);
  if (!code) { hardErrors.push(`EDINET 코드 목록에 証券コード ${sym}0 없음`); return null; }
  const ix = await docIndex();
  if (ix.failed.length && !ix.reported) { ix.reported = true; hardErrors.push(`EDINET 날짜 목록 조회 실패 ${ix.failed.length}일 — 예: ${ix.failed[0]}`); }
  const rows = ix.docs
    .filter((r) => r.edinetCode === code.edinetCode && rowOk(r, code) && (r.withdrawalStatus ?? "0") === "0" && r.xbrlFlag === "1")
    .sort((a, b) => b.submitDateTime.localeCompare(a.submitDateTime));
  if (!rows.length) { hardErrors.push(`EDINET ${what} 없음(${code.edinetCode}, ${scanFrom} 이후)`); return null; }
  const docs = [];
  for (const r of rows) {
    try {
      const d = await loadDoc(r);
      if (!d.roles.size) continue; // 訂正 중 재무제표를 다시 싣지 않은 것
      d.consUsed = [...d.roles.values()].some((x) => x.cons);
      docs.push(d);
    } catch (e) {
      hardErrors.push(`${r.docID} XBRL 판독 실패 — ${redact(e.message).slice(0, 100)}`);
    }
  }
  if (!docs.length) { hardErrors.push(`판독된 ${what} 없음`); return null; }
  const std = docs[0].dei.AccountingStandardsDEI ?? null;
  return { code, docs, std, same: docs.filter((d) => (d.dei.AccountingStandardsDEI ?? null) === std) };
}

/**
 * A1 — 앱 줄(본표 kind)마다 기대값과 정확 대조. expOf(l) → undefined(원자료에 그 기간 값 없음) | { v: null }(nil) | { v } | { conflict } | { blank: 사유 }
 */
function checkLines(t, layer, label, mine, expOf, tag) {
  const { add, PASS, FAIL, NA } = t;
  const NAME = "본표 줄 = EDINET 원본";
  for (const l of mine) {
    if (l.concept.endsWith("Abstract")) continue;
    const a = l.values[label] ?? null;
    const f = expOf(l);
    const col = `${label} ${l.id}`;
    const an = l.notes[label] ? ` · 앱 주석 ${l.notes[label]}` : "";
    if (f && f.conflict) { add(layer, NAME, col, { status: NA, note: `원자료 같은 문맥 값 둘(${f.conflict.join(" · ")})` }); continue; }
    if (f && f.blank) { if (a != null) add(layer, NAME, col, { status: FAIL, app: a, src: null, note: `${f.blank} — 앱은 빈칸이어야 하는데 값 ${a}` }); else add(layer, NAME, col, { status: PASS, note: `기대 빈칸 — ${f.blank}` }); continue; }
    if (f === undefined) {
      if (a != null) add(layer, NAME, col, { status: FAIL, app: a, src: null, note: `원자료(${tag}) 본표에 그 기간 값 없음인데 앱 값 ${a}${an}` });
      continue;
    }
    if (f.v == null) { add(layer, NAME, col, a == null ? { status: PASS, note: "원자료 －(nil) · 앱 빈칸" } : { status: FAIL, app: a, src: null, note: `원자료 －(nil)인데 앱 값 ${a}` }); continue; }
    if (a == null) add(layer, NAME, col, { status: FAIL, app: null, src: f.v, note: `원자료(${tag}) ${f.v} 있는데 앱 빈칸${an}` });
    else add(layer, NAME, col, a === f.v ? { status: PASS, app: a, src: f.v } : { status: FAIL, app: a, src: f.v, note: `앱 ${a} vs 원자료 ${f.v}(${tag}${f.how ? ` — ${f.how}` : ""})` });
  }
}
/** A2 — 원자료 본표 개념 중 그 열에 값이 있는 것이 앱 화면에 줄로 있는가 */
function checkMissing(t, layer, label, kind, d, roles, per, viewLines) {
  const { add, PASS, FAIL, NA } = t;
  const have = new Set(viewLines.map((l) => l.concept));
  let seen = 0, missing = 0;
  for (const c of new Set(roles.flatMap((r) => [...r.concepts]))) {
    if (c.endsWith("Abstract")) continue;
    const f = valueIn(d, c, kind, per, "");
    if (!f || f.conflict || f.v == null) continue;
    seen++;
    if (have.has(c)) continue;
    missing++;
    add(layer, "본표 줄 누락 없음", `${label} ${kind}:${c}`, { status: FAIL, src: f.v, note: `원자료(${d.row.docID}) 본표 줄 ${c} = ${f.v} 인데 앱 화면에 줄 없음` });
  }
  if (!missing) add(layer, "본표 줄 누락 없음", `${label} ${kind}`, seen ? { status: PASS, note: `원자료(${d.row.docID}) 값 있는 줄 ${seen}개 모두 앱에 있음` } : { status: NA, note: "원자료 본표에 값 있는 줄 없음" });
}
const negPls = (roles) => {
  const neg = new Set(roles.flatMap((r) => [...r.neg]));
  const pls = new Map();
  for (const r of roles) for (const [c, s] of r.pls) pls.set(c, (pls.get(c) ?? "") + s);
  return { neg, pls };
};
/** 서류 d 의 줄 l 기대값(부호·기초/기말 반영) — 역할에 개념이 없으면 undefined */
function expIn(d, roles, kind, per, l, np) {
  if (!roles.some((r) => r.concepts.has(l.concept))) return undefined;
  const pos = (np.pls.get(l.concept) ?? "")[l.occ] ?? "";
  const f = valueIn(d, l.concept, kind, per, pos);
  if (!f || f.conflict || f.v == null) return f;
  return np.neg.has(l.concept) ? { ...f, v: -f.v, how: "negatedLabel 반전" } : f;
}
const isPerShareUnit = (d, c) => (d.facts.get(c) ?? []).some((f) => /PerShare/i.test(f.unit));

export async function jpAnnualLayers(sym, app, { add, PASS, FAIL, NA, hardErrors }) {
  const t = { add, PASS, FAIL, NA };
  const src = await companyDocs(sym, hardErrors, (r) => r.docTypeCode === "120" || r.docTypeCode === "130", "有報");
  if (!src) return;
  const { docs, std, same } = src;

  // ── 층 B: 사업연도 — 같은 기준 有報의 당기·전기(표준 문맥) 중 손익 본표가 실린 것, 최근 5개
  const fy = new Map();
  for (const d of same) for (const c of d.ctx.values()) {
    if (c.dims.length || !c.start) continue;
    const per = { start: c.start, end: c.end };
    const days = (Date.parse(c.end) - Date.parse(c.start)) / 864e5;
    if (days < 300 || days > 400 || fy.has(c.end)) continue;
    if (carries(d, "is", per)) fy.set(c.end, per);
  }
  const fys = [...fy.values()].sort((a, b) => a.end.localeCompare(b.end)).slice(-N_FY);
  const isView = app.is, bsView = app.bs, cfView = app.cf;
  const appFy = (isView?.periods ?? []).filter((p) => /^FY\d{4}$/.test(p.label));
  const appEnds = new Set(appFy.map((p) => p.endDate));
  for (const p of fys) add("B", "사업연도 열 = EDINET 결산일", p.end, appEnds.has(p.end) ? { status: PASS } : { status: FAIL, note: `원자료 사업연도(${p.start}~${p.end}) 열이 앱에 없음` });
  for (const p of appFy) if (!fys.some((f) => f.end === p.endDate)) add("B", "앱 연도 열 ∈ 원자료 최근 5개 사업연도", p.label, { status: FAIL, note: `앱 열 ${p.label}(${p.endDate}) — 원자료 최근 5개(${fys.map((f) => f.end).join(", ")})에 없음` });
  add("B", "회계기준", "-", { status: PASS, note: `${std} · ${docs[0].consUsed ? "連結" : "個別"} — 최신 ${docs[0].row.docID}${docs.length > same.length ? ` · 기준이 다른 옛 서류 ${docs.length - same.length}건 제외` : ""}` });

  const lines = { is: appLines(isView), bs: appLines(bsView), cf: appLines(cfView) };
  const viewOf = (k) => (k === "ci" ? "is" : k);
  const hl = app.hl?.highlights;
  const hlRow = (key) => hl?.rows?.find((r) => r.key === key) ?? hl?.valuationRows?.find((r) => r.key === key) ?? null;
  const hlCol = (end) => (hl?.columns ?? []).findIndex((c) => c.kind === "fy" && c.date === end);

  const splits = await yahooSplits(sym).catch((e) => { hardErrors.push(`Yahoo 분할 이력 실패 — ${String(e.message).slice(0, 80)}`); return null; });

  for (const per of fys) {
    const label = appFy.find((p) => p.endDate === per.end)?.label;
    if (!label) continue;
    const colOf = {};
    for (const kind of ["is", "ci", "bs", "cf"]) {
      const d = same.find((x) => carries(x, kind, per)) ?? null;
      colOf[kind] = d;
      if (!d) { add("A", `${kind} 열 출처`, label, { status: NA, note: "원자료 서류에 그 기간 본표 없음" }); continue; }
      const roles = roleOf(d, kind);
      const np = negPls(roles);
      checkLines(t, "A", label, lines[viewOf(kind)].filter((l) => l.kind === kind), (l) => expIn(d, roles, kind, per, l, np), d.row.docID);
      checkMissing(t, "A", label, kind, d, roles, per, lines[viewOf(kind)]);
    }
    // A5 — 열 출처 서류
    for (const [kind, word] of [["is", "손익"], ["bs", "재무상태"]]) {
      const appSrc = appColSources((kind === "is" ? isView : bsView)?.source, word);
      const mine = colOf[kind]?.row.docID ?? "없음";
      const theirs = appSrc?.[per.end.slice(0, 4)] ?? null;
      add("A", `${word} 열 출처 서류 = 검증기 판정`, label, theirs == null ? { status: NA, note: "앱 출처 문구에 열 서류 없음" } : theirs === mine ? { status: PASS, note: mine } : { status: FAIL, note: `앱 ${theirs} vs 검증기 ${mine}` });
    }
    // A3 — 주요 항목
    for (const [name, kind, ids, hlKey] of KEY) {
      const d = colOf[kind];
      if (!d) continue;
      const inRole = (c) => roleOf(d, kind).some((r) => r.concepts.has(c));
      // 매출은 계산 구조 규칙 먼저(소니 — 売上高(NetSalesIFRS)은 구성 요소, 매출 합계는 그 위 노드), 못 정하면 표준 요소
      let concept = name === "매출" ? revenueByCalc(d, per) : null;
      let how = concept ? "계산 구조 규칙 J-A3" : "표준 요소";
      concept ??= ids.find((c) => inRole(c) && valueIn(d, c, kind, per, "e")?.v != null) ?? null;
      if (!concept) {
        if (name === "경상이익" && std !== "Japan GAAP") continue;
        if (name === "지배주주 자본" && std === "Japan GAAP") continue;
        add("A", `주요 항목 ${name}`, label, { status: NA, note: `표준 요소 없음(${d.row.docID} — 회사 고유 요소 또는 금융 서식)` });
        continue;
      }
      const f = valueIn(d, concept, kind, per, "e");
      const src = f?.v ?? null;
      const ln = lines[viewOf(kind)].find((l) => l.kind === kind && l.concept === concept);
      const a = ln ? (ln.values[label] ?? null) : null;
      add("A", `주요 항목 ${name} — 본표`, label, src == null ? { status: NA, note: "원자료 값 없음" } : a === src ? { status: PASS, app: a, src, note: `${concept}(${how})` } : { status: FAIL, app: a, src, note: `앱 ${a ?? "줄·값 없음"} vs 원자료 ${src} — ${concept}(${how}, ${d.row.docID})` });
      if (hlKey && hl) {
        const ci = hlCol(per.end);
        const hv = ci >= 0 ? (hlRow(hlKey)?.values?.[ci] ?? null) : null;
        const fin = [...d.facts.keys()].some((k) => /(BNK|INS)$/.test(k));
        if (ci < 0) add("A", `주요 항목 ${name} — 하이라이트`, label, { status: FAIL, note: "하이라이트에 그 사업연도 열 없음" });
        else if (!hlRow(hlKey) && fin) add("A", `주요 항목 ${name} — 하이라이트`, label, { status: PASS, note: "금융 서식 — 하이라이트에 그 행 없음(원자료 BNK·INS 요소 확인)" });
        else add("A", `주요 항목 ${name} — 하이라이트`, label, hv === src ? { status: PASS, app: hv, src } : { status: FAIL, app: hv, src, note: `하이라이트 ${hv} vs 원자료 ${src} — ${concept}(${how})` });
      }
    }
    // A4 — EPS(경영지표, 가장 나중 有報) ÷ 그 서류 제출일 뒤 분할
    if (hl) {
      const ci = hlCol(per.end);
      const hv = ci >= 0 ? (hlRow("eps")?.values?.[ci] ?? null) : null;
      const epsIn = (d) => {
        if (!d) return null;
        const pick = (tags) => {
          for (const t of tags) {
            const f = plainValue(d, `jpcrp_cor:${t}`, { start: per.start, end: per.end }) ?? (d.consUsed ? undefined : ncValue(d, `jpcrp_cor:${t}`, { start: per.start, end: per.end }));
            if (f !== undefined && !f.conflict && f.v != null) return { v: f.v, t };
          }
          return null;
        };
        const dil = pick(["DilutedEarningsLossPerShareIFRSSummaryOfBusinessResults", "DilutedEarningsPerShareSummaryOfBusinessResults"]);
        const bas = dil ? null : pick(["BasicEarningsLossPerShareIFRSSummaryOfBusinessResults", "BasicEarningsLossPerShareSummaryOfBusinessResults"]);
        const hit = dil ?? bas;
        if (!hit) return null;
        const at = d.row.submitDateTime.slice(0, 10);
        const after = (splits ?? []).filter((x) => x.date > at);
        const factor = after.reduce((x, y) => x * y.ratio, 1);
        return { ...hit, kind: dil ? "희석" : "기본", d, at, after, factor, exp: hit.v / factor };
      };
      let got = null;
      for (const d of same) if ((got = epsIn(d))) break;
      const eq = (x, y) => x != null && y != null && Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(y));
      const desc = (g) => `${g.kind} ${g.v}(${g.d.row.docID} ${g.at})${g.after.length ? ` ÷ 분할 ${g.after.map((x) => `${x.date} ${x.ratio}`).join("·")}` : ""}`;
      const NAME = "EPS(하이라이트) = 경영지표";
      if (!got) add("A", NAME, label, { status: NA, note: "경영지표 EPS 없음" });
      else if (!splits) add("A", NAME, label, { status: NA, note: "분할 이력 조회 실패" });
      else if (eq(hv, got.exp)) add("A", NAME, label, { status: PASS, app: hv, src: got.exp, note: desc(got) });
      else {
        // 분할 뒤 회사가 경영지표를 소급 재작성하면 소수 2자리 반올림 값(소니 FY2022 705.16 ÷ 5 = 141.032 → 재작성 141.03). 손익 열 서류 값 ÷ 그 뒤 분할이
        // 앱과 정확히 같고, 그 값을 2자리 반올림하면 재작성 값과 같을 때만 통과(두 공시가 식으로 이어짐)
        const alt = epsIn(colOf.is);
        const r2 = (x) => Math.sign(x) * Math.round(Math.abs(x) * 100 + 1e-9) / 100;
        if (alt && alt.d !== got.d && eq(hv, alt.exp) && got.factor === 1 && r2(alt.exp) === got.v)
          add("A", NAME, label, { status: PASS, app: hv, src: alt.exp, note: `${desc(alt)} — 재작성 경영지표 ${got.v}(${got.d.row.docID}) = 2자리 반올림` });
        else add("A", NAME, label, { status: FAIL, app: hv, src: got.exp, note: `하이라이트 ${hv} vs 경영지표 ${desc(got)}${alt && alt.d !== got.d ? ` · 손익 열 서류 경로 ${desc(alt)} = ${alt.exp}` : ""}` });
      }
    }
  }
}

// ── 반기(A-H) ─────────────────────────────────────────────────────────
/** 결산일 문구("3月31日"·"3月末日") → 상반기 말 월 */
const h1EndMonth = (fyEnd) => {
  const m = Number(/(\d{1,2})月/.exec(fyEnd ?? "")?.[1]);
  return Number.isFinite(m) && m >= 1 ? ((m + 6 - 1) % 12) + 1 : null;
};
const ANNUAL_OK = (r) => r.docTypeCode === "120" || r.docTypeCode === "130";

/**
 * A 반기 — 앱 분기 탭(반기 열). H1 = 半期報告書(2024-04 이후)·옛 四半期報告書 第2四半期(DEI TypeOfCurrentPeriodDEI = HY·Q2)의 상반기 누적,
 * 열 출처 = 같은 기준 반기 서류 중 가장 나중 제출본으로 반기 표준 문맥(Interim·Prior1Interim·CurrentYTD·Prior1YTD·CurrentQuarter·Prior1Quarter)에
 * 그 기간을 싣는 것. H2 = 사업연도(有報 열 출처) − 상반기(반기 열 출처), 재무상태표·기말 잔액 = 사업연도 말, 기초 잔액 = 상반기 말,
 * 주당 지표는 차감하지 않음(빈칸 기대). 층 B 반기: 원자료 최근 6개 반기 열(상반기 + 그 사업연도 有報가 있는 하반기) ↔ 앱 열.
 */
export async function jpHalfLayers(sym, app, { add, PASS, FAIL, NA, hardErrors }) {
  const t = { add, PASS, FAIL, NA };
  const ann = await companyDocs(sym, hardErrors, ANNUAL_OK, "有報");
  if (!ann) return;
  const h1m = h1EndMonth(ann.code.fyEnd);
  const half = await companyDocs(sym, hardErrors, (r) => r.docTypeCode === "160" || r.docTypeCode === "170" || ((r.docTypeCode === "140" || r.docTypeCode === "150") && Number(r.periodEnd?.slice(5, 7)) === h1m), "반기 서류");
  if (!half) return;
  const halfDocs = half.docs.filter((d) => /^(HY|Q2)$/.test(d.dei.TypeOfCurrentPeriodDEI ?? ""));
  const newest = [ann.docs[0], halfDocs[0]].filter(Boolean).sort((a, b) => b.row.submitDateTime.localeCompare(a.row.submitDateTime))[0];
  const std = newest.dei.AccountingStandardsDEI ?? null;
  const hs = halfDocs.filter((d) => (d.dei.AccountingStandardsDEI ?? null) === std);
  const as = ann.docs.filter((d) => (d.dei.AccountingStandardsDEI ?? null) === std);
  // 상반기 기간 후보
  const h1 = new Map();
  for (const d of hs) for (const [id, c] of d.ctx) {
    if (c.dims.length || !c.start || !HALF_CTX.test(id)) continue;
    const per = { start: c.start, end: c.end };
    if (!h1.has(c.end) && carries(d, "is", per, HALF_CTX)) h1.set(c.end, per);
  }
  const fyOf = (p) => ({ start: p.start, end: addDays(`${Number(p.start.slice(0, 4)) + 1}${p.start.slice(4)}`, -1) });
  const cols = [];
  for (const p of [...h1.values()].sort((a, b) => a.end.localeCompare(b.end))) {
    cols.push({ kind: "H1", per: p });
    const fy = fyOf(p);
    if (as.some((d) => carries(d, "is", fy) || carries(d, "bs", fy))) cols.push({ kind: "H2", per: { start: addDays(p.end, 1), end: fy.end }, fy, h1: p });
  }
  const shown = cols.slice(-6);
  const isq = app.isq, bsq = app.bsq, cfq = app.cfq;
  const appCols = (isq?.periods ?? []).map((p) => ({ label: p.label, end: p.endDate, kind: /H1$/.test(p.label) ? "H1" : /H2$/.test(p.label) ? "H2" : "?" }));
  for (const c of shown) add("B", "반기 열 = EDINET", `${c.kind} ${c.per.end}`, appCols.some((a) => a.kind === c.kind && a.end === c.per.end) ? { status: PASS } : { status: FAIL, note: `원자료 ${c.kind}(${c.per.start}~${c.per.end}) 열이 앱에 없음` });
  for (const a of appCols) if (!shown.some((c) => c.kind === a.kind && c.per.end === a.end)) add("B", "앱 반기 열 ∈ 원자료 최근 6개", a.label, { status: FAIL, note: `앱 열 ${a.label}(${a.end}) — 원자료 최근 6개(${shown.map((c) => `${c.kind} ${c.per.end}`).join(", ")})에 없음` });

  const lines = { is: appLines(isq), bs: appLines(bsq), cf: appLines(cfq) };
  const viewOf = (k) => (k === "ci" ? "is" : k);
  const appSrc = appHalfSources(isq?.source);
  for (const c of shown) {
    const label = appCols.find((a) => a.kind === c.kind && a.end === c.per.end)?.label;
    if (!label) continue;
    for (const kind of ["is", "ci", "bs", "cf"]) {
      const mine = lines[viewOf(kind)].filter((l) => l.kind === kind);
      if (c.kind === "H1") {
        const d = hs.find((x) => carries(x, kind, c.per, HALF_CTX)) ?? null;
        if (!d) { add("A", "반기 열 출처", `${label} ${kind}`, { status: NA, note: "원자료 반기 서류에 그 기간 본표 없음" }); continue; }
        const roles = roleOf(d, kind);
        const np = negPls(roles);
        checkLines(t, "A반기", label, mine, (l) => expIn(d, roles, kind, c.per, l, np), d.row.docID);
        checkMissing(t, "A반기", label, kind, d, roles, c.per, lines[viewOf(kind)]);
        if (kind === "is") {
          const theirs = appSrc?.[label] ?? null;
          add("A반기", "상반기 열 출처 서류 = 검증기 판정", label, theirs == null ? { status: NA, note: "앱 출처 문구에 열 서류 없음" } : theirs === d.row.docID ? { status: PASS, note: theirs } : { status: FAIL, note: `앱 ${theirs} vs 검증기 ${d.row.docID}` });
        }
        continue;
      }
      // H2 = 사업연도 − 상반기
      const fd = as.find((x) => carries(x, kind, c.fy)) ?? null;
      const hd = hs.find((x) => carries(x, kind, c.h1, HALF_CTX)) ?? null;
      const fRoles = fd ? roleOf(fd, kind) : [];
      const hRoles = hd ? roleOf(hd, kind) : [];
      const fnp = negPls(fRoles), hnp = negPls(hRoles);
      const tag = `${fd?.row.docID ?? "有報 없음"} − ${hd?.row.docID ?? "반기 없음"}`;
      checkLines(t, "A반기", label, mine, (l) => {
        if (kind === "bs") return fd ? expIn(fd, fRoles, "bs", c.fy, l, fnp) : undefined;
        const pos = (hnp.pls.get(l.concept) ?? fnp.pls.get(l.concept) ?? "")[l.occ] ?? "";
        if (pos === "e") return fd ? expIn(fd, fRoles, kind, c.fy, l, fnp) : undefined;
        if (pos === "s") {
          if (!hd || !hRoles.some((r) => r.concepts.has(l.concept))) return undefined;
          const f = plainValue(hd, l.concept, { instant: c.h1.end });
          return f && !f.conflict && f.v != null && hnp.neg.has(l.concept) ? { ...f, v: -f.v } : f;
        }
        if ((fd && isPerShareUnit(fd, l.concept)) || (hd && isPerShareUnit(hd, l.concept))) return { blank: "주당 지표 — 하반기 = 사업연도 − 상반기 차감 안 함" };
        if (!fd || !hd || !fRoles.some((r) => r.concepts.has(l.concept)) || !hRoles.some((r) => r.concepts.has(l.concept))) return undefined;
        const fv = plainValue(fd, l.concept, c.fy), hv = plainValue(hd, l.concept, c.h1);
        if (fv === undefined || hv === undefined) return undefined;
        if (fv.conflict || hv.conflict) return { conflict: [fv.v ?? "충돌", hv.v ?? "충돌"] };
        if (fv.v == null || hv.v == null) return { blank: "사업연도·상반기 중 한쪽 －(nil)" };
        const v = fv.v - hv.v;
        return { v: hnp.neg.has(l.concept) ? -v : v, how: `${fv.v} − ${hv.v}` };
      }, tag);
    }
  }
}
/** 앱 출처 문구 "상반기 열 출처: 2024 H1 S100UP32, …" → { "2024 H1": docID } */
function appHalfSources(source) {
  const m = /상반기 열 출처: ([^·]+)/.exec(source ?? "");
  if (!m) return null;
  return Object.fromEntries([...m[1].matchAll(/(\d{4} H1) (S[0-9A-Z]{7}|없음)/g)].map((x) => [x[1], x[2]]));
}
