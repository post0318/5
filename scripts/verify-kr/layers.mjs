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
import { dartList, dartFnltt, dartAlot, dartXbrlFacts, dartXbrlCum, dartDocLeaseCells, dartDocDaTables, dartCompany } from "./dart.mjs";
import { daCandidates, invTableDep } from "./docda.mjs";
import { dataGoDividends } from "./datago.mjs";
import { krxCapsOn } from "./krx.mjs";
import { emptyKind } from "./calendar.mjs";
import { classifyBsRows, sumCol, leaseNoteFor, quarterLeaseFromCells, leaseFromFacts } from "./b16.mjs";

const COL = ["thstrm_amount", "frmtrm_amount", "bfefrmtrm_amount"];
const num = (x) => { const t = String(x ?? "").trim(); return t === "" || t === "-" ? null : Number(t.replace(/,/g, "")); };
const nm = (s) => String(s ?? "").replace(/\s|\(.*?\)/g, "");
/**
 * 금융 자회사 연결 판정(감사 2차 ⑧ — 예전엔 앱과 같은 손목록이었다). DART 연결 재무상태표 원자료 규칙: 이름에 "금융업"이 든 자산 줄(현대차
 * "금융업채권" 유동·비유동 — 할부금융 자회사 자산)의 합이 자산총계의 10% 이상이면 금융 자회사 연결. 앱 목록(dart-ev.ts KR_CAPTIVE)을 읽지 않는다
 */
function captiveOf(rows, col) {
  const bs = (rows ?? []).filter((r) => r.sj_div === "BS");
  const assets = bs.find((r) => r.account_id === "ifrs-full_Assets");
  const tot = assets ? num(assets[col]) : null;
  const fin = bs.filter((r) => /금융업/.test(nm(r.account_nm)) && !/부채|차입|사채/.test(nm(r.account_nm)));
  const sum = fin.reduce((a, r) => a + (num(r[col]) ?? 0), 0);
  return tot && sum / tot >= 0.1 ? `금융업 자산 줄 ${fin.map((r) => nm(r.account_nm)).join("·")} 합 ${sum} = 자산총계의 ${((sum / tot) * 100).toFixed(1)}%` : null;
}
/** 지배주주 자본(PBR 분모) — 지배기업 소유주지분 줄, 없고 비지배지분 줄도 없으면(별도·비지배 없음) 자본총계 */
function parentEquity(rows, col) {
  const p = oneVal(pickRow(rows, ["ifrs-full_EquityAttributableToOwnersOfParent"], ["지배기업의소유주에게귀속되는자본", "지배기업소유주지분", "지배기업의소유주지분", "지배주주지분"], ["BS"]), (r) => num(r[col]));
  if (p.v != null) return { v: p.v, how: "DART 지배기업 소유주지분" };
  const nci = pickRow(rows, ["ifrs-full_NoncontrollingInterests"], ["비지배지분"], ["BS"]).some((r) => num(r[col]));
  const t = oneVal(pickRow(rows, ["ifrs-full_Equity"], ["자본총계"], ["BS"]), (r) => num(r[col]));
  return t.v != null && !nci ? { v: t.v, how: "DART 자본총계(비지배지분 없음)" } : null;
}
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
const EPS_D = [["ifrs-full_DilutedEarningsLossPerShare"], ["희석주당이익", "희석주당순이익", "보통주희석주당이익", "희석주당이익손실", "보통주기본및희석주당이익", "보통주기본및희석주당순이익", "기본및희석주당이익"]];
const EPS_B = [["ifrs-full_BasicEarningsLossPerShare"], ["기본주당이익", "기본주당순이익", "보통주기본주당이익", "기본주당이익손실", "기본및희석주당이익", "보통주기본및희석주당이익", "보통주기본및희석주당순이익"]];
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
  const { PASS, FAIL, NA, COMMON } = ctx.consts;
  // 이번 종목에서 남긴 검사 기록(층·열·상태) — 뒤 검사가 앞 검사의 공통모드를 물려받는 데 쓴다(감사 9차 ④). 하위 함수도 ...ctx 로 같은 add 를 쓴다
  const added = [];
  const add0 = ctx.add;
  ctx.add = (layer, name, col, r) => { added.push({ layer, name, col, status: r?.status }); return add0(layer, name, col, r); };
  const { sym, corp, h, H, add, hardErrors, dartYearSource, same } = ctx;
  const fail = (layer, name, col, note) => add(layer, name, col, { status: FAIL, note });
  const err = (what, e) => { const m = `${what}: ${String(e?.message ?? e).slice(0, 120)}`; hardErrors.push(m); add("응답", what, "-", { status: FAIL, note: m }); };
  /** 정확 일치(정수) — 원자료 있고 앱 빈칸·앱만 있고 원자료 빈칸 모두 실패. common = 기대치가 독립 판독이 아니면(적재본 등) 그 사유 — 통과를 공통모드로 */
  const cmp = (app, src, why = "", common = null) => {
    if (src == null && app == null) return { status: NA, note: `양쪽 빈칸${why ? ` · ${why}` : ""}` };
    if (src == null) return { status: FAIL, note: `원자료 없음인데 앱 값 ${app}${why ? ` · ${why}` : ""}` };
    if (app == null) return { status: FAIL, note: `원자료 ${src} 있는데 앱 빈칸${why ? ` · ${why}` : ""}` };
    const ok = Number.isInteger(src) && Number.isInteger(app) ? app === src : Math.abs(app - src) <= Math.abs(src) * 1e-9;
    if (!ok) return { status: FAIL, app, src, note: `앱 ${app} vs 원자료 ${src} (차 ${app - src})${why ? ` · ${why}` : ""}` };
    return common ? { status: COMMON, app, src, note: `${why ? `${why} · ` : ""}공통모드 — ${common}` } : { status: PASS, app, src, ...(why ? { note: why } : {}) };
  };
  const exact = (layer, name, col, app, src, why = "", common = null) => add(layer, name, col, cmp(app, src, why, common));
  /**
   * PER·PBR·PSR 값 대조(감사 4·5차 — 유무만 보면 모든 화면이 같은 틀린 배수일 때 통과: 005930 PBR 2024 분모 자본총계, PSR LTM 매출 1분기 누락,
   * 373220 PER 2023 ×1.01). 정의(앱 dart-highlights.ts 와 같은 정의, 값은 검증기가 따로): PER = 주가 ÷ EPS(희석), PBR = 보통주 시가총액 ÷ 지배주주 자본,
   * PSR = 보통주 시가총액 ÷ 매출. 분자는 K1 에서 KRX(·Yahoo 게시 전 규칙)로 확인된 값, 분모는 DART 원자료(앱 값 아님). 분모 > 0 이면 값이 있고
   * 같아야, ≤ 0 이면 빈칸(부호 규칙). 정확 일치(감사 5차 — 허용치 없음): 서버는 원값을 보내고 화면이 소수 2자리 버림을 하므로 원값을 비교한다.
   * 분자(정수 시가총액·종가)와 분모(정수 원·원/주)가 같으면 나눗셈 한 번이라 비트 단위로 같다. 화면 표시값(버림)도 메모에 남긴다.
   * 분자·분모를 못 정하면 검증불가(이유 기록 — 조용히 건너뛰지 않음)
   */
  const trunc2 = (v) => (v == null ? null : Math.trunc(Math.round(v * 1e6) / 1e4) / 100);
  /** 배수 분자·분모(검증기 기대치) — 개요 화면 대조(overviewLayer)가 다시 쓴다 */
  const multDen = {};
  const multExpect = (col, x, d) => {
    multDen[col] = d;
    for (const [key, label, n, den, nn, dn] of [["per", "PER", d.price, d.eps, "주가", "EPS"], ["pbr", "PBR", d.mc, d.eq, "보통주 시가총액", "지배주주 자본"], ["psr", "PSR", d.mc, d.rev, "보통주 시가총액", "매출"]]) {
      const v = x[key] ?? null;
      if (den?.v == null || n == null) {
        add("D", `${label} = ${nn}(K1 확인) ÷ DART ${dn}`, col, { status: NA, app: v, note: `${n == null ? `${nn} 확인 불가` : ""}${n == null && den?.v == null ? " · " : ""}${den?.v == null ? `DART ${dn} 판독 불가(${den?.how ?? "보고서 없음"})` : ""} — 앱 ${v ?? "빈칸"}` });
        continue;
      }
      if (den.v > 0) {
        const e = n / den.v;
        const nm1 = `${label} = ${nn}(K1 확인) ÷ DART ${dn}`;
        if (v == null) fail("D", nm1, col, `${nn} ${n} ÷ ${den.how} ${den.v} = ${e} 인데 ${label} 빈칸`);
        else if (v !== e) fail("D", nm1, col, `앱 ${v}(화면 ${trunc2(v)}) vs ${e}(화면 ${trunc2(e)}) — 차 ${v - e} (${nn} ${n} ÷ ${den.how} ${den.v})`);
        else add("D", nm1, col, { status: PASS, app: v, src: e, note: `${n} ÷ ${den.how} ${den.v} · 화면 ${trunc2(v)}` });
      } else add("D", `${label} 부호 규칙(DART ${dn} ≤ 0 → 빈칸)`, col, v == null ? { status: PASS, note: `${den.how} ${den.v}` } : { status: FAIL, note: `${den.how} ${den.v} ≤ 0 인데 ${label} ${v}` });
    }
  };
  /** K5 기대치(개요 DPS·DPS(TTM) 대조용) */
  const k5Exp = {};
  /**
   * 배당수익률 기대치(감사 6차 ② — DPS 0·DPS 없음·상장 전이면 검사가 통째로 빠졌다). d = 기대 DPS(0 = 무배당, null = 배당 공시 없음),
   * px = { v, how } 기준 주가 · { pre: true } 상장 전(주가 없음) · null 주가 확인 불가. 앱 식 = DPS ÷ 주가 × 100(dart-highlights.ts)
   */
  const yieldCheck = (col, name, appY, d, px, how) => {
    if (px?.pre) add("K5", `${name}(상장 전 — 빈칸 기대)`, col, appY == null ? { status: PASS, note: "KRX 연말 종목 없음 — 빈칸" } : { status: FAIL, app: appY, note: `상장 전인데 배당수익률 ${appY}` });
    else if (d == null) add("K5", `${name}(DPS 없음 — 빈칸 기대)`, col, appY == null ? { status: PASS, note: `DPS 원자료 없음(${how || "배당 공시 없음"}) — 빈칸` } : { status: FAIL, app: appY, note: `DPS 원자료 없음(${how || "배당 공시 없음"})인데 배당수익률 ${appY}` });
    else if (!px) add("K5", name, col, { status: NA, app: appY, note: "주가 확인 불가(K1 시가총액 미확인)" });
    else {
      const e = (d / px.v) * 100;
      add("K5", name, col, appY === e ? { status: PASS, app: appY, src: e, note: `${d} ÷ ${px.how} ${px.v}` } : { status: FAIL, app: appY, src: e, note: `앱 ${appY ?? "빈칸"} vs ${e} (DPS ${d} ÷ ${px.how} ${px.v})` });
    }
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
  const captive = latestFyBs ? captiveOf(latestFyBs.rows, latestFyBs.col) : null;
  const evBlockWhy = fin ? "금융업(검증기 판정 — 예수부채·보험계약부채 등 줄)" : captive ? `금융 자회사 연결(검증기 판정 — ${captive})` : null;
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
    if (!k || k.common == null) {
      exact("K1", "시가총액(보통주) = KRX 연말", col, x.mc, null, "KRX 에 그해 말 종목 없음(상장 전)");
      // 상장 전 해 — 주가·시가총액이 없으니 배수도 빈칸이어야(감사 5차 — 이 열 배수가 검사 없이 빠지지 않게)
      for (const [key, label] of [["per", "PER"], ["pbr", "PBR"], ["psr", "PSR"]])
        add("D", `${label} 기대 빈칸(상장 전 — KRX 연말 종목 없음)`, col, x[key] == null ? { status: PASS, note: "KRX 연말 종목 없음 — 빈칸" } : { status: FAIL, note: `KRX 연말 종목 없음(상장 전)인데 ${label} ${x[key]}` });
      continue;
    }
    exact("K1", "시가총액(보통주) = KRX 연말", col, x.mc, k.common, `KRX ${k.date}`);
    const appPref = x.pref ?? (rowHidden("pref_mcap") ? 0 : null);
    exact("K1", "우선주 시가총액 = KRX 연말", col, appPref, k.preferred, `KRX ${k.date}${k.prefIssues.length ? ` ${k.prefIssues.join("·")}` : " 우선주 없음"}`);
    // PER·PBR·PSR 값(감사 4차 ③·5차): K1 시가총액이 KRX 와 같으면 KRX 연말 시가총액·종가 ÷ DART 분모(그해를 담은 가장 최근 보고서 — 앱 연간 로더와 같은 기준)
    const src = yearSrc.get(y);
    if (x.mc === k.common && src) {
      const bo = bsOwner(src, y);
      const io = [[src.next2, 2], [src.next, 1], [src.cur, 0]].find(([R, i]) => hasIs(R, i));
      const f = io ? (r) => num(r[COL[io[1]]]) : null;
      multExpect(col, x, {
        mc: k.common, price: k.close ?? null,
        eq: bo ? parentEquity(bo.rows, bo.col) : null,
        rev: io ? { ...oneVal(pickRow(io[0], IT.rev[0], IT.rev[1]), f), how: `DART 매출(${y + io[1]} 보고서)` } : null,
        // EPS = A층이 DART 에서 직접 읽은 희석 EPS(미공시면 기본 — 앱 값 아님). layers 의 간이 판독은 "기본 및 희석주당이익" 같은 이름을 놓쳤다(009150 2021)
        eps: ctx.dartVint?.[`${col}|희석 EPS`] ? { v: ctx.dartVint[`${col}|희석 EPS`].latest ?? null, how: "DART EPS(A층 판독 — 그해를 담은 가장 최근 보고서)" } : { v: null, how: "A층 DART EPS 판독 없음" },
      });
    }
  }
  let ltmPrefOk = null; // LTM EV 기대치에 쓸 우선주 시가총액(K1 에서 확인된 값)
  let ltmPrefPending = false; // 우선주를 못 확인한 사유가 KRX 게시 전(재실행하면 풀림)인지 — 아니면 K1 실패·KRX 조회 실패(감사 3차 ⑤)
  let ltmPrice = null; // LTM 배당수익률 기대치에 쓸 현재가(K1 보통주 시가총액이 확인된 종가)
  // LTM 열은 DART 정기공시가 있으면 반드시 있어야 한다(감사 2차 ① — 열이 없으면 LTM 검사가 조용히 사라졌다)
  if (!H.LTM && L.latestPeriod()) fail("K1", "LTM 열 존재(하이라이트)", "LTM", `DART 정기공시 ${L.latestPeriod().nm} 이 있는데 하이라이트 LTM 열 없음`);
  if (H.LTM && capCur && capCur.common != null) {
    // KRX 가 거래일 D 자료를 공식 게시일(다음 거래일) 전에 내보낸 경우(2026-10-10 실측 — 10-08 자료가 연휴 중 검증기에는 왔고 앱 요청에는 빈 응답) —
    // 앱은 D 를 게시 전으로 보고 직전 거래일 값을 쓴다. 그 직전 거래일 KRX 값도 기대치로 둔다(D 가 게시 대기 기간일 때만)
    let early = null;
    if ((await emptyKind(capCur.date)) === "pending") {
      const d0 = new Date(Date.UTC(+capCur.date.slice(0, 4), +capCur.date.slice(4, 6) - 1, +capCur.date.slice(6, 8) - 1));
      try { const kp = await krxCapsOn(sym, d0.toISOString().slice(0, 10).replace(/-/g, "")); if (kp?.common != null) early = kp; } catch (e) { err("KRX 직전 거래일(게시 대기 기간)", e); }
    }
    const appPref = H.LTM.pref ?? (rowHidden("pref_mcap") ? 0 : null);
    // 검증기가 건너뛴 게시 전 거래일(그 거래일~다음 거래일 KST) — 앱은 그 날 자료를 이미 받았을 수 있다. 다음 거래일도 지난 거래일의 빈 응답은 krx.mjs 가 조회 실패로 던진다
    const gap = capCur.pendingDays?.length ? capCur.pendingDays.join("·") : null;
    if (appPref === capCur.preferred) { add("K1", "우선주 시가총액 = KRX 최근 거래일", "LTM", { status: PASS, app: appPref, src: capCur.preferred, note: `KRX ${capCur.date}` }); ltmPrefOk = appPref; }
    else if (early && appPref === early.preferred && H.LTM.mc === early.common) { add("K1", "우선주 시가총액 = KRX 최근 거래일", "LTM", { status: PASS, app: appPref, src: early.preferred, note: `KRX ${capCur.date} 는 게시 대기 기간(다음 거래일 전) — 앱 = 직전 거래일 KRX ${early.date}` }); ltmPrefOk = appPref; }
    else if (gap && appPref != null && !(appPref === 0 && capCur.preferred > 0)) {
      // 게시 전 거래일을 건너뛴 경우 — 앱 기준일이 그 날일 수 있다. 앱 값을 믿지 않고 우선주마다 Yahoo 종가(게시 전 날) × KRX 상장주식수(최근
      // 게시일)로 따로 확인(보통주와 같은 방식, 감사 2차 ③). 확인 못 하면 검증불가 — LTM EV 도 검증불가(통과로 세지 않음)
      // 앱 기준일은 게시 전 거래일 중 하나(앱이 그 날 KRX 자료를 받았거나 Yahoo 종가로 계산) 또는 오늘 — 후보 날짜마다 기대치를 만들고 앱이 그중
      // 하나와 정확히 같아야 한다(가장 늦은 봉 하나만 보면 장중 봉이 끼어 거짓 실패가 났다)
      let exps = null, why = null;
      try {
        const days = new Set([...capCur.pendingDays]);
        const per = [];
        for (const [code, sh] of capCur.prefShares ?? []) {
          if (sh == null) throw new Error(`${code} KRX 상장주식수 없음`);
          const bars = (await ctx.yahooBars(code)).filter((b) => b.date.replace(/-/g, "") > capCur.date && b.close != null);
          for (const b of bars) days.add(b.date.replace(/-/g, ""));
          per.push({ code, sh, bars });
        }
        exps = [];
        for (const dd of days) {
          let v = 0, how = "";
          for (const p of per) {
            const b = p.bars.find((x) => x.date.replace(/-/g, "") === dd);
            if (!b) { v = null; break; }
            v += b.close * p.sh;
            how += `${p.code} Yahoo ${b.date} ${b.close} × KRX 상장주식수 ${p.sh} `;
          }
          if (v != null) exps.push({ v, how: how.trim() || `${dd} 우선주 없음` });
        }
        if (!exps.length) { why = "게시 전 날의 Yahoo 우선주 종가 없음"; exps = null; }
      } catch (e) { exps = null; why = `Yahoo 일봉 조회 실패 — ${String(e?.message ?? e).slice(0, 80)}`; }
      if (exps) {
        const hit = exps.find((x) => x.v === appPref);
        if (hit) { add("K1", "우선주 시가총액 = KRX 최근 거래일(게시 전 — Yahoo 종가 × KRX 주식수)", "LTM", { status: PASS, app: appPref, src: hit.v, note: `KRX ${gap} 게시 전 · ${hit.how}` }); ltmPrefOk = appPref; }
        else fail("K1", "우선주 시가총액 = KRX 최근 거래일(게시 전 — Yahoo 종가 × KRX 주식수)", "LTM", `앱 ${appPref} — 게시 전 날 후보 ${exps.map((x) => `${x.v}(${x.how})`).join(" / ")} 어느 것과도 다름`);
      } else { add("K1", "우선주 시가총액 = KRX 최근 거래일", "LTM", { status: NA, app: appPref, src: capCur.preferred, note: `KRX ${gap} 게시 전 — 우선주 독립 확인 불가(${why}) — 재실행 필요` }); ltmPrefPending = true; }
    } else exact("K1", "우선주 시가총액 = KRX 최근 거래일", "LTM", appPref, capCur.preferred, `KRX ${capCur.date}`);
    if (H.LTM.mc === capCur.common) { add("K1", "시가총액(보통주) = KRX 최근 거래일", "LTM", { status: PASS, note: `KRX ${capCur.date}` }); ltmPrice = capCur.close; }
    else if (early && H.LTM.mc === early.common) { add("K1", "시가총액(보통주) = KRX 최근 거래일", "LTM", { status: PASS, note: `KRX ${capCur.date} 는 게시 대기 기간 — 앱 = 직전 거래일 KRX ${early.date}` }); ltmPrice = early.close; }
    else {
      // 앱 시세 규칙(quote/index.ts): KRX 일별 자료가 아직 안 나온 날은 Yahoo 종가 × KRX 상장주식수 — 검증기가 Yahoo 종가를 따로 받아 확인
      let why = null;
      try {
        const y = await ctx.yahooBars(sym);
        // KRX 기준일 뒤 Yahoo 봉 중 하나(게시 전 거래일·오늘) — 가장 늦은 봉만 보면 장중 봉이 끼어 거짓 실패
        const later = y.filter((b) => b.date.replace(/-/g, "") > capCur.date && b.close != null).find((b) => capCur.shares != null && H.LTM.mc === b.close * capCur.shares);
        if (later) { why = `KRX ${capCur.date} 뒤 Yahoo ${later.date} 종가 ${later.close} × KRX 상장주식수 ${capCur.shares}(앱 시세 규칙)`; ltmPrice = later.close; }
      } catch (e) { err("Yahoo 일봉(현재 시가총액 확인)", e); }
      if (why) add("K1", "시가총액(보통주) = KRX 최근 거래일", "LTM", { status: PASS, note: why });
      else fail("K1", "시가총액(보통주) = KRX 최근 거래일", "LTM", `앱 ${H.LTM.mc} vs KRX ${capCur.date} ${capCur.common}`);
    }
  } else if (H.LTM && capCur) {
    // KRX 최근 거래일 자료에 이 종목이 없음(감사 6차 ⑥ — 예전엔 LTM 시가총액·배수 검사가 기록 없이 빠졌다). 상장폐지·거래정지 등 — 검증기가 정할 수 없어 검증불가
    add("K1", "시가총액(보통주) = KRX 최근 거래일", "LTM", { status: NA, app: H.LTM.mc, note: `KRX ${capCur.date} 전종목 자료에 ${sym} 없음 — 현재 시가총액·LTM 배수·배당수익률 기대치 없음` });
  }

  // ── K2 EV 구성요소(사업연도) ──
  const policySrc = []; // LTM 판정에 쓸 최근 사업연도 리스 판정
  const leaseByYear = new Map(); // 단위 안전장치용 — 앱이 주석에서 더한 리스부채(사업연도)
  // 단위 오류 보고서 — 사업보고서 R(y) 의 리스부채 주석이 앞뒤 보고서 모두와 같은 해 값이 정확히 1000^k 배로 갈리면 그 보고서 리스부채는 쓰지 않는다
  // (079550 2024 보고서: 천원 숫자를 decimals="0" KRW 로 — 44,977,895·49,524,406 vs 앞뒤 보고서 ×1000). 규칙 문장만 보고 따로 짠 판정
  const badLease = new Map();
  // 주석 리스부채를 쓰는 회사(표시 연도 중 본표에 리스부채 줄이 없는 해가 있음)만 — 나머지는 사업보고서 XBRL 을 받지 않는다(012450·402340 최신 판본엔 XBRL 이 없다, DART 014)
  const needLease = yearsShown.some((y) => { const s0 = yearSrc.get(y), o = s0 ? bsOwner(s0, y) : null; return o && !classifyBsRows(o.rows).leaseFace.length; });
  if (needLease) try {
    const amt = async (ry, pre, y) => { const r = L.latest(ry, "11011"); return r ? leaseFromFacts(await dartXbrlFacts(r.rcept, "11011"), pre, yearSrc.get(y)?.fsDiv ?? "CFS").amount : null; };
    const off = (a, b) => a > 0 && b > 0 && [1e3, 1e6, 1e9].includes(Math.max(a, b) / Math.min(a, b));
    for (const ry of new Set(yearsShown.flatMap((y) => [y, y + 1]))) {
      const r = L.latest(ry, "11011");
      if (!r) continue;
      const left = off(await amt(ry, `PFY${ry - 1}eFY`, ry - 1), await amt(ry - 1, `CFY${ry - 1}eFY`, ry - 1));
      const right = off(await amt(ry, `CFY${ry}eFY`, ry), await amt(ry + 1, `PFY${ry}eFY`, ry));
      if (left && right) badLease.set(r.rcept, `FY${ry} 사업보고서 리스부채가 앞뒤 보고서와 1000^k 배`);
    }
  } catch (e) { err("리스부채 단위 대조(사업보고서 XBRL)", e); }
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
        lease = await leaseNoteFor([r0 && { rcept: r0.rcept, all: all(y), prefix: `CFY${y}eFY`, fy: y }, r1 && { rcept: r1.rcept, all: all(y + 1), prefix: `PFY${y}eFY`, fy: y + 1 }], src.fsDiv, namesOf, badLease);
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
    // 금융업·금융 자회사 판정은 해마다 그해 재무상태표로(감사 3차 ⑥ — 예전엔 최근 사업연도 판정을 전 연도에 썼다). LTM 은 최신 판정(evBlockWhy)
    const capY = captiveOf(own.rows, own.col);
    const evBlockY = cl.financial ? "금융업(검증기 판정 — 그해 예수부채·보험계약부채 등 줄)" : capY ? `금융 자회사 연결(검증기 판정 — 그해 ${capY})` : null;
    const blockWhy = evBlockY ?? (lease.status === "unknown" ? "리스부채 확인 불가 — EV 공란이어야" : null) ?? (!k || k.common == null ? "KRX 연말 시가총액 없음" : null);
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
      await ltmLayer({ ...ctx, L, lp, LT, exact, fail, err, policySrc, capCur, ltmPrefOk, ltmPrefPending, evBlockWhy, rowHidden, multExpect, ltmMcOk: ltmPrice != null, ltmPrice });
    } catch (e) { err("LTM 원자료(DART 분기·반기 보고서)", e); }
    // LTM 배수 검사가 안 돌았으면(K1 현재 시가총액 미확인 등) 그 사실을 남긴다(조용히 빠지지 않게)
    if (!multDen.LTM) for (const l of ["PER", "PBR", "PSR"]) add("D", `${l} LTM 값 대조`, "LTM", { status: NA, app: H.LTM?.[l.toLowerCase()] ?? null, note: ltmPrice == null ? "K1 현재 시가총액 미확인 — 분자 없음" : "LTM 원자료 판독 실패 — 분모 없음" });
  } // LTM 열이 없으면 위 K1 「LTM 열 존재」 실패

  // ── 분기 재무제표 화면 A층(감사 2차 ②) — 분기 열마다 DART 분기·반기·3분기·사업보고서와 정확 대조 ──
  try { await quarterLayer({ ...ctx, exact, L }); } catch (e) { err("분기 재무제표 원자료(DART)", e); }

  // ── K3 감가상각비 ──
  try { await daLayer({ ...ctx, exact, cmp, fail, err, yearSrc, yearsShown, caps, L }); } catch (e) { err("감가상각비 원자료(kr_da·XBRL·원문)", e); }

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
        // 무배당 = 0(오너 규칙) — 현금배당금총액 "-"(또는 0)이고 보통주 주당 현금배당금도 비었으면 0(2026-10-08)
        const tot = (list ?? []).find((x) => /^현금배당금총액/.test(x.se ?? ""));
        const t = String(tot?.[f] ?? "").trim();
        if (tot && (t === "-" || num(t) === 0)) { dps = 0; how = `DART 배당 ${ry} 사업보고서 ${f} 현금배당금총액 "${t}" — 무배당`; break; }
      }
    } catch (e) { err(`DART 배당(alotMatter) ${y}`, e); continue; }
    const appDps = h.rows.find((r) => r.key === "dps")?.values[h.columns.findIndex((c) => c.label === col)] ?? null;
    exact("K5", "주당배당금 = DART", col, appDps, dps, how);
    const k = caps.get(y);
    const appY = h.rows.find((r) => r.key === "divyield")?.values[h.columns.findIndex((c) => c.label === col)] ?? null;
    // 상장 전 = KRX 조회는 됐는데 그해 말 종목 없음. 조회 자체가 실패한 해(caps 에 없음 — err 기록)는 주가 미확인(검증불가)(감사 7차 ⑤)
    yieldCheck(col, "배당수익률 = DPS ÷ KRX 연말 종가", appY, dps, !caps.has(y) ? null : !k || k.common == null ? { pre: true } : k.close != null ? { v: k.close, how: `KRX ${k.date} 종가` } : null, how);
    if (y === Math.max(...yearsShown)) k5Exp.fyDps = { v: dps, how };
  }
  // LTM DPS(감사 2차 ⑦) — 검증기가 공공데이터포털 배당정보(금융위원회 GetStocDiviInfoService_V2, 앱과 같은 원천을 따로 호출 — KRX 와 같은 성격)를
  // 법인등록번호(DART 기업개황)로 직접 받아 규칙 문장("최근 12개월 — 배당기준일 > 1년 전 오늘(KST), 같은 기준일 한 번, 보통주")대로 합한다.
  // 그 창에 배당이 없으면 앱은 최근 사업연도 값으로 대신하고 주석을 단다 — 그때는 주석·값을 대조. 배당수익률 = DPS ÷ K1 에서 확인된 현재가
  if (H.LTM) {
    const i = h.columns.findIndex((c) => c.kind === "ltm");
    const appD = h.rows.find((r) => r.key === "dps")?.values[i] ?? null;
    const appY = h.rows.find((r) => r.key === "divyield")?.values[i] ?? null;
    const ly = Math.max(...yearsShown);
    const fyD = h.rows.find((r) => r.key === "dps")?.values[h.columns.findIndex((c) => c.label === `${ly}Y`)] ?? null;
    const fb = /LTM.*주당배당금.*최근 사업연도/.test(notes);
    let exp = null, how = "";
    try {
      if (!ctx.env.DATA_GO_KR_KEY) throw new Error("DATA_GO_KR_KEY 미설정");
      const co = await dartCompany(corp);
      if (!co.jurir_no) throw new Error("DART 기업개황 법인등록번호 없음");
      const ev = await dataGoDividends(co.jurir_no, ctx.env.DATA_GO_KR_KEY);
      const t = new Date(Date.now() + 9 * 3600e3);
      const lo = `${t.getUTCFullYear() - 1}${String(t.getUTCMonth() + 1).padStart(2, "0")}${String(t.getUTCDate()).padStart(2, "0")}`;
      const byDate = new Map(ev.filter((e) => e.bd > lo).map((e) => [e.bd, e.amt]));
      if (byDate.size) { exp = [...byDate.values()].reduce((a, b) => a + b, 0); how = `공공데이터 배당기준일 ${[...byDate].map(([d, a]) => `${d} ${a}`).join(" + ")} (> ${lo})`; }
      else how = `공공데이터 배당기준일 > ${lo} 없음(전체 ${ev.length}건)`;
    } catch (e) { err("공공데이터 배당정보(LTM 주당배당금)", e); how = null; }
    if (how != null) {
      if (exp == null) {
        // 창 안 배당 없음 — 앱은 최근 사업연도 값 + 주석(무배당이면 빈칸)
        // 최근 사업연도도 무배당(0)이면 창 안 합(0)과 사업연도 값(0)이 같다 — 앱 0 이면 주석 유무와 관계없이 통과(2026-10-08, 무배당 = 0)
        if (fyD === 0) add("K5", "LTM 주당배당금 = 공공데이터 12개월 합", "LTM", appD === 0 ? { status: PASS, note: `${how} · 최근 사업연도도 무배당 — 0` } : { status: FAIL, note: `${how} · 최근 사업연도 무배당인데 앱 ${appD}` });
        else if (fyD != null) add("K5", "LTM 주당배당금 = 최근 사업연도(창 안 배당 없음 — 주석 표시된 대체)", "LTM", fb ? same(appD, fyD) : { status: FAIL, note: `${how} · 앱 ${appD} 인데 대체 주석 없음` });
        else add("K5", "LTM 주당배당금 = 공공데이터 12개월 합", "LTM", appD == null ? { status: PASS, note: `${how} · 사업연도 배당도 없음 — 빈칸` } : { status: FAIL, note: `${how} · 앱 ${appD}` });
      } else exact("K5", "LTM 주당배당금 = 공공데이터 12개월 합", "LTM", appD, exp, how);
      // 기대 DPS: 창 안 합, 없으면 최근 사업연도(DART — 앱 값 아님)가 무배당(0)이면 0, 대체 주석이면 그 사업연도 값, 둘 다 아니면 빈칸
      const fyE = k5Exp.fyDps?.v ?? null;
      const d = exp ?? (fyE === 0 ? 0 : fb ? fyE : null);
      k5Exp.ltmDps = { v: d, how };
      yieldCheck("LTM", "LTM 배당수익률 = DPS ÷ 현재가", appY, d, ltmPrice != null ? { v: ltmPrice, how: "K1 확인 현재가" } : null, how);
    } else add("K5", "LTM 배당수익률 = DPS ÷ 현재가", "LTM", { status: NA, app: appY, note: "LTM 주당배당금 원자료 조회 실패 — 배당수익률 기대치 없음" });
  }

  // ── 개요 화면(감사 6차 ① — 개요는 화면이 /ttm·verify-row 값으로 직접 계산한다: PER(TTM) = 현재가 ÷ /ttm EPS, 배당수익률 = /ttm DPS(TTM) ÷ 현재가).
  // 화면 식을 앱 응답 값으로 그대로 재현한 결과를 검증기 기대치(K1 확인 현재가 · DART 분모 · K5 배당)와 대조
  overviewLayer({ ...ctx, H, fail, ltmPrice, capCur, k5Exp, multDen, yearsShown, added });
  // 사용자가 실제로 보는 유니버스 통합 뷰 DB 캐시(universe_overview — 2호기 DB 는 매일 05:30 운영 사본)(감사 9차 ②, 리드 지시)
  try { await universeCacheLayer({ ...ctx, H, L, multDen, added }); } catch (e) { err("유니버스 DB 캐시(universe_overview) 판독", e); }
}

/**
 * 유니버스 DB 캐시 대조(K6). 캐시 한 건 = 그 계산 시각의 시세 + 그때의 TTM. 검증기 기대치:
 *  - 현재가·시가총액 = 캐시 시각(KST) 이전 최근 거래일 KRX 종가·시가총액, 또는 KRX 게시 전이면 그 뒤 Yahoo 종가 × KRX 상장주식수(앱 시세 규칙)
 *  - 매출·영업이익률·순이익률·PER(TTM)·PBR = 캐시가 최신 정기보고서 접수 뒤 계산됐을 때만 지금의 DART LTM 기대치로(그 전이면 TTM 기준이 달라 검증불가)
 *  - 4일 넘게 갱신 안 됐으면 실패(매일 갱신)
 */
async function universeCacheLayer(c) {
  const { add, sym, H, L, multDen } = c;
  const { PASS, FAIL, NA } = c.consts;
  const uri = c.env?.MONGODB_URI;
  if (!uri) { add("K6", "유니버스 DB 캐시 조회", "LTM", { status: NA, note: "MONGODB_URI 없음" }); return; }
  const { MongoClient } = await import("mongodb");
  const cli = await new MongoClient(uri).connect();
  let d;
  try { d = await cli.db("market_research").collection("universe_overview").findOne({ market: "kr", symbol: sym }); } finally { await cli.close(); }
  if (!d) { add("K6", "유니버스 DB 캐시 있음", "LTM", { status: NA, note: "universe_overview 에 이 종목 없음(유니버스 밖이거나 아직 계산 전)" }); return; }
  const at = Date.parse(d.updatedAt);
  const kst = new Date(at + 9 * 3600e3), day = kst.toISOString().slice(0, 10).replace(/-/g, "");
  const ageD = (Date.now() - at) / 864e5;
  add("K6", "유니버스 캐시 갱신(4일 안)", "LTM", ageD <= 4 ? { status: PASS, note: `${d.updatedAt}` } : { status: FAIL, note: `마지막 갱신 ${d.updatedAt}(${ageD.toFixed(1)}일 전)` });
  if (d.error) add("K6", "유니버스 캐시 오류 없음", "LTM", { status: FAIL, note: String(d.error).slice(0, 120) });
  const fl = (a, b) => a === b || (a != null && b != null && Math.abs(a - b) <= Math.abs(b) * 1e-14);
  const ck = (name, app, exp, note) => add("K6", `유니버스 캐시 ${name}`, "LTM", exp === undefined ? { status: NA, app, note } : fl(app, exp) ? { status: PASS, app, src: exp, note } : { status: FAIL, app, src: exp, note: `캐시 ${app ?? "빈칸"} vs 기대 ${exp ?? "빈칸"} · ${note}` });
  // 현재가·시가총액 — 캐시 시각에 이미 마감한 최근 거래일 D(KST 16시 전이면 전날까지). 앱 시세 규칙: KRX 일별 자료가 있으면 KRX 종가·시가총액, 아직 게시
  // 전이면 Yahoo 종가 × KRX 상장주식수(최근 게시일) — 캐시 시각엔 D 의 KRX 자료가 게시 전이었을 수 있어 두 경우를 모두 기대치로 둔다
  const cut = new Date(kst);
  if (kst.getUTCHours() < 16) cut.setUTCDate(cut.getUTCDate() - 1);
  const cutDay = cut.toISOString().slice(0, 10).replace(/-/g, "");
  const k = await krxCapsOn(sym, cutDay);
  let px = undefined, mcE = undefined, how = "";
  if (k?.common != null) {
    const prevDay = new Date(Date.UTC(+k.date.slice(0, 4), +k.date.slice(4, 6) - 1, +k.date.slice(6, 8) - 1)).toISOString().slice(0, 10).replace(/-/g, "");
    const kp = await krxCapsOn(sym, prevDay);
    const yb = c.yahooBars ? (await c.yahooBars(sym)).find((b) => b.date.replace(/-/g, "") === k.date) : null;
    const cands = [{ px: k.close, mc: k.common, how: `KRX ${k.date} 종가·시가총액` }];
    if (yb?.close != null && kp?.shares != null) cands.push({ px: yb.close, mc: yb.close * kp.shares, how: `KRX ${k.date} 게시 전 — Yahoo ${k.date} 종가 ${yb.close} × KRX ${kp.date} 상장주식수 ${kp.shares}` });
    if (yb?.close != null && k.shares != null) cands.push({ px: yb.close, mc: yb.close * k.shares, how: `Yahoo ${k.date} 종가 ${yb.close} × KRX ${k.date} 상장주식수 ${k.shares}` });
    const hit = cands.find((x) => x.px === d.last && x.mc === d.marketCap) ?? cands[0];
    px = hit.px; mcE = hit.mc; how = `${hit.how}(캐시 시각 ${d.updatedAt} — 마감 거래일 ${k.date}, 후보 ${cands.length}개)`;
  }
  ck("현재가 = KRX(캐시 시각 기준)", d.last ?? null, px, how);
  ck("시가총액 = KRX(캐시 시각 기준)", d.marketCap ?? null, mcE, how);
  // 재무 칸 — 최신 정기보고서 접수 뒤 계산된 캐시만
  const lp = L.latestPeriod();
  const filed = String(lp?.rcept ?? "").slice(0, 8);
  const fresh = filed && day >= filed;
  const rv = multDen.LTM?.rev?.v ?? undefined, eq = multDen.LTM?.eq?.v ?? undefined, eps = multDen.LTM?.eps?.v ?? undefined;
  const hop = c.h.rows.find((x) => x.key === "opinc")?.values[c.h.columns.findIndex((x) => x.kind === "ltm")] ?? undefined;
  const ni = H.LTM?.ni ?? undefined;
  const why = fresh ? `최신 정기보고서 ${lp.nm}(${filed}) 뒤 계산` : `캐시(${day})가 최신 정기보고서 ${lp?.nm ?? "?"}(${filed}) 전 계산 — TTM 기준이 달라 기대치 없음`;
  const F = (v) => (fresh ? v : undefined);
  ck("매출(LTM) = DART LTM 매출", d.revenueAnnual ?? null, F(rv), why);
  ck("영업이익률 = LTM 영업이익 ÷ 매출", d.opMargin ?? null, F(rv === undefined || hop === undefined ? undefined : rv && hop != null ? hop / rv : null), why);
  ck("순이익률 = LTM 순이익 ÷ 매출", d.netMargin ?? null, F(rv === undefined || ni === undefined ? undefined : rv && ni != null ? ni / rv : null), why);
  ck("PER(TTM) = 캐시 현재가 ÷ DART LTM EPS", d.perTtm ?? null, F(eps === undefined || d.last == null ? undefined : eps > 0 ? d.last / eps : null), why);
  ck("PBR = 캐시 시가총액 ÷ DART 지배주주 자본", d.pbr ?? null, F(eq === undefined || d.marketCap == null ? undefined : eq > 0 ? d.marketCap / eq : null), why);
}

/** 개요 화면 표시값 대조 — 화면 식(stock-analysis.tsx)을 앱 응답으로 재현한 값 vs 검증기 기대치 */
function overviewLayer(c) {
  const { add, row, tt, ltmPrice, k5Exp, multDen, capCur } = c;
  const { PASS, FAIL, NA } = c.consts;
  const m = row?.overview?.multiples ?? null;
  const price = m?.inputs?.price ?? null;
  const fl = (a, b) => a === b || (a != null && b != null && Math.abs(a - b) <= Math.abs(b) * 1e-14); // 같은 값을 다른 순서로 나눈 부동소수 끝자리만
  const chk = (name, app, exp, note) => add("K1", `개요 ${name}`, "LTM", exp === undefined ? { status: NA, app, note } : fl(app, exp) ? { status: PASS, app, src: exp, note } : { status: FAIL, app, src: exp, note: `앱 ${app ?? "빈칸"} vs 기대 ${exp ?? "빈칸"} · ${note}` });
  if (!m) { add("K1", "개요 멀티플 응답", "LTM", { status: FAIL, note: "verify-row 개요 멀티플 없음" }); return; }
  // 현재가 — 화면 모든 식의 분자
  chk("현재가 = K1 확인 현재가", price, ltmPrice ?? undefined, ltmPrice == null ? "K1 현재가 미확인" : "KRX(·게시 전 Yahoo) 종가");
  const ok = ltmPrice != null && price === ltmPrice;
  const ttm = tt?.ttm ?? null;
  // EPS(TTM)·PER(TTM): 화면 = 현재가 ÷ /ttm EPS(> 0), 빈칸이면 빈칸(대체 계산 없음)
  // 분모 판독 불가(null)는 기대치 없음(검증불가) — 빈칸 기대가 아니다
  const eL = multDen.LTM?.eps?.v ?? undefined;
  chk("EPS(TTM) /ttm = DART LTM EPS", ttm?.eps ?? null, eL === undefined ? undefined : eL, multDen.LTM?.eps?.how ?? "LTM 분모 없음");
  const scrPer = price != null && ttm?.eps != null && ttm.eps > 0 ? price / ttm.eps : null;
  chk("PER(TTM) 화면 = 현재가 ÷ /ttm EPS", scrPer, !ok || eL === undefined ? undefined : eL != null && eL > 0 ? ltmPrice / eL : null, `기대 = K1 현재가 ÷ DART LTM EPS ${eL}`);
  // PER(연간) = 현재가 ÷ 최근 사업연도 희석 EPS(A층 DART 판독)
  const fy = Math.max(...c.yearsShown), eF = multDen[`${fy}Y`]?.eps?.v ?? undefined;
  chk("PER = 현재가 ÷ 최근 사업연도 EPS", m.per ?? null, !ok || eF === undefined ? undefined : eF != null && eF > 0 ? ltmPrice / eF : null, `FY${fy} DART EPS ${eF}`);
  // PBR·PSR — 하이라이트 LTM 과 같은 정의, 검증기 기대치(LTM 분모)
  const mc = capCur?.common != null && ok ? c.H.LTM?.mc : null;
  const eq = multDen.LTM?.eq?.v ?? undefined, rv = multDen.LTM?.rev?.v ?? undefined;
  chk("PBR = 시가총액 ÷ DART 지배주주 자본", m.pbr ?? null, mc == null || eq === undefined ? undefined : eq != null && eq > 0 ? mc / eq : null, multDen.LTM?.eq?.how ?? "");
  chk("PSR = 시가총액 ÷ DART LTM 매출", m.psr ?? null, mc == null || rv === undefined ? undefined : rv != null && rv > 0 ? mc / rv : null, multDen.LTM?.rev?.how ?? "");
  // BPS = DART 지배주주 자본 ÷ KRX 상장주식수(시가총액 = 종가 × 상장주식수와 같은 주식수)
  const sh = capCur?.shares ?? null;
  chk("BPS = DART 지배주주 자본 ÷ KRX 상장주식수", m.bps ?? null, eq === undefined || sh == null ? undefined : eq != null ? eq / sh : null, `${multDen.LTM?.eq?.how ?? ""} · KRX 상장주식수 ${sh}`);
  // DPS·DPS(TTM)·배당수익률(화면 = /ttm DPS(TTM) ÷ 현재가, 소수 비율)
  const dv = tt?.dividend ?? null;
  chk("DPS = DART 최근 사업연도", dv?.annual?.dps ?? null, k5Exp.fyDps ? k5Exp.fyDps.v : undefined, k5Exp.fyDps?.how ?? "K5 사업연도 DPS 없음");
  chk("DPS(TTM) = 공공데이터 12개월", dv?.ttm?.dps ?? null, k5Exp.ltmDps ? k5Exp.ltmDps.v : undefined, k5Exp.ltmDps?.how ?? "K5 LTM DPS 없음");
  const scrY = price != null && dv?.ttm?.dps != null && price > 0 ? dv.ttm.dps / price : null;
  const dE = k5Exp.ltmDps?.v;
  chk("배당수익률 화면 = /ttm DPS(TTM) ÷ 현재가", scrY, !ok || dE === undefined ? undefined : dE != null ? dE / ltmPrice : null, `기대 = DPS ${dE} ÷ K1 현재가`);

  // ── 화면 입력값(감사 7차 ① — 위 배수는 verify-row(서버가 같은 computeTrailingMultiples 로 계산)인데, 화면은 /overview 시세와 /ttm 응답으로 브라우저에서
  // 다시 계산한다. 한국 경로는 /ttm 스냅샷·시세만 쓴다(multiples.ts — 연간 재무제표 표는 안 씀). 같은 함수에 같은 입력이면 같은 값이므로, 화면이 받는
  // 입력값마다 검증기 기대치와 대조한다)
  if (!c.ov) { add("K1", "개요 화면 입력 /overview 응답", "LTM", { status: FAIL, note: "/overview 응답 없음" }); return; }
  const q = c.ov.quote ?? null;
  chk("화면 입력 현재가(/overview 시세) = K1 확인 현재가", q?.last ?? null, ltmPrice ?? undefined, "브라우저 멀티플 분자");
  // 한국 화면은 Yahoo 컨센서스 주식수·시가총액으로 채우지 않는다(감사 8차 ② — stock-analysis.tsx·service.ts) — 시세 값만
  const scrSh = q?.sharesOutstanding ?? null;
  chk("화면 입력 주식수(/overview 시세) = KRX 상장주식수", scrSh, sh ?? undefined, `KRX 상장주식수 ${sh}`);
  const scrMc = q?.marketCap ?? null;
  chk("화면 입력 시가총액(/overview 시세) = K1 확인 시가총액", scrMc, mc ?? undefined, "하이라이트 LTM 시가총액(K1 KRX 확인)");
  chk("화면 입력 /ttm 최근 사업연도 EPS = DART", ttm?.fyEps?.eps ?? null, eF, `FY${fy} DART EPS`);
  chk("화면 입력 /ttm 매출 = DART LTM 매출", ttm?.revenue ?? null, rv, multDen.LTM?.rev?.how ?? "");
  chk("화면 입력 /ttm 지배주주 자본 = DART", ttm?.snapshot?.equity ?? null, eq, multDen.LTM?.eq?.how ?? "");
  // EV 입력 — 하이라이트 LTM 의 EV 구성요소(K2 에서 DART 와 대조됨)와 같아야
  const L = c.H.LTM ?? {};
  // 하이라이트 EV 다리의 현금 줄은 음수로 싣는다(− 현금) — 순차입금 = EV − 보통주 시가총액 − 우선주(K2 가 EV 를 DART 와 대조)
  const nd = L.ev != null && L.mc != null ? L.ev - L.mc - (L.pref ?? 0) : undefined;
  chk("화면 입력 /ttm 순차입금 = 하이라이트 LTM EV − 시가총액 − 우선주(K2 확인)", ttm?.snapshot?.evNetDebt ?? null, nd, `EV ${L.ev} − 시가총액 ${L.mc} − 우선주 ${L.pref ?? 0} (다리: 차입금 ${L.debt} · 비지배 ${L.nci ?? 0} · 현금 줄 ${L.cash})`);
  chk("화면 입력 /ttm 우선주 시가총액 = 하이라이트 LTM(K1 확인)", ttm?.snapshot?.evPreferredMcap ?? 0, L.pref ?? 0, "");
  const hOp = c.h.rows.find((x) => x.key === "opinc")?.values[c.h.columns.findIndex((x) => x.kind === "ltm")] ?? null;
  chk("화면 입력 /ttm 영업이익 = 하이라이트 LTM(K4 확인)", ttm?.opIncome ?? null, hOp ?? undefined, "");
  // LTM 감가상각이 K3 에서 공통모드(적재본만 일치)였으면 이 대조도 독립 확인이 아니다(감사 9차 ④)
  const daCommon = (c.added ?? []).some((x) => x.layer === "K3" && x.col === "LTM" && x.status === c.consts.COMMON);
  const asCommon = (r) => (daCommon && r.status === PASS ? { ...r, status: c.consts.COMMON, note: `${r.note ? `${r.note} · ` : ""}공통모드 — LTM 감가상각이 K3 에서 공통모드(적재본과만 일치)` } : r);
  { const e0 = L.ebitda != null && hOp != null ? L.ebitda - hOp : undefined, a0 = ttm?.daTtm ?? null;
    add("K1", "개요 화면 입력 /ttm 감가상각 = 하이라이트 LTM EBITDA − 영업이익(K3 확인)", "LTM", asCommon(e0 === undefined ? { status: NA, app: a0 } : fl(a0, e0) ? { status: PASS, app: a0, src: e0 } : { status: FAIL, app: a0, src: e0, note: `앱 ${a0 ?? "빈칸"} vs 기대 ${e0 ?? "빈칸"}` })); }
  // 유니버스 통합 뷰 행(verify-row universe = computeKrOverviewMetrics, 화면 표 그대로)의 재무 칸(감사 9차 ② — 시가총액·PER·PBR 만 보고 매출·이익률·
  // 현재가는 대조하지 않았다): 매출 = DART LTM 매출, 영업이익률 = 하이라이트 LTM 영업이익(K4 확인) ÷ 매출, 순이익률 = LTM 순이익(K4 확인) ÷ 매출, 현재가 = K1
  const uv = row?.universe && !row.universe.error ? row.universe : null;
  if (!uv) add("K1", "유니버스 행 응답", "LTM", { status: FAIL, note: row?.universe?.error ?? "verify-row 유니버스 행 없음" });
  else {
    const uChk = (name, app, exp, note) => add("K1", `유니버스 ${name}`, "LTM", exp === undefined ? { status: NA, app, note } : fl(app, exp) ? { status: PASS, app, src: exp, note } : { status: FAIL, app, src: exp, note: `앱 ${app ?? "빈칸"} vs 기대 ${exp ?? "빈칸"} · ${note}` });
    const hop = c.h.rows.find((x) => x.key === "opinc")?.values[c.h.columns.findIndex((x) => x.kind === "ltm")] ?? undefined;
    const lni = c.H.LTM?.ni ?? undefined;
    uChk("현재가 = K1 확인 현재가", uv.last ?? null, ltmPrice ?? undefined, "");
    uChk("매출(LTM) = DART LTM 매출", uv.revenueAnnual ?? null, rv, multDen.LTM?.rev?.how ?? "");
    uChk("영업이익률 = LTM 영업이익 ÷ DART LTM 매출", uv.opMargin ?? null, rv === undefined || hop === undefined ? undefined : rv && hop != null ? hop / rv : null, `영업이익 ${hop}`);
    uChk("순이익률 = LTM 순이익 ÷ DART LTM 매출", uv.netMargin ?? null, rv === undefined || lni === undefined ? undefined : rv && lni != null ? lni / rv : null, `순이익 ${lni}`);
  }
  // 화면 계산이 읽는 그 밖의 칸(감사 8차 ① — evBlocker·evShares·bookShares·isReit·error 를 바꿔도 통과였다): 한국 스냅샷에 허용된 칸만 있어야 하고, TTM 오류가
  // 없어야 하며, EV 차단 여부는 하이라이트 LTM EV(K2 확인) 유무와 같아야 한다
  if (ttm?.error) add("K1", "개요 화면 입력 /ttm 오류 없음", "LTM", { status: FAIL, note: `/ttm 응답 오류 ${String(ttm.error).slice(0, 80)} — 화면 멀티플 전부 빈칸` });
  const SNAP_KEYS = new Set(["label", "equity", "liabilities", "cash", "shares", "evNetDebt", "evBlocker", "evPreferredMcap", "evBridge"]);
  const extra = Object.keys(ttm?.snapshot ?? {}).filter((k) => !SNAP_KEYS.has(k));
  // 순차입금 칸은 반드시 있어야(값이 null 이어도) — 칸이 빠지면 예전 앱은 부채총계 − 현금 식으로 EV 를 지어냈다(감사 9차 ①)
  const miss = ["evNetDebt", "equity"].filter((k) => !(k in (ttm?.snapshot ?? {})));
  add("K1", "개요 화면 입력 /ttm 스냅샷 칸(한국 허용 목록·필수 칸)", "LTM", ttm?.snapshot ? (extra.length || miss.length ? { status: FAIL, note: `${extra.length ? `허용 목록 밖 칸 ${extra.join(", ")} ` : ""}${miss.length ? `필수 칸 없음 ${miss.join(", ")}` : ""}` } : { status: PASS }) : { status: FAIL, note: "/ttm 스냅샷 없음" });
  const blk = ttm?.snapshot?.evBlocker ?? null;
  if (L.ev != null) add("K1", "개요 화면 입력 EV 차단 없음(하이라이트 LTM EV 있음)", "LTM", blk == null ? { status: PASS } : { status: FAIL, note: `하이라이트 LTM EV ${L.ev} 인데 /ttm evBlocker "${blk}"` });
  // 화면 최종 EV/EBITDA = (현재가 × 상장주식수 + 우선주 + 순차입금) ÷ (영업이익 + 감가상각) — 화면 입력으로 다시 계산해 하이라이트 LTM(K2·K3 확인)과 대조
  const sp = q?.last ?? null;
  const evS = blk == null && sp != null && scrSh != null && ttm?.snapshot?.evNetDebt != null ? sp * scrSh + (ttm.snapshot.evPreferredMcap ?? 0) + ttm.snapshot.evNetDebt : null;
  const ebS = ttm?.opIncome != null && ttm?.daTtm != null ? ttm.opIncome + ttm.daTtm : null;
  const evx = evS != null && ebS != null && ebS > 0 ? evS / ebS : null;
  const fl2 = (a, b) => a === b || (a != null && b != null && Math.abs(a - b) <= Math.abs(b) * 1e-12);
  // 화면 EV 식은 앱(multiples.ts 한국)과 같다: 차단 없음 · 순차입금 값 · 현재가 · 상장주식수가 모두 있을 때만. 하이라이트 EV 가 빈칸이면 화면 EV 도 빈칸이어야
  if (L.ev == null) add("K1", "개요 화면 EV 빈칸(하이라이트 LTM EV 빈칸)", "LTM", evS == null ? { status: PASS, note: `차단 ${blk ?? "없음"} · 순차입금 ${ttm?.snapshot?.evNetDebt ?? "빈칸"}` } : { status: FAIL, app: evS, note: `하이라이트 LTM EV 빈칸인데 화면 입력으로 EV ${evS} 가 나옴` });
  add("K1", "개요 화면 EV/EBITDA(화면 입력으로 계산) = 하이라이트 LTM", "LTM", asCommon(L.evx === undefined ? { status: NA, note: "하이라이트 LTM 없음" } : fl2(evx, L.evx ?? null) ? { status: PASS, app: evx, src: L.evx ?? null, note: `EV ${evS} ÷ EBITDA ${ebS}` } : { status: FAIL, app: evx, src: L.evx ?? null, note: `화면 입력 계산 ${evx ?? "빈칸"} vs 하이라이트 ${L.evx ?? "빈칸"} (EV ${evS ?? "빈칸 — 차단·순차입금·현재가·상장주식수 중 없음"} ÷ EBITDA ${ebS})` }));
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
  const { corp, L, lp, LT, exact, fail, add, consts, tt, policySrc, capCur, evBlockWhy, rowHidden } = c;
  const { PASS, NA } = consts;
  const fs = async (y, code) => {
    for (const d of ["CFS", "OFS"]) { const r = await dartFnltt(corp, y, code, d); if (r && r.length) return { rows: r, fsDiv: d }; }
    return null;
  };
  if (lp.code === "11011") {
    // 최신 정기보고서가 사업보고서(3~5월) → LTM = 그 사업연도. 앱 연도 열이 아니라 DART 사업보고서와 직접 대조(감사 2차 ⑤)
    const label = tt?.ttm?.periodLabel ?? "";
    add("K4", "LTM 기준 = 최신 정기보고서", "LTM", /^FY\d{4}/.test(label) && !/\+/.test(label) && label.includes(String(lp.year)) ? { status: PASS, note: `${lp.nm} → ${label}` } : { status: "fail", note: `최신 정기보고서 ${lp.nm}(사업연도) 인데 앱 LTM ${label}` });
    const cur = await fs(lp.year, "11011");
    if (!cur) { fail("K4", "LTM 사업보고서 재무제표", "LTM", `${lp.nm} 재무제표(fnltt) 없음`); return; }
    const hi = c.h.columns.findIndex((x) => x.kind === "ltm");
    const hrow = (key) => c.h.rows.find((x) => x.key === key)?.values[hi] ?? null;
    const val = (it) => oneVal(pickRow(cur.rows, it[0], it[1]), (r) => num(r.thstrm_amount)).v;
    exact("K4", "LTM 매출 = DART 사업보고서(최신 정기보고서)", "LTM", hrow("revenue"), val(IT.rev), `${lp.nm} ${cur.fsDiv}`);
    if (c.ltmMcOk) c.multExpect("LTM", LT, { mc: LT.mc, price: c.ltmPrice, eq: parentEquity(cur.rows, "thstrm_amount"), rev: { v: val(IT.rev), how: `${lp.nm} 매출` }, eps: { v: epsOfRows(cur.rows, (r) => num(r.thstrm_amount)), how: `${lp.nm} EPS` } });
    exact("K4", "LTM 영업이익 = DART 사업보고서(최신 정기보고서)", "LTM", hrow("opinc"), val(IT.op), `${lp.nm} ${cur.fsDiv}`);
    exact("K4", "LTM 순이익(연결) = DART 사업보고서(최신 정기보고서)", "LTM", LT.ni, val(IT.ni), `${lp.nm} ${cur.fsDiv}`);
    exact("K4", "LTM EPS = DART 사업보고서(최신 정기보고서)", "LTM", LT.eps, epsOfRows(cur.rows, (r) => num(r.thstrm_amount)), lp.nm);
    const cl = classifyBsRows(cur.rows);
    const faceDebt = sumCol(cl.debt, "thstrm_amount") ?? 0;
    const pol = policySrc.at(-1);
    const lease = cl.leaseFace.length ? { status: "face" } : pol && pol.fy === lp.year ? pol : { status: "unknown", how: `FY${lp.year} 리스 판정 없음` };
    const expDebt = faceDebt + (lease.status === "added" ? lease.amount : 0);
    const cash = sumCol(cl.cash, "thstrm_amount") ?? 0, nci = sumCol(cl.nci, "thstrm_amount") ?? 0;
    exact("K2", "LTM 총차입금 = DART 사업보고서(B16)", "LTM", LT.debt, expDebt, `${lp.nm}${lease.status !== "face" ? ` · 본표 리스부채 줄 없음 → ${lease.how}` : ""}`);
    exact("K2", "LTM 현금성자산 = DART 사업보고서(B16)", "LTM", LT.cash == null ? null : -LT.cash, cash);
    exact("K2", "LTM 비지배지분 = DART 사업보고서", "LTM", LT.nci ?? (rowHidden("nci") ? 0 : null), nci);
    const block = evBlockWhy ?? (lease.status === "unknown" ? "리스부채 확인 불가 — EV 공란이어야" : null) ?? (!capCur || capCur.common == null ? "KRX 현재 시가총액 없음" : null);
    ltmEvCheck(c, block, expDebt, nci, cash);
    return;
  }
  const Y = lp.year, q = { "11013": 1, "11012": 2, "11014": 3 }[lp.code];
  const label = tt?.ttm?.periodLabel ?? "";
  const wantTok = `${Y} ${QNAME[q]}`;
  add("K4", "LTM 기준 = 최신 정기보고서", "LTM", label.includes(`+ ${wantTok}`) ? { status: PASS, note: `${lp.nm} (${lp.rcept}) → ${label}` } : { status: "fail", note: `최신 정기보고서 ${lp.nm}(${lp.rcept}) 인데 앱 LTM 라벨 "${label}" — 연간·이전 분기 대체` });
  const cur = await fs(Y, lp.code);
  if (!cur) { fail("K4", "LTM 분기 보고서 재무제표", "LTM", `${lp.nm} 재무제표(fnltt) 없음`); return; }
  const basis = cur.fsDiv;
  const { R, qval, pick } = qSource(corp, basis);
  const seq = [];
  for (let i = 3; i >= 0; i--) { const idx = Y * 4 + (q - 1) - i; seq.push([Math.floor(idx / 4), (idx % 4) + 1]); }
  const hi = c.h.columns.findIndex((x) => x.kind === "ltm");
  const hrow = (key) => c.h.rows.find((x) => x.key === key)?.values[hi] ?? null;
  // LTM = 최근 사업연도 + 당기 누적 − 당기 보고서의 전기 누적(정정본)(오너 결정 2026-10-10 — 예전 "최근 4개 분기 합"은 전년 분기를 정정 전 값으로 더했다).
  // 당기 보고서에 전기 누적 칸이 없으면(현금흐름표 — DART 재무제표 API 가 분기·반기 전기 열을 주지 않음) 전년 같은 보고서의 당기 누적(정정 전일 수 있음)
  void seq; void qval;
  const annualR = await R(Y - 1, "11011");
  const priorOwn = await R(Y - 1, lp.code);
  const ltmOf = (it) => {
    const a = oneVal(pick(annualR ?? [], it), (r) => num(r.thstrm_amount)).v;
    const cc = oneVal(pick(cur.rows, it), (r) => num(r.thstrm_add_amount) ?? num(r.thstrm_amount)).v;
    let pc = oneVal(pick(cur.rows, it), (r) => num(r.frmtrm_add_amount) ?? num(r.frmtrm_amount)).v, from = "당기 보고서 전기 누적";
    // 당기 보고서에 전기 누적 칸이 없으면 빈칸 기대(전년 같은 보고서 값으로 대신하지 않음 — 오너 결정 2026-10-10)
    if (pc == null) from = "당기 보고서 전기 누적 칸 없음 — 빈칸 기대";
    void priorOwn;
    return { v: a != null && cc != null && pc != null ? a + cc - pc : null, how: `FY${Y - 1} ${a} + ${wantTok} 누적 ${cc} − ${from} ${pc}` };
  };
  let revLtm = null;
  for (const [key, it, label2] of [["revenue", IT.rev, "매출"], ["opinc", IT.op, "영업이익"], ["ni", IT.ni, "순이익(연결)"]]) {
    const r0 = ltmOf(it);
    if (key === "revenue") revLtm = r0.v;
    exact("K4", `LTM ${label2} = DART 사업연도 + 당기 누적 − 당기 보고서 전기 누적`, "LTM", key === "ni" ? LT.ni : hrow(key), r0.v, r0.how);
  }
  // 부가 흐름(/ttm krLtm — 재무분석·하이라이트 LTM 이 쓰는 값): 매출총이익·세전이익·법인세·영업현금흐름·유형/무형자산 취득·이자·배당 지급. 계정 = 재무분석 정의(규칙
  // 문장을 검증기가 따로 적음 — ID 우선, 없으면 이름)
  const XT = {
    gross: [["ifrs-full_GrossProfit"], ["매출총이익"], ["IS", "CIS"]],
    pretax: [["ifrs-full_ProfitLossBeforeTax"], ["법인세비용차감전순이익"], ["IS", "CIS"]],
    tax: [["ifrs-full_IncomeTaxExpenseContinuingOperations", "ifrs-full_IncomeTaxExpenseBenefit"], ["법인세비용"], ["IS", "CIS"]],
    ocf: [["ifrs-full_CashFlowsFromUsedInOperatingActivities"], ["영업활동현금흐름"], ["CF"]],
    capex: [["ifrs-full_PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities"], ["유형자산의취득"], ["CF"]],
    intangAcq: [["ifrs-full_PurchaseOfIntangibleAssetsClassifiedAsInvestingActivities"], ["무형자산의취득"], ["CF"]],
    intPaid: [["ifrs-full_InterestPaidClassifiedAsOperatingActivities"], ["이자의지급"], ["CF"]],
    divPaid: [["ifrs-full_DividendsPaidClassifiedAsFinancingActivities"], ["배당금의지급", "배당금지급"], ["CF"]],
  };
  const kl = tt?.ttm?.krLtm ?? null;
  const why = tt?.ttm?.krLtmReasons ?? {};
  const xExp = {};
  // 현금흐름 전기 누적 = 당기 분기·반기 보고서 XBRL 전기 칸(정정본, 오너 결정 2026-10-10 — 재무제표 API 는 분기 현금흐름 전기 열이 없다). XBRL 로 확인 못 하면
  // 앱은 빈칸 + 사유여야 한다. XBRL 당기 누적 = 재무제표 API 당기 누적일 때만 같은 줄로 본다
  let cum = null, cumErr = null;
  try { cum = await dartXbrlCum(lp.rcept, lp.code); } catch (e) { cumErr = String(e?.message ?? e).slice(0, 120); }
  const QC = { "11013": "FQ", "11012": "HY", "11014": "TQ" }[lp.code];
  const member = cur.fsDiv === "CFS" ? "Consolidated" : "Separate";
  const xCum = (ids, pre) => {
    for (const id of ids) {
      const nm = id.replace(/_/, ":");
      const vs = new Set((cum ?? []).filter(([c0, ctx]) => c0 === nm && (ctx === pre || ctx === `${pre}_ifrs-full_ConsolidatedAndSeparateFinancialStatementsAxis_ifrs-full_${member}Member`)).map((x) => x[2]));
      if (vs.size === 1) return [...vs][0];
      if (vs.size > 1) return undefined; // 못 정함
    }
    return null;
  };
  for (const [k, it] of Object.entries(XT)) {
    const isCf = it[2].includes("CF");
    let r0 = ltmOf(it), expU = false;
    if (isCf) {
      const a = oneVal(pick(annualR ?? [], it), (r) => num(r.thstrm_amount)).v;
      const cc = oneVal(pick(cur.rows, it), (r) => num(r.thstrm_add_amount) ?? num(r.thstrm_amount)).v;
      if (cumErr) { r0 = { v: null, how: `XBRL 판독 실패 — ${cumErr}` }; expU = true; }
      else {
        const xc = xCum(it[0], `CFY${Y}d${QC}A`), xp = xCum(it[0], `PFY${Y - 1}d${QC}A`);
        if (xc === undefined || xp === undefined) r0 = { v: null, how: "XBRL 같은 칸 값이 여럿 — 못 정함(빈칸 기대)" };
        else if (cc != null && xc != null && xc !== cc) r0 = { v: null, how: `XBRL 당기 누적 ${xc} ≠ 재무제표 ${cc} — 같은 줄 아님(빈칸 기대)` };
        else r0 = { v: a != null && cc != null && xc != null && xp != null ? a + cc - xp : null, how: `FY${Y - 1} ${a} + ${wantTok} 누적 ${cc} − XBRL 전기 누적(PFY${Y - 1}d${QC}A) ${xp}` };
      }
    }
    xExp[k] = expU ? undefined : r0.v;
    const appV = kl ? (kl[k] ?? null) : null;
    const nm0 = `LTM ${k} (/ttm 부가 흐름) = DART 사업연도 + 당기 누적 − 전기 누적`;
    if (expU) add("K4", nm0, "LTM", { status: NA, app: appV, note: `${r0.how} · 앱 ${appV ?? "빈칸"}${why[k] ? `(사유: ${why[k]})` : ""}` });
    else if (r0.v == null && appV == null) add("K4", nm0, "LTM", why[k] || !isCf ? { status: PASS, note: `기대 빈칸 — ${r0.how}${why[k] ? ` · 앱 사유 ${why[k]}` : ""}` } : { status: FAIL, note: `기대 빈칸(${r0.how})인데 앱 사유 없음` });
    else exact("K4", nm0, "LTM", appV, r0.v, r0.how);
  }
  // 하이라이트 LTM 영업현금흐름·자본지출(자본지출은 음수 표시)
  if (xExp.ocf === undefined) add("K4", "하이라이트 LTM 영업활동 현금흐름 = DART 사업연도 + 누적 − 전기 누적", "LTM", { status: NA, app: hrow("ocf"), note: "XBRL 판독 실패 — 기대치 없음" });
  else exact("K4", "하이라이트 LTM 영업활동 현금흐름 = DART 사업연도 + 누적 − 전기 누적", "LTM", hrow("ocf"), xExp.ocf, "");
  if (xExp.capex === undefined) add("K4", "하이라이트 LTM 자본지출 = −(DART 유형자산 취득 사업연도 + 누적 − 전기 누적)", "LTM", { status: NA, app: hrow("capex"), note: "XBRL 판독 실패 — 기대치 없음" });
  else exact("K4", "하이라이트 LTM 자본지출 = −(DART 유형자산 취득 사업연도 + 누적 − 전기 누적)", "LTM", hrow("capex"), xExp.capex == null ? null : -Math.abs(xExp.capex), "");
  // 재무분석 LTM 비율 — 매출총이익률·유효세율(분자·분모 모두 검증기 기대치)
  {
    const aRow = (nm) => (c.an?.sections ?? []).flatMap((x) => x.items ?? []).find((x) => String(x.accountName ?? "").trim() === nm)?.values ?? null;
    const lv = (o) => (o ? (o["현재/LTM"] ?? o.LTM ?? null) : null);
    const g = aRow("매출총이익률 (%)"), t0 = aRow("유효세율 (%)");
    const fl = (a, b) => a === b || (a != null && b != null && Math.abs(a - b) <= Math.abs(b) * 1e-12);
    const eg = xExp.gross != null && revLtm ? (xExp.gross / revLtm) * 100 : null;
    const et = xExp.tax != null && xExp.pretax ? (xExp.tax / xExp.pretax) * 100 : null;
    if (g) add("K4", "재무분석 LTM 매출총이익률 = 매출총이익 ÷ 매출(검증기 기대치)", "LTM", fl(lv(g), eg) ? { status: PASS, app: lv(g), src: eg } : { status: FAIL, app: lv(g), src: eg, note: `앱 ${lv(g) ?? "빈칸"} vs ${eg ?? "빈칸"}` });
    if (t0) add("K4", "재무분석 LTM 유효세율 = 법인세 ÷ 세전이익(검증기 기대치)", "LTM", fl(lv(t0), et) ? { status: PASS, app: lv(t0), src: et } : { status: FAIL, app: lv(t0), src: et, note: `앱 ${lv(t0) ?? "빈칸"} vs ${et ?? "빈칸"}` });
  }
  // EPS = 사업연도 + 당기 누적 − 전년 동기 누적(희석, 없으면 기본)
  let epsLtm = null;
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
    epsLtm = exp;
    const approxDisclosed = /EPS.*(환산|근사)/.test((c.h.notes ?? []).join(" ")) || /환산|근사/.test(JSON.stringify(tt?.ttm?.reasons?.eps ?? ""));
    if (exp == null && LT.eps != null && approxDisclosed) add("K4", "LTM EPS = DART 사업연도 + 누적 − 전년 누적", "LTM", { status: "unverifiable", note: `분기 EPS 공시 없음 — 앱 근사(주석 표시) ${LT.eps}` });
    else exact("K4", "LTM EPS = DART 사업연도 + 누적 − 전년 누적", "LTM", LT.eps, exp, `FY${Y - 1} ${a} + ${wantTok} 누적 ${cc} − 전년 ${pc}`);
  }
  // LTM 재무상태표(최신 분기말) — 총차입금·현금·비지배지분, EV
  const cl = classifyBsRows(cur.rows, cur.rows, { rows: await R(Y - 1, "11011"), col: "frmtrm_amount" });
  const faceDebt = sumCol(cl.debt, "thstrm_amount") ?? 0;
  // PBR·PSR 기대치(감사 4차 ③) — 지배주주 자본 = 최신 분기말, 매출 = DART 최근 4개 분기 합
  if (c.ltmMcOk) c.multExpect("LTM", LT, { mc: LT.mc, price: c.ltmPrice, eq: parentEquity(cur.rows, "thstrm_amount"), rev: { v: revLtm, how: "DART 최근 4개 분기 매출 합" }, eps: { v: epsLtm, how: "DART 사업연도 + 누적 − 전년 누적 EPS" } });
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
        // 절댓값으로 크기 비교, 부호는 그대로 보인다(감사 2차 ⑩ — 음수가 "앱 분기말 -130조" 로만 보였다). 리스부채가 음수면 부호 오류
        const r = Math.max(Math.abs(appQ), Math.abs(pol.amount)) / Math.min(Math.abs(appQ), Math.abs(pol.amount));
        if (appQ < 0 || pol.amount <= 0 || r > 100) fail("K2", "분기말 리스부채 크기 = 사업연도 주석과 100배 안(단위 안전장치)", "LTM", `앱 분기말 리스부채(앱 LTM 총차입금 − 본표 차입금) ${appQ} vs FY${Y - 1} 주석 ${pol.amount} — ${appQ < 0 || pol.amount <= 0 ? "음수(부호 오류)" : `크기 ${r.toFixed(0)}배(단위 오류 의심)`}`);
        else add("K2", "분기말 리스부채 크기 = 사업연도 주석과 100배 안(단위 안전장치)", "LTM", { status: PASS, note: `${r.toFixed(2)}배` });
      }
    } else lease = { status: "unknown", how: `FY${Y - 1} 주석 리스부채 ${pol?.status ?? "없음"} — 분기 보고서 전기말 열 확인 불가` };
  }
  const expDebt = faceDebt + (lease.status === "added" ? lease.amount : 0);
  exact("K2", "LTM 총차입금 = DART 최신 분기(B16)", "LTM", LT.debt, expDebt, `${lp.nm} ${basis}${lease.status !== "face" ? ` · 본표 리스부채 줄 없음 → ${lease.how}` : ""}`);
  exact("K2", "LTM 현금성자산 = DART 최신 분기(B16)", "LTM", LT.cash == null ? null : -LT.cash, sumCol(cl.cash, "thstrm_amount") ?? 0);
  exact("K2", "LTM 비지배지분 = DART 최신 분기", "LTM", LT.nci ?? (rowHidden("nci") ? 0 : null), sumCol(cl.nci, "thstrm_amount") ?? 0);
  const block = evBlockWhy ?? (lease.status === "unknown" ? "리스부채 확인 불가 — EV 공란이어야" : null) ?? (!capCur || capCur.common == null ? "KRX 현재 시가총액 없음" : null);
  ltmEvCheck(c, block, expDebt, sumCol(cl.nci, "thstrm_amount") ?? 0, sumCol(cl.cash, "thstrm_amount") ?? 0);
}

/** LTM EV 대조 — 공란 기대(block)·우선주 미확인(게시 전 — 검증불가, 통과로 세지 않음)·정확 대조 */
function ltmEvCheck(c, block, expDebt, nci, cash) {
  const { LT, add, fail, exact, ltmPrefOk, ltmPrefPending, consts } = c;
  const { PASS, NA } = consts;
  if (block) { if (LT.ev != null) fail("K2", "LTM EV = KRX + DART(B16)", "LTM", `기대 공란(${block})인데 앱 EV ${LT.ev}`); else add("K2", "LTM EV = KRX + DART(B16)", "LTM", { status: PASS, note: `공란 — ${block}` }); return; }
  if (ltmPrefOk == null && LT.ev != null) { add("K2", "LTM EV = KRX + DART(B16)", "LTM", { status: NA, app: LT.ev, note: ltmPrefPending ? "우선주 시가총액 확인 불가(KRX 게시 전) — 재실행 필요" : "우선주 시가총액 확인 불가(K1 우선주·시가총액 검사 실패 또는 KRX 현재 조회 실패 — 그 실패가 이미 기록됨)" }); return; }
  exact("K2", "LTM EV = KRX + DART(B16)", "LTM", LT.ev, LT.mc == null ? null : LT.mc + ltmPrefOk + expDebt + nci - cash, "보통주 시가총액은 K1 에서 따로 대조");
}

/** 분기 값 원천(앱 규칙 문서와 같은 우선순위) — 3개월 = 다음 해 같은 분기 보고서 전년 3개월 → 그 분기 보고서 3개월 → 누적 차, 4분기 = 사업보고서 − 3분기 누적 */
function qSource(corp, basis) {
  const memo = new Map();
  const R = (y, code) => {
    const k = `${y}|${code}`;
    if (!memo.has(k)) memo.set(k, (async () => { const r = await dartFnltt(corp, y, code, basis); return r && r.length ? r : null; })());
    return memo.get(k);
  };
  const pick = (rows, it) => pickRow(rows, it[0], it[1], it[2]);
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
  return { R, ytd, qval, pick };
}

/** 전체 EPS(희석 → 기본), 전체 EPS 미공시면 계속영업 + 중단영업 주당이익 */
function epsOfRows(rows, f) {
  const pick = (it) => pickRow(rows ?? [], it[0], it[1]);
  for (const it of [EPS_D, EPS_B]) { const o = oneVal(pick(it), f); if (o.v != null) return o.v; }
  for (const k of ["Diluted", "Basic"]) {
    const c0 = oneVal(pick([[`ifrs-full_${k}EarningsLossPerShareFromContinuingOperations`], []]), f).v;
    if (c0 == null) continue;
    return c0 + (oneVal(pick([[`ifrs-full_${k}EarningsLossPerShareFromDiscontinuedOperations`], []]), f).v ?? 0);
  }
  return null;
}

/**
 * 분기 재무제표 화면 A층(감사 2차 ② — 2025 Q3 영업현금흐름 ×1.1·Q4 자산총계 +10억을 놓쳤다). 분기 손익계산서·재무상태표·현금흐름표의 분기 열마다
 * DART 분기·반기·3분기·사업보고서와 정확 대조: 손익·현금흐름 = 3개월(qSource 와 같은 우선순위), 재무상태표 = 그 분기 보고서 당기말. 앱에만 값·있어야 할 값
 * 빈칸 모두 실패(exact)
 */
async function quarterLayer(c) {
  const { corp, quarter, items, exact, add, consts, L } = c;
  const { isq, bsq, cfq } = quarter ?? {};
  if (!isq || !bsq || !cfq || !items) return; // 응답 실패는 호출부가 이미 실패로 기록
  const shown = (isq.periods ?? []).map((p) => p.label).filter((l) => /^\d{4} Q[1-4]$/.test(l));
  // 기대 분기 열(감사 3차 ④ — 앱이 보여 주는 열만 돌아 2025 Q2 열을 지워도 실패 0): DART 정기공시 목록의 최신 기간부터 최근 5개 분기 중 그 분기
  // 보고서(4분기는 사업보고서)가 있는 분기. 빠진 열은 실패, 그 열의 대조도 돈다(원자료 있는데 앱 빈칸 → 실패)
  const lp = L?.latestPeriod();
  const expected = [];
  if (lp) {
    const last = lp.year * 4 + ({ "11013": 1, "11012": 2, "11014": 3, "11011": 4 }[lp.code] - 1);
    for (let i = 4; i >= 0; i--) {
      const yy = Math.floor((last - i) / 4), qq = ((last - i) % 4) + 1;
      if (L.latest(yy, qq === 4 ? "11011" : QCODE[qq])) expected.push(`${yy} Q${qq}`);
    }
  }
  const lack = expected.filter((l) => !shown.includes(l));
  add("A", "분기 열 = DART 정기공시 최근 5개 분기", "-", lack.length ? { status: consts.FAIL, note: `기대 ${expected.join("·")} / 앱 ${shown.join("·")} — 빠짐 ${lack.join("·")}` } : { status: consts.PASS, note: expected.join("·") || "정기공시 없음" });
  const per = [...new Set([...shown, ...expected])].sort();
  if (!per.length) { add("A", "분기 열 존재", "-", { status: consts.FAIL, note: "분기 손익계산서 열 0개" }); return; }
  // 기준(연결·별도)은 분기마다 그 분기 보고서로(감사 4차 MINOR — 예전엔 최신 분기 하나의 기준을 전 분기에 썼다)
  const srcs = {};
  const itemsOf = (st) => (st?.sections ?? []).flatMap((x) => x.items ?? []);
  const isByName = (name, k) => itemsOf(isq).find((x) => x.accountName?.trim() === name)?.values?.[k] ?? null;
  const byId = (st, id, k) => itemsOf(st).find((x) => x.accountId === id)?.values?.[k] ?? null;
  for (const lb of per) {
    const y = Number(lb.slice(0, 4)), qq = Number(lb.slice(-1));
    const basis = (await dartFnltt(corp, y, qq === 4 ? "11011" : QCODE[qq], "CFS"))?.length ? "CFS" : "OFS";
    const Q = (srcs[basis] ??= qSource(corp, basis));
    for (const [name, loc, sjs, ids, names] of items) {
      const app = loc.is ? isByName(loc.is, lb) : loc.bs ? byId(bsq, loc.bs, lb) : byId(cfq, loc.cf, lb);
      let exp, how, noNciLine = false, noOwnLine = false;
      if (loc.bs) {
        const rows = await Q.R(y, qq === 4 ? "11011" : QCODE[qq]);
        exp = rows ? oneVal(pickRow(rows, ids, names, sjs), (r) => num(r.thstrm_amount)).v : null;
        noNciLine = !!rows?.some((r) => r.sj_div === "BS") && !pickRow(rows, ["ifrs-full_NoncontrollingInterests"], ["비지배지분"], ["BS"]).length;
        noOwnLine = !!rows?.some((r) => r.sj_div === "BS") && !pickRow(rows, ids, names, sjs).length;
        how = `${y} ${qq === 4 ? "사업" : QNAME[qq]}보고서 당기말 ${basis}`;
      } else {
        const r = await Q.qval(y, qq, [ids, names, sjs]);
        exp = r.v;
        how = `${r.how} ${basis}`;
        // 승인 규칙(앱 dart-income.ts, 연간 A층과 같은 조건 — 검증기가 DART 원자료로 따로 확인): 연결인데 그 분기 보고서들이 지배주주 귀속 줄을 생략했고
        // 비지배지분 순이익(3개월)이 없거나 0, 분기말 재무상태표 비지배지분이 없거나 0 이면 지배 = 당기순이익(062040·060370 반기·3분기 보고서)
        if (exp == null && name === "당기순이익(지배)" && basis === "CFS") {
          const nciQ = await Q.qval(y, qq, [["ifrs-full_ProfitLossAttributableToNonControllingInterests", "ifrs-full_ProfitLossAttributableToNoncontrollingInterests"], [], ["IS", "CIS"]]);
          const bsRows = await Q.R(y, qq === 4 ? "11011" : QCODE[qq]);
          const bsNci = bsRows ? oneVal(pickRow(bsRows, ["ifrs-full_NoncontrollingInterests"], ["비지배지분"], ["BS"]), (x) => num(x.thstrm_amount)).v : null;
          if (!nciQ.v && !bsNci) {
            const ni = await Q.qval(y, qq, [["ifrs-full_ProfitLoss"], ["당기순이익", "당기순이익손실", "분기순이익", "반기순이익"], ["IS", "CIS"]]);
            if (ni.v != null) { exp = ni.v; how = `DART 지배주주 귀속 줄 생략 · 비지배지분 순이익·재무상태표 비지배지분 없음(0) → 지배 = 당기순이익 ${ni.how}(승인 규칙) ${basis}`; }
          }
        }
      }
      // 양쪽 빈칸의 기대 빈칸(2026-10-08, 연간 A층과 같은 원칙): 별도 재무제표 기준이면 지배·비지배 구분 없음, 연결 재무상태표에 비지배지분 줄이 없으면 빈칸
      if (app == null && exp == null && /^(당기순이익\(지배\)|지배주주 지분|비지배지분)$/.test(name) && (basis === "OFS" || (name === "비지배지분" && noNciLine))) {
        add("A", `분기 ${name} = DART`, lb, { status: consts.PASS, note: `양쪽 빈칸 = 기대 빈칸 — ${basis === "OFS" ? "DART 별도 재무제표 기준: 지배·비지배 구분 없음" : "DART 연결 재무상태표에 비지배지분 줄 없음"} (${how})` });
        continue;
      }
      // 연결 재무상태표에 지배기업 소유주지분 줄 자체가 없으면(비지배지분도 없음 — 자본총계 한 줄, 062040 2025 반기·3분기) 본표에 별도 줄 없음 = 빈칸(2026-10-09)
      if (app == null && exp == null && name === "지배주주 지분" && basis === "CFS" && noOwnLine && noNciLine) {
        add("A", `분기 ${name} = DART`, lb, { status: consts.PASS, note: `양쪽 빈칸 = 기대 빈칸 — DART 연결 재무상태표에 지배기업 소유주지분·비지배지분 줄 없음(본표에 별도 줄 없음) (${how})` });
        continue;
      }
      // 직전 분기 보고서는 있지만 그 보고서에 이 기준(연결) 재무제표가 없으면(그해 연결 전환 — 062040 2025 1분기는 별도만) 누적 차를 만들 수 없다(2026-10-09)
      if (app == null && exp == null && !loc.bs && qq > 1 && /누적 차 불가/.test(how) && L.latest(y, QCODE[qq - 1]) && !(await Q.R(y, QCODE[qq - 1]))) {
        add("A", `분기 ${name} = DART`, lb, { status: consts.PASS, note: `양쪽 빈칸 = 기대 빈칸 — 직전 분기(${y} Q${qq - 1}) 보고서에 ${basis} 재무제표 없음: 3개월 값 산출 불가 (${how})` });
        continue;
      }
      // 3개월 값 = 누적 − 직전 누적인데 직전 분기 보고서가 DART 에 아예 없으면(상장 첫 분기보고서 — 062040 2025 반기) 3개월 값은 만들 수 없다 — 앱 빈칸이 맞다(2026-10-08)
      if (app == null && exp == null && !loc.bs && qq > 1 && /누적 차 불가/.test(how) && !L.latest(y, QCODE[qq - 1])) {
        add("A", `분기 ${name} = DART`, lb, { status: consts.PASS, note: `양쪽 빈칸 = 기대 빈칸 — 직전 분기(${y} Q${qq - 1}) 보고서가 DART 에 없음(상장 전): 3개월 값 산출 불가 (${how})` });
        continue;
      }
      exact("A", `분기 ${name} = DART`, lb, app, exp, how);
    }
    // 비지배 순이익(감사 3차 ⑥) — 앱은 비지배주주 귀속 줄을 따로 보이지 않으므로 「당기순이익 − (지배주주 귀속)」이 DART 비지배지분 순이익(3개월)과 같아야
    // 한다. DART 줄이 없거나 0 이고 비지배지분이 없으면(승인 규칙) 0
    if (basis === "CFS") {
      const ni = isByName("당기순이익", lb), par = isByName("(지배주주 귀속)", lb);
      const r = await Q.qval(y, qq, [["ifrs-full_ProfitLossAttributableToNonControllingInterests", "ifrs-full_ProfitLossAttributableToNoncontrollingInterests"], ["비지배지분"], ["IS", "CIS"]]);
      let expN = r.v, howN = `${r.how} ${basis}`;
      if (expN == null) {
        const bsRows = await Q.R(y, qq === 4 ? "11011" : QCODE[qq]);
        const bsNci = bsRows ? oneVal(pickRow(bsRows, ["ifrs-full_NoncontrollingInterests"], ["비지배지분"], ["BS"]), (x) => num(x.thstrm_amount)).v : null;
        if (!bsNci) { expN = 0; howN = "DART 비지배지분 순이익 줄 없음 · 재무상태표 비지배지분 없음(0) → 0"; }
      }
      exact("A", "분기 비지배 순이익(당기순이익 − 지배주주 귀속) = DART", lb, ni != null && par != null ? ni - par : null, expN, howN);
    }
  }
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
/**
 * DART 재무제표 현금흐름 감가상각 줄(검증기 판독). 합계 줄(감가상각 및 상각)이 있고 따로 무형상각 줄이 없으면 그 값 + 따로 적은 사용권·투자부동산 줄. 아니면 유형자산 감가상각
 * + 무형자산상각 + 사용권자산·투자부동산 감가상각 줄의 합 — 유형자산 감가상각 줄이 없으면 부분합이라 null(감사 5차 ① — 010120 2023 보고서는
 * "감가상각비에 대한 조정"(ifrs-full_AdjustmentsForDepreciationExpense) 이라 이름 목록에 안 걸려 무형·사용권만 합했다). 이름 "감가상각비"는
 * 무형상각 줄이 따로 있으면 유형자산 감가상각으로 본다
 */
const DA_CF_PARTS = [
  ["dep", /^(ifrs-full|dart)_(AdjustmentsForDepreciationExpense|DepreciationExpense|DepreciationAndAmortizationExpensePropertyPlantAndEquipment)$/, ["유형자산감가상각비", "유형자산의감가상각비", "감가상각비", "감가상각비에대한조정", "유형자산감가상각비에대한조정", "감가상각비(유형자산)", "유형자산감가상각"]],
  ["amo", /^(ifrs-full|dart)_(AdjustmentsForAmortisationExpense|AmortisationExpense)$/, ["무형자산상각비", "무형자산의상각비", "무형자산상각비에대한조정", "상각비에대한조정", "무형자산상각", "상각비(무형자산)"]],
  // 회사 고유 태그(…_AdjustmentForAmortisationOfRightOfUseAssets 등 — 감사 6차 ④)도 접미사로
  ["rou", /(^(ifrs-full|dart)_AdjustmentsForDepreciationRightofuseAssets$)|(^(?!ifrs-full_|dart_)\w+_Adjustments?For(Depreciation|Amorti[sz]ation)\w*Right[Oo]f[Uu]se)/, ["사용권자산감가상각비", "사용권자산상각비", "사용권자산감가상각비에대한조정", "사용권자산상각비에대한조정", "감가상각비(사용권자산)", "사용권자산상각", "사용권자산감가상각", "상각비(사용권자산)"]],
  ["inv", /(^(ifrs-full|dart)_AdjustmentsForDepreciationInvestmentProperty$)|(^(?!ifrs-full_|dart_)\w+_Adjustments?For(Depreciation|Amorti[sz]ation)\w*InvestmentPropert)/, ["투자부동산감가상각비", "투자부동산상각비", "투자부동산감가상각비에대한조정", "감가상각비(투자부동산)", "투자부동산상각", "투자부동산감가상각"]],
];
function daCfLine(rows, col) {
  const cf = (rows ?? []).filter((r) => r.sj_div === "CF" && num(r[col]) != null);
  const n0 = (r) => String(r.account_nm ?? "").replace(/\s/g, "");
  const part = (k) => { const [, re, names] = DA_CF_PARTS.find((x) => x[0] === k); return cf.find((x) => re.test(x.account_id)) ?? cf.find((x) => names.includes(n0(x))); };
  const amo = part("amo");
  // 합계 줄에 따로 적은 사용권자산·투자부동산 감가상각 줄은 더한다(CLAUDE.md 감가상각비 = 유형 + 사용권 + 투자부동산 — 따로 적은 줄도 합산)
  const extra = ["rou", "inv"].map(part).filter(Boolean);
  const withExtra = (r, how) => ({ v: num(r[col]) + extra.reduce((a, e) => a + num(e[col]), 0), how: `${how}${extra.map((e) => ` + ${e.account_nm}`).join("")}` });
  const tot = !amo && (["ifrs-full_DepreciationAndAmortisationExpense", "ifrs-full_AdjustmentsForDepreciationAndAmortisationExpense", "dart_AdjustmentsForDepreciationAndAmortisationExpense"].map((id) => cf.find((x) => x.account_id === id)).find(Boolean)
    ?? cf.find((x) => ["감가상각비와무형자산상각비", "감가상각비및무형자산상각비", "감가상각비와상각비", "감가상각비및상각비"].includes(n0(x))));
  if (tot) return withExtra(tot, `DART 현금흐름 ${tot.account_nm}(${tot.account_id})`);
  const ps = DA_CF_PARTS.map(([k]) => part(k)).filter(Boolean);
  if (!part("dep")) return null; // 유형자산 감가상각 줄 없음 — 부분합은 감가상각비가 아니다
  return { v: ps.reduce((a, r) => a + num(r[col]), 0), how: `DART 현금흐름 ${ps.map((r) => r.account_nm).join("+")}` };
}

// 감가상각 현금흐름 조정 태그(사업보고서 XBRL) — 검증기 판독
// 접두어는 ifrs-full·dart 둘 다(2022 접수 사업보고서는 dart:AdjustmentsForDepreciationExpense — 000500·015760·052690 2021 실측)
const DEP = ["AdjustmentsForDepreciationExpense"];
const AMO = ["AdjustmentsForAmortisationExpense"];
const DA = ["AdjustmentsForDepreciationAndAmortisationExpense"];
const EXTRA = ["AdjustmentsForDepreciationRightofuseAssets", "AdjustmentsForDepreciationInvestmentProperty"];
const EXTRA_ENT = [/^Adjustments?For(Depreciation|Amorti[sz]ation)\w*Right[Oo]f[Uu]seAsset/, /^Adjustments?For(Depreciation|Amorti[sz]ation)\w*InvestmentPropert/];
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
  // 회사 고유(entity…) 태그 — 표준 태그가 없을 때 이름이 사용권자산·투자부동산 상각 조정인 것(현대로템 064350 "AdjustmentForAmortisationOfRightOfUseAssets…")
  const getEnt = (re) => { const vs = facts.filter(([k, ctx]) => /^entity\d+:/.test(k) && re.test(k.slice(k.indexOf(":") + 1)) && ok(ctx)).map((f) => f[2]); return !vs.length ? null : vs.every((v) => v === vs[0]) ? vs[0] : NaN; };
  // 감가상각 태그가 없고 "감가상각 및 상각" 합계 태그와 무형자산상각 태그가 같은 문맥에 따로 있으면 합계 태그는 감가상각만 담은 것(무형을 두 번
  // 세지 않게 — 012450 2026 반기: 합계 태그 230,705,668천원 = 유형자산 변동표 감가상각, 무형 194,531,698천원 별도)
  const base = d ?? (da != null && a != null ? da : null);
  if (base != null) {
    const ex = EXTRA.map((cpt, i) => get([cpt]) ?? getEnt(EXTRA_ENT[i]));
    if (ex.some((v) => Number.isNaN(v))) return { v: null, how: "사용권·투자부동산 태그 값이 여럿" };
    return { v: base + ex.reduce((s, v) => s + (v ?? 0), 0) + (a ?? 0), parts: { rou: ex[0], inv: ex[1], amo: a }, how: `XBRL 감가${d == null ? "(합계 태그 — 무형 태그 별도)" : ""} ${base}${ex.some((v) => v != null) ? ` + 사용권·투자부동산 ${ex.map((v) => v ?? 0).join("+")}` : ""} + 무형 ${a ?? 0}` };
  }
  if (da != null) return { v: da, how: `XBRL 감가·무형 합계 ${da}` };
  return { v: null, how: "XBRL 현금흐름 감가상각 태그 없음" };
}

/**
 * 원문 표(보고서 여러 개 — 같은 기간 판본 전부) → 확정 후보(daCandidates — 표 종류·한 조합·머리행 열) + 투자부동산 변동표 감가상각. 범위는 basis(CFS → 연결,
 * OFS → 별도)와 **같다고 판정된 표만**(감사 3차: 범위 미상 표를 남겨 000660 별도 현금흐름표 누적이 연결 TTM 대조에 끼었다)
 */
async function docReads(rcepts, basis) {
  const want = basis === "OFS" ? "sep" : "con";
  const cands = [], inv = [];
  for (const r of rcepts) {
    const t = await dartDocDaTables(r);
    for (const x of daCandidates(t)) if (x.scope === want) cands.push({ ...x, rcept: r, how: `${r} ${x.how}` });
    for (const x of invTableDep(t)) if (x.scope === want) inv.push({ ...x, rcept: r, how: `${r} ${x.how}` });
  }
  return { cands, inv };
}
/** XBRL 사실 — 그 판본에 XBRL 파일이 없으면(DART 014) null. 다른 실패는 던진다 */
async function xbrlFactsOrNone(rcept, code) {
  try { return await dartXbrlFacts(rcept, code); }
  catch (e) { if (/<status>014<\/status>/.test(String(e?.message ?? e))) return null; throw e; }
}
/** 분기·반기 XBRL 현금흐름 조정 누적 — 컨텍스트 접두어(CFY2026dHYA 등, 끝이 A = 누적)마다 xbrlDa */
function xbrlCum(facts, cp, y, basis) {
  const re = new RegExp(`^(${cp}${y}d[A-Z0-9]*?A)(?:_|$)`);
  const pre = [...new Set(facts.map((f) => f[1].match(re)?.[1]).filter(Boolean))];
  return pre.map((p) => ({ ...xbrlDa(facts, p, basis), p })).filter((x) => x.v != null).map((x) => ({ v: x.v, how: `XBRL ${x.p} ${x.how}` }));
}
/**
 * 시험 스위치(심은 오류 재현 전용) KR_VERIFY_TEST_DA_SHIFT="종목:해:더할값,종목:LTM:더할값" — 검증기가 읽은 적재본 값을 바꿔 적재 스크립트 결함을
 * 흉내낸다(앱 쪽에도 같은 값을 심어 앱 = 적재본인 채로 독립 판독만 그 차이를 잡는지 본다). 평소엔 쓰지 않는다
 */
function testShift(doc, sym) {
  const spec = process.env.KR_VERIFY_TEST_DA_SHIFT;
  if (!spec) return doc;
  const d = structuredClone(doc);
  for (const part of spec.split(",")) {
    const [s, y, v] = part.split(":");
    if (s !== sym) continue;
    if (y === "LTM") { if (d.ttmDepreciation != null) d.ttmDepreciation += Number(v); }
    else if (d.byYear?.[y]?.depreciation != null) d.byYear[y].depreciation += Number(v);
  }
  return d;
}

/**
 * K3 감가상각(감사 2차 ④). 적재본(kr_da)은 앱 적재 스크립트가 만든 값이라 그것과만 맞으면 공통모드 — 검증기가 따로 읽은 값과 같을 때만 통과로 센다.
 *  · 출처 「xbrl」·「xbrl(별도)」·「…+영업비용확인」: 적재 스크립트가 XBRL 현금흐름 조정 값을 그대로 둔 해(성격별 표와 같음만 확인 — populate-kr-da.mjs
 *    "+영업비용확인" 은 값을 바꾸지 않는다) — 사업보고서 XBRL 을 검증기가 따로 읽어 재현.
 *  · 그 밖(원문 현금흐름 조정 주석·영업비용 기준 성격별 표·사용권자산 줄 보완·원문 무형): 사업보고서 원문 표를 검증기가 따로 읽어(docda.mjs) 후보 중
 *    정확히 같은 값이 있어야 한다. 원문에서 감가상각 표를 하나도 못 읽으면 검증불가(적재 대조는 공통모드), 후보는 있는데 같은 값이 없으면 실패.
 *  · LTM TTM = 최근 사업연도 + 당기 누적 − 전년 동기 누적: 분기·반기 보고서 원문 표·XBRL 누적을 검증기가 따로 읽어 식이 정확히 성립해야 한다.
 *    최신 정기보고서가 사업보고서면 LTM 감가상각 = 그 사업연도(감사 2차 ⑤)
 */
async function daLayer(c) {
  const { sym, env, IS, H, exact, fail, add, consts, yearSrc, yearsShown, caps, L, h } = c;
  const { PASS, NA, COMMON } = consts;
  const col = await daCol(env);
  const doc0 = await col.findOne({ _id: sym });
  if (!doc0) { fail("K3", "감가상각 적재본(kr_da) 존재", "-", `유니버스 종목인데 ${env.KR_DA_COLLECTION || "kr_da"} 에 문서 없음`); return; }
  const doc = testShift(doc0, sym);
  // 단위 안전장치 — 적재 감가상각(원문 해 포함, 전 해)의 이웃 해 크기 대조 + TTM vs 최근 사업연도
  const daBy = new Map(Object.entries(doc.byYear ?? {}).map(([y, d]) => [Number(y), (d.depreciation ?? 0) + (d.amortisation ?? 0)]).filter(([, v]) => v !== 0));
  unitGuard(daBy, "K3", "감가상각 적재본 크기 = 이웃 해와 100배 안(단위 안전장치)", add, fail, PASS);
  if (doc.ttmDepreciation != null && daBy.size) {
    const fy = Math.max(...daBy.keys()), t = doc.ttmDepreciation + (doc.ttmAmortisation ?? 0), f = daBy.get(fy);
    const r = Math.max(Math.abs(t), Math.abs(f)) / Math.min(Math.abs(t), Math.abs(f));
    if (t <= 0 || f <= 0 || !(r <= 100)) fail("K3", "감가상각 TTM 크기 = 최근 사업연도와 100배 안(단위 안전장치)", "LTM", `TTM ${t} vs FY${fy} ${f}${t <= 0 || f <= 0 ? " — 0 이하(부호 오류)" : ` (크기 ${r.toFixed(0)}배)`}`);
    else add("K3", "감가상각 TTM 크기 = 최근 사업연도와 100배 안(단위 안전장치)", "LTM", { status: PASS, note: `${r.toFixed(2)}배` });
  }
  const annualReps = (yy) => L.reports.filter((x) => x.year === yy && x.code === "11011").sort((a, b) => b.rcept.localeCompare(a.rcept)).map((x) => x.rcept);
  const indepY = new Map(); // 해 → 검증기 독립 판독과 일치(설명)
  for (const y of yearsShown) {
    const colY = `${y}Y`;
    const d = doc.byYear?.[y];
    const app = IS[colY]?.da ?? null;
    const src = yearSrc.get(y);
    // 손익계산서 본표에 감가상각 줄이 있는 회사(성격별 손익계산서 — 402340): 앱은 영업이익과 같은 보고서(그해를 담은 가장 최근 보고서)의 본표 줄을 쓴다
    // (감사 9차 후속 — 적재본은 그해 자기 보고서 값이라 재작성 해(2021·2023)에 영업이익과 기준이 갈렸다). 검증기가 DART 본표 줄을 직접 읽어 대조
    {
      const io = src ? [[src.next2, 2], [src.next, 1], [src.cur, 0]].find(([R, i]) => hasIs(R, i)) : null;
      const FACE = /^(ifrs-full|dart)_(DepreciationExpense|DepreciationAndAmortisationExpense|AmortisationExpense)$/;
      const face = io ? io[0].filter((r) => (r.sj_div === "IS" || r.sj_div === "CIS") && FACE.test(r.account_id ?? "") && num(r[COL[io[1]]]) != null) : [];
      if (face.length) {
        const tot = face.find((r) => /DepreciationAndAmortisationExpense$/.test(r.account_id));
        const v = tot ? num(tot[COL[io[1]]]) : face.reduce((a, r) => a + num(r[COL[io[1]]]), 0);
        const how = `DART ${y + io[1]} 사업보고서 손익계산서 본표 ${(tot ? [tot] : face).map((r) => `${r.account_nm}(${r.account_id}) ${num(r[COL[io[1]]])}`).join(" + ")}`;
        exact("K3", "감가상각비 = DART 손익계산서 본표 감가상각 줄(영업이익과 같은 보고서)", colY, app, v, how);
        const op = IS[colY]?.op ?? null, eb = IS[colY]?.ebitda ?? null;
        if (op != null) exact("K3", "EBITDA = 영업이익 + 본표 감가상각", colY, eb, op + v, how);
        indepY.set(y, how);
        continue;
      }
    }
    const xbrlOf = async (basis) => {
      const out = [];
      // 그 보고서의 판본마다(최신부터) — XBRL 파일이 없는 판본(DART 014 — [첨부정정] 등, 012450 2025·402340 2022)은 다음 판본. 보고서마다 첫 값
      for (const [ry, pre] of [[y + 1, `PFY${y}dFY`], [y, `CFY${y}dFY`]]) {
        for (const rc of annualReps(ry)) {
          const f = await xbrlFactsOrNone(rc, "11011");
          if (!f) continue;
          const x = xbrlDa(f, pre, basis);
          if (x.v != null) { out.push({ ...x, rcept: rc }); break; }
        }
      }
      return out;
    };
    if (d && (d.depreciation != null || d.amortisation != null)) {
      const v = (d.depreciation ?? 0) + (d.amortisation ?? 0);
      const s = String(d.src ?? "");
      // 출처 기준(연결·별도) = 그해 재무제표 기준
      if (src) {
        const sep = /별도/.test(s);
        if (sep !== (src.fsDiv === "OFS")) fail("K3", "감가상각 출처 기준 = 재무제표 기준(연결·별도)", colY, `재무제표 ${src.fsDiv === "OFS" ? "별도" : "연결"} · 감가상각 출처 "${s}"`);
        else add("K3", "감가상각 출처 기준 = 재무제표 기준(연결·별도)", colY, { status: PASS, note: `${src.fsDiv} · ${s}` });
      }
      const basis = src?.fsDiv ?? "CFS";
      let indep = null;
      if (/^xbrl(\(별도\))?(\+영업비용확인)?$/.test(s)) {
        const got = (await xbrlOf(basis))[0];
        const nm0 = "감가상각 적재본 = 사업보고서 XBRL(검증기 판독)";
        if (!got) fail("K3", nm0, colY, `적재 ${v}(${s}) — 검증기가 XBRL 에서 못 읽음`);
        else if (got.v !== v) fail("K3", nm0, colY, `적재 ${v}(${s}) vs XBRL ${got.v}(${got.how}, ${got.rcept})`);
        else { add("K3", nm0, colY, { status: PASS, note: `${got.how} (${got.rcept})${/영업비용확인/.test(s) ? " · 영업비용 기준 확인 해(값 = XBRL 그대로)" : ""}` }); indep = `XBRL ${got.rcept}`; }
      } else {
        // 원문 표(그해·이듬해 사업보고서, 판본 전부) — 확정 판독만(감사 3차): 그해 열(그해 보고서 당기·이듬해 보고서 전기), 범위 = 재무제표 기준,
        // 표 종류 = 적재 출처(「+영업비용」 = 성격별 표, 원문 현금흐름 = 현금흐름 조정 표), 조합 = 그 표 묶음의 구성요소 전부 하나
        const reps2 = [...annualReps(y + 1), ...annualReps(y)];
        const rd = await docReads(reps2, basis);
        const ryOf = (rc) => L.reports.find((x) => x.rcept === rc)?.year;
        const inYear = (c0) => c0.cum !== false && c0.period === (ryOf(c0.rcept) === y ? "cur" : ryOf(c0.rcept) === y + 1 ? "prior" : "none");
        const natureSrc = /\+영업비용(?!확인)/.test(s);
        const kindOk = (c0) => (natureSrc ? c0.kind === "nature" : c0.kind === "cf");
        const cs = rd.cands.filter((c0) => inYear(c0) && kindOk(c0));
        const pool = [];
        if (/^xbrl/.test(s) && !natureSrc) {
          // XBRL 값 + 원문에서 보완한 줄 — 「xbrl+doc」: XBRL 에 없는 사용권·투자부동산 줄(같은 현금흐름 조정 표·같은 열에 있는 것 전부), 「+원문무형」: 원문 무형
          for (const x of await xbrlOf(basis)) {
            for (const c0 of cs) {
              let add0 = 0, used = [];
              if (/xbrl\+doc/.test(s)) for (const k of ["rou", "inv"]) if (x.parts?.[k] == null && c0.comps[k] != null) { add0 += c0.comps[k]; used.push(k); }
              if (/원문무형/.test(s) && x.parts?.amo == null && c0.comps.amo != null) { add0 += c0.comps.amo; used.push("amo"); }
              if (used.length) pool.push({ v: x.v + add0, how: `XBRL ${x.how} + 원문 ${used.join("·")}(${c0.how})` });
            }
          }
        } else {
          for (const c0 of cs) {
            const vv = /−투자부동산/.test(s) ? c0.vNoInv : c0.v;
            if (vv == null) continue;
            if (/\+투자부동산/.test(s)) {
              // 성격별 합계 + 같은 보고서·같은 해 열의 투자부동산 변동표 감가상각(LS)
              for (const iv of rd.inv) if (iv.rcept === c0.rcept && iv.period === c0.period) pool.push({ v: vv + iv.v, how: `${c0.how} + ${iv.how}` });
            } else pool.push({ v: vv, how: c0.how });
          }
        }
        const nm0 = "감가상각 적재본 = 사업보고서 원문(검증기 판독)";
        const hit = pool.find((p) => p.v === v);
        // 이웃 해 적재 값과 같으면(열을 잘못 읽은 적재) 실패
        const twin = [y - 1, y + 1].find((yy) => { const o = doc.byYear?.[yy]; return o && (o.depreciation ?? 0) + (o.amortisation ?? 0) === v; });
        if (hit && twin != null) fail("K3", nm0, colY, `적재 ${v} 가 원문 ${hit.how} 와 같지만 FY${twin} 적재 값과도 같음 — 열(해)을 잘못 읽은 적재 의심`);
        else if (hit) { add("K3", nm0, colY, { status: PASS, note: `${s} · ${hit.how}` }); indep = `원문 ${hit.how}`; }
        else if (!pool.length) add("K3", nm0, colY, { status: COMMON, note: `${s} · 확정 판독 불가(그해 열·범위·표 종류가 정해진 원문 후보 없음 — 보고서 ${reps2.join("·") || "없음"}) — 공통모드` });
        else {
          const near = [...pool].sort((a, b) => Math.abs(a.v - v) - Math.abs(b.v - v))[0];
          fail("K3", nm0, colY, `적재 ${v}(${s}) — 확정 원문 후보 ${pool.length}개 중 같은 값 없음(가장 가까운 ${near.v} ${near.how}, 차 ${v - near.v})`);
        }
      }
      indepY.set(y, indep);
      const cm = indep ? null : "적재본(앱 적재 스크립트 값)과만 대조 — 검증기 독립 판독 없음";
      exact("K3", "감가상각비 = 적재본(kr_da)", colY, app, v, `적재 출처 ${s}${indep ? ` · 독립 확인 ${indep}` : ""}`, cm);
      const op = IS[colY]?.op ?? null, eb = IS[colY]?.ebitda ?? null;
      if (op != null) exact("K3", "EBITDA = 영업이익 + 감가상각(적재본)", colY, eb, op + v, "", cm);
    } else {
      // 적재본에 없는 해 — 앱 규칙(오너 결정 2026-10-02 "가"): DART 공시 현금흐름 감가상각 줄, 없으면 빈칸. 검증기가 DART 줄을 따로 읽어 대조.
      // 빈칸 허용: 상장 전(KRX 연말 종목 없음) · 연결 재작성 해(그해·이듬해 사업보고서엔 연결 손익이 없고 다다음 해 보고서 전전기 열에만 —
      // 연결 기준 주석 원자료가 없다, 060370 2022)
      const k = caps.get(y);
      const pre = !k || k.common == null;
      const own = src ? bsOwnerAny(src, y) : null;
      const cfLine = own ? daCfLine(own.rows, own.col) : null;
      const restated = src?.fsDiv === "CFS" && !hasIs(src.cur, 0) && !hasIs(src.next, 1) && hasIs(src.next2, 2);
      // 적재 누락 판정(감사 4차 ① — 010120 2025·015760 2023 을 적재본에서 지우자 앱이 DART 현금흐름 줄(무형·사용권 상각 빠짐)로 넘어갔는데 통과):
      // 검증기가 그해 사업보고서 XBRL 현금흐름 조정을 재무제표 기준(연결·별도)으로 읽을 수 있으면 적재 스크립트는 반드시 그해를 적재한다(XBRL 해는 원문
      // 확인 사슬과 무관 — populate-kr-da.mjs 는 XBRL 값을 먼저 넣고, 지우는 경우는 출처 기준 ≠ 재무제표 기준뿐인데 같은 기준으로 읽었다) → 실패.
      // XBRL 은 없고 원문 표 후보만 있으면 적재 스크립트가 원문 확인 사슬 실패로 일부러 비웠을 수 있어 검증불가
      if (!pre && !restated && src) {
        const xb = (await xbrlOf(src.fsDiv))[0];
        if (xb) { fail("K3", "감가상각 적재본 해 존재(검증기 XBRL 판독 가능)", colY, `적재본에 ${y} 없음 — 검증기가 사업보고서 XBRL 에서 읽음 ${xb.v}(${xb.how}, ${xb.rcept}) · 앱 ${app ?? "빈칸"}(적재 누락)`); continue; }
        const rd = await docReads([...annualReps(y + 1), ...annualReps(y)], src.fsDiv);
        const ryOf = (rc) => L.reports.find((x) => x.rcept === rc)?.year;
        const docHit = rd.cands.find((c0) => c0.cum !== false && c0.period === (ryOf(c0.rcept) === y ? "cur" : ryOf(c0.rcept) === y + 1 ? "prior" : "none") && c0.v != null);
        if (docHit) add("K3", "감가상각 적재본 해 존재(검증기 XBRL 판독 가능)", colY, { status: NA, note: `적재본에 ${y} 없음 · XBRL 없음 · 원문 후보 ${docHit.v}(${docHit.how}) — 적재 스크립트가 원문 확인 사슬 실패로 비웠을 수 있음(검증불가)` });
      }
      // 줄 판독 규칙(daCfLine)은 앱 krCfDaByYear 와 같은 규칙 문장을 따로 구현한 것이라 독립 판독이 아니다 — 공통모드(감사 7차 ④)
      if (cfLine != null) exact("K3", "감가상각비 = DART 공시 현금흐름 줄(적재본 없는 해)", colY, app, cfLine.v, `${cfLine.how} · 기준 보고서 ${own.by}`, "현금흐름 감가상각 줄 고르기 규칙을 앱과 같은 규칙으로 재구현");
      else if (app == null) add("K3", "감가상각비 = 적재본(kr_da)", colY, pre ? { status: PASS, note: "적재본·공시 줄 없음 · 상장 전 해(KRX 연말 종목 없음) — 빈칸" } : restated ? { status: PASS, note: "적재본·공시 줄 없음 · 연결 재작성 해(연결 손익은 다다음 해 보고서 전전기 열뿐) — 빈칸" } : { status: "fail", note: `적재본에 ${y} 없음 · 공시 줄 없음 · 상장 후 해인데 빈칸(적재 누락)` });
      else fail("K3", "감가상각비 = 적재본(kr_da)", colY, `적재본·DART 공시 현금흐름 줄 모두 없는데 앱 ${app}`);
    }
  }
  // LTM — 손익 TTM 과 같은 구성의 감가상각 TTM 만
  const LT = H.LTM;
  if (!LT) return;
  const hi = h.columns.findIndex((x) => x.kind === "ltm");
  const op = h.rows.find((x) => x.key === "opinc")?.values[hi] ?? null;
  const lp = L.latestPeriod();
  if (!lp) return;
  if (lp.code === "11011") {
    // 최신 정기보고서 = 사업보고서 → LTM 감가상각 = 그 사업연도(앱 규칙 — 손익 TTM 이 연간이면 최근 사업연도)
    const d = doc.byYear?.[lp.year];
    const v = d ? (d.depreciation ?? 0) + (d.amortisation ?? 0) : null;
    const ind = indepY.get(lp.year);
    exact("K3", "LTM EBITDA = LTM 영업이익 + 사업연도 감가상각(최신 정기보고서 = 사업보고서)", "LTM", LT.ebitda, op != null && v != null ? op + v : null, `FY${lp.year} 적재${ind ? ` · 독립 확인 ${ind}` : ""}`, ind ? null : `FY${lp.year} 감가상각이 검증기 독립 판독으로 확인되지 않음`);
    return;
  }
  const tok = (s) => s?.match(/FY(\d{4})\s*\+\s*(\d{4})\s*(1분기|반기|3분기)/)?.slice(1).join("|") ?? null;
  const Y = lp.year;
  const wantTok = `${Y - 1}|${Y}|${QNAME[{ "11013": 1, "11012": 2, "11014": 3 }[lp.code]]}`;
  const fy = doc.byYear?.[Y - 1];
  const fyTot = fy ? (fy.depreciation ?? 0) + (fy.amortisation ?? 0) : null;
  const basis = yearSrc.get(Y - 1)?.fsDiv ?? "CFS";
  const reps = (yy) => L.reports.filter((x) => x.year === yy && x.code === lp.code).sort((a, b) => b.rcept.localeCompare(a.rcept)).map((x) => x.rcept);
  const curR = reps(Y), prevR = reps(Y - 1);
  // 확정 판독만(감사 3차 — 당기 후보가 전년 쪽에도 들어가 「FY + 표 − 같은 표」·당기·전년 뒤바꿈·별도 표가 통과했다):
  //  a = 당기 보고서의 당기 누적 열, b = 전년 누적(당기 보고서의 전기 누적 열 또는 전년 같은 보고서의 당기 누적 열), 같은 표 종류·같은 구성, 같은 후보 금지.
  //  범위 = 재무제표 기준과 같다고 판정된 표만. 적재 출처(ttmSrc)가 성격별이면 성격별 표, 현금흐름 조정(원문)이면 현금흐름 표, 현금흐름 조정이면 XBRL 만
  const cur = await docReads(curR, basis), prev = await docReads(prevR, basis);
  const candPairs = async (kind) => {
    const okDoc = (c0) => c0.cum !== false && (kind === "any" || c0.kind === kind);
    const A = cur.cands.filter((c0) => okDoc(c0) && c0.period === "cur").map((c0) => ({ ...c0, grp: `doc:${c0.kind}:${c0.sig}` }));
    const B = [...cur.cands.filter((c0) => okDoc(c0) && c0.period === "prior"), ...prev.cands.filter((c0) => okDoc(c0) && c0.period === "cur")].map((c0) => ({ ...c0, grp: `doc:${c0.kind}:${c0.sig}` }));
    if (kind === "xbrl" || kind === "any") {
      for (const r of curR) { const f = await xbrlFactsOrNone(r, lp.code); if (f) { A.push(...xbrlCum(f, "CFY", Y, basis).map((x) => ({ ...x, grp: "xbrl" }))); B.push(...xbrlCum(f, "PFY", Y - 1, basis).map((x) => ({ ...x, grp: "xbrl" }))); } }
      for (const r of prevR) { const f = await xbrlFactsOrNone(r, lp.code); if (f) B.push(...xbrlCum(f, "CFY", Y - 1, basis).map((x) => ({ ...x, grp: "xbrl" }))); }
    }
    return { A, B };
  };
  if (doc.ttmDepreciation == null || tok(doc.ttmLabel) !== wantTok) {
    // TTM 이 있어야 하는지(감사 4차 ② — 005930 ttmDepreciation 을 지우자 LTM EBITDA 빈칸이 검증불가로만 남았다): 적재 스크립트 TTM 규칙
    // (populate-kr-da.mjs ttmDa)대로 — 사업연도 적재값이 있고, 같은 종류·구성의 당기·전년 누적 후보 쌍을 검증기가 읽으면 TTM 이 있어야 한다.
    // 사업연도가 영업비용 기준(「+영업비용」)으로 바뀐 회사는 성격별 표만(현금흐름 누적으로 대신하지 않는다 — 한전KPS), 그 밖은 성격별·현금흐름·XBRL 누적
    const fySrc = String(fy?.src ?? "");
    const { A, B } = fyTot == null ? { A: [], B: [] } : await candPairs(/\+영업비용(?!확인)/.test(fySrc) ? "nature" : "any");
    const pair = A.flatMap((a) => B.filter((b) => a !== b && a.grp === b.grp).map((b) => [a, b]))[0];
    const nmT = "LTM 감가상각 TTM 적재";
    const got = `적재 TTM ${doc.ttmLabel ?? "없음"} ≠ 최신 ${wantTok}`;
    if (LT.ebitda != null) add("K3", nmT, "LTM", { status: "fail", note: `${got} 인데 앱 LTM EBITDA ${LT.ebitda}` });
    else if (pair) add("K3", nmT, "LTM", { status: "fail", note: `${got} — 검증기가 누적 후보 쌍을 읽음(FY${Y - 1} ${fyTot}(${fySrc}) + ${pair[0].how} ${pair[0].v} − ${pair[1].how} ${pair[1].v}) · TTM 이 있어야 하는데 앱 LTM EBITDA 빈칸(적재 누락)` });
    else add("K3", nmT, "LTM", { status: NA, note: `${got} — ${fyTot == null ? `적재본 FY${Y - 1} 없음` : "검증기도 같은 종류·구성의 당기·전년 누적 후보 쌍을 못 읽음"} — 앱 LTM EBITDA 빈칸(규칙)` });
    return;
  }
  const v = doc.ttmDepreciation + (doc.ttmAmortisation ?? 0);
  const ts = String(doc.ttmSrc ?? "");
  const kind = /성격별\(손익계산서/.test(ts) ? null : /성격별/.test(ts) ? "nature" : /원문/.test(ts) ? "cf" : /현금흐름/.test(ts) ? "xbrl" : "any";
  const { A, B } = await candPairs(kind);
  const nm0 = "LTM 감가상각 TTM 적재본 = 사업연도 + 당기 누적 − 전년 누적(검증기 원문·XBRL 판독)";
  let hit = null;
  if (fyTot != null) for (const a of A) { for (const b of B) if (a !== b && a.grp === b.grp && fyTot + a.v - b.v === v) { hit = `FY${Y - 1} ${fyTot} + ${a.how} ${a.v} − ${b.how} ${b.v}`; break; } if (hit) break; }
  const fyInd = indepY.get(Y - 1);
  if (hit) add("K3", nm0, "LTM", { status: PASS, note: `${doc.ttmLabel} = ${hit}${fyInd ? "" : " · 사업연도 값은 독립 판독 안 됨"}` });
  else if (fyTot == null || !A.length || !B.length || !A.some((a) => B.some((b) => a.grp === b.grp))) add("K3", nm0, "LTM", { status: COMMON, note: `${doc.ttmLabel}(${ts}) — ${fyTot == null ? `적재본 FY${Y - 1} 없음` : "확정 판독 불가(같은 종류·구성의 당기·전년 누적 후보 쌍 없음)"} — 공통모드` });
  else fail("K3", nm0, "LTM", `적재 TTM ${v}(${doc.ttmLabel}, ${doc.ttmSrc ?? ""}) — 사업연도 ${fyTot} + 누적 후보 ${A.length}개 − 전년 후보 ${B.length}개 조합 중 같은 값 없음`);
  const ind = hit && fyInd;
  if (op != null || LT.ebitda != null) exact("K3", "LTM EBITDA = LTM 영업이익 + 감가상각 TTM(적재본)", "LTM", LT.ebitda, op != null ? op + v : null, `적재 ${doc.ttmLabel}`, ind ? null : "감가상각 TTM 이 검증기 독립 판독으로 확인되지 않음");
}

/** 단위 안전장치 — 해 → 값 지도에서 이웃 해(바로 앞 해)와 크기(절댓값)가 100배 넘게 다르거나 부호가 다르면 실패(1000배 단위 오류를 태그·단위 표기와 무관하게 잡는다) */
function unitGuard(byYear, layer, name, add, fail, PASS) {
  const ys = [...byYear.keys()].sort((a, b) => a - b);
  for (let i = 1; i < ys.length; i++) {
    const a = byYear.get(ys[i - 1]), b = byYear.get(ys[i]);
    if (a == null || b == null || a === 0 || b === 0 || ys[i] - ys[i - 1] !== 1) continue;
    const r = Math.max(Math.abs(a), Math.abs(b)) / Math.min(Math.abs(a), Math.abs(b));
    if (Math.sign(a) !== Math.sign(b)) fail(layer, name, `${ys[i]}Y`, `FY${ys[i - 1]} ${a} vs FY${ys[i]} ${b} — 부호가 다름(부호 오류 의심)`);
    else if (r > 100) fail(layer, name, `${ys[i]}Y`, `FY${ys[i - 1]} ${a} vs FY${ys[i]} ${b} (크기 ${r.toFixed(0)}배) — 단위 오류 의심`);
    else add(layer, name, `${ys[i]}Y`, { status: PASS, note: `FY${ys[i - 1]} 대비 ${r.toFixed(2)}배` });
  }
}
