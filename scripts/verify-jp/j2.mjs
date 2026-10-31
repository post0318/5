/**
 * 일본 검증기 J2 — EV 구성요소(총차입금·현금성자산·비지배지분)와 EV 공란 판정을 EDINET 원본으로 따로 정한다(docs/verify-jp-design.md §4 J2).
 * 앱 jp-ev.ts 와 다른 방법(코드 공유 없음 — 앱 코드를 읽지 않는다):
 *  - 차입금 줄 = 재무상태표 **계산 구조**에서 부채 아래 개념 중 **요소 이름**이 차입금 꼴(Borrowing·BorrowedMoney(은행 借用金)·LoansPayable·Bond·Debt·CommercialPaper·CallMoney·
 *    LeaseLiabilit·LeaseObligation·InterestBearingLiabilit·FinancingLiabilit)인 것의 최상위. 예금(Deposit)·충당금·미지급이자 등은 차입금이 아니다
 *  - 현금성자산 = 현금흐름표 「現金及び現金同等物 期末残高」(오너 Q3 재결정 2026-10-14 — 01-metric-dictionary P9·J8: 定期預金·短期投資·有価証券 제외,
 *    현지 株探 「現金等残高」·みんかぶ 「現金期末残高」와 같은 정의 08). 그 서류 연결 현금흐름표 역할에서 기말(periodEnd) 이름표로 실린 CashAndCashEquivalents… 개념의
 *    결산일 D 시점 값 — IFRS 는 재무상태표와 다르면 …IfDifferentFromBSBalance(本田 2026-03 BS 5,066,828 vs CF 5,118,477 — 売却目的保有 현금 포함).
 *    옛 판정(재무상태표 유동자산의 현금·예금·단기투자·유가증권 꼴 합)은 쓰지 않는다
 *  - 본표에 리스 개념이 없는 IFRS 회사의 리스부채 = IAS 7 재무활동 부채 변동표(주석)의 기말 잔액으로 **산술 판정**: 차입금 꼴 행(리스 제외) 기말 합이
 *    본표 차입금 줄 합과 맞고 리스 행을 더하면 안 맞으면 "별도"(리스 행 기말을 더한다), 리스 행까지 더해야 맞으면 "포함". 둘 다 아니면 판정 불가
 *
 * 금융업·금융사업 연결 EV(오너 결정 2026-10-11 — 「금융업·금융 자회사 EV = 전 시장 미국 규칙」, docs/verify-common/01-metric-dictionary.md P8·P24 원칙 10):
 *  - 은행형(연결 부채에 은행업 예금 — 요소 이름 …BankingBusiness·…ForBanking…·…DepositsFor(Banking|Financial)Business…): **EV 채움**. 총차입금 = 이자부 차입금만
 *    (예금은 차입금 꼴 요소가 아니라 자동 제외 — Deposit 은 NOT_DEBT_ID). 원자료 확인(2026-10-31, reports/.edinet-cache):
 *      9984 S100YGH5 2026-03-31 InterestBearingLiabilities CL 7,251,630 + NCL 17,433,486 + LeaseLiabilities CL 184,666 + NCL 793,784(백만엔), 
 *        ext:DepositsForBankingBusinessCLIFRS 2,550,998 = PayPay銀行 예금(차입금 아님)
 *      9434 S100YE76 2026-03-31 InterestBearingLiabilities CL 1,956,418 + NCL 4,528,164, ext:DepositsForBankingBusinessCLIFRS 2,556,010(제외)
 *      3382 S100VT7P 2025-02-28 ext:DepositsReceivedInBankingBusiness 813,388(セブン銀行 銀行業における預金 — 제외), jppfs_cor:CallMoneyLiabilitiesBNK 100,000
 *        (コールマネー = 은행 간 단기 이자부 차입 — 차입금 꼴로 넣는다), S100Y4VB 2026-02-28 은 セブン銀行 연결 제외로 예금·コールマネー 값 없음
 *      9432 ext:ShortTermDepositsForBankingCLIFRS·9433 ext:ShortTermDepositsForFinancialBusinessCLIFRS 도 예금 — 같은 처리
 *  - 금융 자회사 보유(자산 요소 이름에 FinancialServices — 7203 ext:ReceivablesRelatedToFinancialServices(N)CAIFRS 金融事業に係る債権, 6758 옛 연도
 *    ext:InvestmentsAndAdvancesInTheFinancialServicesSegment(N)CAIFRS 金融分野における投資及び貸付, 7267 ext:ReceivablesFromFinancialServices(N)CAIFRS
 *    金融サービスに係る債権): **제조 부문 차입금으로 EV**(미국 CAT 방식 — EV = 시가총액 + 제조 부문 차입금 + 비지배지분 − 연결 현금, 하이라이트 총차입금 행 =
 *    제조 부문 차입금). 제조 부문 차입금 = 有報(·半期) 본문의 금융 부문 구분 재무상태표(백만엔 표)의 비금융 부문 차입금 줄 합. 표의 열은 그 표 (연결) 자산·
 *    부채 합계가 이 열 원자료(XBRL)와 정확히 같은 열만 쓴다(표·열 판독 확인). 원자료 확인:
 *      7203 有報 S100Y8NY 経営者による分析 「自動車等セグメントと金融セグメントを区分した連結財政状態計算書」 (自動車等) 有利子負債 流動 976,235 + 非流動 1,823,843
 *        = 2,800,078(2026-03-31), 2025-03-31 1,188,430 + 1,547,461 = 2,735,891; (連結)負債合計 64,502,263·56,722,437 = XBRL LiabilitiesIFRS. 2021~2025 有報는 같은 표가
 *        セグメント情報 주석(NotesSegmentInformation…TextBlock)에 있다. 半期報告書에는 이 표가 없다(S100WYZE·S100UP32) → 그 열은 공란 + 사유
 *      6758 有報 S100W19Q 「金融分野を除くソニー連結の要約財政状態計算書」 短期借入金 258,918 + 長期借入債務 1,376,593(2024年度末 = 2025-03-31) — 같은 표 ソニー連結 열
 *        短期借入金 2,131,404 + 長期借入債務 2,066,842 = 4,198,246 = XBRL 차입금 줄 합(리스 포함 판정 그대로)이라 줄 범위 확인. 2026-03 은 금융 분리(스핀오프) 뒤라 금융 자회사 아님
 *      7267 有報 S100YDD9: 금융 부문을 가른 재무상태표 표가 없다. 本文 「生産販売事業の資金調達に伴う…債務残高は1兆2,388億円」(억엔 단위 서술)뿐 — 백만엔 원자료가 아니라
 *        정확 판정 근거가 없어 **EV 공란 + 사유**(그때 총차입금 행 기대값 = 연결 차입금)
 *  - 금융사(손익 본표 BNK·INS·SEC 서식 — 8306·8411·6178·옛 8766, 또는 EDINET 提出者業種 保険業·銀行業·証券業 — 8766 IFRS): 오너 결정 2026-10-31 「가」로
 *    EV 를 미국 규칙으로 채운다 — 총차입금(이자부 차입금만)은 대조, 현금(미국 정의: 현금 + 단기투자 + 채권형 투자증권)은 有価証券 한 줄에 채권·주식이 섞여
 *    원자료로 가를 수 없어 현금·EV 판정 불가(아래 evComponents 주석)
 *  - 차입금 개념이 기타 금융부채를 합친 한 줄(…AndOtherFinancialLiabilities — 오너 결정 D4) · 리스부채 판정 불가 → EV 공란·검증불가(종전과 같음).
 */
import { plainValue } from "./xbrl.mjs";

const local = (k) => k.slice(k.indexOf(":") + 1);
const DEBT_ID = /(Borrowing|BorrowedMoney|LoansPayable|Bond|Debt|CommercialPaper|CallMoney|LeaseLiabilit|LeaseObligation|InterestBearingLiabilit|FinancingLiabilit)/;
const NOT_DEBT_ID = /(Receivable|Asset|InterestPayable|InterestExpense|Derivative|Deposit|Provision|Accrued|Allowance|Abstract|Repurchase|Securities|Tax|Heading|Table|LineItems)/;
const LEASE_ID = /(LeaseLiabilit|LeaseObligation)/;

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
    // IAS 7 재무활동 부채 변동표 — 「財務活動」 제목이 다른 주석에 있고 표는 有利子負債 주석에 있는 회사(トヨタ NotesInterestBearingLiabilities — 「有利子負債合計」 행)도
    if (!(/財務活動/.test(t) || /有利子負債合計/.test(t)) || !/リース負債|リース債務/.test(t)) continue;
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

// ── 금융 부문 구분 재무상태표(백만엔 표) 판독 — 제조 부문 차입금 ──
const SEG_NUM = /^(△?-?[\d,]+|-|―|—)$/;
const segNum = (x) => (/^[-―—]$/.test(x) ? 0 : (x.startsWith("△") ? -1 : 1) * Number(x.replace(/[△,]/g, "")));
/** 표 평문 → 행 [{ label(공백 뺀 이름), nums }] — 이름 토큰 뒤 숫자 토큰 n 개(정확히 n 개인 것만) */
function segRows(text, n) {
  const toks = text.replace(/\*\d/g, " ").split(" ").filter(Boolean);
  const out = [];
  let lab = [];
  for (let i = 0; i < toks.length; ) {
    if (!SEG_NUM.test(toks[i])) { lab.push(toks[i++]); continue; }
    const nums = [];
    while (i < toks.length && SEG_NUM.test(toks[i])) nums.push(toks[i++]);
    if (nums.length === n) out.push({ label: lab.join(""), nums: nums.map(segNum) });
    lab = [];
  }
  return out;
}
const SEG_DEBT_ROW = /借入|社債|有利子負債|リース負債|コマーシャル|資金調達に係る債務/;
/**
 * 서류 d 의 금융 부문 구분 재무상태표에서 결산일 D 의 제조(비금융) 부문 차입금. 열은 표의 (연결) 자산 합계·부채 합계가 원자료 assets·liab(백만엔)와 정확히 같은 열.
 * consDebt = 검증기가 XBRL 로 정한 연결 차입금(백만엔) — 연결 열이 있는 표(ソニー형)는 같은 줄 범위의 연결 합이 이것과 같아야 한다.
 * → { v(엔), how } | { why } | null(표 없음)
 */
function segMfgDebt(d, assets, liab, consDebt) {
  let why = null;
  for (const { t } of d.segTbs ?? []) {
    if (!/\(単位:百万円\)/.test(t)) continue;
    // 형식 T(トヨタ) — 「…区分した連結財政状態計算書 (単位:百万円) 前… (날짜) 当… (날짜) 資産 (自動車等) … (金融) … (消去) … (連結) 資産合計 … 負債 (自動車等) … (金融) … (連結)負債合計 …」
    const iT = t.search(/区分した(要約)?(中間)?連結財政状態計算書/);
    if (iT >= 0 && /\(金融\)/.test(t.slice(iT))) {
      const body = t.slice(iT, iT + 6000);
      const iL = body.search(/負債 ?\((?!金融|消去|連結)[^)]+\)/);
      if (iL < 0) { why = `${d.row.docID} 구분 재무상태표에 비금융 부문 부채 구역 없음`; continue; }
      const hdr = body.slice(body.lastIndexOf("(単位:百万円)", iL), iL);
      const n = [...hdr.matchAll(/(\d{4})年(\d{1,2})月(\d{1,2})日/g)].length;
      if (!n) { why = `${d.row.docID} 구분 재무상태표 열 머리 날짜 없음`; continue; }
      const seg = (/負債 ?\(([^)]+)\)/.exec(body.slice(iL)) ?? [])[1];
      const assetPart = segRows(body.slice(0, iL), n), liabPart = segRows(body.slice(iL), n);
      const consA = assetPart.find((r) => /^\(連結\)資産合計$/.test(r.label)), consL = liabPart.find((r) => /^\(連結\)負債合計$/.test(r.label));
      if (!consA || !consL) { why = `${d.row.docID} 구분 재무상태표에 (連結) 자산·부채 합계 행 없음`; continue; }
      const j = consA.nums.findIndex((v, k) => v === assets && consL.nums[k] === liab);
      if (j < 0) { why = `${d.row.docID} 구분 재무상태표 (連結) 합계가 이 열 원자료(자산 ${assets}·부채 ${liab})와 같은 열 없음`; continue; }
      // 비금융 부문 구역 = 부채 구역 처음 ~ (金融) 앞
      const finAt = liabPart.findIndex((r) => /^\(金融\)/.test(r.label));
      const blk = liabPart.slice(0, finAt < 0 ? liabPart.length : finAt);
      const debt = blk.filter((r) => SEG_DEBT_ROW.test(r.label.replace(/^\([^)]+\)/, "")) && !/合計|消去/.test(r.label));
      const tot = blk.find((r) => /^負債合計$/.test(r.label)), cur = blk.find((r) => /流動負債合計$/.test(r.label) && !/非流動/.test(r.label)), ncur = blk.find((r) => /非流動負債合計$/.test(r.label));
      if (!debt.length) { why = `${d.row.docID} (${seg}) 차입금 줄 없음`; continue; }
      // 구역 구조 확인(유동·비유동 부채 합계·부채합계 행이 그 구역에 있다). 회사 표 자체가 반올림이라 유동 + 비유동 = 합계가 1 어긋나는 해가 있다
      // (S100VWVY (自動車等) 2025-03 12,062,240 + 4,991,070 = 17,053,310 vs 負債合計 17,053,309) — 산술 대조는 하지 않고 열은 (連結) 합계 = XBRL 로만 정한다
      if (!tot || !cur || !ncur) { why = `${d.row.docID} (${seg}) 부채 구역에 유동·비유동 부채 합계·부채합계 행 없음 — 표 판독 확인 실패`; continue; }
      const v = debt.reduce((a, r) => a + r.nums[j], 0);
      return { v: v * 1e6, how: `${d.row.docID} 구분 재무상태표 (${seg}) ${debt.map((r) => `${r.label} ${r.nums[j]}`).join(" + ")} = ${v}(백만엔, (連結) 자산·부채 합계 = XBRL 열 확인)` };
    }
    // 형식 S(ソニー) — 「要約財政状態計算書 (単位:百万円) 科 目 金融分野 金融分野を除くX連結 X連結 <열 이름 k 개 × 3> 資 産 の 部 …」
    const iS = t.search(/要約(中間)?財政状態計算書 \(単位:百万円\) 科 ?目 /);
    if (iS >= 0) {
      const head = /科 ?目 (金融\S*) (\S*除く\S*) (\S+)/.exec(t.slice(iS, iS + 300));
      if (!head) { why = `${d.row.docID} 요약 재무상태표 머리(금융·금융 제외·연결) 형식 다름`; continue; }
      const body = t.slice(iS, iS + 8000).replace(/\*\d+/g, " ").replace(/ +/g, " ");
      const iA = body.search(/資 ?産 ?の ?部/);
      const iL = body.search(/負 ?債 ?及 ?び ?資 ?本 ?の ?部/);
      if (iA < 0 || iL < 0) { why = `${d.row.docID} 요약 재무상태표 자산·부채 구역 없음`; continue; }
      // 열 수: 자산 구역 첫 숫자 행의 숫자 개수 ÷ 3
      const firstNums = (body.slice(iA).match(/(?:(?:△?-?[\d,]+|-) ){3,}/) ?? [""])[0].trim().split(" ").length;
      const k = firstNums / 3;
      if (!Number.isInteger(k) || k < 1) { why = `${d.row.docID} 요약 재무상태표 열 수 판정 불가`; continue; }
      const aRows = segRows(body.slice(iA, iL), 3 * k), lRows = segRows(body.slice(iL), 3 * k);
      const aTot = aRows.find((r) => /^合計$/.test(r.label)), lTot = lRows.find((r) => /^負債合計$/.test(r.label));
      if (!aTot || !lTot) { why = `${d.row.docID} 요약 재무상태표 합계 행 없음`; continue; }
      const j = [...Array(k).keys()].find((x) => aTot.nums[2 * k + x] === assets && lTot.nums[2 * k + x] === liab);
      if (j == null) { why = `${d.row.docID} 요약 재무상태표 연결 열 합계가 이 열 원자료(자산 ${assets}·부채 ${liab})와 같은 열 없음`; continue; }
      const debt = lRows.slice(0, lRows.indexOf(lTot)).filter((r) => SEG_DEBT_ROW.test(r.label) && !/合計/.test(r.label));
      if (!debt.length) { why = `${d.row.docID} 요약 재무상태표 차입금 줄 없음`; continue; }
      const cons = debt.reduce((a, r) => a + r.nums[2 * k + j], 0);
      if (consDebt == null || cons !== consDebt) { why = `${d.row.docID} 요약 재무상태표 연결 차입금 ${debt.map((r) => r.label).join("+")} ${cons} ≠ 검증기 연결 차입금 ${consDebt} — 줄 범위 다름`; continue; }
      const v = debt.reduce((a, r) => a + r.nums[k + j], 0);
      return { v: v * 1e6, how: `${d.row.docID} 요약 재무상태표 「${head[2]}」 ${debt.map((r) => `${r.label} ${r.nums[k + j]}`).join(" + ")} = ${v}(백만엔, 같은 줄 연결 합 ${cons} = XBRL 차입금 · 연결 자산·부채 합계 = XBRL 열 확인)` };
    }
  }
  return why ? { why } : null;
}

/**
 * 결산일 D 의 EV 구성요소 기대값. which = D 가 그 서류의 당기말("cur")인지 전기말("prior")인지.
 * 반환 { debt: { v | blank | why, how }, cash, nci, evBlank: 사유|null, evWhy: 판정 불가 사유|null }
 */
export function evComponents(d, D, which, { segDocs = [], industry = null } = {}) {
  const { par, concepts } = bsParents(d);
  const val = (k) => plainValue(d, k, { instant: D });
  const isLiab = (k) => ancestors(par, k).some((a) => /^(Total)?(Current|NonCurrent|Noncurrent)?L[a-z]*bilit/.test(local(a)) && !/AndEquity|AndNetAssets/.test(local(a)));
  // 금융업 서식 = 손익계산서 본표에 은행·보험·증권 요소(…BNK·INS·SEC) — 주석 사실(JR東海)·재무상태표 한 줄(セブン&アイ コールマネー)로 판정하지 않는다
  const financial = [...d.roles.values()].filter((r) => r.kind === "is" && r.cons === d.consUsed).some((r) => [...r.concepts].some((k) => /(BNK|INS|SEC)$/.test(k)));
  const debtKs = [...concepts].filter((k) => DEBT_ID.test(local(k)) && !NOT_DEBT_ID.test(local(k)) && isLiab(k));
  const top = debtKs.filter((k) => !ancestors(par, k).some((a) => debtKs.includes(a)));
  const parts = top.map((k) => ({ k, f: val(k) })).filter((x) => x.f && !x.f.conflict && x.f.v != null);
  const debtBs = parts.reduce((a, x) => a + x.f.v, 0);
  // 현금 = 현금흐름표 기말 잔액(Q3 재결정 2026-10-14)
  const cfEnd = new Map();
  for (const ro of d.roles.values()) {
    if (ro.kind !== "cf" || ro.cons !== d.consUsed) continue;
    for (const [k, pl] of ro.pls ?? []) if (pl.includes("e") && /^CashAndCashEquivalents/.test(local(k))) { const f = val(k); if (f && !f.conflict && f.v != null) cfEnd.set(k, f.v); }
  }
  const cashVals = new Set(cfEnd.values());
  const nciK = ["jpigp_cor:NonControllingInterestsIFRS", "jppfs_cor:NonControllingInterests"].find((k) => concepts.has(k));
  const nciF = nciK ? val(nciK) : undefined;
  const ifrs = d.dei.AccountingStandardsDEI === "IFRS";
  const r = {
    debt: { v: debtBs, how: parts.map((x) => `${local(x.k)} ${x.f.v / 1e6}`).join(" + ") || "차입금 꼴 요소 없음(0)" },
    cash: cashVals.size === 1 ? { v: [...cashVals][0], how: `현금흐름표 기말 잔액 ${[...cfEnd.keys()].map(local).join("·")}` } : cashVals.size ? { why: `현금흐름표 기말 잔액 개념 값이 여럿(${[...cfEnd].map(([k, v]) => `${local(k)} ${v / 1e6}`).join(" · ")})` } : { why: "현금흐름표 기말 잔액(CashAndCashEquivalents… 기말 이름표) 없음" },
    // 비지배지분 줄이 본표에 없으면 — 자본총계 줄이 있으면 0(자본총계 = 지배주주 자본), 자본총계 줄도 없으면 빈칸
    nci: nciK ? { v: nciF?.v ?? 0, how: local(nciK) } : ["jpigp_cor:EquityIFRS", "jppfs_cor:NetAssets"].some((k) => concepts.has(k) && val(k)?.v != null) ? { v: 0, how: "비지배지분 줄 없음 · 자본총계 있음(0)" } : { blank: "본표에 비지배지분·자본총계 줄 없음" },
    evBlank: null,
    evWhy: null,
  };
  // 금융사(은행·보험·증권 — BNK·INS·SEC 서식, 또는 EDINET 업종 保険業·銀行業·証券業 — 8766 IFRS 처럼 서식 요소가 없는 회사): 오너 결정 2026-10-31 「가」 —
  // EV 를 미국 규칙으로 채운다. 총차입금 = 이자부 차입금만(DEBT_ID — 借用金·社債·短期社債·CP·コールマネー·리스. 預金·譲渡性預金·保険契約負債·売現先(Repurchase)·
  // 債券貸借取引受入担保金·特定取引負債는 차입금 꼴 요소가 아니라 빠진다). 현금 = 미국 정의(현금 + 단기투자 + 채권형 투자증권, 장기투자자산은 빼지 않음)인데
  // 일본 금융사 본표의 有価証券(SecuritiesAssetsBNK·SecuritiesAssetsINS·IFRS InvestmentSecurities) 한 줄에 채권과 주식이 섞여 있고, 주석 표도 「その他の証券」(외국 채권·
  // 외국 주식 합계 — 8306 S100YJQO 経営者による分析 有価証券 표)처럼 채권형만 원자료 숫자로 가를 수 없다 → 현금·EV 는 판정 불가(검증불가 + 사유), 총차입금만 대조
  const finIndustry = /保険業|銀行業|証券、商品先物取引業|証券業/.test(industry ?? "");
  if (financial || finIndustry) {
    r.kind = { fin: `금융사(${financial ? "BNK·INS·SEC 서식" : `EDINET 업종 ${industry}`}) — 미국 규칙 EV(오너 결정 2026-10-31)` };
    r.cash = { why: "금융사 — 미국 현금 정의의 채권형 투자증권을 원자료 줄로 가를 근거 없음(有価証券 한 줄에 채권·주식 혼재)" };
    r.evWhy = `${r.kind.fin} — 현금 판정 불가(${r.cash.why})`;
    return r;
  }
  // 금융 자회사 보유 = 금융서비스 자산(…FinancialServices…) 요소에 값. 은행업 예금(…BankingBusiness·…ForBanking·…ForFinancialBusiness 부채)만 있는 회사는 은행형 — EV 채움
  const captive = [...concepts].find((k) => /FinancialServices/.test(local(k)) && /(CA|NCA)IFRS$|Assets?$/.test(local(k)) && val(k)?.v != null);
  const bankDep = [...concepts].find((k) => /Deposit/.test(local(k)) && /BankingBusiness|ForBanking|ForFinancialBusiness/.test(local(k)) && isLiab(k) && val(k)?.v != null);
  if (bankDep) r.kind = { bank: `은행형 — ${local(bankDep)} ${val(bankDep).v / 1e6}(예금 — 차입금 아님, EV 채움)` };
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
      // 리스 행이 유동·비유동 두 줄(トヨタ 1年以内返済予定長期リース負債·長期リース負債)일 수 있다 — 리스 행 전부의 합
      const leaseKs = [...at.m.keys()].filter((k) => /リース負債|リース債務/.test(k));
      const non = [...at.m].filter(([k]) => !leaseKs.includes(k)).reduce((a, [, v]) => a + v, 0);
      const bsM = debtBs / 1e6;
      const tol = at.m.size;
      if (!leaseKs.length) r.lease = { why: "변동표에 リース負債 행 없음" };
      else {
        const L = leaseKs.reduce((a, k) => a + at.m.get(k), 0);
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
  if (captive && !r.evBlank && r.debt.v == null) r.kind = { captive: `금융 자회사 보유(${local(captive)}) — 연결 차입금 판정 불가라 제조 부문 대조 안 함` };
  else if (captive && !r.evBlank) {
    // 금융 자회사 보유 — 제조 부문 차입금(미국 CAT 방식). 표는 이 서류 → 같은 기준 다른 서류 순(그 결산일 열을 실은 것)
    const assetsK = ["jpigp_cor:AssetsIFRS", "jppfs_cor:Assets"].find((k) => concepts.has(k));
    const liabK = ["jpigp_cor:LiabilitiesIFRS", "jppfs_cor:Liabilities"].find((k) => concepts.has(k));
    const A = assetsK ? val(assetsK)?.v : null, L = liabK ? val(liabK)?.v : null;
    const consM = r.debt.v != null ? r.debt.v / 1e6 : null;
    let got = null;
    const whys = [];
    if (A == null || L == null) whys.push("이 열 원자료 자산·부채 합계 없음");
    else for (const x of [d, ...segDocs.filter((o) => o !== d)]) {
      const m = segMfgDebt(x, A / 1e6, L / 1e6, consM);
      if (m?.v != null) { got = m; break; }
      if (m?.why) whys.push(m.why);
    }
    r.kind = { captive: `금융 자회사 보유(${local(captive)})` };
    if (got) {
      if (r.lease?.sep) {
        // 리스부채가 본표 밖(주석)인데 구분표 차입금 줄에 리스가 들었는지 원자료로 알 수 없다
        r.evBlank = `금융 자회사 보유(${local(captive)}) — 리스부채가 본표 밖이라 제조 부문 리스 분리 불가`;
      } else {
        r.consDebt = r.debt;
        r.debt = { v: got.v, how: `제조 부문 차입금 — ${got.how}` };
        r.mfg = got;
      }
    } else r.evBlank = `금융 자회사 보유(${local(captive)}) — 제조 부문 차입금 원자료 없음(${whys.length ? whys.slice(0, 3).join(" · ") : "금융 부문 구분 재무상태표 없음"})`;
  }
  return r;
}
