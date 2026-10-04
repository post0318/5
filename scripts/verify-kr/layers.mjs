/**
 * 검증기 — 한국 원자료 층(감사 1차, 2026-10-05). 앱 출력·앱이 보낸 메타데이터(주석·분류)로 기대치를 정하지 않는다.
 *  K1 시가총액(보통주·우선주) = KRX 일별 전종목 MKTCAP 직접 조회(연말 마지막 거래일·현재) — 정확 일치. 앱이 근사를 썼다면 KRX 가 실제로 실패했어야 한다.
 *  K2 EV 구성요소(총차입금·현금성자산·비지배지분) = DART 재무상태표 줄로 B16 규칙을 검증기가 따로 계산(b16.mjs) — 사업연도·LTM(최신 분기 보고서).
 *     금융업·금융 자회사 판정도 검증기 자체 규칙(앱 isFinancialBs·KR_CAPTIVE·주석 문구를 쓰지 않음).
 *  K3 감가상각비 — 적재본(kr_da, populate-kr-da.mjs 가 원자료에서 만든 값)을 DB 에서 직접 읽어 대조하고, XBRL 해는 사업보고서 XBRL 현금흐름
 *     조정 태그로 따로 재현. 적재본이 있는 해에 앱이 빈칸이면 실패. 재무제표 기준(연결·별도)과 감가상각 출처 기준이 해마다 같아야 한다.
 *  K4 LTM 손익 = DART 분기·반기 보고서로 검증기가 직접(최근 4개 분기 합 — 앱 규칙 문서 "LTM = 최근 4개 분기 열 합", 분기 = 다음 해 같은 분기
 *     보고서의 전년 3개월 값 → 그 분기 보고서 3개월 값 → 누적 차, 4분기 = 사업보고서 − 3분기 누적), EPS = 사업연도 + 당기 누적 − 전년 동기 누적.
 *     최신 정기보고서는 정기공시 목록(list.json)으로 정한다(앱 ttm.periodLabel 아님).
 *  K5 주당배당금(사업연도) = DART alotMatter, 배당수익률 = DPS ÷ KRX 연말 종가.
 */
import { dartList, dartFnltt, dartAlot, dartXbrlFacts, dartDocLeaseCells } from "./dart.mjs";
import { krxCapsOn } from "./krx.mjs";
import { classifyBsRows, sumCol, leaseNoteFor, quarterLeaseFromCells } from "./b16.mjs";

const COL = ["thstrm_amount", "frmtrm_amount", "bfefrmtrm_amount"];
const num = (x) => { const t = String(x ?? "").trim(); return t === "" || t === "-" ? null : Number(t.replace(/,/g, "")); };
const nm = (s) => String(s ?? "").replace(/\s|\(.*?\)/g, "");
/** 금융 자회사(할부금융 차입금 미분리) — 검증기 자체 목록(사유 근거: 현대차 연결 현대캐피탈·현대카드) */
const CAPTIVE = new Map([["005380", "현대캐피탈·현대카드 연결(할부금융 차입금 미분리)"]]);
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");

/** 사업연도 y 재무상태표의 기준 보고서·열 — 그 해 재무상태표 값이 실린 가장 최근 보고서(y+2 전전기 → y+1 전기 → y 당기) */
function bsOwner(src, y) {
  for (const [L, by] of [[src.next2, y + 2], [src.next, y + 1], [src.cur, y]]) {
    const col = COL[by - y];
    if (L && L.some((r) => r.sj_div === "BS" && num(r[col]) != null)) return { rows: L, col, by };
  }
  return null;
}

function pickRow(rows, ids, names, sjs = ["IS", "CIS"]) {
  const rs = (rows ?? []).filter((r) => sjs.includes(r.sj_div));
  const byId = rs.filter((r) => ids.includes(r.account_id));
  if (byId.length) return byId;
  return rs.filter((r) => names.includes(nm(r.account_nm)));
}
/** 같은 계정 후보 줄들의 값 — 모두 같으면 그 값, 다르면 ambiguous */
function oneVal(rows, f) {
  const vs = rows.map((r) => f(r)).filter((x) => x != null);
  if (!vs.length) return { v: null };
  return vs.every((x) => x === vs[0]) ? { v: vs[0] } : { v: null, ambiguous: vs };
}

const IT = {
  rev: [["ifrs-full_Revenue", "dart_Revenue"], ["매출액", "수익매출액", "영업수익", "매출"]],
  op: [["dart_OperatingIncomeLoss", "ifrs-full_ProfitLossFromOperatingActivities"], ["영업이익", "영업이익손실", "영업손익"]],
  ni: [["ifrs-full_ProfitLoss"], ["당기순이익", "당기순이익손실", "분기순이익", "반기순이익", "연결당기순이익"]],
};
const EPS_D = [["ifrs-full_DilutedEarningsLossPerShare"], ["희석주당이익", "희석주당순이익", "보통주희석주당이익", "희석주당이익손실"]];
const EPS_B = [["ifrs-full_BasicEarningsLossPerShare"], ["기본주당이익", "기본주당순이익", "보통주기본주당이익", "기본주당이익손실", "기본및희석주당이익"]];
const QCODE = { 1: "11013", 2: "11012", 3: "11014" };
const QNAME = { 1: "1분기", 2: "반기", 3: "3분기" };

/** 몽고 감가상각 적재본(kr_da) 직접 읽기 — 앱 API 를 거치지 않는다 */
let daColP = null;
async function daCol(env) {
  if (!daColP) daColP = (async () => {
    if (!env.MONGODB_URI) throw new Error("MONGODB_URI 미설정 — 감가상각 적재본(kr_da)을 직접 못 읽음");
    const { MongoClient } = await import("mongodb");
    const c = new MongoClient(env.MONGODB_URI, { serverSelectionTimeoutMS: 15_000 });
    await c.connect();
    process.once("beforeExit", () => { c.close().then(() => {}, () => {}); });
    return c.db(env.MONGODB_DB || "market_research").collection(env.KR_DA_COLLECTION || "kr_da");
  })();
  return daColP;
}
export async function closeKrLayers() {
  if (!daColP) return;
  const col = await daColP;
  await col.client?.close?.();
}

/**
 * @param ctx { sym, corp, env, h, H, IS, tt, add, hardErrors, dartYearSource, consts: { PASS, FAIL, NA }, same }
 */
export async function krOriginalLayers(ctx) {
  const { sym, corp, h, H, add, hardErrors, dartYearSource, same } = ctx;
  const { PASS, FAIL, NA } = ctx.consts;
  const fail = (layer, name, col, note) => add(layer, name, col, { status: FAIL, note });
  const err = (what, e) => { const m = `${what}: ${String(e?.message ?? e).slice(0, 120)}`; hardErrors.push(m); add("응답", what, "-", { status: FAIL, note: m }); };
  /** 정확 일치(정수) — 원자료 있고 앱 빈칸·앱만 있고 원자료 빈칸 모두 실패 */
  const exact = (layer, name, col, app, src, why = "") => {
    if (src == null && app == null) return add(layer, name, col, { status: NA, note: `양쪽 빈칸${why ? ` · ${why}` : ""}` });
    if (src == null) return fail(layer, name, col, `원자료 없음인데 앱 값 ${app}${why ? ` · ${why}` : ""}`);
    if (app == null) return fail(layer, name, col, `원자료 ${src} 있는데 앱 빈칸${why ? ` · ${why}` : ""}`);
    const ok = Number.isInteger(src) && Number.isInteger(app) ? app === src : Math.abs(app - src) <= Math.abs(src) * 1e-9;
    return add(layer, name, col, ok ? { status: PASS, app, src, ...(why ? { note: why } : {}) } : { status: FAIL, app, src, note: `앱 ${app} vs 원자료 ${src} (차 ${app - src})${why ? ` · ${why}` : ""}` });
  };
  const notes = (h.notes ?? []).join(" ¶ ");
  const fyCols = h.columns.filter((c) => c.kind === "fy");
  const yearsShown = fyCols.map((c) => Number(String(c.label).slice(0, 4)));
  const rowHidden = (key) => !h.rows.some((r) => r.key === key);

  let L;
  try { L = await dartList(corp); } catch (e) { err("DART 정기공시 목록(list.json)", e); return; }

  // ── 연도별 원자료 ──
  const yearSrc = new Map();
  for (const y of yearsShown) {
    try { yearSrc.set(y, await dartYearSource(corp, y)); } catch (e) { err(`DART 재무제표 ${y}`, e); }
  }
  const latestFyBs = (() => { const y = Math.max(...yearsShown); const s = yearSrc.get(y); return s ? bsOwner(s, y) : null; })();
  const fin = latestFyBs ? classifyBsRows(latestFyBs.rows).financial : false;
  const captive = CAPTIVE.get(sym) ?? null;
  const evBlockWhy = fin ? "금융업(검증기 판정 — 예수부채·보험계약부채 등 줄)" : captive ? `금융 자회사(검증기 목록: ${captive})` : null;
  add("K2", "EV 적용 판정(검증기 자체 — 금융업·금융 자회사)", "-", { status: PASS, note: evBlockWhy ?? "일반 기업 — EV 계산 대상" });

  // ── K1 시가총액 ──
  const approxNote = /근사/.test(notes) && /시가총액/.test(notes);
  const caps = new Map();
  for (const y of yearsShown) {
    try { caps.set(y, await krxCapsOn(sym, `${y}1231`)); } catch (e) { err(`KRX 시가총액 ${y}`, e); }
  }
  let capCur = null;
  try { capCur = await krxCapsOn(sym, kstToday()); } catch (e) { err("KRX 시가총액(현재)", e); }
  if (approxNote) fail("K1", "시가총액 근사 표시 = KRX 실제 실패", "-", `앱이 시가총액 근사(종가 × 현재 주식수)를 표시했는데 검증기 KRX 조회는 성공 — 근사 사용 사유 없음`);
  for (const c of fyCols) {
    const y = Number(String(c.label).slice(0, 4)), col = `${y}Y`, x = H[col];
    if (!caps.has(y)) continue;
    const k = caps.get(y);
    if (!k || k.common == null) { exact("K1", "시가총액(보통주) = KRX 연말", col, x.mc, null, "KRX 에 그해 말 종목 없음(상장 전)"); continue; }
    exact("K1", "시가총액(보통주) = KRX 연말", col, x.mc, k.common, `KRX ${k.date}`);
    const appPref = x.pref ?? (rowHidden("pref_mcap") ? 0 : null);
    exact("K1", "우선주 시가총액 = KRX 연말", col, appPref, k.preferred, `KRX ${k.date}${k.prefIssues.length ? ` ${k.prefIssues.join("·")}` : " 우선주 없음"}`);
  }
  let ltmPrefOk = null; // LTM EV 기대치에 쓸 우선주 시가총액(K1 에서 확인된 값)
  if (H.LTM && capCur && capCur.common != null) {
    const appPref = H.LTM.pref ?? (rowHidden("pref_mcap") ? 0 : null);
    // 검증기가 건너뛴 게시 전 거래일(그 거래일~다음 거래일 KST) — 앱은 그 날 자료를 이미 받았을 수 있다. 다음 거래일도 지난 거래일의 빈 응답은 krx.mjs 가 조회 실패로 던진다
    const gap = capCur.pendingDays?.length ? capCur.pendingDays.join("·") : null;
    if (appPref === capCur.preferred) { add("K1", "우선주 시가총액 = KRX 최근 거래일", "LTM", { status: PASS, app: appPref, src: capCur.preferred, note: `KRX ${capCur.date}` }); ltmPrefOk = appPref; }
    else if (gap && appPref != null && !(appPref === 0 && capCur.preferred > 0)) {
      // 게시 전 거래일을 건너뛴 경우 — 앱 기준일이 그 날일 수 있다. 0 으로 비운 경우는 그대로 실패
      add("K1", "우선주 시가총액 = KRX 최근 거래일", "LTM", { status: NA, app: appPref, src: capCur.preferred, note: `KRX ${gap} 게시 전(그 거래일~다음 거래일) — 검증기 최근 거래일 ${capCur.date}(${capCur.preferred})와 앱 기준일이 다를 수 있음` });
      ltmPrefOk = appPref;
    } else exact("K1", "우선주 시가총액 = KRX 최근 거래일", "LTM", appPref, capCur.preferred, `KRX ${capCur.date}`);
    if (H.LTM.mc === capCur.common) add("K1", "시가총액(보통주) = KRX 최근 거래일", "LTM", { status: PASS, note: `KRX ${capCur.date}` });
    else {
      // 앱 시세 규칙(quote/index.ts): KRX 일별 자료가 아직 안 나온 날은 Yahoo 종가 × KRX 상장주식수 — 검증기가 Yahoo 종가를 따로 받아 확인
      let why = null;
      try {
        const y = await ctx.yahooBars(sym);
        const later = y.filter((b) => b.date.replace(/-/g, "") > capCur.date && b.close != null).at(-1);
        if (later && capCur.shares != null && H.LTM.mc === later.close * capCur.shares) why = `KRX ${capCur.date} 뒤 Yahoo ${later.date} 종가 ${later.close} × KRX 상장주식수 ${capCur.shares}(앱 시세 규칙)`;
      } catch (e) { err("Yahoo 일봉(현재 시가총액 확인)", e); }
      if (why) add("K1", "시가총액(보통주) = KRX 최근 거래일", "LTM", { status: PASS, note: why });
      else fail("K1", "시가총액(보통주) = KRX 최근 거래일", "LTM", `앱 ${H.LTM.mc} vs KRX ${capCur.date} ${capCur.common}`);
    }
  }

  // ── K2 EV 구성요소(사업연도) ──
  const policySrc = []; // LTM 판정에 쓸 최근 사업연도 리스 판정
  const leaseByYear = new Map(); // 단위 안전장치용 — 앱이 주석에서 더한 리스부채(사업연도)
  for (const c of fyCols) {
    const y = Number(String(c.label).slice(0, 4)), col = `${y}Y`, x = H[col];
    const src = yearSrc.get(y);
    if (!src) continue;
    const own = bsOwner(src, y);
    if (!own) { exact("K2", "총차입금 = DART(B16)", col, x.debt, null, "그해 재무상태표 없음"); continue; }
    // 기타(유동)금융자산 성격은 그해 자기 보고서(src.cur)의 분류로 — 값은 기준 보고서(own)
    const cl = classifyBsRows(own.rows, src.cur ?? own.rows, src.cur && src.cur !== own.rows ? { rows: src.cur, col: own.col } : null);
    const faceDebt = sumCol(cl.debt, own.col) ?? 0;
    let lease = { status: "face" }, why = `기준 보고서 ${own.by} ${own.col}${src.fsDiv === "OFS" ? " · 별도" : ""}`;
    if (!cl.leaseFace.length) {
      try {
        const r0 = L.latest(y, "11011"), r1 = L.latest(y + 1, "11011");
        // 회계정책 문장은 그 기간 보고서의 모든 판본(정정본은 바뀐 부분만 담기도 한다 — 103590 2022 정정본에 정책 문장 없음)
        const all = (yy) => L.reports.filter((x) => x.year === yy && x.code === "11011").map((x) => x.rcept);
        const namesOf = async (fy) => classifyBsRows(await dartFnltt(corp, fy, "11011", src.fsDiv)).debt.map((r) => nm(r.account_nm));
        lease = await leaseNoteFor([r0 && { rcept: r0.rcept, all: all(y), prefix: `CFY${y}eFY`, fy: y }, r1 && { rcept: r1.rcept, all: all(y + 1), prefix: `PFY${y}eFY`, fy: y + 1 }], src.fsDiv, namesOf);
      } catch (e) { err(`리스부채 주석 ${y}`, e); continue; }
      why += ` · 본표 리스부채 줄 없음 → ${lease.status === "added" ? `주석 리스부채 ${lease.amount} 가산` : lease.status === "included" ? "차입금 줄에 포함" : "리스부채 확인 불가"}(${lease.how})`;
      if (y === Math.max(...yearsShown)) policySrc.push({ ...lease, fy: y });
    } else if (y === Math.max(...yearsShown)) policySrc.push({ ...lease, fy: y });
    const expDebt = faceDebt + (lease.status === "added" ? lease.amount : 0);
    // 안전장치는 앱이 실제로 더한 값(앱 총차입금 − 본표 차입금)으로 — 검증기 판독과 같은 결함을 함께 가져도 잡히게
    if (lease.status === "added" && x.debt != null) leaseByYear.set(y, x.debt - faceDebt);
    const expCash = sumCol(cl.cash, own.col) ?? 0;
    const expNci = sumCol(cl.nci, own.col) ?? 0;
    exact("K2", "총차입금 = DART(B16)", col, x.debt, expDebt, why);
    exact("K2", "현금성자산 = DART(B16)", col, x.cash == null ? null : -x.cash, expCash, `${cl.cash.map((r) => nm(r.account_nm)).join("+")}`);
    exact("K2", "비지배지분 = DART", col, x.nci ?? (rowHidden("nci") ? 0 : null), expNci);
    const k = caps.get(y);
    const blockWhy = evBlockWhy ?? (lease.status === "unknown" ? "리스부채 확인 불가 — EV 공란이어야" : null) ?? (!k || k.common == null ? "KRX 연말 시가총액 없음" : null);
    if (blockWhy) { if (x.ev != null) fail("K2", "EV = KRX + DART(B16)", col, `기대 공란(${blockWhy})인데 앱 EV ${x.ev}`); else add("K2", "EV = KRX + DART(B16)", col, { status: PASS, note: `공란 — ${blockWhy}` }); }
    else exact("K2", "EV = KRX + DART(B16)", col, x.ev, k.common + k.preferred + expDebt + expNci - expCash);
  }

  // ── 단위 안전장치(2026-10-05 — 079550 2024 리스부채가 천원 숫자를 원으로 태깅해 앱·검증기가 같은 판독으로 함께 통과했다): 원문·주석 판독값을
  //    태그·단위와 무관한 근거인 **이웃 해 값**과 대조 — 이웃 해와 100배 넘게 다르면 단위 오류로 보고 실패(실제 리스부채가 한 해에 100배 바뀌는 일은
  //    없다고 본다. 리스부채가 처음 생긴 해처럼 진짜 급변이면 실패를 사람이 확인)
  unitGuard(leaseByYear, "K2", "리스부채(주석) 크기 = 이웃 해와 100배 안(단위 안전장치)", add, fail, PASS);

  // ── K4 LTM(최신 정기보고서) ──
  const lp = L.latestPeriod();
  const LT = H.LTM;
  if (lp && LT) {
    try {
      await ltmLayer({ ...ctx, L, lp, LT, exact, fail, err, policySrc, capCur, ltmPrefOk, evBlockWhy, rowHidden });
    } catch (e) { err("LTM 원자료(DART 분기·반기 보고서)", e); }
  }

  // ── K3 감가상각비 ──
  try { await daLayer({ ...ctx, exact, fail, err, yearSrc, yearsShown, caps, L }); } catch (e) { err("감가상각비 원자료(kr_da·XBRL)", e); }

  // ── K5 배당 ──
  for (const y of yearsShown) {
    const col = `${y}Y`;
    let dps = null, how = "";
    try {
      for (const [ry, f] of [[y + 2, "lwfr"], [y + 1, "frmtrm"], [y, "thstrm"]]) {
        if (ry > new Date().getFullYear()) continue;
        if (!L.latest(ry, "11011")) continue;
        const list = await dartAlot(corp, ry);
        const r = alotCommonDps(list);
        const v = r ? num(r[f]) : null;
        if (v != null) { dps = v; how = `DART 배당 ${ry} 사업보고서 ${f}`; break; }
      }
    } catch (e) { err(`DART 배당(alotMatter) ${y}`, e); continue; }
    const appDps = h.rows.find((r) => r.key === "dps")?.values[h.columns.findIndex((c) => c.label === col)] ?? null;
    if (dps === 0 && appDps == null) add("K5", "주당배당금 = DART", col, { status: PASS, note: "무배당(0) — 앱 빈칸" });
    else exact("K5", "주당배당금 = DART", col, appDps, dps, how);
    const k = caps.get(y);
    const appY = h.rows.find((r) => r.key === "divyield")?.values[h.columns.findIndex((c) => c.label === col)] ?? null;
    if (dps != null && dps > 0 && k?.close) {
      const exp = (dps / k.close) * 100;
      add("K5", "배당수익률 = DPS ÷ KRX 연말 종가", col, appY != null && Math.abs(appY - exp) <= Math.abs(exp) * 1e-9 ? { status: PASS } : { status: FAIL, note: `앱 ${appY} vs ${exp} (DPS ${dps} ÷ KRX ${k.date} 종가 ${k.close})` });
    }
  }
  // LTM DPS — 공공데이터 배당정보는 독립 원천이 없다. 앱이 최근 사업연도 값으로 대신했으면 주석에 있어야 하고 그 값이어야 한다
  {
    const i = h.columns.findIndex((c) => c.kind === "ltm");
    const appD = h.rows.find((r) => r.key === "dps")?.values[i] ?? null;
    const fb = /LTM.*주당배당금.*최근 사업연도|배당.*조회 실패/.test(notes);
    if (fb) {
      const ly = Math.max(...yearsShown);
      const fyD = h.rows.find((r) => r.key === "dps")?.values[h.columns.findIndex((c) => c.label === `${ly}Y`)] ?? null;
      add("K5", "LTM 주당배당금 = 최근 사업연도(주석 표시된 대체)", "LTM", same(appD, fyD));
    } else add("K5", "LTM 주당배당금(공공데이터 배당기준일 합)", "LTM", { status: NA, note: "독립 원천 없음 — 공공데이터포털 배당정보(앱 전용)" });
  }
}

/**
 * 보통주 주당 현금배당금 줄 — 주식 종류가 "보통…"인 줄. 없으면 주식 종류가 "-"·빈칸인 줄 중 값이 있는 줄이 하나뿐일 때 그 줄(051600·267260 2024~ 보고서는
 * 보통주 줄의 주식 종류를 "-"로 공시 — 우선주가 없는 회사)
 */
function alotCommonDps(list) {
  const rows = (list ?? []).filter((r) => /주당\s*현금배당금/.test(r.se ?? ""));
  const common = rows.find((r) => /보통/.test(r.stock_knd ?? ""));
  if (common) return common;
  const blank = rows.filter((r) => /^[-\s]*$/.test(r.stock_knd ?? "") && ["thstrm", "frmtrm", "lwfr"].some((f) => num(r[f]) != null));
  return blank.length === 1 && !rows.some((r) => /우선/.test(r.stock_knd ?? "")) ? blank[0] : null;
}

async function ltmLayer(c) {
  const { corp, L, lp, LT, exact, fail, add, consts, tt, policySrc, capCur, ltmPrefOk, evBlockWhy, rowHidden } = c;
  const { PASS } = consts;
  const fs = async (y, code) => {
    for (const d of ["CFS", "OFS"]) { const r = await dartFnltt(corp, y, code, d); if (r && r.length) return { rows: r, fsDiv: d }; }
    return null;
  };
  if (lp.code === "11011") {
    // 최신 정기보고서가 사업보고서 → LTM = 그 사업연도
    const label = tt?.ttm?.periodLabel ?? "";
    add("K4", "LTM 기준 = 최신 정기보고서", "LTM", /^FY\d{4}/.test(label) && !/\+/.test(label) && label.includes(String(lp.year)) ? { status: PASS, note: `${lp.nm} → ${label}` } : { status: "fail", note: `최신 정기보고서 ${lp.nm}(사업연도) 인데 앱 LTM ${label}` });
    const yr = `${lp.year}Y`;
    for (const k of ["revenue", "opinc"]) {
      const i = c.h.columns.findIndex((x) => x.kind === "ltm"), j = c.h.columns.findIndex((x) => x.label === yr);
      const r = c.h.rows.find((x) => x.key === k);
      exact("K4", `LTM ${k} = 사업연도(최신 정기보고서가 사업보고서)`, "LTM", r?.values[i] ?? null, r?.values[j] ?? null);
    }
    return;
  }
  const Y = lp.year, q = { "11013": 1, "11012": 2, "11014": 3 }[lp.code];
  const label = tt?.ttm?.periodLabel ?? "";
  const wantTok = `${Y} ${QNAME[q]}`;
  add("K4", "LTM 기준 = 최신 정기보고서", "LTM", label.includes(`+ ${wantTok}`) ? { status: PASS, note: `${lp.nm} (${lp.rcept}) → ${label}` } : { status: "fail", note: `최신 정기보고서 ${lp.nm}(${lp.rcept}) 인데 앱 LTM 라벨 "${label}" — 연간·이전 분기 대체` });
  const cur = await fs(Y, lp.code);
  if (!cur) { fail("K4", "LTM 분기 보고서 재무제표", "LTM", `${lp.nm} 재무제표(fnltt) 없음`); return; }
  const basis = cur.fsDiv;
  const rowsOf = async (y, code) => { const r = await dartFnltt(corp, y, code, basis); return r && r.length ? r : null; };
  const pick = (rows, it) => pickRow(rows, it[0], it[1]);

  // 분기 값(앱 규칙 문서와 같은 우선순위)
  const memo = new Map();
  const R = async (y, code) => { const k = `${y}|${code}`; if (!memo.has(k)) memo.set(k, await rowsOf(y, code)); return memo.get(k); };
  const ytd = async (y, qq, it) => {
    const rows = await R(y, qq === 4 ? "11011" : QCODE[qq]);
    if (!rows) return { v: null, why: `${y} ${qq === 4 ? "사업" : QNAME[qq]}보고서 없음` };
    return oneVal(pick(rows, it), (r) => num(r.thstrm_add_amount) ?? num(r.thstrm_amount));
  };
  const qval = async (y, qq, it) => {
    if (qq < 4) {
      const later = await R(y + 1, QCODE[qq]);
      if (later) {
        const o = oneVal(pick(later, it), (r) => (r.frmtrm_q_amount != null && num(r.frmtrm_add_amount) != null ? num(r.frmtrm_q_amount) : qq === 1 ? num(r.frmtrm_amount) : null));
        if (o.v != null) return { v: o.v, how: `${y + 1} ${QNAME[qq]} 보고서 전년 3개월` };
      }
      const own = await R(y, QCODE[qq]);
      if (own) {
        const o = oneVal(pick(own, it), (r) => (num(r.thstrm_add_amount) != null ? num(r.thstrm_amount) : qq === 1 ? num(r.thstrm_amount) : null));
        if (o.v != null) return { v: o.v, how: `${y} ${QNAME[qq]} 3개월` };
      }
      if (qq === 1) return { v: null, how: `${y} 1분기 값 없음` };
    }
    const a = await ytd(y, qq, it), b = await ytd(y, qq - 1, it);
    if (a.v == null || b.v == null) return { v: null, how: `${y} Q${qq} 누적 차 불가` };
    return { v: a.v - b.v, how: `${y} Q${qq} = 누적 차` };
  };
  const seq = [];
  for (let i = 3; i >= 0; i--) { const idx = Y * 4 + (q - 1) - i; seq.push([Math.floor(idx / 4), (idx % 4) + 1]); }
  const hi = c.h.columns.findIndex((x) => x.kind === "ltm");
  const hrow = (key) => c.h.rows.find((x) => x.key === key)?.values[hi] ?? null;
  for (const [key, it, label2] of [["revenue", IT.rev, "매출"], ["opinc", IT.op, "영업이익"], ["ni", IT.ni, "순이익(연결)"]]) {
    const parts = [];
    for (const [y, qq] of seq) parts.push(await qval(y, qq, it));
    const exp = parts.every((p) => p.v != null) ? parts.reduce((a, p) => a + p.v, 0) : null;
    exact("K4", `LTM ${label2} = DART 최근 4개 분기 합`, "LTM", key === "ni" ? LT.ni : hrow(key), exp, parts.map((p, i) => `${seq[i][0]}Q${seq[i][1]} ${p.v ?? "?"}(${p.how})`).join(" + "));
  }
  // EPS = 사업연도 + 당기 누적 − 전년 동기 누적(희석, 없으면 기본)
  {
    const annual = await R(Y - 1, "11011");
    // 전체 EPS(희석 → 기본), 전체 EPS 미공시면 계속영업 + 중단영업 주당이익(공시 두 값 — CLAUDE.md EPS 단일 기준)
    const epsOf = (rows, f) => {
      for (const it of [EPS_D, EPS_B]) { const o = oneVal(pick(rows ?? [], it), f); if (o.v != null) return o.v; }
      for (const k of ["Diluted", "Basic"]) {
        const c0 = oneVal(pick(rows ?? [], [[`ifrs-full_${k}EarningsLossPerShareFromContinuingOperations`], []]), f).v;
        if (c0 == null) continue;
        return c0 + (oneVal(pick(rows ?? [], [[`ifrs-full_${k}EarningsLossPerShareFromDiscontinuedOperations`], []]), f).v ?? 0);
      }
      return null;
    };
    const a = epsOf(annual, (r) => num(r.thstrm_amount));
    const cc = epsOf(cur.rows, (r) => num(r.thstrm_add_amount) ?? num(r.thstrm_amount));
    let pc = epsOf(cur.rows, (r) => num(r.frmtrm_add_amount) ?? num(r.frmtrm_amount));
    if (pc == null) pc = epsOf(await R(Y - 1, lp.code), (r) => num(r.thstrm_add_amount) ?? num(r.thstrm_amount));
    const exp = a != null && cc != null && pc != null ? a + cc - pc : null;
    const approxDisclosed = /EPS.*(환산|근사)/.test((c.h.notes ?? []).join(" ")) || /환산|근사/.test(JSON.stringify(tt?.ttm?.reasons?.eps ?? ""));
    if (exp == null && LT.eps != null && approxDisclosed) add("K4", "LTM EPS = DART 사업연도 + 누적 − 전년 누적", "LTM", { status: "unverifiable", note: `분기 EPS 공시 없음 — 앱 근사(주석 표시) ${LT.eps}` });
    else exact("K4", "LTM EPS = DART 사업연도 + 누적 − 전년 누적", "LTM", LT.eps, exp, `FY${Y - 1} ${a} + ${wantTok} 누적 ${cc} − 전년 ${pc}`);
  }
  // LTM 재무상태표(최신 분기말) — 총차입금·현금·비지배지분, EV
  const cl = classifyBsRows(cur.rows, cur.rows, { rows: await R(Y - 1, "11011"), col: "frmtrm_amount" });
  const faceDebt = sumCol(cl.debt, "thstrm_amount") ?? 0;
  let lease = { status: "face" };
  if (!cl.leaseFace.length) {
    // 최근 사업보고서 회계정책이 차입금 줄 포함이면 포함. 아니면 분기 보고서 원문 주석 표의 태그 칸(오너 결정 2026-10-05 — 분기 XBRL 엔 주석이 없지만 원문
    // 표 칸에 ACODE·ACONTEXT 가 달려 있다): 전기말 열이 최근 사업연도 주석 리스부채와 같은 묶음의 분기말 값
    const pol = policySrc.at(-1);
    if (pol?.status === "included") lease = { status: "included", how: pol.how };
    else if (pol?.status === "added" && pol.amount != null && pol.fy === Y - 1) {
      const reps = [];
      for (let qq = 1; qq <= q; qq++)
        for (const x of L.reports.filter((r) => r.year === Y && r.code === QCODE[qq]).sort((a, b) => b.rcept.localeCompare(a.rcept)))
          reps.push({ q: qq, rcept: x.rcept, cells: await dartDocLeaseCells(x.rcept) });
      const ql = quarterLeaseFromCells(reps, Y, q, pol.amount, basis);
      lease = ql.amount != null ? { status: "added", amount: ql.amount, how: ql.how } : { status: "unknown", how: `분기 보고서 주석 리스부채 확인 불가 — ${ql.how}` };
      // 단위 안전장치 — 분기말 리스부채 vs 최근 사업연도 주석 리스부채(100배 안)
      // 앱이 더한 분기말 리스부채(앱 LTM 총차입금 − 본표 차입금)
      const appQ = LT.debt != null ? LT.debt - faceDebt : null;
      if (appQ != null && appQ !== 0) {
        const r = Math.max(appQ, pol.amount) / Math.min(appQ, pol.amount);
        if (!(r > 0) || r > 100) fail("K2", "분기말 리스부채 크기 = 사업연도 주석과 100배 안(단위 안전장치)", "LTM", `앱 분기말 ${appQ} vs FY${Y - 1} ${pol.amount}`);
        else add("K2", "분기말 리스부채 크기 = 사업연도 주석과 100배 안(단위 안전장치)", "LTM", { status: PASS, note: `${r.toFixed(2)}배` });
      }
    } else lease = { status: "unknown", how: `FY${Y - 1} 주석 리스부채 ${pol?.status ?? "없음"} — 분기 보고서 전기말 열 확인 불가` };
  }
  const expDebt = faceDebt + (lease.status === "added" ? lease.amount : 0);
  exact("K2", "LTM 총차입금 = DART 최신 분기(B16)", "LTM", LT.debt, expDebt, `${lp.nm} ${basis}${lease.status !== "face" ? ` · 본표 리스부채 줄 없음 → ${lease.how}` : ""}`);
  exact("K2", "LTM 현금성자산 = DART 최신 분기(B16)", "LTM", LT.cash == null ? null : -LT.cash, sumCol(cl.cash, "thstrm_amount") ?? 0);
  exact("K2", "LTM 비지배지분 = DART 최신 분기", "LTM", LT.nci ?? (rowHidden("nci") ? 0 : null), sumCol(cl.nci, "thstrm_amount") ?? 0);
  const block = evBlockWhy ?? (lease.status === "unknown" ? "리스부채 확인 불가 — EV 공란이어야" : null) ?? (!capCur || capCur.common == null ? "KRX 현재 시가총액 없음" : null);
  if (block) { if (LT.ev != null) fail("K2", "LTM EV = KRX + DART(B16)", "LTM", `기대 공란(${block})인데 앱 EV ${LT.ev}`); else add("K2", "LTM EV = KRX + DART(B16)", "LTM", { status: PASS, note: `공란 — ${block}` }); }
  else exact("K2", "LTM EV = KRX + DART(B16)", "LTM", LT.ev, LT.mc == null || ltmPrefOk == null ? null : LT.mc + ltmPrefOk + expDebt + (sumCol(cl.nci, "thstrm_amount") ?? 0) - (sumCol(cl.cash, "thstrm_amount") ?? 0), "보통주 시가총액은 K1 에서 따로 대조");
}

/** 그해 값이 실린 가장 최근 보고서(손익·현금흐름 포함 — y+2 전전기 → y+1 전기 → y 당기) */
function bsOwnerAny(src, y) {
  for (const [L, by] of [[src.next2, y + 2], [src.next, y + 1], [src.cur, y]]) {
    const col = COL[by - y];
    if (L && L.some((r) => num(r[col]) != null)) return { rows: L, col, by };
  }
  return null;
}
const hasIs = (L, i) => !!L && L.some((r) => (r.sj_div === "IS" || r.sj_div === "CIS") && num(r[COL[i]]) != null);
/** DART 재무제표 현금흐름 감가상각 줄(검증기 판독 — 합계 줄, 없으면 유형·무형·사용권 세부 줄 합) */
function daCfLine(rows, col) {
  const cf = (rows ?? []).filter((r) => r.sj_div === "CF");
  const n0 = (r) => String(r.account_nm ?? "").replace(/\s/g, "");
  for (const id of ["ifrs-full_DepreciationAndAmortisationExpense", "ifrs-full_AdjustmentsForDepreciationAndAmortisationExpense", "dart_DepreciationAndAmortizationExpensePropertyPlantAndEquipment"]) {
    const r = cf.find((x) => x.account_id === id && num(x[col]) != null);
    if (r) return { v: num(r[col]), how: `DART 현금흐름 ${r.account_nm}(${id})` };
  }
  for (const nmx of ["감가상각비와무형자산상각비", "감가상각비", "유형자산감가상각비"]) {
    const r = cf.find((x) => n0(x) === nmx && num(x[col]) != null);
    if (r) return { v: num(r[col]), how: `DART 현금흐름 ${r.account_nm}` };
  }
  const parts = [["유형자산감가상각비", "유형자산의감가상각비", "감가상각비"], ["무형자산상각비", "무형자산의상각비"], ["사용권자산감가상각비"]]
    .map((g) => cf.find((x) => g.includes(n0(x)) && num(x[col]) != null)).filter(Boolean);
  return parts.length ? { v: parts.reduce((a, r) => a + num(r[col]), 0), how: `DART 현금흐름 ${parts.map((r) => r.account_nm).join("+")}` } : null;
}

// 감가상각 현금흐름 조정 태그(사업보고서 XBRL) — 검증기 판독
// 접두어는 ifrs-full·dart 둘 다(2022 접수 사업보고서는 dart:AdjustmentsForDepreciationExpense — 000500·015760·052690 2021 실측)
const DEP = ["AdjustmentsForDepreciationExpense"];
const AMO = ["AdjustmentsForAmortisationExpense"];
const DA = ["AdjustmentsForDepreciationAndAmortisationExpense"];
const EXTRA = ["AdjustmentsForDepreciationRightofuseAssets", "AdjustmentsForDepreciationInvestmentProperty"];
function xbrlDa(facts, prefix, basis) {
  const ok = (ctx) => {
    if (!(ctx === prefix || ctx.startsWith(prefix + "_"))) return false;
    const rest = ctx.slice(prefix.length).replace(/_?ifrs-full_ConsolidatedAndSeparateFinancialStatementsAxis_ifrs-full_(Consolidated|Separate)Member/, "").replace(/^_/, "");
    if (basis === "CFS" ? !/ConsolidatedMember/.test(ctx) : /ConsolidatedMember/.test(ctx)) return false;
    return rest === "" || rest === "ifrs-full_CarryingAmountAccumulatedDepreciationAmortisationAndImpairmentAndGrossCarryingAmountAxis_dart_ReportedAmountMember";
  };
  const get = (cs) => { for (const cpt of cs) { const vs = facts.filter(([k, ctx]) => (k === `ifrs-full:${cpt}` || k === `dart:${cpt}`) && ok(ctx)).map((f) => f[2]); if (vs.length) return vs.every((v) => v === vs[0]) ? vs[0] : NaN; } return null; };
  const d = get(DEP), a = get(AMO), da = get(DA);
  if ([d, a, da].some((v) => Number.isNaN(v))) return { v: null, how: "같은 태그 값이 여럿(판독 불가)" };
  if (d != null) {
    const ex = EXTRA.map((cpt) => get([cpt]));
    if (ex.some((v) => Number.isNaN(v))) return { v: null, how: "사용권·투자부동산 태그 값이 여럿" };
    return { v: d + ex.reduce((s, v) => s + (v ?? 0), 0) + (a ?? 0), how: `XBRL 감가 ${d}${ex.some((v) => v != null) ? ` + 사용권·투자부동산 ${ex.map((v) => v ?? 0).join("+")}` : ""} + 무형 ${a ?? 0}` };
  }
  if (da != null) return { v: da, how: `XBRL 감가·무형 합계 ${da}` };
  return { v: null, how: "XBRL 현금흐름 감가상각 태그 없음" };
}

async function daLayer(c) {
  const { sym, env, IS, H, exact, fail, add, consts, yearSrc, yearsShown, caps, L, h } = c;
  const { PASS, NA } = consts;
  const col = await daCol(env);
  const doc = await col.findOne({ _id: sym });
  if (!doc) { fail("K3", "감가상각 적재본(kr_da) 존재", "-", `유니버스 종목인데 ${env.KR_DA_COLLECTION || "kr_da"} 에 문서 없음`); return; }
  // 단위 안전장치 — 적재 감가상각(원문 해 포함, 전 해)의 이웃 해 크기 대조 + TTM vs 최근 사업연도
  const daBy = new Map(Object.entries(doc.byYear ?? {}).map(([y, d]) => [Number(y), (d.depreciation ?? 0) + (d.amortisation ?? 0)]).filter(([, v]) => v > 0));
  unitGuard(daBy, "K3", "감가상각 적재본 크기 = 이웃 해와 100배 안(단위 안전장치)", add, fail, PASS);
  if (doc.ttmDepreciation != null && daBy.size) {
    const fy = Math.max(...daBy.keys()), t = doc.ttmDepreciation + (doc.ttmAmortisation ?? 0), r = Math.max(t, daBy.get(fy)) / Math.min(t, daBy.get(fy));
    if (!(t > 0) || r > 100) fail("K3", "감가상각 TTM 크기 = 최근 사업연도와 100배 안(단위 안전장치)", "LTM", `TTM ${t} vs FY${fy} ${daBy.get(fy)}`);
    else add("K3", "감가상각 TTM 크기 = 최근 사업연도와 100배 안(단위 안전장치)", "LTM", { status: PASS, note: `${r.toFixed(2)}배` });
  }
  for (const y of yearsShown) {
    const colY = `${y}Y`;
    const d = doc.byYear?.[y];
    const app = IS[colY]?.da ?? null;
    const src = yearSrc.get(y);
    if (d && (d.depreciation != null || d.amortisation != null)) {
      const v = (d.depreciation ?? 0) + (d.amortisation ?? 0);
      const s = String(d.src ?? "");
      // 출처 기준(연결·별도) = 그해 재무제표 기준
      if (src) {
        const sep = /별도/.test(s);
        if (sep !== (src.fsDiv === "OFS")) fail("K3", "감가상각 출처 기준 = 재무제표 기준(연결·별도)", colY, `재무제표 ${src.fsDiv === "OFS" ? "별도" : "연결"} · 감가상각 출처 "${s}"`);
        else add("K3", "감가상각 출처 기준 = 재무제표 기준(연결·별도)", colY, { status: PASS, note: `${src.fsDiv} · ${s}` });
      }
      // XBRL 해(출처가 XBRL 현금흐름 조정 태그뿐)는 검증기가 사업보고서 XBRL 을 따로 읽어 재현
      let note = `적재 출처 ${s}`;
      if (/^xbrl(\(별도\))?$/.test(s)) {
        const r0 = L.latest(y, "11011"), r1 = L.latest(y + 1, "11011");
        let got = null;
        for (const [rp, pre] of [[r1, `PFY${y}dFY`], [r0, `CFY${y}dFY`]]) {
          if (!rp) continue;
          const x = xbrlDa(await dartXbrlFacts(rp.rcept, "11011"), pre, src?.fsDiv ?? "CFS");
          if (x.v != null) { got = { ...x, rcept: rp.rcept }; break; }
        }
        if (!got) fail("K3", "감가상각 적재본 = 사업보고서 XBRL(검증기 판독)", colY, `적재 ${v} — 검증기가 XBRL 에서 못 읽음`);
        else if (got.v !== v) fail("K3", "감가상각 적재본 = 사업보고서 XBRL(검증기 판독)", colY, `적재 ${v} vs XBRL ${got.v}(${got.how}, ${got.rcept})`);
        else add("K3", "감가상각 적재본 = 사업보고서 XBRL(검증기 판독)", colY, { status: PASS, note: `${got.how} (${got.rcept})` });
      } else note += " — 검증기 독립 재현 불가(원문 표·영업비용 기준 판독은 적재 스크립트만) · 적재 값 대조만";
      exact("K3", "감가상각비 = 적재본(kr_da)", colY, app, v, note);
      const op = IS[colY]?.op ?? null, eb = IS[colY]?.ebitda ?? null;
      if (op != null) exact("K3", "EBITDA = 영업이익 + 감가상각(적재본)", colY, eb, op + v);
    } else {
      // 적재본에 없는 해 — 앱 규칙(오너 결정 2026-10-02 "가"): DART 공시 현금흐름 감가상각 줄, 없으면 빈칸. 검증기가 DART 줄을 따로 읽어 대조.
      // 빈칸 허용: 상장 전(KRX 연말 종목 없음) · 연결 재작성 해(그해·이듬해 사업보고서엔 연결 손익이 없고 다다음 해 보고서 전전기 열에만 —
      // 연결 기준 주석 원자료가 없다, 060370 2022)
      const k = caps.get(y);
      const pre = !k || k.common == null;
      const own = src ? bsOwnerAny(src, y) : null;
      const cfLine = own ? daCfLine(own.rows, own.col) : null;
      const restated = src?.fsDiv === "CFS" && !hasIs(src.cur, 0) && !hasIs(src.next, 1) && hasIs(src.next2, 2);
      if (cfLine != null) exact("K3", "감가상각비 = DART 공시 현금흐름 줄(적재본 없는 해)", colY, app, cfLine.v, `${cfLine.how} · 기준 보고서 ${own.by}`);
      else if (app == null) add("K3", "감가상각비 = 적재본(kr_da)", colY, pre ? { status: PASS, note: "적재본·공시 줄 없음 · 상장 전 해(KRX 연말 종목 없음) — 빈칸" } : restated ? { status: PASS, note: "적재본·공시 줄 없음 · 연결 재작성 해(연결 손익은 다다음 해 보고서 전전기 열뿐) — 빈칸" } : { status: "fail", note: `적재본에 ${y} 없음 · 공시 줄 없음 · 상장 후 해인데 빈칸(적재 누락)` });
      else fail("K3", "감가상각비 = 적재본(kr_da)", colY, `적재본·DART 공시 현금흐름 줄 모두 없는데 앱 ${app}`);
    }
  }
  // LTM — 손익 TTM 과 같은 구성의 감가상각 TTM 만
  const LT = H.LTM;
  if (LT) {
    const hi = h.columns.findIndex((x) => x.kind === "ltm");
    const op = h.rows.find((x) => x.key === "opinc")?.values[hi] ?? null;
    const tok = (s) => s?.match(/FY(\d{4})\s*\+\s*(\d{4})\s*(1분기|반기|3분기)/)?.slice(1).join("|") ?? null;
    const lp = L.latestPeriod();
    const wantTok = lp && lp.code !== "11011" ? `${lp.year - 1}|${lp.year}|${QNAME[{ "11013": 1, "11012": 2, "11014": 3 }[lp.code]]}` : null;
    if (wantTok && doc.ttmDepreciation != null && tok(doc.ttmLabel) === wantTok) {
      const v = doc.ttmDepreciation + (doc.ttmAmortisation ?? 0);
      if (op != null) exact("K3", "LTM EBITDA = LTM 영업이익 + 감가상각 TTM(적재본)", "LTM", LT.ebitda, op + v, `적재 ${doc.ttmLabel}`);
    } else if (wantTok) add("K3", "LTM 감가상각 TTM 적재", "LTM", LT.ebitda == null ? { status: NA, note: `적재 TTM ${doc.ttmLabel ?? "없음"} ≠ 최신 ${wantTok} — 앱 LTM EBITDA 빈칸(규칙)` } : { status: "fail", note: `적재 TTM ${doc.ttmLabel ?? "없음"} ≠ 최신 ${wantTok} 인데 앱 LTM EBITDA ${LT.ebitda}` });
  }
}

/** 단위 안전장치 — 해 → 값 지도에서 이웃 해(바로 앞 해)와 100배 넘게 다르면 실패(1000배 단위 오류를 태그·단위 표기와 무관하게 잡는다) */
function unitGuard(byYear, layer, name, add, fail, PASS) {
  const ys = [...byYear.keys()].sort((a, b) => a - b);
  for (let i = 1; i < ys.length; i++) {
    const a = byYear.get(ys[i - 1]), b = byYear.get(ys[i]);
    if (!(a > 0) || !(b > 0) || ys[i] - ys[i - 1] !== 1) continue;
    const r = Math.max(a, b) / Math.min(a, b);
    if (r > 100) fail(layer, name, `${ys[i]}Y`, `FY${ys[i - 1]} ${a} vs FY${ys[i]} ${b} (${r.toFixed(0)}배) — 단위 오류 의심`);
    else add(layer, name, `${ys[i]}Y`, { status: PASS, note: `FY${ys[i - 1]} 대비 ${r.toFixed(2)}배` });
  }
}
