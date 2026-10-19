/**
 * 검증기 — 한국 EV 구성요소(B16, CLAUDE.md "한국 EV·차입금 단일 기준")를 DART 원자료(fnlttSinglAcntAll 재무상태표 줄)로 **따로** 계산한다.
 * 앱 src/lib/markets/kr/dart-ev.ts 를 읽거나 가져오지 않는다 — 규칙 문장만 보고 다시 짠 판독(같은 결함을 같이 갖지 않게).
 *
 *  총차입금 = 차입금·사채·리스부채 줄 합. "(유동|비유동|단기|장기)금융부채" 이름 줄은 다른 차입금 줄이 없을 때만(한전·HD현대식).
 *  현금성자산 = 현금및현금성자산 + 단기금융상품 + 단기투자자산 + 유동 상각후원가·당기손익-공정가치 금융자산. "기타(유동)금융자산" 계열 줄은
 *  주석 내역의 예금성·투자성 부분만(B16 ②b, 오너 결정 2026-10-18 — cashnote.mjs).
 *  비지배지분 = 비지배지분 줄.
 *  재무상태표 본표에 리스부채 줄이 없으면(오너 결정 2026-10-05) 사업보고서 주석의 리스부채 합계를 더한다 — 단 회사 회계정책 주석이 리스부채를
 *  본표 차입금 줄에 포함해 표시한다고 밝히면(삼성전자 "'유동성장기부채' 또는 '장기차입금'으로 분류") 이미 들어 있으므로 더하지 않는다(leaseNote).
 */
import { dartXbrlFacts, dartDocLeaseSentences, dartDocNumberStreams, dartDocLeaseTables } from "./dart.mjs";
import { parseFinTable } from "./cashnote.mjs";

const nm = (s) => String(s ?? "").replace(/\s/g, "");
const isStd = (id) => /^(ifrs-full|dart)_/.test(id ?? "");
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
const FAMILY = /^(기타금융자산|기타유동금융자산|유동금융자산|기타투자자산|유동기타금융자산|기타유동투자자산)$/;
export function classifyBsRows(rows, ownRows = rows, rename = null, valCol = null) {
  void ownRows; void valCol;
  const bs = (rows ?? []).filter((r) => r.sj_div === "BS");
  // B16 ②b 계열 줄 — 유동자산 쪽(비유동자산 머리 줄 뒤·비유동 태그 제외)
  const ncAt = bs.findIndex((r) => r.account_id === "ifrs-full_NoncurrentAssets" || /^비유동자산(합계)?$/.test(nm(r.account_nm)));
  const isFamily = (r) => FAMILY.test(nm(r.account_nm)) && !/Non-?[cC]urrent/.test(r.account_id ?? "") && (ncAt < 0 || bs.indexOf(r) < ncAt);
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
    // B16 ②b(오너 결정 2026-10-18): "기타(유동)금융자산" 계열 줄은 cash 에 넣지 않고 family 로 따로 — 주석 내역으로 현금성 부분을 정한다(cashnote.mjs familyCashFromNotes)
    cash: bs.filter((r) => !isFamily(r) && !/^기타(유동)?금융자산$/.test(nm(r.account_nm)) && (CASH_NAME.test(nm(r.account_nm)) || (isStd(r.account_id) && CASH_STD.test(r.account_id)))),
    family: bs.filter(isFamily),
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
 * 리스부채가 본표 차입금 줄 **금액 안에** 있는가 — 원문 주석 표의 숫자 흐름으로 따로 확인(2026-10-18, 앱 적재 스크립트의 표 줄 판독과 다른 방식).
 * 회계정책 문장만으로는 모자란다: 298040 "리스부채는 이자부 차입금에 포함" 인데 본표 차입금 802,441 백만원 = 차입금 주석 합계(리스 없음, 리스는
 * "기타금융부채(리스부채)"), 103590 2022 "'유동성장기부채' 또는 '장기차입금'으로 분류" 인데 차입금 주석 합계 196,807,960천원 = 본표 차입금 합(리스 없음).
 * 확인 조건: 한 표의 숫자 흐름에서 간격 s(1~4 — 열이 여럿인 표)로 늘어선 숫자 k(≥2)개의 합이 바로 다음 같은 간격 자리 숫자 T 와 **정확히** 같고,
 * T 앞 글자가 합계(계)이며, 그 k 개 중 하나의 앞 글자에 "리스"가 있고, |T| 가 그 보고서 당기 본표 차입금 줄 하나(또는 차입금 줄 합)를 표 단위로 바꾼
 * 값과 k/2 단위 안(반올림한 k 개를 더한 소계라서)일 때. 못 찾으면 null
 */
export async function leaseInsideFaceDebt(rcepts, faceVals) {
  const targets = faceVals.filter((x) => x != null && x !== 0);
  if (!targets.length) return null;
  targets.push(targets.reduce((a, x) => a + x, 0));
  for (const rc of rcepts) {
    for (const { u, toks } of await dartDocNumberStreams(rc)) {
      for (let q = 2; q < toks.length; q++) {
        if (!/계\s*$/.test(toks[q].before)) continue;
        const T = toks[q].v;
        const face = targets.find((f) => Math.abs(Math.abs(f) / u - Math.abs(T)) <= 5);
        if (face == null) continue;
        for (let s = 1; s <= 4; s++) {
          let sum = 0, lease = null;
          for (let k = 1; k <= 12 && q - k * s >= 0; k++) {
            const t = toks[q - k * s];
            if (/계\s*$/.test(t.before)) break; // 앞 묶음의 합계 자리 — 묶음 경계
            sum += t.v;
            if (!lease && /리스/.test(t.before)) lease = t;
            if (k >= 2 && sum === T && lease && Math.abs(Math.abs(face) / u - Math.abs(T)) <= k / 2)
              return `원문 ${rc} 주석 표: '${lease.before.slice(-30)}' ${lease.v} 포함 ${k}개 합 = '${toks[q].before.slice(-12)}' ${T}(단위 ${u}원) ≈ 본표 차입금 ${face}원`;
          }
        }
      }
    }
  }
  return null;
}

// ── 원문 주석 표 판독(오너 결정 2026-10-19 — XBRL 리스부채 주석 태그가 없는 해) ──
const cl0 = (t) => String(t ?? "").replace(/\((?:\*|주)\s*\d*(?:,\s*\d+)*\)|\*\d*/g, "").replace(/\s/g, "");
const isNum = (x) => typeof x?.n === "number" && !Number.isNaN(x.n) && !x.span;
const leafOf = (row) => row.filter((c) => Number.isNaN(c.n) && c.t).map((c) => c.t).at(-1) ?? "";
function headOf(T, c) {
  const first = T.rows.findIndex((r) => r.some((x) => isNum(x) && x.n !== 0));
  const hs = [];
  for (let r = 0; r < (first < 0 ? T.rows.length : first); r++) { const t = T.rows[r][c]?.t; if (t && !hs.includes(t)) hs.push(t); }
  return cl0(hs.join(" "));
}
const FLOWH = /할인|원리금|만기|명목|취득|증가|감소|이자|지급|상환|현금흐름|대체|변동|제거|리스료|환율|외화|최소|이내|초과|순현금|상각|평가|기타|사업결합|연결범위/;
/** 열 머리 → 그 열이 가리키는 기말 시점("cur" 당기말·"prior" 전기말·null). tp = 표 자체의 기간(표 바로 앞 "(전기)" 또는 바로 앞 같은 꼴 표 다음이면 prior).
 *  「제 47(당) 기」「제 46(전) 기말」은 당기·전기로 읽는다. 흐름(취득·지급…)·만기·할인 전 금액(최소리스료·원리금·할인되지 않은) 열은 잔액이 아니다 */
function periodOf(h0, tp) {
  const h = h0.replace(/\(당\)/g, "당").replace(/\(전\)/g, "전").replace(/^\(단위:[^)]*\)/, "");
  if (FLOWH.test(h.replace(/장부금액|현재가치/g, ""))) return null;
  // 표 자체가 전기 표(짝의 둘째 — 051600 2021 재무활동 부채 변동 전기 표도 머리는 「당기초·당기말」)면 그 표의 당기 = 전기, 기초·전기 = 그 전 해(쓰지 않음)
  if (tp === "prior") return /기초|전기/.test(h) ? null : /당기말|당기|당반기|기말|장부금액|현재가치/.test(h) ? "prior" : null;
  if (/기초/.test(h)) return "prior";
  if (/전기말|전기/.test(h)) return "prior";
  if (/당기말|당기|당반기/.test(h)) return "cur";
  if (/기말|장부금액|현재가치/.test(h)) return tp;
  return null;
}
const LEASE_ROW = /리스부채$/; // 리스부채·유동리스부채·비유동리스부채·장기리스부채·유동성 리스부채
// 리스 잔액 표가 아닌 표 — 이연법인세(일시적차이 — 178320 2021 "리스부채 352,453"은 일시적차이 증감 표의 기말)·이자비용·손익·만기분석(할인 전)
const NOT_LEASE_TABLE = /이연법인세|일시적차이|법인세|이자비용|손익|할인되지\s*아니한|할인하지\s*아니한|계약상\s*현금흐름|만기별|민감도/;
/**
 * 원문 주석 표에서 그 해 말 리스부채 장부금액 후보 — entries = [{ rc, role: "cur"|"prior", tables }]. 꼴(표 구조로만):
 *  ① 열 = 시점, 줄 = 항목: 그 열의 리스부채 줄 중 양수 줄 — 하나(리스부채·장기리스부채·금융리스부채)면 그 값, 둘(유동 + 비유동)이면 합.
 *     음수 리스 줄은 유동성 대체(차감)라 더하지 않는다(178320 「장기차입부채」 장기리스부채 17,343,101 · (9,287,694))
 *  ①′ 같은 시점의 '유동'·'비유동' 열 둘(052690 「매입채무및기타채무」 제47(당)기 유동 1,068,770 · 비유동 744,479)의 리스부채 줄 = 두 칸 합
 *  ② 줄 = 시점(기말·기말금액·기말 장부금액·기초), 열 = 항목(재무활동 부채 변동표 — 리스부채 열 하나 또는 둘의 합)
 *  ③ 표 바로 앞 글이 리스부채 표라고 말하고 항목 이름이 없는 표: 줄 "기말…" 또는 "합계"(현재가치·장부금액 열)
 * 같은 내용 표(본문·감사보고서 중복)는 하나로 센다
 */
export function leaseDocCandidates(entries, want, sepOk = true) {
  const out = [];
  const seen = new Set();
  const headSig = (T) => { const first = T.rows.findIndex((r) => r.some((x) => isNum(x) && x.n !== 0)); return T.rows.slice(0, first < 0 ? 0 : first).map((r) => r.map((c) => cl0(c.t)).join("|")).join("/"); };
  const flat = (T) => T.rows.map((r) => r.map((c) => c.t).join(" ")).join(" ").replace(/\s+/g, "");
  for (const { rc, role, tables } of entries) {
    let ts = tables.map(parseFinTable).filter((T) => T.u);
    // 원하는 범위(연결) 표가 없는 보고서(그해 연결 재무제표 없음 — 062040 2024 사업보고서)는 별도 표를 쓰되, 그해 연결 본표 = 별도 본표(자산·부채·자본총계)가
    // 확인된 경우만(sepOk — layers 가 정한다). 확인 못 하면 그 보고서 표를 쓰지 않는다
    if (want && ts.some((T) => T.scope === want)) ts = ts.filter((T) => T.scope !== (want === "con" ? "sep" : "con"));
    else if (want === "con" && !sepOk) ts = ts.filter((T) => T.scope !== "sep");
    // 표 기간 — 표 앞 "(전기)"·"전기", 또는 바로 앞 표와 머리 꼴이 같고 사이에 다른 글이 없으면 그 짝의 둘째 표 = 전기(051600 2021 당기·전기 리스부채 변동표)
    const capOf = (T) => T.pre.split(/\d{1,3}(?:,\d{3})+\)?/).at(-1).slice(-200);
    const pairPrev = ts.map(() => false);
    const tps = ts.map((T, i) => {
      // 표 앞 끝이 「(전기)」「전기」「② 전기말」(062040 유동성위험 표 「② 전기말」 장부금액 열)
      if (/\(?전\s*기\s*말?\)?\s*(?:\(단위[^)]*\))?\s*$/.test(T.pre.slice(-40))) return "prior";
      const P = ts[i - 1];
      // 머리 꼴 = 열 수 + 첫·마지막 머리 칸(가운데 흐름 열 이름은 해마다 다를 수 있다 — 051600 「환율변동」↔「기타」)
      const sig = (X) => { const h = headSig(X).split("/").at(-1)?.split("|") ?? []; return h.length > 1 ? `${h.length}|${h[0]}|${h.at(-1)}` : ""; };
      if (P && sig(P) && sig(P) === sig(T) && T.pre.replace(/\s+/g, "").slice(-120).includes(flat(P).slice(-40))) { pairPrev[i] = true; return "prior"; }
      return "cur";
    });
    ts.forEach((T, ti) => {
      const key = T.rows.map((r) => r.map((c) => c.t).join("|")).join("\n");
      if (seen.has(key)) return;
      seen.add(key);
      // 표 제목 글 = 표 앞 글 중 마지막 숫자(앞 표 끝) 뒤 — 앞 표 내용("계약상 현금흐름의 현재가치")이 섞이지 않게
      const cap = capOf(T);
      // 짝의 둘째 표(전기)는 첫째 표 제목을 따른다(178320 「일시적차이 … 1) 당기 / 2) 전기」)
      if (NOT_LEASE_TABLE.test(cap) || (pairPrev[ti] && NOT_LEASE_TABLE.test(capOf(ts[ti - 1])))) return;
      // 표 안 줄이 일시적차이 항목이면(대손충당금·퇴직급여충당부채·이연법인세 — 「2) 전기」처럼 제목이 짧은 이어진 표) 리스 잔액 표가 아니다
      if (T.rows.some((r) => /이연법인세|대손충당금|퇴직급여충당부채/.test(cl0(leafOf(r))))) return;
      const tp = tps[ti];
      const preLease = /리스/.test(cap);
      const ncol = Math.max(...T.rows.map((r) => r.length));
      // k = 더한 칸 수 — 칸 하나(원문에 그 값이 그대로 있음)와 반올림된 칸들의 합을 나눠 판정한다(pickLeaseAmount)
      const push = (cells, how) => { if (cells.length) out.push({ won: cells.reduce((a, x) => a + x.n, 0) * T.u, u: T.u, k: cells.length, rc, how: `${rc} ${how} ${cells.map((x) => x.n).join("+")}(단위 ${T.u})`, key }); };
      const leaseRows = (c) => T.rows.filter((r) => isNum(r[c]) && LEASE_ROW.test(cl0(leafOf(r))) && !/합계|소계|이자|비용/.test(cl0(leafOf(r))));
      // ①′ 같은 시점 유동·비유동 열 짝
      const byP = new Map();
      for (let c = 1; c < ncol; c++) {
        const h = headOf(T, c), p = periodOf(h.replace(/비유동|유동/g, ""), tp);
        if (!p || !/유동/.test(h)) continue;
        if (!byP.has(p)) byP.set(p, []);
        byP.get(p).push({ c, non: /비유동/.test(h) });
      }
      const pairCols = new Set();
      for (const [p, cs] of byP) {
        if (cs.length !== 2 || cs.filter((x) => x.non).length !== 1) continue;
        cs.forEach((x) => pairCols.add(x.c));
        if (p !== role) continue;
        const rows = T.rows.filter((r) => LEASE_ROW.test(cl0(leafOf(r))) && cs.some((x) => isNum(r[x.c])));
        if (rows.length === 1) push(cs.map((x) => rows[0][x.c]).filter(isNum), `'${headOf(T, cs[0].c).slice(0, 14)}'·'${headOf(T, cs[1].c).slice(0, 14)}' 열 리스부채 줄`);
      }
      // ①
      for (let c = 1; c < ncol; c++) {
        if (pairCols.has(c)) continue;
        const p = periodOf(headOf(T, c), tp);
        if (p !== role) continue;
        const pos = leaseRows(c).filter((r) => r[c].n > 0);
        if (pos.length === 1 && /^(?:장기|금융)?리스부채$/.test(cl0(leafOf(pos[0])))) push([pos[0][c]], `'${headOf(T, c).slice(0, 14)}' 열 '${leafOf(pos[0])}' 줄`);
        else if (pos.length === 2) push(pos.map((r) => r[c]), `'${headOf(T, c).slice(0, 14)}' 열 리스부채 두 줄`);
        // 리스부채 표(제목이 리스)의 「기말…」 줄·현재가치/장부금액 열 「합계」 줄 — 유동·비유동 줄이 같은 표에 있어도 칸 하나 값으로 따로 센다(062040 2024 보고서
        // 「(2) 리스부채의 변동내역」 전기 기말 880,631 = 유동 479,870 + 비유동 400,761)
        if (preLease) {
          const end = T.rows.filter((r) => isNum(r[c]) && (/^기말/.test(cl0(leafOf(r))) || (cl0(leafOf(r)) === "합계" && /현재가치|장부금액/.test(headOf(T, c)))));
          if (end.length === 1) push([end[0][c]], `리스부채 표 '${headOf(T, c).slice(0, 14)}' 열 '${leafOf(end[0])}' 줄`);
        }
      }
      // ②
      for (const r of T.rows) {
        const lf = cl0(leafOf(r));
        const p = /^기말/.test(lf) ? tp : /^기초/.test(lf) && tp === "cur" ? "prior" : null;
        if (p !== role) continue;
        const cs = [];
        for (let c = 1; c < r.length; c++) if (isNum(r[c]) && LEASE_ROW.test(headOf(T, c)) && !/합계/.test(headOf(T, c))) cs.push(r[c]);
        if (cs.length === 1 || cs.length === 2) push(cs, `'${leafOf(r)}' 줄 리스부채 열`);
      }
    });
  }
  return out;
}
/** 후보 묶음 판정 — 표 단위 1칸 안 값끼리 한 무리. 서로 다른 표 2개 이상이 받치고 다음 무리보다 많아야 채택. 무리 안 값이 다르면 반올림 범위 */
export function pickLeaseAmount(cands) {
  if (!cands.length) return null;
  const sorted = [...cands].sort((a, b) => a.won - b.won);
  const groups = [];
  // 한 무리 = 이웃 값 차가 (더한 칸 수 × 표 단위) 안 — 반올림된 칸 k 개의 합은 k/2 단위씩 벗어날 수 있다
  for (const x of sorted) { const g = groups.at(-1); if (g && x.won - g.at(-1).won <= Math.max(x.k * x.u, g.at(-1).k * g.at(-1).u)) g.push(x); else groups.push([x]); }
  const score = (g) => new Set(g.map((x) => x.key)).size;
  groups.sort((a, b) => score(b) - score(a));
  if (score(groups[0]) < 2 || (groups[1] && score(groups[1]) >= score(groups[0]))) return { amount: null, how: `원문 주석 리스부채 후보가 모이지 않음 — ${cands.map((x) => x.how).join(" / ").slice(0, 400)}` };
  const g = groups[0];
  const others = groups.slice(1).flat();
  const how0 = `원문 주석 표 ${score(g)}개 — ${g.map((x) => x.how).join(" / ").slice(0, 400)}${others.length ? ` (다른 값: ${others.map((x) => x.how).join(" / ").slice(0, 200)})` : ""}`;
  const support = (v, xs) => new Set(xs.filter((x) => x.won === v).map((x) => x.key)).size;
  // 원문 칸 하나로 있는 값이 우선 — 반올림된 칸들의 합은 그 값과 다를 수 있어 범위로만 쓴다
  const singles = g.filter((x) => x.k === 1);
  if (singles.length) {
    const sv = [...new Set(singles.map((x) => x.won))].sort((a, b) => support(b, singles) - support(a, singles));
    const u = Math.max(...singles.map((x) => x.u));
    if (sv.length === 1) return { amount: sv[0], how: `${how0} — 칸 하나 값 ${sv[0]}(합으로 맞춘 값은 범위로만)`, range: u > 1 ? [sv[0] - u / 2, sv[0] + u / 2] : null };
    return { amount: sv[0], how: `${how0} — 원문 칸 하나 값끼리 갈림(${sv.join("·")}) — 표 단위 반올림 범위`, range: [Math.min(...sv) - u / 2, Math.max(...sv) + u / 2], rounding: true, ambiguous: true };
  }
  const vals = [...new Set(g.map((x) => x.won))].sort((a, b) => support(b, g) - support(a, g));
  const lo = Math.min(...g.map((x) => x.won - (x.k * x.u) / 2)), hi = Math.max(...g.map((x) => x.won + (x.k * x.u) / 2));
  return { amount: vals[0], how: `${how0} — 칸 하나 값 없음, 반올림 칸 합만(값 ${vals.join("·")})`, range: hi > lo ? [lo, hi] : null, rounding: vals.length > 1, ambiguous: true };
}
/**
 * 회계정책상 본표 차입금 포함인 회사 — 원문 차입금 주석에서 본표 차입금 합 F(원)를 합계로 하는 표를 찾아 그 안의 리스부채 금액(없으면 0)을 낸다.
 * 표 조건: 합계 줄(합계·계·총차입금) 값이 F 와 표 단위 5칸 안, 같은 표에 차입금·사채 이름 줄이 2개 이상. 그 열 합계 줄 위의 "리스" 이름 줄 합 = 본표 안 리스부채
 */
export function leaseInsideFromNote(entries, F0, want, sepOk = true) {
  // F0 = 본표 차입금 줄 값들(원) — 합계 줄은 그 줄들 중 일부의 합과 맞아도 된다(178320 「장기차입부채」 합계 214,220,318 = 본표 장기차입부채 줄)
  const lines = (Array.isArray(F0) ? F0 : [F0]).filter((x) => x);
  if (!lines.length) return null;
  const targets = new Set();
  for (let m = 1; m < 1 << Math.min(lines.length, 8); m++) targets.add(lines.reduce((a, x, i) => (m & (1 << i) ? a + x : a), 0));
  const F = [...targets];
  for (const { rc, tables } of entries) {
    let ts = tables.map(parseFinTable).filter((T) => T.u);
    // 원하는 범위(연결) 표가 없는 보고서(그해 연결 재무제표 없음 — 062040 2024 사업보고서)는 별도 표를 쓰되, 그해 연결 본표 = 별도 본표(자산·부채·자본총계)가
    // 확인된 경우만(sepOk — layers 가 정한다). 확인 못 하면 그 보고서 표를 쓰지 않는다
    if (want && ts.some((T) => T.scope === want)) ts = ts.filter((T) => T.scope !== (want === "con" ? "sep" : "con"));
    else if (want === "con" && !sepOk) ts = ts.filter((T) => T.scope !== "sep");
    for (const T of ts) {
      if (/자본조달|자본관리|순부채/.test(T.pre.slice(-200))) continue; // 자본관리 표의 "총차입금" 한 줄은 내역이 아니다
      const debtRows = T.rows.filter((r) => /차입금|사채/.test(cl0(leafOf(r))) && !/합계|소계|^계$|총차입금/.test(cl0(leafOf(r))));
      if (debtRows.length < 2) continue;
      for (let r = 0; r < T.rows.length; r++) {
        const lf = cl0(leafOf(T.rows[r]));
        if (!/합계$|^계$|^총차입금$/.test(lf)) continue;
        for (let c = 1; c < T.rows[r].length; c++) {
          const x = T.rows[r][c];
          const hitF = isNum(x) ? F.find((f) => Math.abs(x.n * T.u - f) <= 5 * T.u) : null;
          if (hitF == null) continue;
          // 리스 줄 중 양수만(음수 = 유동성 대체 — 다른 본표 차입금 줄로 옮겨 간 것)
          const ls = T.rows.slice(0, r).filter((rw) => /리스/.test(cl0(leafOf(rw))) && isNum(rw[c]) && rw[c].n > 0);
          const inside = ls.reduce((a, rw) => a + rw[c].n * T.u, 0);
          return { inside, how: `차입금 주석 ${rc} '${leafOf(T.rows[r])}' ${x.n}(단위 ${T.u}) ≈ 본표 차입금 ${hitF}${ls.length ? ` — 안에 리스 ${ls.map((rw) => `'${leafOf(rw)}' ${rw[c].n}`).join("+")}` : " — 안에 리스 줄 없음"}` };
        }
      }
    }
  }
  return null;
}

/**
 * 본표에 리스부채 줄이 없는 해의 판정 — { status: "included"|"added"|"unknown", amount, how }.
 *  included: 정책 문장이 리스부채를 본표 차입금 줄(이름이 본표 차입금 줄과 맞음)에 포함한다고 밝힘 → 더하지 않음
 *  added: 주석 리스부채 장부금액(후보 두 개 이상 일치) → 총차입금에 더함
 *  unknown: 둘 다 못 정함 → EV 공란이어야 한다
 * report = { rcept, prefix } (그 해 값이 실린 사업보고서와 컨텍스트 접두어)
 */
export async function leaseNoteFor(reports, basis, faceDebtNamesOf, badReports = new Map(), faceDebtValuesOf = null, faceDebtY = null, sepOk = true) {
  const tried = [];
  const want = basis === "OFS" ? "sep" : "con";
  // 원문 주석 표(XBRL 태그가 없는 해·회계정책 확인용) — 보고서마다 한 번만
  const docEntries = [];
  const docOf = async () => {
    if (!docEntries.length) for (const rp of reports) { if (!rp || badReports.has(rp.rcept)) continue; for (const rc of rp.all?.length ? rp.all : [rp.rcept]) docEntries.push({ rc, role: rp.prefix.startsWith("PFY") ? "prior" : "cur", tables: await dartDocLeaseTables(rc) }); }
    return docEntries;
  };
  let policyHit = null, xbrl = null;
  for (const rp of reports) {
    if (!rp) continue;
    if (badReports.has(rp.rcept)) { tried.push(`${rp.rcept}: 단위 오류 보고서(${badReports.get(rp.rcept)}) — 건너뜀`); continue; }
    const sents = [];
    for (const rc of rp.all?.length ? rp.all : [rp.rcept]) sents.push(...(await dartDocLeaseSentences(rc)));
    const names = leaseInDebtLines(sents);
    // 정책 문장의 줄 이름은 그 보고서 본표의 차입금 줄과 맞춘다(같은 보고서 — 103590: 2022 보고서 "장기차입금", 2024 보고서는 줄 이름을 바꿨다)
    const faceDebtNames = names.length ? await faceDebtNamesOf(rp.fy) : [];
    const hit = names.filter((n) => faceDebtNames.some((f) => f.includes(n) || n.includes(f)));
    const facts = await dartXbrlFacts(rp.rcept, "11011");
    const L = leaseFromFacts(facts, rp.prefix, basis);
    // 문장만으로 포함이라 보지 않는다 — 그 보고서 당기 본표 차입금 줄 금액 안에 리스가 있는지 원문 숫자로 확인(못 하면 주석 리스부채를 더한다)
    const conf = hit.length && faceDebtValuesOf ? await leaseInsideFaceDebt(rp.all?.length ? rp.all : [rp.rcept], await faceDebtValuesOf(rp.fy)) : null;
    if (hit.length && conf) return { status: "included", amount: L.amount, how: `회계정책 주석: 리스부채를 본표 '${hit.join("'·'")}'에 포함(사업보고서 ${rp.rcept}) — 금액 확인: ${conf}` };
    if (hit.length && !policyHit) policyHit = { rc: rp.rcept, names: hit };
    if (hit.length) tried.push(`${rp.rcept}: 회계정책 문장('${hit.join("'·'")}')은 있으나 숫자 흐름으로 본표 차입금 안의 리스를 확인 못 함`);
    if (L.amount != null && !xbrl) xbrl = { amount: L.amount, how: `사업보고서 ${rp.rcept} XBRL 주석 ${rp.prefix} — ${L.how}` };
    if (L.amount == null) tried.push(`${rp.rcept}: ${L.how}`);
  }
  // 리스부채 합계 — XBRL 주석 태그 → 없으면 원문 주석 표(오너 결정 2026-10-19)
  let total = xbrl;
  if (!total) {
    const p = pickLeaseAmount(leaseDocCandidates(await docOf(), want, sepOk));
    if (p?.amount != null) total = { amount: p.amount, range: p.range ?? null, ambiguous: !!p.ambiguous, how: `원문 주석 — ${p.how}` };
    else tried.push(p ? p.how : "원문 주석 표에 리스부채 후보 없음");
  }
  if (!total) return { status: "unknown", amount: null, how: tried.join(" / ") || "사업보고서 없음" };
  // 원문 차입금 주석으로 본표 안에 든 리스부채를 확인해 빠진 만큼만 더한다(오너 결정 2026-10-19). 회계정책 문장이 없어도 차입금 주석 표가 리스 줄을 담고
  // 합계가 본표 차입금(줄 일부 합)과 맞으면 포함으로 본다(178320 2021). 회계정책상 포함인데 그런 표를 못 찾으면 공란
  const ins0 = leaseInsideFromNote(await docOf(), faceDebtY, want, sepOk);
  if (!policyHit && ins0?.inside > 0) policyHit = { rc: "차입금 주석", names: ["차입금 주석 표의 리스 줄"] };
  if (policyHit) {
    const ins = ins0;
    if (!ins) return { status: "unknown", amount: null, how: `회계정책 문장('${policyHit.names.join("'·'")}', ${policyHit.rc})은 본표 차입금 포함인데 원문 차입금 주석에서 본표 차입금 합 ${JSON.stringify(faceDebtY)} 표를 못 찾음 — 본표 안 리스부채 확인 불가 / ${tried.join(" / ")}` };
    const add = total.amount - ins.inside;
    if (add === 0) return { status: "included", amount: total.amount, how: `${ins.how} — 리스부채 ${total.amount} 전부 본표 안(${total.how})` };
    if (add < 0) return { status: "unknown", amount: null, how: `${ins.how} — 본표 안 리스(${ins.inside})가 리스부채 합계(${total.amount})보다 큼 / ${total.how}` };
    return { status: "added", amount: add, ambiguous: total.ambiguous, range: total.range ? [total.range[0] - ins.inside, total.range[1] - ins.inside] : null, how: `리스부채 ${total.amount} − 본표 안 ${ins.inside} = ${add} 가산(${ins.how}; ${total.how})` };
  }
  return { status: "added", amount: total.amount, range: total.range ?? null, ambiguous: total.ambiguous, how: total.how };
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


// B16 ②b(기타(유동)금융자산 계열 줄의 현금성 부분)는 cashnote.mjs — 원문 표를 행·열 격자로 읽는 판독(2026-10-18 다시 짬, 예전 숫자 흐름 familyCashPart 삭제)
