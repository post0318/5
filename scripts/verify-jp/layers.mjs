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

// ── Yahoo 일봉·분할 이력(검증기 직접 — 앱 시세 모듈 안 씀) ──
const yMemo = new Map();
/** { bars: [{ date(JST), close(현재 주식 기준) }], splits: [{ date, ratio }], price(현재가) } */
function yahooDaily(sym) {
  if (!yMemo.has(sym)) {
    const p = (async () => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}.T?period1=${Date.parse("2019-01-01") / 1000}&period2=${Math.floor(Date.now() / 1000)}&interval=1d&events=split`;
      const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`Yahoo 일봉 HTTP ${r.status}`);
      const res = (await r.json())?.chart?.result?.[0];
      if (!res?.timestamp) throw new Error("Yahoo 일봉 응답 형식 이상");
      const jst = (t) => new Date(t * 1000 + 9 * 3600e3).toISOString().slice(0, 10);
      const close = res.indicators?.quote?.[0]?.close ?? [];
      const bars = res.timestamp.map((t, i) => ({ date: jst(t), close: close[i] })).filter((b) => b.close != null);
      const splits = Object.values(res.events?.splits ?? {}).map((x) => ({ date: jst(x.date), ratio: x.numerator / x.denominator }));
      return { bars, splits, price: res.meta?.regularMarketPrice ?? null };
    })();
    p.catch(() => yMemo.delete(sym));
    yMemo.set(sym, p);
  }
  return yMemo.get(sym);
}
const yahooSplits = async (sym) => (await yahooDaily(sym)).splits;

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
  if (!rows.length) {
    if (what === "有報") hardErrors.push(`EDINET ${what} 없음(${code.edinetCode}, ${scanFrom} 이후)`);
    return { code, docs: [], same: [], std: null, none: `EDINET ${what} 없음(${scanFrom} 이후)` };
  }
  const docs = [];
  let parsedNoStmt = null;
  for (const r of rows) {
    try {
      const d = await loadDoc(r);
      if (!d.roles.size) { parsedNoStmt ??= d; continue; } // 訂正 중 재무제표를 다시 싣지 않은 것 · US GAAP 본표는 문단뿐
      d.consUsed = [...d.roles.values()].some((x) => x.cons);
      docs.push(d);
    } catch (e) {
      hardErrors.push(`${r.docID} XBRL 판독 실패 — ${redact(e.message).slice(0, 100)}`);
    }
  }
  if (!docs.length) {
    // 판독은 됐는데 본표 숫자 요소가 없음(US GAAP 회사 — 본표가 문단) — 조회 실패가 아니라 검증 범위 밖(검증불가 사유)
    const std = parsedNoStmt?.dei.AccountingStandardsDEI ?? null;
    if (!parsedNoStmt) hardErrors.push(`판독된 ${what} 없음`);
    return { code, docs: [], same: [], std, none: `${what} 본표 숫자 요소 없음(${std ?? "기준 미상"} — 본표가 문단뿐)` };
  }
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

/** 같은 기준 有報의 당기·전기(표준 문맥) 중 손익 본표가 실린 사업연도, 최근 5개 */
function fyList(same) {
  const fy = new Map();
  for (const d of same) for (const c of d.ctx.values()) {
    if (c.dims.length || !c.start) continue;
    const per = { start: c.start, end: c.end };
    const days = (Date.parse(c.end) - Date.parse(c.start)) / 864e5;
    if (days < 300 || days > 400 || fy.has(c.end)) continue;
    if (carries(d, "is", per)) fy.set(c.end, per);
  }
  return [...fy.values()].sort((a, b) => a.end.localeCompare(b.end)).slice(-N_FY);
}

export async function jpAnnualLayers(sym, app, { add, PASS, FAIL, NA, hardErrors }) {
  const t = { add, PASS, FAIL, NA };
  const src = await companyDocs(sym, hardErrors, (r) => r.docTypeCode === "120" || r.docTypeCode === "130", "有報");
  if (!src) return null;
  const { docs, std, same } = src;
  if (!same.length || !fyList(same).length) {
    add("B", "회계기준", "-", { status: NA, note: src.none ?? `${std} — 연결·개별 본표 숫자 요소로 사업연도 손익이 실린 서류 없음(US GAAP 연결 본표는 문단뿐)` });
    for (const p of (app.is?.periods ?? []).filter((x) => /^FY\d{4}$/.test(x.label))) {
      const hasVal = (app.is?.sections ?? []).some((sec) => sec.items.some((it) => it.values?.[p.label] != null));
      add("B", "앱 연도 열 ∈ 원자료 최근 5개 사업연도", p.label, hasVal ? { status: FAIL, note: `원자료 본표 숫자 없음(${std})인데 앱 열에 값` } : { status: NA, note: `앱 열 값 없음 — 원자료 본표 숫자 없음(${std})` });
    }
    return null;
  }
  /** 결산일 → { 항목: { concept, v } · colOf · eps(기대 EPS) } — 2단계 층(J1·J5·C·D)이 쓴다 */
  const keyVals = new Map();

  // ── 층 B: 사업연도 — 같은 기준 有報의 당기·전기(표준 문맥) 중 손익 본표가 실린 것, 최근 5개
  const fys = fyList(same);
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
    const kv = { colOf, per };
    keyVals.set(per.end, kv);
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
        if (name === "영업이익") continue; // 표준 영업이익 줄 없는 회사 — 앱 근사는 J-OP 층이 원자료로 따로 대조
        add("A", `주요 항목 ${name}`, label, { status: NA, note: `표준 요소 없음(${d.row.docID} — 회사 고유 요소 또는 금융 서식)` });
        continue;
      }
      const f = valueIn(d, concept, kind, per, "e");
      const src = f?.v ?? null;
      kv[name] = { concept, v: src, how };
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
      else if (eq(hv, got.exp)) { kv.eps = got.exp; add("A", NAME, label, { status: PASS, app: hv, src: got.exp, note: desc(got) }); }
      else {
        // 분할 뒤 회사가 경영지표를 소급 재작성하면 소수 2자리 반올림 값(소니 FY2022 705.16 ÷ 5 = 141.032 → 재작성 141.03). 손익 열 서류 값 ÷ 그 뒤 분할이
        // 앱과 정확히 같고, 그 값을 2자리 반올림하면 재작성 값과 같을 때만 통과(두 공시가 식으로 이어짐)
        const alt = epsIn(colOf.is);
        const r2 = (x) => Math.sign(x) * Math.round(Math.abs(x) * 100 + 1e-9) / 100;
        if (alt && alt.d !== got.d && eq(hv, alt.exp) && got.factor === 1 && r2(alt.exp) === got.v) {
          kv.eps = alt.exp;
          add("A", NAME, label, { status: PASS, app: hv, src: alt.exp, note: `${desc(alt)} — 재작성 경영지표 ${got.v}(${got.d.row.docID}) = 2자리 반올림` });
        } else add("A", NAME, label, { status: FAIL, app: hv, src: got.exp, note: `하이라이트 ${hv} vs 경영지표 ${desc(got)}${alt && alt.d !== got.d ? ` · 손익 열 서류 경로 ${desc(alt)} = ${alt.exp}` : ""}` });
      }
    }
  }
  return { src, fys, keyVals };
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
  if (!half.docs.length) { add("A반기", "반기 서류", "-", { status: NA, note: half.none }); return; }
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
      // H2 재무상태표 = 사업연도 말 — 원자료 有報 재무상태표 줄이 앱 반기 화면에 있는가
      // (반기 화면 줄 구조 = 반기 서류 본표 — 有報에만 있는 세부 줄(J-GAAP 요약 반기 재무상태표에 없는 棚卸 내역 등)은 대상 아님)
      if (kind === "bs" && fd && hd) {
        const hC = new Set(hRoles.flatMap((r) => [...r.concepts]));
        checkMissing(t, "A반기", label, "bs", fd, fRoles.map((r) => ({ ...r, concepts: new Set([...r.concepts].filter((x) => hC.has(x))) })), c.fy, lines.bs);
      }
    }
  }
}
/** 앱 출처 문구 "상반기 열 출처: 2024 H1 S100UP32, …" → { "2024 H1": docID } */
function appHalfSources(source) {
  const m = /상반기 열 출처: ([^·]+)/.exec(source ?? "");
  if (!m) return null;
  return Object.fromEntries([...m[1].matchAll(/(\d{4} H1) (S[0-9A-Z]{7}|없음)/g)].map((x) => [x[1], x[2]]));
}

// ── 2단계: J1 시가총액 · J5 DPS · J4 LTM · 영업이익 근사(J-OP) · C 화면 간 · D 항등식 (docs/verify-jp-design.md §4) ──
const normName = (x) => String(x ?? "").replace(/株式会社|㈱|[(（]株[)）]|\s|　/g, "");
const relEq = (a, b, tol = 1e-12) => a != null && b != null && Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const addYears = (d, n) => `${Number(d.slice(0, 4)) + n}${d.slice(4) === "-02-29" ? "-02-28" : d.slice(4)}`;
const noDim = (d, c) => {
  for (const f of d.facts.get(c) ?? []) { const x = d.ctx.get(f.ctx); if (x && !x.dims.length) return f; }
  return undefined;
};
const rowOfCtx = (d, id) => { const x = d.ctx.get(id); const m = x && x.dims.length === 1 ? /^SequentialNumbersAxis=(Row\d+Member)$/.exec(x.dims[0]) : null; return m ? m[1] : null; };

/**
 * J1 주식수 — 그 서류 자신의 株式の総数等(기말 발행주식수, 차원 없음) − 自己株式等 표의 제출회사 행(자기 명의 + 타인 명의).
 * 제출회사 행 = 소유자 이름이 DEI 제출자명과 같은 행 **이고 1행**(記載要領 — 자기 보유분을 먼저 적는다) — 두 조건이 다르면 판정 안 함(검증불가).
 */
function ownShares(d) {
  const issued = noDim(d, "jpcrp_cor:NumberOfIssuedSharesAsOfFiscalYearEndIssuedSharesTotalNumberOfSharesEtc")?.v ?? null;
  const issuedFiling = noDim(d, "jpcrp_cor:NumberOfIssuedSharesAsOfFilingDateIssuedSharesTotalNumberOfSharesEtc")?.v ?? null;
  if (issued == null) return { why: `${d.row.docID} 発行済株式(株式の総数等) 없음` };
  const names = new Map();
  for (const t of d.texts.get("NameOfShareholderTreasurySharesEtc") ?? []) { const r = rowOfCtx(d, t.ctx); if (r) names.set(r, t.s); }
  const byRow = (c) => { const m = new Map(); for (const f of d.facts.get(c) ?? []) { const r = rowOfCtx(d, f.ctx); if (r) m.set(r, f.v ?? 0); } return m; };
  const own = byRow("jpcrp_cor:NumberOfSharesHeldInOwnNameTreasurySharesEtc"), oth = byRow("jpcrp_cor:NumberOfSharesHeldInOthersNamesTreasurySharesEtc");
  if (!names.size && !own.size) return { issued, issuedFiling, treasury: 0, shares: issued, how: "自己株式等 표 없음" };
  const filer = normName(d.dei.FilerNameInJapaneseDEI);
  const mine = [...names].filter(([, n]) => normName(n) === filer).map(([r]) => r);
  if (!mine.length) return { issued, issuedFiling, why: `${d.row.docID} 自己株式等 표에 제출회사 행 없음(${[...names.values()].slice(0, 2).join("·")})` };
  if (!mine.includes("Row1Member")) return { issued, issuedFiling, why: `${d.row.docID} 제출회사 행이 1행이 아님(${mine.join("·")}) — 판정 보류` };
  const treasury = mine.reduce((a, r) => a + (own.get(r) ?? 0) + (oth.get(r) ?? 0), 0);
  return { issued, issuedFiling, treasury, shares: issued - treasury, how: `${d.row.docID} 発行済 ${issued} − 自己株式(제출회사 행 ${mine.join("·")}) ${treasury}` };
}

/** 영업이익 줄 없는 회사의 앱 영업이익 근사 기대값(J-OP) — 금융 서식 → 빈칸, 事業利益(요소 이름) → 그 값, 세전 + 支払利息 − 持分法 → 그 값, 支払利息 줄 없음 → 빈칸 */
function opAltExp(d, per, valOf) {
  if ([...d.facts.keys()].some((k) => /(BNK|INS)$/.test(k))) return { blank: "금융 서식(BNK·INS 요소) — 영업이익 없음" };
  const roles = roleOf(d, "is");
  const inR = (c) => roles.some((r) => r.concepts.has(c));
  const biz = [...new Set(roles.flatMap((r) => [...r.concepts]))].find((c) => /:(ProfitLossFromBusinessActivities|BusinessProfit)\w*$/.test(c) && !/Abstract$/.test(c));
  if (biz) { const v = valOf(biz); if (v != null) return { v, how: `${biz}(事業利益 — 요소 이름)` }; }
  const pick = (cs) => cs.find((c) => inR(c) && valOf(c) != null);
  const pt = pick(["jpigp_cor:ProfitLossBeforeTaxIFRS", "jppfs_cor:IncomeBeforeIncomeTaxes", "jppfs_cor:IncomeBeforeIncomeTaxesAndMinorityInterests"]);
  const ie = pick(["jpigp_cor:InterestExpensesIFRS", "jppfs_cor:InterestExpensesNOE"]);
  if (pt && ie) {
    const eq = pick(["jpigp_cor:ShareOfProfitLossOfInvestmentsAccountedForUsingEquityMethodIFRS", "jppfs_cor:EquityInEarningsOfAffiliatesNOI"]);
    const eqL = pick(["jppfs_cor:EquityInLossesOfAffiliatesNOE"]);
    const v = valOf(pt) + Math.abs(valOf(ie)) - (eq ? valOf(eq) : 0) + (eqL ? valOf(eqL) : 0);
    return { v, how: `세전 ${valOf(pt)} + 支払利息 ${Math.abs(valOf(ie))}${eq ? ` − 持分法 ${valOf(eq)}` : ""}${eqL ? ` + 持分法損失 ${valOf(eqL)}` : ""}` };
  }
  return { blank: `영업이익 줄·事業利益 없음, ${pt ? "支払利息 요소 없음" : "세전이익 없음"} — 근사 안 함` };
}

/**
 * 2단계 층. ctx = jpAnnualLayers 반환({ src, fys, keyVals }). 앱 화면: hl(하이라이트)·an(재무분석)·tt(TTM)·is/bs/cf(연간 본표, LTM 열)
 */
export async function jpValueLayers(sym, app, ctx, { add, PASS, FAIL, NA, hardErrors }) {
  if (!ctx) return;
  const t = { add, PASS, FAIL, NA };
  const { src, fys, keyVals } = ctx;
  const hl = app.hl?.highlights;
  if (!hl) return;
  const row = (k) => hl.rows?.find((r) => r.key === k) ?? hl.valuationRows?.find((r) => r.key === k) ?? null;
  const val = (k, i) => (i >= 0 ? (row(k)?.values?.[i] ?? null) : null);
  const ltmI = hl.columns.findIndex((c) => c.kind === "ltm");
  let y;
  try { y = await yahooDaily(sym); } catch (e) { hardErrors.push(`Yahoo 일봉 실패 — ${String(e.message).slice(0, 80)}`); return; }
  const splitsAfter = (d) => y.splits.filter((s) => s.date > d).reduce((a, s) => a * s.ratio, 1);
  const barOn = (d) => { let b = null; for (const x of y.bars) if (x.date <= d) b = x; return b && b.date >= addDays(d, -10) ? b : null; };
  const blankOk = new Map();
  const KEYOF = { "PER = 종가 ÷ EPS": "per", "PBR = 시가총액 ÷ 지배주주 자본(원자료)": "pbr", "PSR = 시가총액 ÷ 매출(원자료)": "psr", "EV/EBITDA = EV ÷ EBITDA": "ev_ebitda", "시가총액 = 결산일 종가 × 유통주식수": "mktcap" };
  const cmp = (layer, name, col, app0, exp, how, tol = 1e-12) => {
    if (exp && exp.blank && app0 == null && KEYOF[name]) blankOk.set(`${KEYOF[name]}|${col}`, exp.blank);
    if (exp && exp.blank) return add(layer, name, col, app0 == null ? { status: PASS, note: `기대 빈칸 — ${exp.blank}` } : { status: FAIL, app: app0, note: `${exp.blank} — 앱은 빈칸이어야 하는데 값 ${app0}` });
    if (exp == null || exp.v == null) return add(layer, name, col, { status: NA, note: exp?.why ?? "원자료 기대값 없음" });
    add(layer, name, col, relEq(app0, exp.v, tol) ? { status: PASS, app: app0, src: exp.v, note: how ?? exp.how } : { status: FAIL, app: app0, src: exp.v, note: `앱 ${app0} vs 기대 ${exp.v}${how ?? exp.how ? ` — ${how ?? exp.how}` : ""}` });
  };
  const ownDoc = (end) => src.docs.find((d) => d.dei.CurrentFiscalYearEndDateDEI === end && d.dei.TypeOfCurrentPeriodDEI === "FY" && noDim(d, "jpcrp_cor:NumberOfIssuedSharesAsOfFiscalYearEndIssuedSharesTotalNumberOfSharesEtc"));
  const eqParentOf = (d, end) => {
    if (!d) return null;
    const v = (c) => plainValue(d, c, { instant: end })?.v ?? null;
    const ifrs = v("jpigp_cor:EquityAttributableToOwnersOfParentIFRS");
    if (ifrs != null) return ifrs;
    const na = v("jppfs_cor:NetAssets");
    return na == null ? null : na - (v("jppfs_cor:NonControllingInterests") ?? 0) - (v("jppfs_cor:SubscriptionRightsToShares") ?? 0);
  };

  // ── 사업연도 열 ──
  const fyShares = new Map();
  for (const per of fys) {
    const i = hl.columns.findIndex((c) => c.kind === "fy" && c.date === per.end);
    const kv = keyVals.get(per.end);
    const label = `${per.end.slice(0, 7)}`;
    if (i < 0 || !kv) continue;
    // J1 시가총액 = 결산일(직전 거래일) 실제 종가 × 그 날 유통주식수
    const od = ownDoc(per.end);
    const sh = od ? ownShares(od) : { why: "그 사업연도 有報(株式の総数等) 없음" };
    const bar = barOn(per.end);
    const first = y.bars[0]?.date;
    let mcapExp = null;
    if (!bar) mcapExp = first && first > per.end ? { blank: `상장 전(Yahoo 첫 거래일 ${first})` } : { why: `${per.end} 주가 없음` };
    else if (sh.shares == null) mcapExp = { why: sh.why };
    else {
      const win = y.splits.find((s) => s.date <= per.end && s.date > addDays(per.end, -10));
      const winOk = win && sh.issuedFiling && Math.abs(sh.issuedFiling / sh.issued - win.ratio) < 0.01 * win.ratio;
      const shares = sh.shares * (winOk ? win.ratio : 1);
      fyShares.set(per.end, { shares, at: per.end });
      const actual = bar.close * splitsAfter(bar.date);
      mcapExp = { v: actual * shares, how: `${bar.date} 종가 ${bar.close}${splitsAfter(bar.date) !== 1 ? ` × 분할 ${splitsAfter(bar.date)}` : ""} × ${sh.how}${winOk ? ` × 기말 직전 권리락 분할 ${win.ratio}(${win.date}, 提出日現在発行数 확인)` : ""}` };
    }
    cmp("J1", "시가총액 = 결산일 종가 × 유통주식수", label, val("mktcap", i), mcapExp);
    const price = bar?.close ?? null; // 현재 주식 기준(PER·배당수익률 분자·분모와 같은 기준)
    // J5 DPS — 그 사업연도 有報 자신의 경영지표 1株当たり配当額(개별), 결산일 뒤 분할(+ 기말 직전 권리락)로 나눔
    // 그 사업연도 자신의 有報가 없으면(상장 전 해 — 285A FY2024) 그 해를 경영지표에 실은 가장 나중 有報
    const dpsDoc = od ?? src.docs.find((d) => ncValue(d, "jpcrp_cor:DividendPaidPerShareSummaryOfBusinessResults", { start: per.start, end: per.end }) !== undefined);
    if (dpsDoc) {
      const od = dpsDoc;
      const f = ncValue(od, "jpcrp_cor:DividendPaidPerShareSummaryOfBusinessResults", { start: per.start, end: per.end });
      const win = y.splits.find((s) => s.date <= per.end && s.date > addDays(per.end, -10));
      const shr = ownShares(od);
      const winOk = win && shr.issuedFiling && shr.issued && Math.abs(shr.issuedFiling / shr.issued - win.ratio) < 0.01 * win.ratio;
      const fac = splitsAfter(per.end) * (winOk ? win.ratio : 1);
      const dpsExp = f === undefined ? { blank: "경영지표에 1株当たり配当額 없음" } : { v: (f.v ?? 0) / fac, how: `${od.row.docID} ${f.v == null ? "－(무배당) = 0" : f.v}${fac !== 1 ? ` ÷ ${fac}` : ""}` };
      cmp("J5", "DPS = 경영지표 ÷ 결산일 뒤 분할", label, val("dps", i), dpsExp);
      if (dpsExp.v != null && price) cmp("J5", "배당수익률 = DPS ÷ 종가", label, val("divyield", i), { v: (dpsExp.v / price) * 100 }, null, 1e-9);
    } else cmp("J5", "DPS = 경영지표 ÷ 결산일 뒤 분할", label, val("dps", i), { blank: "어느 有報 경영지표에도 그 해 1株当たり配当額 없음" });
    // J-OP 영업이익 근사(표준 영업이익 요소 없는 회사)
    const isDoc = kv.colOf.is;
    if (!kv["영업이익"] && isDoc) {
      const e = opAltExp(isDoc, per, (c) => plainValue(isDoc, c, { start: per.start, end: per.end })?.v ?? null);
      const has = !!row("opinc");
      if (e.blank && !has) add("J-OP", "영업이익 근사(하이라이트)", label, { status: PASS, note: `기대 빈칸 — ${e.blank} · 하이라이트에 행 없음` });
      else cmp("J-OP", "영업이익 근사(하이라이트)", label, val("opinc", i), e);
      if (e.v != null) kv.opAlt = e.v;
      kv.opAltExp = e;
    }
    // C·D — 배수·마진·EV 항등식(원자료 분모)
    const rev = kv["매출"]?.v ?? null, ni = kv["순이익(지배)"]?.v ?? null, op = kv["영업이익"]?.v ?? kv.opAlt ?? null;
    const eqP = eqParentOf(kv.colOf.bs, per.end);
    const pos = (a, b) => (a != null && b != null && b > 0 ? a / b : null);
    const mc = mcapExp?.v ?? null;
    if (mcapExp?.blank) for (const k of ["per", "pbr", "psr", "ev_ebitda"]) {
      if (val(k, i) == null) blankOk.set(`${k}|${label}`, `시가총액 기대 빈칸(${mcapExp.blank})`);
      else add("D", `${k} 빈칸 = 시가총액 빈칸`, label, { status: FAIL, app: val(k, i), note: `${mcapExp.blank}인데 ${k} 값` });
    }
    if (mc != null) {
      cmp("D", "PBR = 시가총액 ÷ 지배주주 자본(원자료)", label, val("pbr", i), eqP == null ? { why: "지배주주 자본 원자료 없음" } : eqP <= 0 ? { blank: "자본 ≤ 0" } : { v: mc / eqP }, null, 1e-9);
      cmp("D", "PSR = 시가총액 ÷ 매출(원자료)", label, val("psr", i), rev == null ? { why: "매출 원자료 없음" } : rev <= 0 ? { blank: "매출 ≤ 0" } : { v: mc / rev }, null, 1e-9);
    }
    const epsA = val("eps", i);
    if (price != null && epsA != null) cmp("D", "PER = 종가 ÷ EPS", label, val("per", i), epsA <= 0 ? { blank: "EPS ≤ 0" } : { v: pos(price, epsA) }, null, 1e-9);
    for (const [k, num] of [["revenue_yoy", null], ["opinc_m", op], ["ni_m", ni], ["ebitda_m", val("ebitda", i)]]) {
      if (k === "revenue_yoy") continue;
      if (row(k) && num != null && rev) cmp("D", `${k} = ÷ 매출 × 100`, label, val(k, i), { v: (num / rev) * 100 }, null, 1e-9);
    }
    const ev = val("ev", i);
    if (ev != null) cmp("D", "EV = 시가총액 + 차입금 + 비지배 − 현금", label, ev, { v: val("mktcap", i) + (val("debt", i) ?? 0) + (val("nci", i) ?? 0) + (val("cash", i) ?? 0) }, null, 1e-12);
    if (row("ev_ebitda")) {
      const eb = val("ebitda", i);
      // EV 공란 자체의 옳고 그름은 J2(EV 구성요소·금융사업 연결 D2) 몫 — 여기서는 기대 빈칸으로 세지 않는다
      if (ev == null) add("D", "EV/EBITDA = EV ÷ EBITDA", label, val("ev_ebitda", i) == null ? { status: NA, note: "EV 공란 — EV 공란 판정은 J2(미구현·D2 결정 대기)" } : { status: FAIL, app: val("ev_ebitda", i), note: "EV 공란인데 EV/EBITDA 값" });
      else cmp("D", "EV/EBITDA = EV ÷ EBITDA", label, val("ev_ebitda", i), eb == null || eb <= 0 ? { blank: "EBITDA 없음·≤ 0" } : { v: ev / eb }, null, 1e-9);
    }
    // C — 재무분석 = 하이라이트(같은 사업연도)
    const an = app.an;
    const ai = (an?.periods ?? []).findIndex((p) => p.endDate === per.end);
    const anv = (id) => { for (const s of an?.sections ?? []) for (const it of s.items ?? []) if (it.accountId === id) return it.values?.[an.periods[ai].label] ?? null; return undefined; };
    if (ai >= 0) for (const [id, k] of [["an:PER", "per"], ["an:PBR", "pbr"], ["an:PSR", "psr"], ["an:EV/EBITDA", "ev_ebitda"]]) {
      const a = anv(id);
      if (a === undefined) continue;
      const h = val(k, i);
      const why = blankOk.get(`${k}|${label}`);
      add("C", `재무분석 ${id.slice(3)} = 하이라이트`, label, a == null && h == null ? (why ? { status: PASS, note: `양쪽 빈칸 = 기대 빈칸 — ${why}` } : { status: NA, note: "양쪽 빈칸" }) : relEq(a, h) ? { status: PASS, app: a, src: h } : { status: FAIL, app: a, src: h, note: `재무분석 ${a} vs 하이라이트 ${h}` });
    }
  }

  // ── J4 LTM ──
  const lastFy = fys.at(-1);
  if (!lastFy || ltmI < 0) return;
  const half = await companyDocs(sym, hardErrors, (r) => r.docTypeCode === "160" || r.docTypeCode === "170" || r.docTypeCode === "140" || r.docTypeCode === "150", "반기·분기 서류(LTM)");
  const h = (half?.docs ?? []).find((d) => /^(HY|Q2)$/.test(d.dei.TypeOfCurrentPeriodDEI ?? "") && d.dei.CurrentFiscalYearStartDateDEI === addDays(lastFy.end, 1) && (d.dei.AccountingStandardsDEI ?? null) === (src.std ?? null)) ?? null;
  const ltmEnd = h ? h.dei.CurrentPeriodEndDateDEI : lastFy.end;
  const isv = app.is;
  const ltmP = (isv?.periods ?? []).find((p) => p.label === "현재/LTM");
  add("B", "LTM 기준일 = 원자료", "LTM", !ltmP ? { status: FAIL, note: "앱 손익 화면에 현재/LTM 열 없음" } : ltmP.endDate === ltmEnd ? { status: PASS, note: h ? `반기 ${h.row.docID} ${ltmEnd}` : `최근 사업연도 ${ltmEnd}(그 뒤 반기 보고서 없음)` } : { status: FAIL, note: `앱 ${ltmP.endDate} vs 원자료 ${ltmEnd}${h ? `(반기 ${h.row.docID})` : ""}` });
  const kvL = keyVals.get(lastFy.end);
  const hCur = h ? { start: h.dei.CurrentFiscalYearStartDateDEI, end: h.dei.CurrentPeriodEndDateDEI } : null;
  const hPri = h ? { start: lastFy.start, end: addYears(hCur.end, -1) } : null;
  /** LTM 기대값 — 줄 l(kind): 반기 없음 = 최근 사업연도 열, 반기 있음 = 사업연도 + 당기 반기 − 전년 반기(재무상태표·기말 = 반기말, 기초 = 전년 반기말, 주당 = 빈칸) */
  const ltmExp = (l, kind) => {
    const fd = kvL?.colOf?.[kind];
    if (!fd) return undefined;
    const fR = roleOf(fd, kind), fnp = negPls(fR);
    if (!h) return expIn(fd, fR, kind, lastFy, l, fnp);
    const hR = roleOf(h, kind), hnp = negPls(hR);
    if (!hR.some((r) => r.concepts.has(l.concept))) return undefined;
    const pos = (hnp.pls.get(l.concept) ?? "")[l.occ] ?? "";
    const neg = (f) => (f && !f.conflict && f.v != null && hnp.neg.has(l.concept) ? { ...f, v: -f.v } : f);
    if (kind === "bs" || pos === "e") return neg(plainValue(h, l.concept, { instant: hCur.end }));
    if (pos === "s") return neg(plainValue(h, l.concept, { instant: hPri.end }));
    if (isPerShareUnit(h, l.concept) || isPerShareUnit(fd, l.concept)) return { blank: "주당 지표 — LTM 합산 안 함" };
    if (!fR.some((r) => r.concepts.has(l.concept))) return undefined;
    const a = plainValue(fd, l.concept, lastFy), b = plainValue(h, l.concept, hCur), c = plainValue(h, l.concept, hPri);
    if (a === undefined || b === undefined || c === undefined) return undefined;
    if (a.conflict || b.conflict || c.conflict) return { conflict: ["충돌", "충돌"] };
    if (a.v == null || b.v == null || c.v == null) return { blank: "사업연도·반기 중 －(nil)" };
    const v = a.v + b.v - c.v;
    return { v: fnp.neg.has(l.concept) ? -v : v, how: `${a.v} + ${b.v} − ${c.v}` };
  };
  const views = { is: app.is, bs: app.bs, cf: app.cf };
  for (const [vk, view] of Object.entries(views)) {
    const ls = appLines(view);
    for (const kind of vk === "is" ? ["is", "ci"] : [vk]) checkLines(t, "J4", "현재/LTM", ls.filter((l) => l.kind === kind), (l) => ltmExp(l, kind), h ? `${kvL?.colOf?.[kind]?.row.docID} + ${h.row.docID}` : kvL?.colOf?.[kind]?.row.docID ?? "없음");
  }
  // LTM 하이라이트 = 본표 LTM(원자료 기대값)
  const keyLtm = (name, kind) => { const k = kvL?.[name]; return k?.concept ? ltmExp({ concept: k.concept, occ: 0 }, kind) : null; };
  for (const [name, kind, hk] of [["매출", "is", "revenue"], ["영업이익", "is", "opinc"], ["순이익(지배)", "is", "ni"], ["영업활동 CF", "cf", "ocf"]]) {
    const e = keyLtm(name, kind);
    if (!e || !row(hk)) continue;
    cmp("J4", `LTM ${name}(하이라이트)`, "LTM", val(hk, ltmI), e);
  }
  // J-OP LTM(반기 없음 = 최근 사업연도 근사와 같은 값)
  if (kvL?.opAltExp && !h) {
    const e = kvL.opAltExp;
    if (e.blank && !row("opinc")) add("J-OP", "영업이익 근사(하이라이트)", "LTM", { status: PASS, note: `기대 빈칸 — ${e.blank} · 하이라이트에 행 없음` });
    else cmp("J-OP", "영업이익 근사(하이라이트)", "LTM", val("opinc", ltmI), e);
  }
  // LTM 시가총액 — 주식수(최근 사업연도 말, 반기 뒤면 반기 서류) × 그 뒤 분할 → 앱 시가총액 ÷ 주식수 = Yahoo 현재가
  const shL = h ? (() => { const s = ownShares(h); return s.shares != null ? { shares: s.shares, at: hCur.end } : null; })() : fyShares.get(lastFy.end);
  const mL = val("mktcap", ltmI);
  if (shL && mL != null) {
    const shares = shL.shares * splitsAfter(shL.at);
    // 앱이 그 응답에서 쓴 현재가 = DPS ÷ 배당수익률 또는 PER × EPS(같은 응답 안 — 현재가 조회 시점 차 없음)
    const dy = val("divyield", ltmI), dp = val("dps", ltmI), pe = val("per", ltmI), ep = val("eps", ltmI);
    const pApp = dy && dp ? (dp * 100) / dy : pe && ep ? pe * ep : null;
    const name = "LTM 시가총액 = 현재가 × 주식수";
    if (pApp == null) add("J1", name, "LTM", { status: NA, note: "앱 응답에서 현재가를 되돌릴 값 없음(배당·PER 모두 빈칸)" });
    else add("J1", name, "LTM", relEq(mL, pApp * shares, 1e-9) ? { status: PASS, note: `현재가 ${pApp}(앱 응답) × 주식수 ${shares}(${shL.at}${splitsAfter(shL.at) !== 1 ? `, 그 뒤 분할 ${splitsAfter(shL.at)}` : ""}) · Yahoo 현재가 ${y.price}` } : { status: FAIL, app: mL, src: pApp * shares, note: `앱 ${mL} vs 현재가 ${pApp} × 주식수 ${shares}` });
  } else add("J1", "LTM 시가총액 = 현재가 × 주식수", "LTM", { status: NA, note: shL ? "앱 LTM 시가총액 빈칸" : "주식수 판독 안 됨" });
  // LTM DPS·EPS(반기 없음 = 최근 사업연도와 같은 값)
  const fyI = hl.columns.findIndex((c) => c.kind === "fy" && c.date === lastFy.end);
  if (!h) {
    for (const k of ["dps", "eps"]) {
      const a = val(k, ltmI), b = val(k, fyI);
      add("J4", `LTM ${k.toUpperCase()} = 최근 사업연도(반기 없음)`, "LTM", a == null && b == null ? { status: NA, note: "양쪽 빈칸" } : relEq(a, b) ? { status: PASS, app: a, src: b } : { status: FAIL, app: a, src: b, note: `LTM ${a} vs 사업연도 ${b}` });
    }
  } else if (shL) {
    const ni = keyLtm("순이익(지배)", "is");
    if (ni?.v != null) cmp("J4", "LTM EPS = LTM 지배 순이익 ÷ 주식수", "LTM", val("eps", ltmI), { v: ni.v / (shL.shares * splitsAfter(shL.at)) }, null, 1e-9);
  }
  // C — TTM(개요 멀티플·유니버스) = 하이라이트 LTM
  const tt = app.tt?.ttm;
  if (tt) {
    for (const [k, hk] of [["revenue", "revenue"], ["opIncome", "opinc"], ["netIncome", "ni"], ["eps", "eps"]]) {
      if (!row(hk)) continue;
      const a = tt[k] ?? null, b = val(hk, ltmI);
      const opBlank = k === "opIncome" && !h ? kvL?.opAltExp?.blank : null;
      add("C", `TTM ${k} = 하이라이트 LTM`, "LTM", a == null && b == null ? (opBlank ? { status: PASS, note: `양쪽 빈칸 = 기대 빈칸 — ${opBlank}` } : { status: NA, note: "양쪽 빈칸" }) : relEq(a, b) ? { status: PASS, app: a, src: b } : { status: FAIL, app: a, src: b, note: `TTM ${a} vs 하이라이트 ${b}` });
    }
    const cashL = val("cash", ltmI);
    if (tt.snapshot?.cash != null || cashL != null) add("C", "TTM 현금 = 하이라이트 LTM", "LTM", relEq(tt.snapshot?.cash ?? null, cashL == null ? null : -cashL) ? { status: PASS } : { status: FAIL, note: `TTM ${tt.snapshot?.cash} vs 하이라이트 −(${cashL})` });
    const eqL = eqParentOf(h ?? kvL?.colOf?.bs, ltmEnd);
    if (eqL != null) cmp("C", "TTM 지배주주 자본 = 원자료", "LTM", tt.snapshot?.equity ?? null, { v: eqL });
    const ebL = val("ebitda", ltmI), opL = val("opinc", ltmI);
    if (ebL != null && tt.daTtm != null && opL != null) cmp("D", "LTM EBITDA = 영업이익 + 감가상각(TTM)", "LTM", ebL, { v: opL + tt.daTtm });
  }
}
