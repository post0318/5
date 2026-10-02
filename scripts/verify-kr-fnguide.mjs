/**
 * 한국 재무제표 줄 단위 외부 대조 — FnGuide(주) · Yahoo(보조), 검증 스크립트 전용(오너 결정 2026-09-24 "FnGuide 는 검증 대상").
 * 미국 --metric=bscf 와 같은 분류: ① 일치 / ② 등식으로 원인 확인 / 외부 단독 이탈(야후 = 앱, FnGuide 만 다름) / 미해결.
 *   - 비교 단위: FnGuide 는 억원 소수 둘째 자리(= 백만원) → 앱 값을 백만원 반올림해 같으면 ①.
 *   - Yahoo 는 원 단위(한국 종목) → 백만원 반올림 비교.
 *   - ② 는 줄마다 정한 등식이 백만원 단위에서 정확히 닫힐 때만(정의 차이 이름표로는 ② 아님).
 * 사용: node scripts/verify-kr-fnguide.mjs [--symbols=005930,...] [--base=http://localhost:3000] [--json=out.json]
 *   symbols 를 비우면 kr_da 적재 종목(유니버스) 전체.
 */
import fs from "node:fs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = /^--([^=]+)=?(.*)$/.exec(a); return m ? [m[1], m[2] || true] : [a, true]; }));
const BASE = String(args.base ?? "http://localhost:3000").replace(/\/$/, "");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const M = 1e6;

async function symbolsDefault() {
  const { MongoClient } = await import("mongodb");
  const env = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }));
  const c = new MongoClient(env.MONGODB_URI); await c.connect();
  const ids = (await c.db("market_research").collection(env.KR_DA_COLLECTION || "kr_da").find({}, { projection: { _id: 1 } }).toArray()).map((d) => d._id);
  await c.close();
  return ids.sort();
}

/** FnGuide 재무제표 요약(finIncome·finBalance·finCashFlow) — 줄 순서 그대로(같은 이름 줄이 여러 번 나와 위치로 찾는다) */
async function fnguide(code) {
  const r = await fetch(`https://wcomp.fnguide.com/CompanyInfo/Finance?cmp_cd=${code}`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`FnGuide HTTP ${r.status}`);
  const t = await r.text();
  const got = /cmp_cd:\s*'(\d{6})'/.exec(t)?.[1];
  if (got !== code) throw new Error(`FnGuide 응답 종목 ${got} ≠ ${code}`);
  const block = (key) => { const i = t.indexOf(`${key}:`); if (i < 0) throw new Error(`FnGuide ${key} 없음`); const s = t.indexOf("{", i), e = t.indexOf("\n", s); return JSON.parse(t.slice(s, e).trim().replace(/,\s*$/, "")); };
  const num = (s) => (s == null || s === "" ? null : Number(String(s).replace(/,/g, "")));
  const parse = (j) => {
    const cols = j.header.filter((h) => /^\d{4}\/12$/.test(h.YYMM)).map((h) => ({ y: Number(h.YYMM.slice(0, 4)), cd: h.CD }));
    const rows = j.data.map((d) => ({ name: String(d.NAME).trim(), v: Object.fromEntries(cols.map((c) => [c.y, num(d[c.cd]) == null ? null : Math.round(num(d[c.cd]) * 100) * M])) }));
    return { years: cols.map((c) => c.y), rows };
  };
  return { is: parse(block("finIncome")), bs: parse(block("finBalance")), cf: parse(block("finCashFlow")) };
}

/** Yahoo 연간(fundamentalsTimeSeries) — 원 단위 */
async function yahoo(code) {
  const YF = (await import("yahoo-finance2")).default;
  const yf = typeof YF === "function" ? new YF({ suppressNotices: ["yahooSurvey", "ripHistorical"] }) : YF;
  for (const suf of [".KS", ".KQ"]) {
    try {
      const out = {};
      for (const module of ["financials", "balance-sheet", "cash-flow"]) {
        const r = await yf.fundamentalsTimeSeries(`${code}${suf}`, { period1: "2019-01-01", type: "annual", module }, { validateResult: false });
        for (const q of r) { const y = new Date(q.date).getUTCFullYear(); out[y] = { ...(out[y] ?? {}), ...q }; }
      }
      if (Object.keys(out).length) return out;
    } catch { /* 다음 접미사 */ }
  }
  return {};
}

/** DART 원자료(사업보고서 연결 전체 재무제표) — 연도 y 를 담은 보고서 y(당기)·y+1(전기) 열. ② 등식의 구성 줄을 찾는 데만 쓴다 */
const ENV = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }));
const CORP = (() => { const cc = JSON.parse(fs.readFileSync("src/lib/markets/kr/data/corpcodes.json", "utf8")); return new Map((Array.isArray(cc) ? cc : Object.values(cc)).map((x) => [x.s, x.c])); })();
const dartCache = new Map();
async function dartReport(code, year) {
  const k = `${code}:${year}`;
  if (dartCache.has(k)) return dartCache.get(k);
  await new Promise((r) => setTimeout(r, 350)); // DART 몰아서 요청하면 이 PC 를 1시간 막는다
  const u = `https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json?crtfc_key=${ENV.DART_API_KEY}&corp_code=${CORP.get(code)}&bsns_year=${year}&reprt_code=11011&fs_div=CFS`;
  const j = await (await fetch(u, { signal: AbortSignal.timeout(30_000) })).json().catch(() => ({}));
  const list = j.status === "000" ? j.list : [];
  dartCache.set(k, list);
  return list;
}
const n0 = (x) => (x == null || x === "" ? null : Number(String(x).replace(/,/g, "")));
/** 차이(외부 − 앱)가 같은 보고서·같은 열의 관련 줄 1~3개 합과 백만원 단위로 정확히 같으면 그 등식 */
async function explain(code, st, yr, diff, family) {
  if (!family || diff == null) return null;
  for (const [by, col] of [[yr, "thstrm_amount"], [yr + 1, "frmtrm_amount"]]) {
    const L = (await dartReport(code, by)).filter((r) => (st === "bs" ? r.sj_div === "BS" : st === "cf" ? r.sj_div === "CF" : r.sj_div === "IS" || r.sj_div === "CIS") && family.test(r.account_nm));
    const c = L.map((r) => ({ nm: r.account_nm, v: n0(r[col]) })).filter((x) => x.v != null && x.v !== 0);
    const target = Math.round(diff / M);
    // 외부는 백만원으로 반올림한 값 — (외부 − 앱) 과 구성 줄 합이 각자 반올림돼 1 단위까지 어긋날 수 있다(한화에어로 2025 연구개발비 295,424.59)
    const hit = (v) => Math.abs(Math.round(v / M) - target) <= 1;
    for (let i = 0; i < c.length; i++) {
      if (hit(c[i].v)) return `${c[i].nm}(${by} 보고서)`;
      for (let j = i + 1; j < c.length; j++) {
        if (hit(c[i].v + c[j].v)) return `${c[i].nm} + ${c[j].nm}(${by} 보고서)`;
        for (let k = j + 1; k < c.length; k++) if (hit(c[i].v + c[j].v + c[k].v)) return `${c[i].nm} + ${c[j].nm} + ${c[k].nm}(${by} 보고서)`;
      }
    }
  }
  return null;
}
/**
 * 외부 값 = 다른 판본(그 해를 담은 다른 사업보고서)의 같은 줄 값인가 — 앱은 그 해를 담은 가장 최근 보고서(재작성 반영)를 쓴다.
 * 같은 줄 = 이름 모양(LINE_NAME)이 맞는 줄. 판본 y(당기)·y+1(전기)·y+2(전전기) 중 외부와 정확히 같고 앱과 다른 판본을 찾는다
 */
async function vintage(code, st, yr, ext, ours, nameRe, family) {
  if (!nameRe || ext == null) return null;
  const COLS = { 0: "thstrm_amount", 1: "frmtrm_amount", 2: "bfefrmtrm_amount" };
  let extBy = null, oursBy = null;
  for (const d of [0, 1, 2]) {
    const L = (await dartReport(code, yr + d)).filter((r) => (st === "bs" ? r.sj_div === "BS" : st === "cf" ? r.sj_div === "CF" : r.sj_div === "IS" || r.sj_div === "CIS") && nameRe.test(r.account_nm.replace(/\s/g, "")));
    for (const r of L) {
      const v = n0(r[COLS[d]]);
      if (v == null) continue;
      if (extBy == null && Math.round(v / M) === Math.round(ext / M)) extBy = yr + d;
      if (Math.round(v / M) === Math.round(ours / M)) oursBy = Math.max(oursBy ?? 0, yr + d);
    }
  }
  if (extBy != null && oursBy != null && extBy !== oursBy) return `외부 = ${extBy} 보고서 판본, 앱 = ${oursBy} 보고서 판본(재작성)`;
  // 판본 + 재분류가 겹친 경우: 다른 판본의 같은 줄 + 같은 보고서·열의 관련 줄 하나 = 외부(SK스퀘어 2023 매출 = 2023 보고서 영업수익 + 지분법이익)
  if (family && oursBy != null)
    for (const d of [0, 1, 2]) {
      if (yr + d === oursBy) continue;
      const rows = (await dartReport(code, yr + d)).filter((r) => (st === "bs" ? r.sj_div === "BS" : st === "cf" ? r.sj_div === "CF" : r.sj_div === "IS" || r.sj_div === "CIS"));
      for (const a of rows.filter((r) => nameRe.test(r.account_nm.replace(/\s/g, "")))) {
        const va = n0(a[COLS[d]]);
        if (va == null) continue;
        for (const b of rows.filter((r) => r !== a && family.test(r.account_nm))) {
          const vb = n0(b[COLS[d]]);
          if (vb != null && Math.abs(Math.round((va + vb) / M) - Math.round(ext / M)) <= 1) return `외부 = ${yr + d} 보고서 판본 ${a.account_nm} + ${b.account_nm}, 앱 = ${oursBy} 보고서 판본(재작성)`;
        }
      }
    }
  return null;
}
const LINE_NAME = {
  "매출액": /^(매출액|수익\(매출액\)|영업수익|매출)$/, "매출원가": /^(매출원가|영업비용)$/, "매출총이익": /^매출총이익/, "판매관리비": /^판매비와관리비/,
  "영업이익": /^영업이익/, "세전이익": /^(계속영업)?법인세비용차감전/, "법인세비용": /^(계속영업)?법인세비용(\(수익\))?$/, "당기순이익": /^당기순이익/, "순이익(지배)": /지배기업.*소유주/,
};
/** 줄마다 차이를 설명할 수 있는 관련 계정 이름(같은 성격 줄만 — 우연한 합 일치 방지) */
const FAMILY = {
  "매출채권": /채권|미수/, "매입채무": /채무|미지급|예수|선수/, "단기차입금·유동성장기부채": /차입|사채|리스|금융부채/, "장기차입금·사채": /차입|사채|리스|금융부채/,
  "현금·현금성자산": /현금|예금|금융상품/, "판매관리비": /판매|관리|연구|개발|대손|물류|경상|영업비용/, "매출액": /지분법이익|영업수익/, "매출원가": /지분법손실|매출원가/, "무형자산": /무형|영업권/, "유형자산": /유형|사용권|투자부동산/,
};

async function app(code) {
  const out = {};
  for (const v of ["is", "bs", "cf"]) {
    const j = await (await fetch(`${BASE}/api/markets/kr/${code}/financials?period=annual&view=${v}`, { signal: AbortSignal.timeout(300_000) })).json();
    if (!j.sections) throw new Error(`앱 ${v} 조회 실패 ${JSON.stringify(j).slice(0, 100)}`);
    out[v] = Object.fromEntries(j.sections.flatMap((s) => s.items).map((it) => [it.accountId, Object.fromEntries(Object.entries(it.values).map(([k, x]) => [Number(k.slice(2)), x]))]));
  }
  return out;
}

// FnGuide 줄 찾기 — name, 앞에 와야 하는 기준 줄(같은 이름이 여러 번 나오는 "기타"·"이자수입(지급)" 등)
const fgRow = (st, name, after) => {
  const start = after ? st.rows.findIndex((r) => r.name === after) : 0;
  if (start < 0) return null;
  return st.rows.slice(start).find((r) => r.name === name) ?? null;
};
const fgSum = (st, names, after) => (y) => {
  let acc = 0, any = false;
  for (const n of names) { const r = fgRow(st, n, after); const v = r?.v[y]; if (v != null) { acc += v; any = true; } }
  return any ? acc : null;
};
const fgOne = (st, name, after, sign = 1) => (y) => { const v = fgRow(st, name, after)?.v[y]; return v == null ? null : sign * v; };

/** 대조 정의 — [화면, 앱 줄 id, 이름, FnGuide 값(st, y), Yahoo 키(부호), 원인 등식 후보] */
const DEFS = [
  // 손익계산서
  ["is", "is:매출액", "매출액", (f) => fgOne(f.is, "매출액(수익)"), "totalRevenue"],
  ["is", "is:(−) 매출원가", "매출원가", (f) => fgOne(f.is, "매출원가"), "costOfRevenue"],
  ["is", "is:매출총이익", "매출총이익", (f) => fgOne(f.is, "매출총이익"), "grossProfit"],
  ["is", "is:(−) 판매관리비", "판매관리비", (f) => fgOne(f.is, "판매비와관리비"), "sellingGeneralAndAdministration"],
  ["is", "is:영업이익", "영업이익", (f) => fgOne(f.is, "영업이익(발표기준)"), "operatingIncome"],
  ["is", "is:세전이익", "세전이익", (f) => fgOne(f.is, "법인세비용차감전계속사업이익"), "pretaxIncome"],
  ["is", "is:(−) 법인세비용", "법인세비용", (f) => fgOne(f.is, "법인세비용"), "taxProvision"],
  ["is", "is:당기순이익", "당기순이익", (f) => fgOne(f.is, "당기순이익"), "netIncomeIncludingNoncontrollingInterests"],
  ["is", "is:(지배주주 귀속)", "순이익(지배)", (f) => fgOne(f.is, "(지배주주지분)당기순이익"), "netIncomeCommonStockholders"],
  // 재무상태표
  ["bs", "bs:자산:현금·현금성자산", "현금·현금성자산", (f) => fgOne(f.bs, "현금및현금성자산"), "cashAndCashEquivalents"],
  ["bs", "bs:자산:매출채권", "매출채권", (f) => fgOne(f.bs, "매출채권및기타채권"), "receivables"],
  ["bs", "bs:자산:재고자산", "재고자산", (f) => fgOne(f.bs, "재고자산"), "inventory"],
  ["bs", "bs:자산:유동자산 총계", "유동자산", (f) => fgOne(f.bs, "유동자산"), "currentAssets"],
  ["bs", "bs:자산:유형자산", "유형자산", (f) => fgOne(f.bs, "유형자산"), "netPPE"],
  ["bs", "bs:자산:무형자산", "무형자산", (f) => fgOne(f.bs, "무형자산"), "goodwillAndOtherIntangibleAssets"],
  ["bs", "bs:자산:비유동자산 총계", "비유동자산", (f) => fgOne(f.bs, "비유동자산"), "totalNonCurrentAssets"],
  ["bs", "bs:자산:자산 총계", "자산총계", (f) => fgOne(f.bs, "자산총계"), "totalAssets"],
  ["bs", "bs:부채:매입채무", "매입채무", (f) => fgOne(f.bs, "매입채무및기타채무"), "payablesAndAccruedExpenses"],
  ["bs", "bs:부채:단기차입금·유동성장기부채", "단기차입금·유동성장기부채", (f) => fgSum(f.bs, ["단기사채", "단기차입금", "유동성장기부채"]), "currentDebt"],
  ["bs", "bs:부채:유동부채 총계", "유동부채", (f) => fgOne(f.bs, "유동부채"), "currentLiabilities"],
  ["bs", "bs:부채:장기차입금·사채", "장기차입금·사채", (f) => fgSum(f.bs, ["사채", "장기차입금"]), "longTermDebt"],
  ["bs", "bs:부채:비유동부채 총계", "비유동부채", (f) => fgOne(f.bs, "비유동부채"), "totalNonCurrentLiabilitiesNetMinorityInterest"],
  ["bs", "bs:부채:부채 총계", "부채총계", (f) => fgOne(f.bs, "부채총계"), "totalLiabilitiesNetMinorityInterest"],
  ["bs", "bs:자본:이익잉여금(결손금)", "이익잉여금", (f) => fgOne(f.bs, "이익잉여금"), "retainedEarnings"],
  ["bs", "bs:자본:자본 총계", "자본총계", (f) => fgOne(f.bs, "자본총계"), "totalEquityGrossMinorityInterest"],
  ["bs", "bs:note:지배주주 지분", "지배주주지분", (f) => fgOne(f.bs, "지배주주지분"), "stockholdersEquity"],
  ["bs", "bs:note:비지배지분", "비지배지분", (f) => fgOne(f.bs, "비지배주주지분"), "minorityInterest"],
  // 현금흐름표
  ["cf", "cf:영업활동 현금흐름:당기순이익", "CF 당기순이익", (f) => fgOne(f.cf, "당기순이익"), null],
  ["cf", "cf:영업활동 현금흐름:운전자본 변동", "운전자본 변동", (f) => fgOne(f.cf, "영업활동으로인한자산부채변동(운전자본변동)"), "changeInWorkingCapital"],
  ["cf", "cf:total:영업활동 현금흐름", "영업활동 현금흐름", (f) => fgOne(f.cf, "영업활동으로인한현금흐름"), "operatingCashFlow"],
  ["cf", "cf:투자활동 현금흐름:유형자산 취득", "유형자산 취득", (f) => fgOne(f.cf, "유형자산의증가", "투자활동현금유출액", -1), "purchaseOfPPE"],
  ["cf", "cf:투자활동 현금흐름:무형자산 취득", "무형자산 취득", (f) => fgOne(f.cf, "무형자산의증가", "투자활동현금유출액", -1), "purchaseOfIntangibles"],
  ["cf", "cf:total:투자활동 현금흐름", "투자활동 현금흐름", (f) => fgOne(f.cf, "투자활동으로인한현금흐름"), "investingCashFlow"],
  ["cf", "cf:total:재무활동 현금흐름", "재무활동 현금흐름", (f) => fgOne(f.cf, "재무활동으로인한현금흐름"), "financingCashFlow"],
  ["cf", "cf:fx", "환율변동 효과", (f) => fgOne(f.cf, "환율변동효과"), "effectOfExchangeRateChanges"],
  ["cf", "cf:netchange", "현금 순증감", (f) => fgOne(f.cf, "현금및현금성자산의증가"), "changesInCash"],
];

const mm = (v) => (v == null ? null : Math.round(v / M));
const eq = (a, b) => a != null && b != null && mm(a) === mm(b);

const syms = args.symbols ? String(args.symbols).split(",") : await symbolsDefault();
const rows = [];
for (const s of syms) {
  let f, a, y;
  try { [f, a, y] = await Promise.all([fnguide(s), app(s), yahoo(s)]); }
  catch (e) { rows.push({ sym: s, err: String(e).slice(0, 120) }); console.log(s, "오류", String(e).slice(0, 120)); continue; }
  for (const [st, id, name, fgFn, yKey] of DEFS) {
    const fv = fgFn(f);
    const appRow = a[st][id];
    for (const yr of f[st].years) {
      const ours = appRow?.[yr] ?? null;
      const ext = fv(yr);
      const yv = yKey ? (y[yr]?.[yKey] ?? null) : null;
      const yAdj = yv == null ? null : (yKey === "purchaseOfPPE" || yKey === "purchaseOfIntangibles" ? yv : yv); // 야후 투자 유출은 음수
      if (ours == null && ext == null) continue;
      let cls;
      if (eq(ours, ext)) cls = "①";
      else if (ours == null || ext == null) {
        cls = ours == null ? "앱 빈칸" : "외부 빈칸";
        // 앱에 그 줄이 없는 구조(SK스퀘어 — 성격별 손익): 외부 값이 DART 관련 줄과 정확히 같으면 정의 차이(②)
        if (ours == null && ext != null) {
          // 매출총이익: FnGuide 자체 매출 − 매출원가(둘 다 위에서 재분류로 확인된 값)와 같으면 같은 재분류의 결과
          if (name === "매출총이익") {
            const fr = fgOne(f.is, "매출액(수익)")(yr), fc = fgOne(f.is, "매출원가")(yr);
            if (fr != null && fc != null && mm(fr - fc) === mm(ext)) { rows.push({ sym: s, st, name, yr, ours, fg: ext, yahoo: yAdj, cls: "②", why: "앱 줄 없음(성격별 손익) — FnGuide 매출 − 매출원가(지분법 재분류)" }); continue; }
          }
          const w = await explain(s, st, yr, ext, FAMILY[name]);
          if (w) { rows.push({ sym: s, st, name, yr, ours, fg: ext, yahoo: yAdj, cls: "②", why: `앱 줄 없음 — FnGuide = ${w}` }); continue; }
        }
      }
      else if (eq(ours, yAdj)) cls = "외부 단독 이탈";
      else cls = "미해결";
      let why = null;
      if (cls === "미해결" || cls === "외부 단독 이탈") why = await vintage(s, st, yr, ext, ours, LINE_NAME[name], FAMILY[name]);
      if (why) cls = "②";
      else if (cls === "미해결" || cls === "외부 단독 이탈") {
        why = await explain(s, st, yr, ext - ours, FAMILY[name]);
        if (why) why = `FnGuide = 앱 + ${why}`;
        else { const w2 = await explain(s, st, yr, ours - ext, FAMILY[name]); if (w2) why = `앱 = FnGuide + ${w2}`; }
        if (why) cls = "②";
      }
      rows.push({ sym: s, st, name, yr, ours, fg: ext, yahoo: yAdj, cls, why });
    }
  }
  process.stdout.write(`${s} `);
}
console.log();
const agg = {};
for (const r of rows) if (r.cls) { const k = r.st; (agg[k] ??= {})[r.cls] = (agg[k][r.cls] ?? 0) + 1; }
for (const [k, v] of Object.entries(agg)) console.log(k.toUpperCase(), JSON.stringify(v));
const byName = {};
for (const r of rows) if (r.cls && r.cls !== "①") (byName[`${r.st}:${r.name}:${r.cls}`] ??= []).push(r);
for (const [k, list] of Object.entries(byName).sort((x, y) => y[1].length - x[1].length)) {
  console.log(`-- ${k} ${list.length}건`);
  for (const r of list.slice(0, 4)) console.log(`   ${r.sym} ${r.yr} 앱 ${mm(r.ours)} · FnGuide ${mm(r.fg)} · 야후 ${mm(r.yahoo)} (백만원)${r.why ? ` — ${r.why}` : ""}`);
}
if (args.json) fs.writeFileSync(String(args.json), JSON.stringify(rows, null, 1));
