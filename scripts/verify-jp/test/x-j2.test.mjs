// 일본 X층(외부 대조)·J2(금융업 EV) 시험 — 외부 요청 없음. 실행: node --test scripts/verify-jp/test/*.test.mjs
// J2 시험은 2호기 검증기 EDINET 캐시(reports/.edinet-cache)의 실제 서류를 읽는다 — 캐시에 서류가 없으면 실패(조용히 건너뛰지 않는다).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyOne, judgeCell, parseKabutan, parseMinkabu, parseYahooJp } from "../ext.mjs";
import { configureEdinet, docFiles } from "../edinet.mjs";
import { parseDoc } from "../xbrl.mjs";
import { evComponents } from "../j2.mjs";

const ST = { PASS: "pass", FAIL: "fail", NA: "unverifiable", COMMON: "common" };
const amt = (m) => ({ v: m * 1e6, unit: 1e6, dec: 0 });
const ps = (v, dec) => ({ v, unit: 1, dec });

test("classifyOne: 정확 일치·1 차이 불일치·반올림/버림으로만 같음 = 정밀도 부족(허용 오차 없음)", () => {
  assert.equal(classifyOne(50684952e6, amt(50684952)).cls, "일치");
  assert.equal(classifyOne(50684952e6 + 1, amt(50684952)).cls, "정밀도", "앱이 1엔 다르면 백만엔 표기로는 반올림으로만 같다");
  assert.equal(classifyOne(50684953e6, amt(50684952)).cls, "불일치", "백만엔 단위 1 차이는 불일치");
  assert.equal(classifyOne(295.25, ps(295.25, 2)).cls, "일치");
  assert.equal(classifyOne(295.25, ps(295.3, 1)).cls, "정밀도", "株探 소수 1자리 — 반올림으로만 같음");
  assert.equal(classifyOne(295.24, ps(295.2, 1)).cls, "정밀도", "버림으로만 같음도 정밀도 부족");
  assert.equal(classifyOne(296.25, ps(295.3, 1)).cls, "불일치");
  assert.equal(classifyOne(null, amt(1)).cls, "불일치", "앱 빈칸·외부 값 있음");
  assert.equal(classifyOne(5, undefined).cls, "없음");
  assert.equal(classifyOne(5, null).cls, "없음", "외부 「－」");
});

const srcs = (k, m, y) => ({
  kabutan: { parsed: { "2026-03": k } },
  minkabu: { parsed: { "2026-03": m } },
  yahoojp: { parsed: { "2026-03": y } },
});
const cell = (app, s, extra = {}) => judgeCell({ name: "매출", label: "2026-03", ym: "2026-03", app, fields: { kabutan: "revenue", minkabu: "revenue", yahoojp: "revenue" }, srcs: s, ...ST, ...extra });

test("judgeCell: 심은 오류 — 앱 값 하나를 1(백만엔) 바꾸면 세 소스 모두 원인 미확인 불일치 → 실패", () => {
  const s = srcs({ revenue: amt(100) }, { revenue: amt(100) }, { revenue: amt(100) });
  assert.equal(cell(100e6, s).check.status, ST.PASS);
  const r = cell(101e6, s);
  assert.equal(r.check.status, ST.FAIL);
  assert.deepEqual(Object.values(r.review.jpClass), ["불일치", "불일치", "불일치"]);
  assert.match(r.review.verdict, /불일치/);
});

test("judgeCell: 심은 오류 — 외부 값을 반올림 단위로만 같게 바꾸면 정밀도 부족(검증불가) — 일치로 세지 않는다", () => {
  const s = srcs({ revenue: amt(100) }, { revenue: amt(100) }, { revenue: amt(100) });
  const r = cell(100e6 + 400_000, s); // 앱 100.4 백만엔 → 외부 100 은 반올림으로만 같다
  assert.equal(r.check.status, ST.NA);
  assert.match(r.check.note, /검증불가\(외부 정밀도 부족\)/);
  assert.equal(r.review.matched, null, "외부 전부일치로 세지 않는다");
  assert.ok(r.review.precisionNa);
});

test("judgeCell: 한 곳 일치(D2 일본 1곳) → 통과, 어긋난 다른 소스는 외부 단독 이탈 · 「불일치」 문구로 전부일치에서 빠진다", () => {
  const s = srcs({ revenue: amt(100) }, { revenue: amt(100) }, { revenue: amt(99) });
  const r = cell(100e6, s);
  assert.equal(r.check.status, ST.PASS);
  assert.equal(r.review.jpClass["Yahoo!ファイナンス"], "외부단독이탈");
  assert.match(r.review.verdict, /2\/3곳 일치 — 불일치/);
});

test("judgeCell: 식으로 원인 확인 — 원인 식이 정확히 성립하면 검증불가(독립 일치 아님), 앱 결정 정의 위반 식은 실패", () => {
  const s = srcs({ revenue: amt(90) }, { revenue: undefined }, { revenue: undefined });
  const ok = cell(100e6, s, { causes: [{ test: (x) => (x === 90e6 ? "외부 = 원자료 기본 값" : null) }] });
  assert.equal(ok.check.status, ST.NA);
  assert.match(ok.check.note, /식으로 원인 확인/);
  const bad = cell(100e6, s, { causes: [{ appWrong: true, test: (x) => (x === 90e6 ? "외부 = 결정 정의 원자료 — 앱 다름" : null) }] });
  assert.equal(bad.check.status, ST.FAIL);
});

test("judgeCell: 소스 조회 실패만 있으면 외부 값 없음(검증불가) — 통과로 세지 않는다", () => {
  const r = cell(100e6, { kabutan: { error: "株探 조회 실패(HTTP 503)" }, minkabu: { error: "x" }, yahoojp: { error: "y" } });
  assert.equal(r.check.status, ST.NA);
  assert.match(r.check.note, /외부 값 없음/);
});

// 판독 — 실제 화면 구조를 줄인 조각(2026-10-14 08 실측 원문에서 옮김)
const KABU = `<table><tr><th>決算期</th><th>売上高</th><th>営業益</th><th>経常益</th><th>最終益</th><th>修正<br>1株益</th><th>修正<br>1株配</th><th>発表日</th></tr>
<tr><td>I</td><td>2025.03</td><td>48,036,704</td><td>4,795,586</td><td>6,414,590</td><td>4,765,086</td><td>359.6</td><td>90</td><td>25/05/08</td></tr>
<tr><td>I 予</td><td>2027.03</td><td>54,000,000</td><td>3,400,000</td><td>4,570,000</td><td>3,250,000</td><td>275.9</td><td>100</td><td>26/08/04</td></tr>
<tr><td>前期比</td></tr></table>
<h2>キャッシュフロー(CF＝現金収支)推移</h2><table><tr><th>決算期</th><th>営業益</th><th>フリーCF</th><th>営業CF</th><th>投資CF</th><th>財務CF</th><th>現金等<br>残高</th><th>現金<br>比率</th></tr>
<tr><td>2025.03</td><td>549,775</td><td>128,910</td><td>409,522</td><td>-280,612</td><td>-83,430</td><td>451,715</td><td>13.73</td></tr></table>
<h3>財務 【実績】</h3><table><tr><th>決算期</th><th>１株<br>純資産</th><th>自己資本<br>比率</th><th>総資産</th><th>自己資本</th><th>剰余金</th><th>有利子<br>負債倍率</th><th>発表日</th></tr>
<tr><td>2025.03</td><td>2,753.09</td><td>38.4</td><td>93,601,350</td><td>35,924,826</td><td>35,841,218</td><td>1.08</td><td>25/05/08</td></tr></table>※単位について`;

test("판독: 株探 업績(예상 행 제외)·CF(칸 순서 営業益|フリーCF|営業CF|投資CF|財務CF|現金等残高)·財務", () => {
  const k = parseKabutan(KABU);
  assert.deepEqual(Object.keys(k).sort(), ["2025-03"], "「予」 행은 읽지 않는다");
  const r = k["2025-03"];
  assert.equal(r.revenue.v, 48036704e6);
  assert.equal(r.eps.v, 359.6);
  assert.equal(r.eps.dec, 1);
  assert.equal(r.dps.v, 90);
  assert.equal(r.ocf.v, 409522e6, "営業CF 는 셋째 칸(営業益·フリーCF 다음)");
  assert.equal(r.fin.v, -83430e6);
  assert.equal(r.cashEnd.v, 451715e6);
  assert.equal(r.assets.v, 93601350e6);
  assert.equal(r.equity.v, 35924826e6);
});

const MINKA = `<h2>決算情報</h2><table><tr><th>決算期</th><th>(決算発表日)</th><th>売上高</th><th>営業利益</th><th>経常利益</th><th>純利益</th><th>1株益</th></tr>
<tr><td>2026年</td><td>3月期</td><td>(2026/05/08)</td><td>50,684,952</td><td>3,766,216</td><td>5,152,996</td><td>3,848,098</td><td>295.25</td></tr></table><p>単位：百万円</p>
<h2>財務情報</h2><table><tr><th>決算期</th><th>1株純資産</th><th>総資産</th><th>純資産</th><th>自己資本率</th></tr><tr><td>2026年</td><td>3月期</td><td>2,735.10</td><td>105,522,331</td><td>41,020,068</td><td>37.80</td></tr></table><p>単位：百万円</p>
<h2>キャッシュフロー(CF)</h2><table><tr><th>決算期</th><th>営業CF</th><th>投資CF</th><th>財務CF</th><th>現金期末残高</th><th>フリーCF</th></tr><tr><td>2026年</td><td>3月期</td><td>5,472,920</td><td>-1,520,307</td><td>-536,659</td><td>12,659,622</td><td>3,952,613</td></tr></table><p>単位：百万円</p>`;

test("판독: みんかぶ 決算情報·財務情報·CF", () => {
  const m = parseMinkabu(MINKA)["2026-03"];
  assert.equal(m.revenue.v, 50684952e6);
  assert.equal(m.eps.v, 295.25);
  assert.equal(m.netAssets.v, 41020068e6);
  assert.equal(m.cashEnd.v, 12659622e6);
  assert.equal(m.fin.v, -536659e6);
});

test("판독: Yahoo!ファイナンス RSC 연간(Q4)만", () => {
  const html = String.raw`self.__next_f.push([1,"{\"fiscalYear\":\"2025\",\"fiscalQuarter\":\"Q4\",\"endDate\":\"2026-03-31\",\"netSales\":50684952000000,\"operatingIncome\":3766216000000,\"epsActual\":295.25,\"equity\":39918854000000,\"operatingCashFlow\":5472920000000}{\"fiscalYear\":\"2025\",\"fiscalQuarter\":\"Q2\",\"endDate\":\"2025-09-30\",\"netSales\":1}"])`;
  const y = parseYahooJp(html);
  assert.deepEqual(Object.keys(y), ["2026-03"]);
  assert.equal(y["2026-03"].revenue.v, 50684952e6);
  assert.equal(y["2026-03"].eps.v, 295.25);
});

// ── J2(원자료 서류) ──
const CACHE = fileURLToPath(new URL("../../../reports/.edinet-cache", import.meta.url));
configureEdinet({ root: CACHE, key: null });
async function doc(id) {
  assert.ok(existsSync(`${CACHE}/doc/${id.slice(0, 4)}/${id}.zip`), `검증기 EDINET 캐시에 ${id} 없음 — 이 시험은 2호기 캐시가 있어야 한다`);
  const d = { row: { docID: id }, ...parseDoc(await docFiles(id)) };
  d.consUsed = [...d.roles.values()].some((x) => x.cons);
  return d;
}

test("J2 은행형 9984: 예금(DepositsForBankingBusiness)은 차입금 아님 — 이자부 차입금 + 리스만, EV 공란 아님", async () => {
  const d = await doc("S100YGH5");
  const e = evComponents(d, "2026-03-31", "cur", {});
  assert.equal(e.evBlank, null);
  assert.equal(e.debt.v, (7251630 + 17433486 + 184666 + 793784) * 1e6);
  assert.ok(e.kind?.bank);
});

test("J2 금융 자회사 7203: 제조 부문 차입금 = (自動車等) 有利子負債 976,235 + 1,823,843 — 연결 차입금 43,205,469 가 아니다", async () => {
  const d = await doc("S100Y8NY");
  const e = evComponents(d, "2026-03-31", "cur", { segDocs: [d] });
  assert.equal(e.evBlank, null);
  assert.equal(e.debt.v, 2800078e6);
  assert.equal(e.consDebt.v, 43205469e6);
  const p = evComponents(d, "2025-03-31", "prior", { segDocs: [d] });
  assert.equal(p.debt.v, (1188430 + 1547461) * 1e6, "전기말 열 — 같은 표 앞 열");
});

test("J2 금융 자회사 7267: 금융 부문 구분 재무상태표(백만엔) 없음 → EV 공란 + 사유", async () => {
  const d = await doc("S100YDD9");
  const e = evComponents(d, "2026-03-31", "cur", { segDocs: [d] });
  assert.match(e.evBlank ?? "", /제조 부문 차입금 원자료 없음/);
});

test("J2 금융사(오너 결정 2026-10-31 「가」): 8766 IFRS 보험·8306 BNK 서식 — EV 공란 기대 없음, 총차입금 = 이자부 차입금만(보험계약부채·예금·레포 제외), 현금 판정 불가", async () => {
  const d = await doc("S100YLS8");
  const e = evComponents(d, "2026-03-31", "cur", { industry: "保険業" });
  assert.equal(e.evBlank, null);
  assert.ok(e.kind?.fin);
  assert.equal(e.debt.v, (598007 + 128939) * 1e6, "BondsAndBorrowings + LeaseLiabilities — InsuranceContractLiabilities·RepurchaseAgreements 제외");
  assert.equal(e.cash.v, undefined);
  assert.match(e.evWhy, /현금 판정 불가/);
  const b = await doc("S100YJQO");
  const eb = evComponents(b, "2026-03-31", "cur", { industry: "銀行業" });
  assert.equal(eb.evBlank, null);
  // 借用金 9,359,997 + 信託勘定借 2,903,438 + 短期社債 1,217,464 + 社債 15,790,570 + CP 3,421,893 + コールマネー 5,307,704 (預金·譲渡性預金·売現先·債券貸借 제외)
  assert.equal(eb.debt.v, (9359997 + 2903438 + 1217464 + 15790570 + 3421893 + 5307704) * 1e6, eb.debt.how);
});

test("J2 현금 = 현금흐름표 기말 잔액(Q3): 7267 CF 5,118,477(재무상태표 5,066,828 아님)", async () => {
  const d = await doc("S100YDD9");
  assert.equal(evComponents(d, "2026-03-31", "cur", {}).cash.v, 5118477e6);
});
