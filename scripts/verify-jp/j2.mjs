/**
 * 일본 검증기 J2 — EV 구성요소(총차입금·현금성자산·비지배지분)와 EV 공란 판정을 EDINET 원본으로 따로 정한다(docs/verify-jp-design.md §4 J2).
 * 앱 jp-ev.ts 와 다른 방법(코드 공유 없음):
 *  - 차입금 줄 = 재무상태표 **계산 구조**에서 부채 아래 개념 중 **요소 이름**이 차입금 꼴(Borrowing·LoansPayable·Bond·Debt·CommercialPaper·
 *    LeaseLiabilit·LeaseObligation·InterestBearingLiabilit·FinancingLiabilit)인 것의 최상위 — 앱은 일본어 이름표 정규식
 *  - 현금성자산 = 유동자산 아래 요소 이름이 현금·예금·단기투자·유가증권 꼴 — 앱은 표준 요소 + 이름표
 *  - 본표에 리스 개념이 없는 IFRS 회사의 리스부채 = IAS 7 재무활동 부채 변동표(주석)의 기말 잔액으로 **산술 판정**: 차입금 꼴 행(리스 제외) 기말 합이
 *    본표 차입금 줄 합과 맞고 리스 행을 더하면 안 맞으면 "별도"(리스 행 기말을 더한다), 리스 행까지 더해야 맞으면 "포함". 둘 다 아니면 판정 불가 —
 *    앱은 주석 문장("…に含めて表示")·리스 행이 든 표의 合計·장부금액 표로 정한다.
 *  - EV 공란 = 금융업 서식(BNK·INS 요소) · 금융사업 연결(자산 요소 이름에 FinancialServices) · 차입금 개념이 기타 금융부채를 합친 한 줄
 *    (…AndOtherFinancialLiabilities — 오너 결정 D4) · 리스부채 판정 불가.
 */
import { plainValue } from "./xbrl.mjs";

const local = (k) => k.slice(k.indexOf(":") + 1);
const DEBT_ID = /(Borrowing|LoansPayable|Bond|Debt|CommercialPaper|LeaseLiabilit|LeaseObligation|InterestBearingLiabilit|FinancingLiabilit)/;
const NOT_DEBT_ID = /(Receivable|Asset|InterestPayable|InterestExpense|Derivative|Deposit|Provision|Accrued|Allowance|Abstract|Repurchase|Securities|Tax|Heading|Table|LineItems)/;
const LEASE_ID = /(LeaseLiabilit|LeaseObligation)/;
const CASH_ID = /^(CashAndCashEquivalents|CashAndDeposits|TimeDeposits|ShortTermDeposits|ShortTermInvestments?(IFRS|CA)|ShortTermInvestmentSecurities|MarketableSecurities)/;

/** 재무상태표 계산 구조 — 자식 → 부모 */
function bsParents(d) {
  const bsRoles = new Set([...d.roles.values()].filter((r) => r.kind === "bs" && r.cons === d.consUsed).map((r) => r.role));
  const par = new Map();
  for (const [role, arcs] of d.calc) if (bsRoles.has(role)) for (const [f, t] of arcs) if (!par.has(t)) par.set(t, f);
  return { par, concepts: new Set([...d.roles.values()].filter((r) => r.kind === "bs" && r.cons === d.consUsed).flatMap((r) => [...r.concepts])) };
}
const ancestors = (par, k) => {
  const out = [];
  for (let p = par.get(k), i = 0; p && i < 20; p = par.get(p), i++) out.push(p);
  return out;
};

/** 변동표 판독 — 행 방향(이름 기초 … 기말)과 열 방향(머리 이름들, 날짜 행) */
const NUM = /^(△\d[\d,]*|\(\d[\d,]*\)|\d[\d,]*|[-‐―—])$/;
const numOf = (s) => (/^[-‐―—]$/.test(s) ? 0 : (/^[△(]/.test(s) ? -1 : 1) * Number(s.replace(/[△,()]/g, "")));
const DATE1 = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/;
const isoOf = (m) => `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
export function reconTables(d) {
  const rows = []; // { tb, label, open, close }
  const cols = []; // { tb, date, vals: Map(label → v) }
  for (const { name, t } of d.tbs ?? []) {
    if (!/財務活動/.test(t) || !/リース負債|リース債務/.test(t)) continue;
    const toks = t.split(" ");
    let i = 0;
    let header = null;
    while (i < toks.length) {
      if (NUM.test(toks[i])) { i++; continue; }
      const lab = [];
      while (i < toks.length && !NUM.test(toks[i])) lab.push(toks[i++]);
      const nums = [];
      while (i < toks.length && NUM.test(toks[i])) nums.push(toks[i++]);
      if (nums.length < 2) continue;
      const vals = nums.map(numOf);
      const dm = DATE1.exec(lab.at(-1) ?? "");
      if (dm) {
        // 열 방향: 날짜 행 — 머리 = 첫 날짜 행 앞의 이름 nums.length 개
        if (!header || header.length !== vals.length) {
          const h = lab.slice(0, -1).slice(-vals.length);
          if (h.length === vals.length && h.some((x) => /リース負債|リース債務/.test(x))) header = h;
        }
        if (header && header.length === vals.length) cols.push({ tb: name, date: isoOf(dm), vals: new Map(header.map((h, j) => [h, vals[j]])) });
        continue;
      }
      if (vals.length < 4 || /^[-‐―—]$/.test(nums[0]) || /^[-‐―—]$/.test(nums.at(-1))) continue;
      const sum = vals.slice(0, -1).reduce((a, b) => a + b, 0);
      if (Math.abs(sum - vals.at(-1)) > Math.floor(vals.filter((v) => v).length / 2)) continue;
      const label = lab.slice(-3).join(" ").replace(/\((注|※)[^)]*\)|\(注\)|注\d/g, "").trim();
      rows.push({ tb: name, label, open: vals[0], close: vals.at(-1) });
    }
  }
  return { rows, cols };
}
const DEBT_ROW = /借入|社債|コマーシャル|ペーパー|CP|債務|リース負債|リース債務/;
const NOT_DEBT_ROW = /デリバティブ|合計|^計$|\s計$|未払|利息|預り|その他|資産/;
const lastWord = (s) => s.split(" ").at(-1);

/**
 * 변동표에서 날짜 D(당기말·전기말) 기말 잔액 { 행 이름 → 값 }(백만엔). 행 방향은 같은 이름 두 행이 이어지는 것(전기 표 기말 = 당기 표 기초)으로
 * 당기말·전기말을 정한다(표 순서 무관). which = "cur" | "prior"
 */
function reconAt(rc, D, which) {
  const out = new Map();
  for (const c of rc.cols) if (c.date === D) for (const [k, v] of c.vals) if (DEBT_ROW.test(k) && !NOT_DEBT_ROW.test(k)) out.set(k, v);
  if (out.size) return { m: out, how: "변동표(열 방향)" };
  const by = new Map();
  for (const r of rc.rows) {
    const k = lastWord(r.label);
    if (!DEBT_ROW.test(k) || NOT_DEBT_ROW.test(k)) continue;
    (by.get(k) ?? by.set(k, []).get(k)).push(r);
  }
  for (const [k, rs] of by) {
    const pair = rs.flatMap((a) => rs.filter((b) => b !== a && a.close === b.open).map((b) => [a, b]))[0];
    if (!pair) return { m: null, why: `변동표 "${k}" 행이 전기·당기로 이어지지 않음` };
    out.set(k, which === "cur" ? pair[1].close : pair[0].close);
  }
  return out.size ? { m: out, how: "변동표(행 방향, 전기 기말 = 당기 기초)" } : { m: null, why: "변동표에 차입금 꼴 행 없음" };
}

/**
 * 결산일 D 의 EV 구성요소 기대값. which = D 가 그 서류의 당기말("cur")인지 전기말("prior")인지.
 * 반환 { debt: { v | blank | why, how }, cash, nci, evBlank: 사유|null, evWhy: 판정 불가 사유|null }
 */
export function evComponents(d, D, which) {
  const { par, concepts } = bsParents(d);
  const val = (k) => plainValue(d, k, { instant: D });
  const isLiab = (k) => ancestors(par, k).some((a) => /^(Total)?(Current|NonCurrent|Noncurrent)?L[a-z]*bilit/.test(local(a)) && !/AndEquity|AndNetAssets/.test(local(a)));
  const isCurAsset = (k) => ancestors(par, k).some((a) => /^CurrentAssets/.test(local(a)));
  // 금융업 서식 = 손익계산서 본표에 은행·보험·증권 요소(…BNK·INS·SEC) — 주석 사실(JR東海)·재무상태표 한 줄(セブン&アイ コールマネー)로 판정하지 않는다
  const financial = [...d.roles.values()].filter((r) => r.kind === "is" && r.cons === d.consUsed).some((r) => [...r.concepts].some((k) => /(BNK|INS|SEC)$/.test(k)));
  const debtKs = [...concepts].filter((k) => DEBT_ID.test(local(k)) && !NOT_DEBT_ID.test(local(k)) && isLiab(k));
  const top = debtKs.filter((k) => !ancestors(par, k).some((a) => debtKs.includes(a)));
  const parts = top.map((k) => ({ k, f: val(k) })).filter((x) => x.f && !x.f.conflict && x.f.v != null);
  const debtBs = parts.reduce((a, x) => a + x.f.v, 0);
  const cashKs = [...concepts].filter((k) => CASH_ID.test(local(k)) && isCurAsset(k));
  const cashTop = cashKs.filter((k) => !ancestors(par, k).some((a) => cashKs.includes(a)));
  const cashP = cashTop.map((k) => ({ k, f: val(k) })).filter((x) => x.f && !x.f.conflict && x.f.v != null);
  const nciK = ["jpigp_cor:NonControllingInterestsIFRS", "jppfs_cor:NonControllingInterests"].find((k) => concepts.has(k));
  const nciF = nciK ? val(nciK) : undefined;
  const ifrs = d.dei.AccountingStandardsDEI === "IFRS";
  const r = {
    debt: { v: debtBs, how: parts.map((x) => `${local(x.k)} ${x.f.v / 1e6}`).join(" + ") || "차입금 꼴 요소 없음(0)" },
    cash: cashP.length ? { v: cashP.reduce((a, x) => a + x.f.v, 0), how: cashP.map((x) => local(x.k)).join(" + ") } : { why: "현금 꼴 요소 없음" },
    // 비지배지분 줄이 본표에 없으면 — 자본총계 줄이 있으면 0(자본총계 = 지배주주 자본), 자본총계 줄도 없으면 빈칸
    nci: nciK ? { v: nciF?.v ?? 0, how: local(nciK) } : ["jpigp_cor:EquityIFRS", "jppfs_cor:NetAssets"].some((k) => concepts.has(k) && val(k)?.v != null) ? { v: 0, how: "비지배지분 줄 없음 · 자본총계 있음(0)" } : { blank: "본표에 비지배지분·자본총계 줄 없음" },
    evBlank: null,
    evWhy: null,
  };
  if (financial) {
    r.evBlank = "금융업 서식(BNK·INS 요소)";
    r.debt = { blank: "금융업 서식 — 총차입금 미산정" };
    return r;
  }
  // 금융사업 연결 = 금융서비스 자산(…FinancialServices…) 또는 은행업 예금(…BankingBusiness — セブン銀行) 요소에 값
  const captive = [...concepts].find((k) => ((/FinancialServices/.test(local(k)) && /(CA|NCA)IFRS$|Assets?$/.test(local(k))) || /BankingBusiness/.test(local(k))) && val(k)?.v != null);
  if (!r.evBlank && captive) r.evBlank = `금융사업 연결(${local(captive)})`;
  const mixed = top.find((k) => /AndOtherFinancialLiabilit/.test(local(k)));
  if (mixed) {
    r.debt = { blank: `차입금 개념이 기타 금융부채를 합친 한 줄(${local(mixed)} — 오너 결정 D4)` };
    if (!r.evBlank) r.evBlank = r.debt.blank;
  }
  if (ifrs && !financial && !mixed && !top.some((k) => LEASE_ID.test(local(k)))) {
    // 본표에 리스 개념 없음 — 변동표 산술 판정
    const rc = reconTables(d);
    const at = reconAt(rc, D, which);
    if (!at.m) r.lease = { why: at.why };
    else {
      const leaseK = [...at.m.keys()].find((k) => /リース負債|リース債務/.test(k));
      const non = [...at.m].filter(([k]) => k !== leaseK).reduce((a, [, v]) => a + v, 0);
      const bsM = debtBs / 1e6;
      const tol = at.m.size;
      if (leaseK == null) r.lease = { why: "변동표에 リース負債 행 없음" };
      else {
        const L = at.m.get(leaseK);
        const sep = Math.abs(non - bsM) <= tol, inc = Math.abs(non + L - bsM) <= tol;
        const how = `${at.how}: ${[...at.m].map(([k, v]) => `${k} ${v}`).join(" · ")} vs 본표 차입금 ${bsM}`;
        if (sep && !inc) r.lease = { v: L * 1e6, sep: true, how };
        else if (inc && !sep) r.lease = { v: 0, sep: false, how };
        else r.lease = { why: `변동표 합이 본표 차입금과 맞지 않음(${how})` };
      }
    }
    if (r.lease.v == null) {
      r.debt = { why: `리스부채 판정 불가 — ${r.lease.why}` };
      r.evWhy = r.debt.why;
    } else if (r.lease.sep) r.debt = { v: debtBs + r.lease.v, how: `${r.debt.how} + 리스부채 ${r.lease.v / 1e6}(${r.lease.how})` };
    else r.debt = { v: debtBs, how: `${r.debt.how} — 리스부채 포함(${r.lease.how})` };
  }
  return r;
}
