/**
 * 검증기 — 한국 EV 구성요소(B16, CLAUDE.md "한국 EV·차입금 단일 기준")를 DART 원자료(fnlttSinglAcntAll 재무상태표 줄)로 **따로** 계산한다.
 * 앱 src/lib/markets/kr/dart-ev.ts 를 읽거나 가져오지 않는다 — 규칙 문장만 보고 다시 짠 판독(같은 결함을 같이 갖지 않게).
 *
 *  총차입금 = 차입금·사채·리스부채 줄 합. "(유동|비유동|단기|장기)금융부채" 이름 줄은 다른 차입금 줄이 없을 때만(한전·HD현대식).
 *  현금성자산 = 현금및현금성자산 + 단기금융상품 + 단기투자자산 + 유동 상각후원가·당기손익-공정가치 금융자산. 기타유동금융자산 제외.
 *  비지배지분 = 비지배지분 줄.
 *  재무상태표 본표에 리스부채 줄이 없으면(오너 결정 2026-10-05) 사업보고서 주석의 리스부채 합계를 더한다 — 단 회사 회계정책 주석이 리스부채를
 *  본표 차입금 줄에 포함해 표시한다고 밝히면(삼성전자 "'유동성장기부채' 또는 '장기차입금'으로 분류") 이미 들어 있으므로 더하지 않는다(leaseNote).
 */
import { dartXbrlFacts, dartDocLeaseSentences } from "./dart.mjs";

const nm = (s) => String(s ?? "").replace(/\s/g, "");
const isStd = (id) => /^(ifrs-full|dart)_/.test(id ?? "");
const thstrm = (r) => v(r, "thstrm_amount");
const v = (r, col) => {
  const t = String(r?.[col] ?? "").trim();
  return t === "" || t === "-" ? null : Number(t.replace(/,/g, ""));
};

// 차입금 개념(표준 ID) — 이름 꼴: …Borrowings / …Bonds… / …Debentures / …LeaseLiabilities / LoansReceived
const DEBT_STD = /(Borrowings|BondsIssued|Debentures?|LeaseLiabilities|ConvertibleBonds?|ExchangeableBonds?|BondsWithWarrant|PortionOfBonds|LoansReceived)/;
const DEBT_STD_NOT = /Derivative|Provision|Payable|Receivable|Asset|Interest/;
const DEBT_NAME = /차입|사채|리스부채|장기부채/;
const DEBT_NAME_NOT = /리스채권|투자|자산|받을|대여|이자|파생|확정계약|충당/;
const PLAIN = /^(유동|비유동|단기|장기)금융부채$/;
// 단기 예치금은 회사가 "현금성자산으로 분류" 태그를 달아도 같은 성격(006260 2024 보고서 금융기관예치금 — 다른 해는 NotClassified)
const CASH_STD = /^(ifrs-full|dart)_(CashAndCashEquivalents|Short[tT]ermDeposits(Not)?ClassifiedAsCashEquivalents|CurrentInvestments|CurrentFinancialAssetsAtAmortisedCost|CurrentFinancialAssetsAtFairValueThroughProfitOrLoss\w*)$/;
// 이름(표준 코드 없음, 또는 포괄 태그 OtherCurrentFinancialAssets) — 단기금융상품·단기투자자산(단기투자증권)·단기금융자산. "기타(유동)금융자산"은 B16 제외
const CASH_NAME = /^(현금및현금성자산|단기금융상품|단기투자자산|단기투자증권|단기금융자산|유동상각후원가측정금융자산|상각후원가측정유동금융자산|유동당기손익-?공정가치측정금융자산|당기손익-?공정가치측정유동금융자산)$/;

/**
 * @param rows 값을 읽을 보고서 줄(그 해를 담은 가장 최근 보고서)
 * @param ownRows 그 기간이 당기인 보고서의 줄(연간 = 그해 사업보고서, LTM = 그 분기 보고서) — "기타(유동)금융자산" 은 이 보고서가 같은 이름 줄에
 *   단기예치금 표준 ID 를 달았을 때만 현금성자산(오너 결정 2026-10-05 — 064350 2020~2022 보고서 dart_ShortTermDepositsNotClassifiedAsCashEquivalents).
 *   생략하면 rows 자신
 * @param rename { rows, col } — 값 보고서가 "(유동|비유동)금융부채" 줄 이름을 "기타 (유동|비유동) 금융부채"로 바꿔 단 경우 같은 줄로 보기 위한 대조
 *   보고서(rows)와 값 보고서의 대조 열(col). 대조 보고서의 같은 표준 ID·그 이름 줄 당기 값이 값 보고서의 col 값과 정확히 같을 때만 같은 줄.
 *   LTM: 직전 사업보고서 + 분기 보고서 전기말 열(015760 2026 반기), 사업연도: 그해 자기 보고서 + 기준 보고서 열(052690 2021 — 2023 보고서 전전기
 *   "기타유동금융부채" 10,000,000 = 2021 보고서 "유동금융부채" 당기)
 */
export function classifyBsRows(rows, ownRows = rows, rename = null) {
  const bs = (rows ?? []).filter((r) => r.sj_div === "BS");
  const DEP = /^(ifrs-full|dart)_Short[tT]ermDeposits(Not)?ClassifiedAsCashEquivalents$/;
  const depositNamed = new Set((ownRows ?? []).filter((r) => r.sj_div === "BS" && DEP.test(r.account_id ?? "") && thstrm(r) != null).map((r) => nm(r.account_nm)));
  // 표준 차입금 태그여도 이름이 자산(대여금·채권)이면 아님
  const debt = bs.filter((r) => (isStd(r.account_id) ? DEBT_STD.test(r.account_id) && !DEBT_STD_NOT.test(r.account_id) && !/대여|자산|받을|리스채권/.test(nm(r.account_nm)) : DEBT_NAME.test(nm(r.account_nm)) && !DEBT_NAME_NOT.test(nm(r.account_nm))));
  const isLease = (r) => /LeaseLiabilities/.test(r.account_id ?? "") || /리스부채/.test(nm(r.account_nm));
  const borrow = debt.filter((r) => !isLease(r));
  const renamedPlain = (r) => {
    if (!rename?.rows || !/^기타(유동|비유동)금융부채$/.test(nm(r.account_nm))) return false;
    const was = rename.rows.find((p) => p.sj_div === "BS" && p.account_id === r.account_id && PLAIN.test(nm(p.account_nm)));
    return was != null && v(was, "thstrm_amount") != null && v(was, "thstrm_amount") === v(r, rename.col);
  };
  const plain = borrow.length ? [] : bs.filter((r) => PLAIN.test(nm(r.account_nm)) || renamedPlain(r));
  return {
    debt: [...debt, ...plain],
    leaseFace: debt.filter(isLease),
    plain,
    // 회사가 같은 줄을 해마다 다른 태그로 달기도 한다(267260·329180 "단기금융자산", 402340 "단기투자자산")
    // 판정 순서: "기타(유동)금융자산" = 그 기간 자기 보고서가 단기예치금 ID 를 달았을 때만 → B16 에 이름이 적힌 항목은 태그와 관계없이 포함 → 그 밖은 표준 태그
    cash: bs.filter((r) => (/^기타(유동)?금융자산$/.test(nm(r.account_nm)) ? depositNamed.has(nm(r.account_nm)) : CASH_NAME.test(nm(r.account_nm)) || (isStd(r.account_id) && CASH_STD.test(r.account_id)))),
    nci: bs.filter((r) => r.account_id === "ifrs-full_NoncontrollingInterests" || nm(r.account_nm) === "비지배지분"),
    // 금융업 판정(검증기 자체 규칙) — 예수부채·예금부채·보험계약부채·책임준비금·투자계약부채 줄이 있으면 은행·보험·증권. 일반 기업의 "예수금"(원천징수 등)은 아님(삼성전자 실측)
    financial: bs.some((r) => /^(예수부채|고객예수부채|예금부채|보험계약부채|책임준비금|투자계약부채)$/.test(nm(r.account_nm)) || /Deposits(From|Due)Customers|InsuranceContractsIssuedThatAreLiabilities|InsuranceContractLiabilities/.test(r.account_id ?? "")),
  };
}

/** 줄 묶음의 한 열 합 — 값이 하나도 없으면 null */
export function sumCol(rows, col) {
  let s = null;
  for (const r of rows) { const x = v(r, col); if (x != null) s = (s ?? 0) + x; }
  return s;
}

// ── 리스부채 주석(사업보고서 XBRL) ──
/**
 * 사업연도 y 말 리스부채 장부금액 — 보고서 XBRL 의 서로 다른 태그 꼴 후보 중 **두 개 이상이 정확히 같은 값**일 때만 채택(한 꼴만 있으면
 * 근거 부족 — 같은 회사가 같은 이름 태그를 다른 표(별도·만기분석 등)에 쓰기도 한다, 실측 047810 29.55억 vs 368.78억).
 * prefix = "CFY2025eFY"(그 보고서 당기말) 또는 "PFY2024eFY"(전기말). basis = "CFS"|"OFS"
 */
export function leaseFromFacts(facts, prefix, basis) {
  const want = (ctx) => {
    if (!(ctx === prefix || ctx.startsWith(prefix + "_"))) return false;
    const rest = ctx.slice(prefix.length);
    const hasAxis = /ConsolidatedAndSeparateFinancialStatementsAxis/.test(rest);
    if (basis === "CFS" ? /SeparateMember/.test(rest) : /ConsolidatedMember/.test(rest)) return false;
    if (basis === "CFS" && hasAxis && !/ConsolidatedMember/.test(rest)) return false;
    return true;
  };
  // 연결 축을 뺀 나머지 차원
  const dims = (ctx) => ctx.slice(prefix.length).replace(/_?ifrs-full_ConsolidatedAndSeparateFinancialStatementsAxis_ifrs-full_(Consolidated|Separate)Member/, "").replace(/^_/, "");
  const RA = "ifrs-full_CarryingAmountAccumulatedDepreciationAmortisationAndImpairmentAndGrossCarryingAmountAxis_dart_ReportedAmountMember";
  const get = (concept, d) => facts.filter(([c, ctx]) => c === concept && want(ctx) && dims(ctx) === d).map((f) => f[2]);
  const one = (xs) => (xs.length && xs.every((x) => x === xs[0]) ? xs[0] : null);
  const cand = {};
  const put = (k, x) => { if (x != null && x > 0) cand[k] = x; };
  put("LeaseLiabilities(무차원)", one(get("ifrs-full:LeaseLiabilities", "")));
  put("LeaseLiabilities(보고금액)", one(get("ifrs-full:LeaseLiabilities", RA)));
  { const c = one(get("ifrs-full:CurrentLeaseLiabilities", RA)), n = one(get("ifrs-full:NoncurrentLeaseLiabilities", RA)); if (c != null && n != null && c >= 0 && n >= 0) put("유동+비유동(보고금액)", c + n); }
  { const c = one(get("ifrs-full:CurrentLeaseLiabilities", "")), n = one(get("ifrs-full:NoncurrentLeaseLiabilities", "")); if (c != null && n != null && c >= 0 && n >= 0) put("유동+비유동(무차원)", c + n); }
  // 부채 종류 축의 리스부채 멤버
  put("LeaseLiabilities(부채종류=리스)", one(get("ifrs-full:LeaseLiabilities", "ifrs-full_ClassesOfLiabilitiesAxis_ifrs-full_LeaseLiabilitiesMember")));
  put("재무활동부채(부채종류=리스)", one(get("ifrs-full:LiabilitiesArisingFromFinancingActivities", "ifrs-full_ClassesOfLiabilitiesAxis_ifrs-full_LeaseLiabilitiesMember")));
  put("기타금융부채(금융부채종류=리스)", one(get("ifrs-full:OtherFinancialLiabilities", "ifrs-full_ClassesOfFinancialLiabilitiesAxis_ifrs-full_LeaseLiabilitiesMember")));
  { // 재무활동 부채 조정표의 리스부채 멤버 — 하나면 그 값, 유동·비유동 둘로 나뉘었으면(하나만 "current") 합
    const AX = "ifrs-full_LiabilitiesArisingFromFinancingActivitiesAxis_";
    const ls = facts.filter(([c, ctx]) => c === "ifrs-full:LiabilitiesArisingFromFinancingActivities" && want(ctx) && dims(ctx).startsWith(AX) && /Lease/i.test(dims(ctx)) && !/Axis_/.test(dims(ctx).slice(AX.length)));
    const by = new Map();
    for (const [, ctx, x] of ls) by.set(dims(ctx), [...(by.get(dims(ctx)) ?? []), x]);
    const ms = [...by].map(([k, xs]) => [k, one(xs)]);
    if (ms.length === 1) put("재무활동부채 조정표 리스 멤버", ms[0][1]);
    else if (ms.length === 2 && ms.every(([, x]) => x != null && x >= 0)) {
      const cur = ms.filter(([k]) => /(?<!non)current/i.test(k.slice(AX.length)));
      if (cur.length === 1) put("재무활동부채 조정표 리스 멤버(유동+비유동)", ms[0][1] + ms[1][1]);
    }
  }
  const vals = Object.values(cand);
  const counts = new Map();
  for (const x of vals) counts.set(x, (counts.get(x) ?? 0) + 1);
  const best = [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
  const how = (x) => Object.entries(cand).filter(([, y]) => y === x).map(([k]) => k).join(" = ");
  if (best.length === 1 || (best.length > 1 && best[0][1] > best[1][1])) return { amount: best[0][0], how: how(best[0][0]), cand };
  // 동수면 DART 주석 표 값(보고금액 멤버 — dart_ReportedAmountMember)이 든 묶음 하나만 채택(실측 079550 2025: 무차원 태그 둘이 전기 값을
  // 천원 단위로 적은 44,977,895, 보고금액 두 꼴은 86,261,167,000)
  if (best.length > 1) {
    const top = best.filter(([, n]) => n === best[0][1]);
    const ra = top.filter(([x]) => /보고금액/.test(how(x)));
    if (ra.length === 1) return { amount: ra[0][0], how: `${how(ra[0][0])} (동수 — 보고금액 묶음 채택, 다른 묶음 ${top.filter((t) => t !== ra[0]).map(([x]) => `${x}: ${how(x)}`).join(", ")})`, cand };
  }
  return { amount: null, how: vals.length ? `후보 불일치·근거 하나 — ${JSON.stringify(cand)}` : "리스부채 주석 태그 없음", cand };
}

/** 회계정책 문장 — 리스부채를 본표의 어느 줄(차입금류)에 포함해 표시하는가. 그 이름들을 돌려준다(없으면 []) */
export function leaseInDebtLines(sentences) {
  const Q = "['‘’\"“”]?";
  const re = new RegExp(`리스부채[를는은]?[^.]{0,40}?${Q}([가-힣]*(?:차입금|차입부채|장기부채|사채))${Q}(?:\\s*(?:또는|및|과|와|,)\\s*${Q}([가-힣]*(?:차입금|차입부채|장기부채|사채))${Q})?\\s*(?:에|으로|로)\\s*(?:포함하여\\s*)?(?:분류|표시|포함)`);
  const out = new Set();
  for (const s of sentences) { const m = re.exec(s); if (m) { out.add(m[1]); if (m[2]) out.add(m[2]); } }
  return [...out];
}

/**
 * 본표에 리스부채 줄이 없는 해의 판정 — { status: "included"|"added"|"unknown", amount, how }.
 *  included: 정책 문장이 리스부채를 본표 차입금 줄(이름이 본표 차입금 줄과 맞음)에 포함한다고 밝힘 → 더하지 않음
 *  added: 주석 리스부채 장부금액(후보 두 개 이상 일치) → 총차입금에 더함
 *  unknown: 둘 다 못 정함 → EV 공란이어야 한다
 * report = { rcept, prefix } (그 해 값이 실린 사업보고서와 컨텍스트 접두어)
 */
export async function leaseNoteFor(reports, basis, faceDebtNamesOf) {
  const tried = [];
  for (const rp of reports) {
    if (!rp) continue;
    const sents = [];
    for (const rc of rp.all?.length ? rp.all : [rp.rcept]) sents.push(...(await dartDocLeaseSentences(rc)));
    const names = leaseInDebtLines(sents);
    // 정책 문장의 줄 이름은 그 보고서 본표의 차입금 줄과 맞춘다(같은 보고서 — 103590: 2022 보고서 "장기차입금", 2024 보고서는 줄 이름을 바꿨다)
    const faceDebtNames = names.length ? await faceDebtNamesOf(rp.fy) : [];
    const hit = names.filter((n) => faceDebtNames.some((f) => f.includes(n) || n.includes(f)));
    const facts = await dartXbrlFacts(rp.rcept, "11011");
    const L = leaseFromFacts(facts, rp.prefix, basis);
    if (hit.length) return { status: "included", amount: L.amount, how: `회계정책 주석: 리스부채를 본표 '${hit.join("'·'")}'에 포함(사업보고서 ${rp.rcept})` };
    if (L.amount != null) return { status: "added", amount: L.amount, how: `사업보고서 ${rp.rcept} XBRL 주석 ${rp.prefix} — ${L.how}` };
    tried.push(`${rp.rcept}: ${L.how}`);
  }
  return { status: "unknown", amount: null, how: tried.join(" / ") || "사업보고서 없음" };
}

// ── 분기말 리스부채(원문 주석 표 태그 칸) ──
/**
 * 본표에 리스부채 줄이 없고 회계정책도 "차입금 줄에 포함"이 아닌 회사의 최신 분기말 리스부채(오너 결정 2026-10-05). 규칙 문장만 보고 따로 짠 판독
 * (앱 scripts/populate-kr-da.mjs leaseQuarterOf 를 가져오지 않는다):
 *  - 칸 묶음 = (개념, 연결 축을 뺀 차원). 열 = 분기말(CFY{Y}e{P}A) · 전기말(PFY{Y-1}e{P}), P = FQ·HY·TQ
 *  - 묶음을 믿는 조건: 그 보고서(또는 같은 해 앞 분기 보고서)의 전기말 값이 최근 사업연도 주석 리스부채와 정확히 같다
 *  - 묶음 종류 순위: 리스부채 개념 > 금융부채 범주 표 리스부채 멤버 > 재무활동 부채 조정표 리스부채 멤버 > 유동 + 비유동 합(같은 차원)
 *  - 가장 앞 순위의 믿는 묶음들이 분기말 값 하나로 모이면 그 값, 아니면 정하지 못함(빈칸이어야)
 * reports: [{ q, rcept, cells }] — 같은 사업연도 Y 의 분기 보고서들, q 오름차순(같은 q 는 최신 판본 먼저). 결과 { amount, how } 또는 { amount: null, how }
 */
export function quarterLeaseFromCells(reports, Y, latestQ, annualAmount, basis) {
  const P = { 1: "FQ", 2: "HY", 3: "TQ" };
  // 장부금액이 아닌 칸 — 축 이름(만기·위험 종류) 또는 정확한 멤버 이름(총액·현재가치할인·상각누계)
  const NOT_CARRYING = ["ifrs-full_GrossCarryingAmountMember", "dart_PresentValueDiscountMember", "ifrs-full_PresentValueDiscountMember", "ifrs-full_AccumulatedDepreciationAmortisationAndImpairmentMember", "ifrs-full_AccumulatedImpairmentMember"];
  const SKIP = { test: (dims) => /MaturityAxis|TypesOfRisksAxis/.test(dims) || NOT_CARRYING.some((m) => `_${dims}_`.includes(`_${m}_`)) };
  const kindOf = (concept, dims) => {
    if (concept === "ifrs-full_LeaseLiabilities") return 1;
    if ((concept === "ifrs-full_FinancialLiabilities" || concept === "ifrs-full_OtherFinancialLiabilities") && dims.endsWith("_ifrs-full_LeaseLiabilitiesMember")) return 2;
    if (concept === "ifrs-full_LiabilitiesArisingFromFinancingActivities" && dims === "ifrs-full_LiabilitiesArisingFromFinancingActivitiesAxis_ifrs-full_LeaseLiabilitiesMember") return 3;
    return null;
  };
  const groupsOf = (cells, q) => {
    const heads = { cur: `CFY${Y}e${P[q]}A`, pfy: `PFY${Y - 1}e${P[q]}` };
    const g = new Map(); // "종류|개념|차원" → { kind, cur:[], pfy:[] }
    const pair = new Map(); // 차원 → { cur: {c:[], n:[]}, pfy: {...} }
    for (const [concept, ctx, val] of cells) {
      const col = Object.keys(heads).find((k) => ctx === heads[k] || ctx.startsWith(`${heads[k]}_`));
      if (!col) continue;
      const tail = ctx.slice(heads[col].length);
      const con = /ConsolidatedMember/.test(tail), sepM = /SeparateMember/.test(tail), axis = /ConsolidatedAndSeparateFinancialStatementsAxis/.test(tail);
      if (basis === "OFS" ? con : sepM || (axis && !con)) continue;
      const dims = tail.replace(/_?ifrs-full_ConsolidatedAndSeparateFinancialStatementsAxis_ifrs-full_(?:Consolidated|Separate)Member/, "").replace(/^_/, "");
      if (SKIP.test(dims)) continue;
      const kind = kindOf(concept, dims);
      if (kind) {
        const key = `${kind}|${concept}|${dims}`;
        if (!g.has(key)) g.set(key, { kind, cur: [], pfy: [] });
        g.get(key)[col].push(val);
      } else if (concept === "ifrs-full_CurrentLeaseLiabilities" || concept === "ifrs-full_NoncurrentLeaseLiabilities") {
        if (!pair.has(dims)) pair.set(dims, { cur: { c: [], n: [] }, pfy: { c: [], n: [] } });
        pair.get(dims)[col][concept.includes("Noncurrent") ? "n" : "c"].push(val);
      }
    }
    const single = (xs) => (xs.length && xs.every((x) => x === xs[0]) ? xs[0] : null);
    const out = new Map();
    for (const [key, x] of g) out.set(key, { kind: x.kind, cur: single(x.cur), pfy: single(x.pfy) });
    for (const [dims, x] of pair) {
      const sum = (s) => { const c = single(s.c), n = single(s.n); return c != null && n != null ? c + n : null; };
      out.set(`4|유동+비유동|${dims}`, { kind: 4, cur: sum(x.cur), pfy: sum(x.pfy) });
    }
    return out;
  };
  const trusted = new Map(); // 묶음 → 근거
  const notes = [];
  for (const r of reports) {
    const gs = groupsOf(r.cells, r.q);
    for (const [key, x] of gs) if (x.pfy != null && x.pfy === annualAmount && !trusted.has(key)) trusted.set(key, `${Y} Q${r.q} 보고서 ${r.rcept} 전기말 = 사업연도 주석 ${annualAmount}`);
    if (r.q !== latestQ) continue;
    const usable = [...gs].filter(([key, x]) => trusted.has(key) && x.cur != null && x.cur > 0);
    if (!usable.length) { notes.push(`${r.rcept}: 전기말이 사업연도 주석과 같은 묶음 없음`); continue; }
    const top = Math.min(...usable.map(([, x]) => x.kind));
    const best = usable.filter(([, x]) => x.kind === top);
    const vals = new Set(best.map(([, x]) => x.cur));
    if (vals.size !== 1) { notes.push(`${r.rcept}: 같은 순위 묶음 분기말 값 불일치 ${best.map(([k, x]) => `${k}=${x.cur}`).join(", ")}`); continue; }
    return { amount: best[0][1].cur, how: `분기 보고서 ${r.rcept} 주석 ${best[0][0]} 분기말 ${best[0][1].cur} (${trusted.get(best[0][0])})` };
  }
  return { amount: null, how: notes.join(" / ") || "분기 보고서 없음" };
}
