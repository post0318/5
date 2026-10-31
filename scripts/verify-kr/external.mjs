/**
 * 검증기 — 한국 외부 대조(F층, 2026-10-31 재구성). 앱 코드를 읽지 않고 FnGuide·Yahoo 값을 원자료(DART·KRX)와 **식으로** 맞춰 본다.
 *
 * 칸마다 소스별 판정(오너 결정 D1 — 허용오차 없음):
 *  - 일치: 외부 값 = 앱 값(정확히)
 *  - 정밀도 부족: 외부 표기 단위로 앱 값을 반올림·버림하면 외부 값과 같다(억원·백만원 표기, Yahoo 10원 끊김). 야후는 합산 항목(EBITDA·총차입금 등)의
 *    천원 미만 끝자리가 흐트러진다(실측 — 원 단위 정밀 공시값 대비 |차| < 1,000원이고 야후 값이 공시 단위 아래 숫자를 가짐) → 정밀도 부족
 *  - 불일치 → 원인 판정: 아래 식이 **원자료로 성립할 때만** 「식으로 원인 확인」, 앱 값이 DART 원자료와 정확히 같고(A·K층 통과) 외부가 자체 계산이면
 *    「앱=DART 원자료, 외부 자체 정의」, 그 밖은 「원인 미확인」
 * 칸 최종(D2 — 한국은 계보가 다른 외부 1곳): 한 곳이라도 일치 → 일치 / 불일치 소스가 모두 식으로 원인 확인 → 식으로 원인 확인 / 식·자체 정의뿐 → 앱=DART 원자료,
 *  외부 자체 정의 / 원인 미확인 불일치가 하나라도 → 원인 미확인 / 정밀도 부족만 → 정밀도 부족 / 외부 값 없음 → 값 없음
 *
 * 원인 식(소스·항목별):
 *  R1 판본 — 외부 = DART 이전 판본(처음 공시·다음 해 보고서 전기), 앱 = 최신 재작성(A층 통과)
 *  R2 FnGuide EV = FnGuide 시가총액 + 순부채(용어 설명 「EV = 시가총액 + 순부채」, 「순부채 = 총차입부채 − (현금및현금성자산 + 단기금융자산)」). 검증기는
 *     FnGuide 순부채(재무비율 화면, 백만원)가 DART 총차입금 − 현금성자산(K2 원자료 값)과 백만원 표기로 같고, KRX 보통주 + 우선주 시가총액(K1) + FnGuide 순부채를
 *     억원 표기하면 FnGuide EV 와 같을 때 「비지배지분 제외 정의」로 닫는다. 순부채가 다르면 그 차를 보고서 주석 표 숫자에서 찾는다(R5)
 *  R3 시가총액 차 — 순부채는 같은데 FnGuide 시가총액(EV − 순부채) ≠ KRX → 앱 시가총액 = KRX(K1 통과)라 「앱=원자료, 외부 자체 정의」
 *  R4 감가상각 — 외부 = 사업보고서 XBRL 주석의 감가상각 개념 묶음(유형·사용권·투자부동산·무형, 현금흐름 조정)과 같다(정해 둔 묶음만 — 아무 부분합이나 찾지 않음)
 *  R5 주석 값 — 외부 − 앱 차가 그 해 사업보고서 원문 주석 표 숫자(표 단위, 유효숫자 4자리 이상) 하나와 같고 그 숫자 앞 줄 이름에 정해 둔 낱말(파생·리스·
 *     사용권·투자부동산 등)이 있을 때
 *  R6 구성 — EBITDA = 영업이익 + 감가상각(야후는 검증기가 그렇게 만들었다), EV/EBITDA = EV ÷ EBITDA: 구성 칸이 모두 일치·정밀도 부족·식으로 원인 확인이면 닫힌다
 * 앱이 틀렸을 가능성(appSuspect): 외부 감가상각 − 앱 = 사용권자산 상각(앱 EV 는 리스부채를 넣으므로 같은 기준 원칙에 어긋남), 외부 총차입금 − 앱 = 파생상품부채
 *  (B16 「(유동|비유동)금융부채」 줄 전체 사용), 계보가 다른 외부 두 곳이 서로 같은데 앱만 다름
 * 기준일이 다른 칸은 대조하지 않는다 — 앱 LTM EV·EV/EBITDA 는 현재 시가총액, FnGuide 최근 분기 열은 그 분기말 시가총액
 */
import { dartList, dartXbrlFacts, dartDocNumberStreams, DartNoFileError } from "./dart.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const num = (s) => { if (s == null || s === "") return null; const n = Number(String(s).replace(/,/g, "")); return Number.isFinite(n) ? n : null; };

async function fgPage(page, code) {
  const r = await fetch(`https://wcomp.fnguide.com/CompanyInfo/${page}?cmp_cd=${code}`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`FnGuide ${page} HTTP ${r.status}`);
  const html = await r.text();
  const got = /cmp_cd:\s*'(\d{6})'/.exec(html)?.[1];
  if (got !== code) throw new Error(`FnGuide ${page} 응답 종목 ${got} ≠ 요청 ${code}`);
  return html;
}
function fgBlock(html, key) {
  const i = html.indexOf(`${key}:`);
  if (i < 0) return null;
  const s = html.indexOf("{", i), e = html.indexOf("\n", s);
  return JSON.parse(html.slice(s, e).trim().replace(/,\s*$/, ""));
}
function fgRows(j, nmKey = "NM") {
  if (!j?.header) return [];
  const cols = j.header.map((h) => ({ ym: String(h.YYMM).slice(0, 7), cd: h.CD }));
  return j.data.map((d) => ({ grp: d.GRP_CD, nm: String(d[nmKey] ?? d.NAME ?? d.NM ?? "").trim(), vals: Object.fromEntries(cols.map((c) => [c.ym, num(d[c.cd])])) }));
}
/** FnGuide 투자지표(억원)·재무제표(억원 소수 둘째 = 백만원)·재무비율 순부채(백만원). 금융업처럼 표가 없는 화면은 빈 값 */
export async function fnguideAll(code) {
  const inv = fgRows(fgBlock(await fgPage("Invest", code), "invValueIndex"));
  const fin = await fgPage("Finance", code);
  const bal = fgRows(fgBlock(fin, "finBalance"), "NAME"), inc = fgRows(fgBlock(fin, "finIncome"), "NAME");
  const rto = fgRows(fgBlock(await fgPage("FinanceRatio", code), "rtoAccumulate"));
  const pick = (rows, grp, nm) => rows.find((x) => (grp == null || x.grp === grp) && x.nm === nm)?.vals ?? {};
  return {
    ebitda: pick(inv, 3, "EBITDA"), ev: pick(inv, 3, "EV"), evx: pick(inv, 3, "EV/EBITDA"), rev: pick(inv, 3, "매출액"), eps: pick(inv, 3, "EPS"),
    niParent: pick(inv, 1, "당기순이익(지배)"),
    nci: pick(bal, null, "비지배주주지분"), niP: pick(inc, null, "(지배주주지분)당기순이익"), niN: pick(inc, null, "(비지배주주지분)당기순이익"),
    nd: pick(rto, null, "순부채"),
    cashF: pick(bal, null, "현금및현금성자산"), stF: pick(bal, null, "단기금융자산"),
  };
}

/** 값을 나누는 가장 큰 10의 거듭제곱(최대 1억) — 소수면 null */
const unitOf = (v) => { if (!Number.isInteger(v)) return null; let u = 1; const a = Math.abs(v); if (a === 0) return 1; while (u < 1e8 && a % (u * 10) === 0) u *= 10; return u; };
const rnd = (x, u) => Math.sign(x) * Math.round(Math.abs(x) / u) * u;
const trc = (x, u) => Math.sign(x) * Math.floor(Math.abs(x) / u) * u;
const rnd2 = (x) => Math.round(x * 100) / 100; // 배수(소수 둘째)
/** 외부 표기 단위(u)로 x 를 반올림하거나 버리면 v 와 같은가 — 허용오차가 아니라 표기 식 */
const shownAs = (x, v, u) => u != null && u > 1 && (rnd(x, u) === v || trc(x, u) === v);

/** 소스 하나 판정 — 일치·정밀도 부족·불일치·값없음·앱빈칸 */
function clsOf(src, item, ours, v) {
  if (v == null) return { cls: "값없음" };
  if (ours == null) return { cls: "앱빈칸" };
  if (/EV\/EBITDA/.test(item)) {
    if (v === ours) return { cls: "일치" };
    return rnd2(ours) === v || Math.trunc(ours * 100) / 100 === v ? { cls: "정밀도부족", why: "외부 소수 둘째 자리 표기" } : { cls: "불일치" };
  }
  if (/EPS/.test(item)) return v === ours ? { cls: "일치" } : Number.isInteger(ours) || !Number.isInteger(v) ? { cls: "불일치" } : rnd(ours, 1) === v ? { cls: "정밀도부족", why: "외부 정수 표기" } : { cls: "불일치" };
  if (v === ours) return { cls: "일치" };
  const ue = unitOf(v), uo = unitOf(ours);
  if (ue != null && uo != null && ue > uo && shownAs(ours, v, ue)) return { cls: "정밀도부족", why: `외부 표기 단위 ${ue}원(반올림·버림 식)` };
  if (src === "Yahoo" && Math.abs(v - ours) < 1000 && v % 10 === 0 && (uo == null || ue == null || ue < uo || uo < 10))
    return { cls: "정밀도부족", why: `야후 끝자리(천원 미만 흐트러짐 — 차 ${v - ours}원)` };
  return { cls: "불일치" };
}

// 감가상각 개념 묶음(R4) — 종류마다 하나씩만 골라 더한다(같은 금액을 두 번 세지 않게)
const DA_CLASS = {
  ppe: ["DepreciationPropertyPlantAndEquipment", "DepreciationExpense", "AdjustmentsForDepreciationExpense"],
  rou: ["DepreciationRightofuseAssets", "AdjustmentsForDepreciationRightofuseAssets", "DepreciationRightOfUseAssets"],
  inv: ["DepreciationInvestmentProperty", "AdjustmentsForDepreciationInvestmentProperty"],
  int: ["AmortisationExpense", "AmortisationIntangibleAssetsOtherThanGoodwill", "AdjustmentsForAmortisationExpense"],
};
const DA_LABEL = { ppe: "유형(감가상각비)", rou: "사용권자산", inv: "투자부동산", int: "무형자산상각" };
function daCombos(facts, prefix, basis) {
  const want = (ctx) => ctx === prefix || ctx === `${prefix}_ifrs-full_ConsolidatedAndSeparateFinancialStatementsAxis_ifrs-full_${basis === "OFS" ? "Separate" : "Consolidated"}Member`;
  const one = new Map();
  for (const [c, ctx, x] of facts) { if (!want(ctx)) continue; const k = c.split(":")[1]; one.set(k, one.has(k) && one.get(k) !== x ? NaN : x); }
  const opts = Object.entries(DA_CLASS).map(([k, names]) => [k, [null, ...names.filter((n) => Number.isFinite(one.get(n)))]]);
  const out = [];
  const rec = (i, pick) => {
    if (i === opts.length) {
      const used = Object.entries(pick).filter(([, n]) => n);
      if (!used.some(([k]) => k === "ppe")) return; // 유형 감가상각 없는 묶음은 감가상각 정의가 아니다
      out.push({ sum: used.reduce((a, [, n]) => a + one.get(n), 0), parts: used.map(([k, n]) => ({ k, n, v: one.get(n) })) });
      return;
    }
    for (const n of opts[i][1]) rec(i + 1, { ...pick, [opts[i][0]]: n });
  };
  rec(0, {});
  // 한 개념이 다른 묶음 합과 같은 총액 개념(DepreciationAndAmortisationExpense)은 따로 하나
  if (Number.isFinite(one.get("DepreciationAndAmortisationExpense"))) out.push({ sum: one.get("DepreciationAndAmortisationExpense"), parts: [{ k: "tot", n: "DepreciationAndAmortisationExpense", v: one.get("DepreciationAndAmortisationExpense") }] });
  return out;
}

export async function krExternal(ctx) {
  const { sym, corp, H, IS, checks, dartVint, yahoo, consts } = ctx;
  const { PASS } = consts;
  const review = [], errs = [];
  // 검증기가 원자료로 확인한 값(K·A층 통과 검사의 src)
  const K = (re, col) => { const c = checks.find((k) => k.status === PASS && k.col === col && (typeof re === "string" ? k.name === re : re.test(k.name))); return c ? (c.src ?? null) : undefined; };
  const items = new Map(); // key → { ours, src: { 소스: { v, cause?(ours,v) } } }
  const put = (src, key, ours, v, cause) => {
    const it = items.get(key) ?? { ours, src: {} };
    if (it.ours == null && ours != null) it.ours = ours;
    it.src[src] = { v: v ?? null, cause };
    items.set(key, it);
  };
  const L = corp ? await dartList(corp) : null;
  const lp = L?.latestPeriod() ?? null;
  const ltmEnd = lp ? `${lp.year}/${String({ "11013": 3, "11012": 6, "11014": 9, "11011": 12 }[lp.code]).padStart(2, "0")}` : null;
  const ltmIso = ltmEnd ? `${ltmEnd.slice(0, 4)}-${ltmEnd.slice(5)}-${{ "03": "31", "06": "30", "09": "30", "12": "31" }[ltmEnd.slice(5)]}` : null;

  // ── 원자료 보조: 그해 사업보고서 판본들(최신 먼저, 014 건너뜀)의 원문 숫자 흐름 · XBRL 감가상각 사실 ──
  const docMemo = new Map();
  const docStreams = async (y) => {
    if (!docMemo.has(y)) docMemo.set(y, (async () => {
      for (const r of (L?.reports ?? []).filter((x) => x.year === y && x.code === "11011").sort((a, b) => b.rcept.localeCompare(a.rcept))) {
        const st = await dartDocNumberStreams(r.rcept);
        if (st.length) return { rcept: r.rcept, st };
      }
      return null;
    })());
    return docMemo.get(y);
  };
  /**
   * R5 — |delta| 원을 그해(또는 다음 해) 보고서 주석 표 숫자에서 찾는다. prec = 외부 정밀도(원). 같은 숫자가 여러 표에 나오면 줄 이름(그 숫자 앞의 가까운
   * 이름 네 개)에 낱말 목록 kws 의 앞 낱말이 든 것을 고른다(파생 > 리스 > …). 낱말이 하나도 없으면 원인으로 쓰지 않는다
   */
  const noteHit = async (y, delta, prec, kws) => {
    const d = Math.abs(delta);
    const hits = [];
    // 차가 외부 정밀도보다 작으면 원인 숫자를 찾지 않는다(정밀도 흐트러짐 — 0 같은 숫자에 우연히 걸린다, 001440 2024 −995,639원 = '파생상품' 0)
    if (!(d >= prec)) return null;
    for (const yy of [y, y + 1]) {
      const D = await docStreams(yy).catch((e) => { errs.push(`원문 ${yy}: ${String(e?.message ?? e).slice(0, 80)}`); return null; });
      if (!D) continue;
      for (const { u, toks } of D.st) for (let i = 0; i < toks.length; i++) {
        const t = toks[i], x = Math.abs(t.v) * u;
        if (t.v === 0) continue;
        const small = Math.abs(t.v) < 1000; // 유효숫자 4자리 미만은 우연 일치 위험 — 그 숫자 바로 앞 이름이 첫째·둘째 낱말(파생·리스 / 사용권·투자부동산)일 때만
        if (!(Math.abs(x - d) < prec)) continue; // 외부 값의 정밀도(야후 1,000원 끝자리, FnGuide 순부채 백만원) 안에서 같은 숫자
        const names = [];
        for (let j = i; j >= Math.max(0, i - 14) && names.length < 4; j--) {
          const b = toks[j].before.trim(), h = b.replace(/[^가-힣A-Za-z]/g, "");
          if (h && !/^(합계|계|소계|총계)$/.test(h)) names.push(b.slice(-40));
        }
        // 가까운 이름부터 — 가장 가까운 이름이 낱말에 걸리면 그 이름(먼 이름의 낱말은 옆 줄일 수 있다 — 029780 '리스부채 ← … ← 파생상품부채')
        let rank = -1, name = "";
        for (let p0 = 0; p0 < names.length && rank < 0; p0++) { const k = kws.findIndex((re) => re.test(names[p0])); if (k >= 0) { rank = p0 * 100 + k; name = names[p0]; } }
        if (small && !(rank >= 0 && rank < 2)) continue;
        if (rank >= 0) hits.push({ v: t.v, u, label: name, near: names.join(" ← "), rcept: D.rcept, rank });
      }
      if (hits.length) break;
    }
    return hits.sort((a, b) => a.rank - b.rank)[0] ?? null;
  };
  const KW_DEBT = [/파생/, /리스|사용권/, /금융보증/, /보증금/, /예치|금융상품/, /전환|교환|상환/, /미지급/, /차입|사채/, /금융부채|금융자산|당기손익/];
  const KW_DA = [/사용권/, /투자부동산/, /무형/, /감가|상각/];
  const xbrlMemo = new Map();
  const xbrlOf = async (rcept) => {
    if (!xbrlMemo.has(rcept)) xbrlMemo.set(rcept, dartXbrlFacts(rcept, "11011").catch((e) => { if (!(e instanceof DartNoFileError)) errs.push(`XBRL ${rcept}: ${String(e?.message ?? e).slice(0, 80)}`); return null; }));
    return xbrlMemo.get(rcept);
  };
  /** 그해 감가상각 개념 묶음 — 그해 보고서 당기(CFY), 다음 해 보고서 전기(PFY, 재작성) */
  const daOf = async (y) => {
    const out = [];
    for (const [ry, pre] of [[y, `CFY${y}dFY`], [y + 1, `PFY${y}dFY`]]) {
      const r = L?.latest(ry, "11011"); if (!r) continue;
      const f = await xbrlOf(r.rcept); if (!f) continue;
      for (const c of daCombos(f, pre, "CFS")) out.push({ ...c, rcept: r.rcept });
    }
    return out;
  };
  const daText = (c) => c.parts.map((p) => `${DA_LABEL[p.k] ?? "감가상각비 합계"}(${p.n}) ${p.v}`).join(" + ");

  // R1 판본 / 앱=DART
  const F2A = { "매출": "매출액", "영업이익": "영업이익", "순이익(연결)": "당기순이익(연결)", "순이익(지배)": "당기순이익(지배)", "EPS": "희석 EPS" };
  const vint = (col, m) => (ours, v, unit) => {
    const a = dartVint[`${col}|${F2A[m] ?? ""}`];
    if (!a || !a.pass || ours !== a.app) return null;
    const old = (a.vAll ?? []).find((x) => x.v !== a.latest && (x.v === v || shownAs(x.v, v, unit)));
    if (old) return { kind: "eq", why: `외부 = DART ${old.by} 사업보고서 판본 ${old.v}, 앱 = 최신 보고서 ${a.latest}` };
    return { kind: "self", why: `앱 = DART 공시값 ${a.latest}(A층 정확 일치) — 외부는 자체 계산·정의` };
  };
  /** 검증기가 원자료로 확인한 그해 감가상각(K3 — 적재본 = 원문·XBRL 독립 판독 통과, 또는 손익계산서 본표 감가상각 줄) */
  const kDa = (col) => K(/^감가상각비 = (적재본\(kr_da\)|DART 손익계산서 본표 감가상각 줄)/, col) ?? null;
  const kSelf = (re, col) => (ours) => { const s = K(re, col); return s != null && s === ours ? { kind: "self", why: `앱 = DART 원자료 ${s}(${typeof re === "string" ? re : re.source} 통과) — 외부는 자체 계산·정의` } : null; };

  // ── FnGuide ──
  let fg = null;
  try { fg = await fnguideAll(sym); } catch (e) { errs.push(`FnGuide: ${String(e?.message ?? e).slice(0, 100)}`); }
  // ── Yahoo ──
  let ya = [], yt = [], yq = [];
  try {
    const y = await yahoo();
    for (const suf of [".KS", ".KQ"]) {
      ya = (await y.fundamentalsTimeSeries(sym + suf, { period1: "2018-01-01", type: "annual", module: "all" }, { validateResult: false })).filter((r) => r.totalRevenue != null);
      if (ya.length) {
        yt = await y.fundamentalsTimeSeries(sym + suf, { period1: "2024-01-01", type: "trailing", module: "all" }, { validateResult: false });
        yq = await y.fundamentalsTimeSeries(sym + suf, { period1: "2024-01-01", type: "quarterly", module: "all" }, { validateResult: false });
        break;
      }
    }
    if (!ya.length) throw new Error("연간 재무 없음(.KS·.KQ)");
  } catch (e) { errs.push(`Yahoo: ${String(e?.message ?? e).slice(0, 100)}`); }
  const iso = (d) => new Date(typeof d === "number" ? d * 1000 : d).toISOString().slice(0, 10);
  const dd = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;

  const yDaCombo = new Map(); // 연도 → 야후 감가상각을 닫은 묶음(FnGuide EBITDA 가 같은 묶음을 쓰는지 볼 때)
  for (const [col, x] of Object.entries(H)) {
    const isL = col === "LTM";
    const y = isL ? null : Number(col.slice(0, 4));
    const ym = isL ? ltmEnd : `${col.slice(0, 4)}/12`;
    const key = (m) => `${col} ${m}`;
    const op = isL ? x.opinc ?? null : IS[col]?.op ?? null;
    // ── FnGuide 칸 ──
    if (fg) {
      const e8 = (v) => (v == null ? null : Math.round(v * 1e8));
      const fEbitda = e8(fg.ebitda[ym]);
      if (!isL || ym) put("FnGuide", key("EBITDA"), x.ebitda, fEbitda, isL ? null : async (ours, v) => {
        // R4/R6 — FnGuide EBITDA = DART 영업이익(A층) + 감가상각 묶음(야후를 닫은 묶음, 없으면 억원 표기로 하나만 맞는 묶음)
        if (op == null) return null;
        // 앱 쪽도 원자료로 닫혀야 — 앱 EBITDA = DART 영업이익 + 검증기가 확인한 감가상각(K3)
        const kda = kDa(col);
        if (kda == null || ours !== op + kda) return null;
        // 영업이익 후보 = 앱(최신 판본, A층) + DART 이전 판본(그해·다음 해 보고서 — 외부가 재작성 전 값을 쓰는 경우, 006400 2022)
        const va = dartVint[`${col}|영업이익`];
        const ops = [{ v: op, how: `DART 영업이익 ${op}` }, ...((va?.vAll ?? []).filter((z) => z.v !== op).map((z) => ({ v: z.v, how: `DART ${z.by} 사업보고서 판본 영업이익 ${z.v}` })))];
        const yc = yDaCombo.get(y);
        const das = [{ sum: kda, text: `앱과 같은 감가상각 ${kda}(K3)` }, ...(yc ? [yc] : await daOf(y)).map((c) => ({ sum: c.sum, pinned: c === yc, text: c.text ?? `XBRL ${daText(c)}(${c.rcept})` }))];
        let hit = [];
        for (const o of ops) for (const d0 of das) if (o.v != null && d0.sum != null && shownAs(o.v + d0.sum, v, 1e8)) hit.push({ o, d0 });
        // 여러 조합이 억원 표기로 맞으면 — 야후가 원자료로 따로 닫은 감가상각 묶음(pinned)을 쓴 조합만 남긴다(그 묶음이 독립 근거)
        if (new Set(hit.map((h0) => h0.o.v + h0.d0.sum)).size > 1 && hit.some((h0) => h0.d0.pinned)) hit = hit.filter((h0) => h0.d0.pinned);
        if (hit.length && new Set(hit.map((h0) => h0.o.v + h0.d0.sum)).size === 1)
          return { kind: "eq", why: `FnGuide EBITDA(억원) = ${hit[0].o.how} + ${hit[0].d0.text} 의 억원 표기 — 앱 EBITDA = 최신 영업이익 + 영업비용 기준 감가상각` };
        return hit.length ? { why: `억원 표기로 맞는 조합이 여럿(${hit.length}) — 하나로 못 정함` } : null;
      });
      if (!isL) {
        // EV·순차입금 — 기준일 같은 연말만(앱 LTM EV 는 현재 시가총액이라 FnGuide 분기말 EV 와 기준일이 다르다)
        const fEv = e8(fg.ev[ym]), fNd = fg.nd[ym] == null ? null : Math.round(fg.nd[ym] * 1e6) * 100;
        const mc = K("시가총액(보통주) = KRX 연말", col), pf = K("우선주 시가총액 = KRX 연말", col);
        const debt = K("총차입금 = DART(B16)", col), cash = K("현금성자산 = DART(B16)", col), nci = K("비지배지분 = DART", col);
        const nd = debt != null && cash != null ? debt - cash : null;
        const ndCause = async (ours, v) => {
          if (nd == null || v == null) return null;
          if (shownAs(nd, v, 1e6) || nd === v) return { kind: "eq", why: `FnGuide 순부채 = DART 총차입금 ${debt} − 현금성자산 ${cash}(K2) 의 백만원 표기` };
          const hit = await noteHit(y, v - nd, 1e6, KW_DEBT);
          if (!hit) {
            // 못 닫은 칸 — FnGuide 재무상태표(최근 3년)가 있으면 순부채를 총차입부채(역산)·현금성으로 나눠 어느 쪽 차인지 남긴다
            const fc = fg.cashF[ym] != null && fg.stF[ym] != null ? Math.round((fg.cashF[ym] + fg.stF[ym]) * 1e6) * 100 : null;
            return { why: `순부채 차 ${v - nd}원(FnGuide − DART B16) — 원문 주석 숫자에서 못 찾음${fc != null ? ` · FnGuide 현금+단기금융자산 ${fc} vs 검증기 현금성자산 ${cash}(차 ${fc - cash}) · FnGuide 총차입부채(순부채 + 현금성 역산) ${v + fc} vs 검증기 총차입금 ${debt}(차 ${v + fc - debt})` : ""}` };
          }
          if (hit) return { kind: "eq", why: `FnGuide 순부채 − DART(B16) 순차입금 = ${v - nd}원 = 원문 ${hit.rcept} 주석 '${hit.label}' ${hit.v}(단위 ${hit.u}원)`, label: hit.label, suspect: /파생/.test(hit.label) && !/자산/.test(hit.label) && v < nd ? `외부(FnGuide)가 파생상품부채('${hit.label.slice(0, 60)}')를 뺀 순부채 — 앱 총차입금이 「(유동|비유동)금융부채」 줄 전체(파생상품부채 포함)를 쓴다` : null };
          return null;
        };
        // 앱 순차입금 = 앱 총차입금 − 앱 현금성(하이라이트 현금 칸은 음수 표시). 원인 식은 앱 값이 K2 원자료 값과 같을 때만
        const appNd = x.debt != null && x.cash != null ? x.debt + x.cash : null;
        put("FnGuide", key("순차입금"), appNd, fNd, async (ours, v) => (nd != null && ours === nd ? ndCause(ours, v) : null));
        put("FnGuide", key("EV"), x.ev, fEv, async (ours, v) => {
          if (mc == null || pf == null || fNd == null || nd == null || nci == null) return null;
          // 앱 쪽도 원자료로 닫혀야 — 앱 EV = KRX 보통주 + 우선주 + DART 총차입금 + 비지배지분 − 현금성자산(K1·K2 원자료 값)
          if (ours !== mc + pf + nd + nci) return null;
          const mcOk = shownAs(mc + pf + fNd, v, 1e8) || mc + pf + fNd === v;
          const ndC = await ndCause(nd, fNd);
          if (mcOk && ndC?.kind) return { kind: "eq", suspect: ndC.suspect ?? null, why: `FnGuide EV = KRX 보통주 ${mc} + 우선주 ${pf} + FnGuide 순부채 ${fNd}(억원 표기) — 비지배지분 ${nci ?? "?"} 제외 정의 · 순부채: ${ndC.why}`, label: ndC.label };
          if (mcOk && ndC && !ndC.kind) return { why: `FnGuide EV = KRX 보통주 + 우선주 + FnGuide 순부채(억원 표기 성립) — 남은 차 = 비지배지분 ${nci} 제외 + ${ndC.why}` };
          if (!mcOk && ndC?.kind) return { kind: "self", why: `FnGuide 시가총액(EV − 순부채) ${v - fNd} ≠ KRX 보통주 + 우선주 ${mc + pf}(앱 = KRX, K1 통과) — 외부 시가총액 자체 정의 · 순부채: ${ndC.why}` };
          return null;
        });
        put("FnGuide", key("비지배지분"), x.nci, fg.nci[ym] == null ? null : Math.round(fg.nci[ym] * 1e6) * 100, kSelf("비지배지분 = DART", col));
        put("FnGuide", key("매출"), IS[col]?.rev ?? null, e8(fg.rev[ym]), vint(col, "매출"));
        put("FnGuide", key("EPS"), x.eps, fg.eps[ym] ?? null, vint(col, "EPS"));
        const fN = fg.niP[ym], fM = fg.niN[ym];
        put("FnGuide", key("순이익(연결)"), x.ni, fN != null && fM != null ? Math.round((fN + fM) * 1e6) * 100 : null, vint(col, "순이익(연결)"));
        put("FnGuide", key("순이익(지배)"), IS[col]?.niParent ?? null, e8(fg.niParent[ym]), vint(col, "순이익(지배)"));
        // EV/EBITDA — FnGuide 배수(소수 둘째)
        put("FnGuide", key("EV/EBITDA"), x.evx, fg.evx[ym] ?? null, (ours, v) => {
          const e = fEv, b = fEbitda;
          if (e == null || b == null || !b) return null;
          if (rnd2(e / b) !== v && Math.trunc((e / b) * 100) / 100 !== v) return null;
          return { kind: "compose", parts: [key("EV"), key("EBITDA")], why: `FnGuide EV/EBITDA = FnGuide EV ${e} ÷ FnGuide EBITDA ${b} — 두 구성 칸 판정을 따른다` };
        });
      } else if (ym && fg.rev[ym] != null) {
        put("FnGuide", key("매출"), x.revenue ?? null, e8(fg.rev[ym]), kSelf(/^LTM 매출 = DART/, "LTM"));
      }
    }
    // ── Yahoo 칸 ──
    const yr = isL ? yt.find((r) => r.date && ltmIso && dd(iso(r.date), ltmIso) <= 7 && r.totalOperatingIncomeAsReported != null) : ya.find((r) => dd(iso(r.date), x.date) <= 7);
    if (!yr) continue;
    const yDep = yr.reconciledDepreciation ?? null;
    const yOp = yr.totalOperatingIncomeAsReported ?? null;
    if (!isL) {
      put("Yahoo", key("매출"), IS[col]?.rev ?? null, yr.totalRevenue ?? null, vint(col, "매출"));
      put("Yahoo", key("영업이익"), op, yOp, vint(col, "영업이익"));
      put("Yahoo", key("감가상각비"), IS[col]?.da ?? null, yDep, async (ours, v) => {
        // R4 — 야후 = XBRL 감가상각 묶음(야후 끝자리 흐트러짐 < 1,000원 안). 앱 값은 K3 에서 원자료로 확인된 값이어야
        if (kDa(col) == null || kDa(col) !== ours) return null;
        const cs = (await daOf(y)).filter((c) => Math.abs(c.sum - v) < 1000);
        if (cs.length && new Set(cs.map((c) => c.sum)).size === 1) {
          const c = cs.sort((a, b) => a.parts.length - b.parts.length)[0];
          yDaCombo.set(y, c);
          const rou = c.parts.find((p) => p.k === "rou");
          const suspect = rou && ours != null && Math.abs(ours + rou.v - c.sum) < Math.max(1e6, Math.abs(c.sum) * 1e-6) ? `앱 감가상각 ${ours} + 사용권자산 상각 ${rou.v} ≈ 외부 ${v} — 앱 감가상각(영업비용 기준)에 사용권자산 상각이 빠졌을 수 있다(EV 에 리스부채를 넣는 같은 기준 원칙)` : null;
          return { kind: "eq", why: `야후 감가상각 = XBRL ${daText(c)} = ${c.sum}(${c.rcept}) — 앱은 영업비용 기준(성격별 주석)`, suspect };
        }
        // 야후 값 자체가 그해 보고서 원문 주석의 감가상각 숫자(재작성 전 판본 — 뒤 보고서가 중단영업 분리 등으로 고친 값)인가
        const own = await noteHit(y, v, 1000, [/감가상각|상각비/]);
        if (own) yDaCombo.set(y, { sum: own.v * own.u, text: `원문 ${own.rcept} 주석 '${own.label}' ${own.v}(단위 ${own.u}원)` });
        if (own) return { kind: "eq", why: `야후 감가상각 ${v} = 원문 ${own.rcept} 주석 '${own.label}' ${own.v}(단위 ${own.u}원) — 그해(또는 다음 해) 보고서 값, 앱은 영업이익과 같은 최신 보고서 영업비용 기준 ${ours}` };
        const hit = await noteHit(y, v - ours, 1000, KW_DA);
        if (hit) return { kind: "eq", why: `야후 − 앱 = ${v - ours}원 = 원문 ${hit.rcept} 주석 '${hit.label}' ${hit.v}(단위 ${hit.u}원)`, suspect: /사용권/.test(hit.label) ? `차 = 사용권자산 상각('${hit.label}') — 앱 감가상각에 사용권자산 상각이 빠졌을 수 있다(EV 리스부채 포함과 같은 기준 원칙)` : null };
        return null;
      });
      put("Yahoo", key("총차입금"), x.debt, yr.totalDebt ?? null, async (ours, v) => {
        const hit = await noteHit(y, v - ours, 1000, KW_DEBT);
        if (!hit) return null;
        return { kind: "eq", why: `야후 − 앱 = ${v - ours}원 = 원문 ${hit.rcept} 주석 '${hit.label}' ${hit.v}(단위 ${hit.u}원)`, label: hit.label, suspect: /파생/.test(hit.label) && !/자산/.test(hit.label) && v < ours ? `외부가 파생상품부채('${hit.label}')를 뺀 값 — 앱 총차입금이 「(유동|비유동)금융부채」 줄 전체(파생상품부채 포함)를 쓴다` : null };
      });
      put("Yahoo", key("순이익(연결)"), x.ni, yr.netIncomeIncludingNoncontrollingInterests ?? null, vint(col, "순이익(연결)"));
      put("Yahoo", key("순이익(지배)"), IS[col]?.niParent ?? null, yr.netIncomeCommonStockholders ?? yr.netIncome ?? null, vint(col, "순이익(지배)"));
      put("Yahoo", key("EPS"), x.eps, yr.dilutedEPS ?? null, vint(col, "EPS"));
      put("Yahoo", key("비지배지분"), x.nci, yr.minorityInterest ?? null, kSelf("비지배지분 = DART", col));
    } else {
      put("Yahoo", key("매출"), x.revenue ?? null, yr.totalRevenue ?? null, kSelf(/^LTM 매출 = DART/, "LTM"));
      put("Yahoo", key("영업이익"), x.opinc ?? null, yOp, kSelf(/^LTM 영업이익 = DART/, "LTM"));
      put("Yahoo", key("순이익(연결)"), x.ni, yr.netIncomeIncludingNoncontrollingInterests ?? null, kSelf(/^LTM 순이익\(연결\) = DART/, "LTM"));
      const q = yq.find((r) => r.date && ltmIso && dd(iso(r.date), ltmIso) <= 7);
      if (q) {
        put("Yahoo", key("총차입금"), x.debt, q.totalDebt ?? null, null);
        put("Yahoo", key("비지배지분"), x.nci, q.minorityInterest ?? null, kSelf(/^LTM 비지배지분 = DART/, "LTM"));
      }
    }
    // EBITDA — 야후 영업이익 + 야후 감가상각(R6 구성)
    put("Yahoo", key("EBITDA"), x.ebitda, yOp != null && yDep != null ? yOp + yDep : null, isL ? null : () => ({ kind: "compose", parts: [key("영업이익"), key("감가상각비")], why: "야후 EBITDA = 야후 영업이익 + 야후 감가상각(검증기 구성) — 두 구성 칸 판정을 따른다" }));
  }

  // ── 판정 ──
  // 구성(compose) 칸은 다른 칸 판정 뒤에 — 앞에서부터 두 번
  const keys = [...items.keys()];
  const order = [...keys.filter((k) => !/EBITDA$/.test(k) && !/EV\/EBITDA/.test(k)), ...keys.filter((k) => /EBITDA$/.test(k) && !/EV\/EBITDA/.test(k)), ...keys.filter((k) => /EV\/EBITDA/.test(k))];
  const finalOf = (k) => review.find((r) => r.item === k)?.d2 ?? null;
  for (const k of order) {
    const it = items.get(k);
    const P = {};
    for (const [n, s] of Object.entries(it.src)) {
      const c = clsOf(n, k, it.ours, s.v);
      if (c.cls === "불일치" && s.cause) {
        let r = null;
        try { r = await s.cause(it.ours, s.v, unitOf(s.v)); } catch (e) { errs.push(`원인 판정 ${k} ${n}: ${String(e?.message ?? e).slice(0, 80)}`); }
        if (r?.kind === "compose") {
          const fs = r.parts.map((p) => finalOf(p));
          // 구성 칸의 같은 소스 판정 — 소스별로 본다(EBITDA 야후 = 야후 영업이익 + 야후 감가상각)
          const ps = r.parts.map((p) => review.find((x) => x.item === p)?.per?.[n]);
          const okP = (q) => q && (q.cls === "일치" || q.cls === "정밀도부족" || q.kind === "eq");
          const selfP = (q) => q && q.kind === "self";
          if (ps.every(okP)) Object.assign(c, { kind: "eq", why: `${r.why} — 구성 ${r.parts.join("·")} 모두 일치·정밀도 부족·식으로 원인 확인` });
          else if (ps.every((q) => okP(q) || selfP(q))) Object.assign(c, { kind: "self", why: `${r.why} — 구성 중 자체 정의 칸 있음` });
          else Object.assign(c, { why: `${r.why} — 구성 판정 ${r.parts.map((p, i) => `${p} ${ps[i]?.cls ?? "없음"}${ps[i]?.kind ? `(${ps[i].kind})` : ""}/${fs[i] ?? "없음"}`).join(", ")}` });
          if (ps.some((q) => q?.suspect)) c.suspect = ps.map((q) => q?.suspect).filter(Boolean).join(" / ");
        } else if (r) Object.assign(c, r);
      }
      P[n] = c;
    }
    const vals = Object.values(P);
    const mism = vals.filter((c) => c.cls === "불일치");
    let d2;
    if (vals.some((c) => c.cls === "일치")) d2 = "일치";
    else if (mism.length && mism.every((c) => c.kind === "eq")) d2 = "식으로 원인 확인";
    else if (mism.length && mism.every((c) => c.kind === "eq" || c.kind === "self")) d2 = "앱=DART 원자료, 외부 자체 정의";
    else if (mism.length) d2 = "원인 미확인";
    else if (vals.some((c) => c.cls === "정밀도부족")) d2 = "정밀도 부족";
    else if (vals.some((c) => c.cls === "앱빈칸")) d2 = "앱 빈칸(외부 값 있음)";
    else d2 = "값 없음";
    // 앱이 틀렸을 가능성 — 식이 드러낸 정의 어긋남, 또는 원인 미확인인데 계보가 다른 외부 두 곳이 서로 같은 값
    let suspect = vals.map((c) => c.suspect).filter(Boolean).join(" / ") || null;
    if (d2 === "원인 미확인") {
      const f = it.src.FnGuide?.v, yv = it.src.Yahoo?.v;
      if (f != null && yv != null && (f === yv || shownAs(yv, f, unitOf(f)))) suspect = `${suspect ? suspect + " / " : ""}계보가 다른 외부 두 곳(FnGuide ${f}·Yahoo ${yv})이 서로 같고 앱 ${it.ours} 만 다름`;
    }
    const names = Object.keys(P).filter((n) => it.src[n].v != null);
    const matched = names.filter((n) => P[n].cls === "일치"), explained = names.filter((n) => P[n].kind === "eq" || P[n].kind === "self");
    const off = names.filter((n) => P[n].cls !== "일치").map((n) => `${n} ${it.src[n].v} [${P[n].cls}${P[n].why ? ` — ${P[n].why}` : ""}]`);
    review.push({
      item: k, ours: it.ours, sources: Object.fromEntries(Object.entries(it.src).map(([n, s]) => [n, s.v])), per: P, d2, ...(suspect ? { appSuspect: suspect } : {}),
      matched, explained, ...(explained.length ? { causes: Object.fromEntries(explained.map((n) => [n, P[n].why])) } : {}),
      verdict: names.length && matched.length === names.length ? `${names.length}곳 모두 일치`
        : `D2 ${d2} — ${matched.length}/${names.length}곳 일치${off.length ? ` · ${/원인|자체 정의/.test(d2) ? "불일치" : "그 밖"}: ${off.join(", ")}` : ""}`,
    });
  }
  // 기준일 다른 칸 — 대조하지 않은 사유를 남긴다(조용히 빠지지 않게)
  if (H.LTM) review.push({ item: "LTM EV·EV/EBITDA 외부 대조 안 함", note: `앱 LTM EV 는 현재(${H.LTM.date}) 시가총액, FnGuide 최근 분기 열(${ltmEnd ?? "없음"})은 분기말 시가총액 — 기준일이 달라 대조하지 않음` });
  return { review, errs };
}
