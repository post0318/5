// 시험 T5(설계 10 §7-5) 심은 오류 — 판독기 부분(보관소 부분은 store.test.mjs·sources.test.mjs). 외부 요청 없음.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, crc32 } from "node:zlib";
import { openStore } from "../common/store.mjs";
import { mutable } from "../common/fetchstore.mjs";
import { makeRequester } from "../common/http.mjs";
import { makeSec } from "../us/sec.mjs";
import { makeDart } from "../kr/dart.mjs";
import { makeKrx } from "../kr/krx.mjs";
import { makeKrMarket } from "../kr/market.mjs";
import { chainItems } from "../kr/items.mjs";
import { fnlttFacts, markVintage } from "../kr/read.mjs";
import { interestItems, readFinanceCostTables, chooseInterest } from "../kr/interest.mjs";

const setup = () => { const root = mkdtempSync(join(tmpdir(), "t5-")); return { root, store: openStore({ root, actor: "verify" }), quotaRoot: join(root, "quota") }; };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
function zip(files) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text), comp = deflateRawSync(data), nb = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc32(data) >>> 0, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc32(data) >>> 0, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, comp); centrals.push(ch, nb); off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

test("DART 800(XBRL 점검) = source_maintenance, 30분 동안 XBRL 요청 안 함", async () => {
  const { store, quotaRoot } = setup();
  let n = 0;
  const f = async () => { n++; return new Response("<result><status>800</status><message>점검</message></result>"); };
  const dart = makeDart({ store, quotaRoot, key: "K", fetchImpl: f });
  await assert.rejects(dart.xbrl("20240312000736", "11011", "00126380"), (e) => e.code === "source_maintenance");
  await assert.rejects(dart.xbrl("20240312000737", "11011", "00126380"), (e) => e.code === "source_maintenance");
  assert.equal(n, 1, "두 번째는 요청 없이 실패");
});

test("SEC 429 연속 = 재시도 후 fetch_failed(옛 사본 없음)", async () => {
  const { store, quotaRoot } = setup();
  let n = 0;
  const f = async () => { n++; return new Response("", { status: 429 }); };
  const sec = makeSec({ store, quotaRoot, fetchImpl: f, env: { SEC_USER_AGENT: "t post0318@gmail.com" }, retry: (a, res) => (res?.status === 429 && a < 3 ? 1 : null) });
  await assert.rejects(sec.companyfacts("320193"), (e) => e.code === "fetch_failed");
  assert.equal(n, 4, "처음 + 재시도 3회");
});

test("KRX 거래일 빈 응답 = 재시도 후 fetch_failed, 휴장일 빈 응답 = holiday(저장)", async () => {
  const { store, quotaRoot } = setup();
  const f = async (url, init) => {
    const u = String(url);
    if (u.includes("GenerateOTP")) return new Response("abc123");
    if (u.includes("OPN99000001")) return json({ block1: [{ calnd_dd: "2025-10-06" }] });
    return json({ OutBlock_1: [] });
  };
  const krx = makeKrx({ store, quotaRoot, key: "K", fetchImpl: f, now: () => new Date("2026-10-15T03:00:00Z") });
  const mk = makeKrMarket(krx, { now: () => new Date("2026-10-15T03:00:00Z") });
  const t0 = Date.now();
  const r = await mk.day("20251007");
  assert.equal(r.status, "fetch_failed");
  assert.ok(Date.now() - t0 >= 12_000, "1·3·9초 재시도");
  assert.equal((await mk.day("20251006")).status, "holiday");
  assert.equal((await mk.day("20251011")).status, "holiday", "토요일");
});

test("같은 칸 후보 하나 추가(값이 다른 같은 표준 ID) = ambiguous", () => {
  const rows = [
    { sj_div: "IS", account_id: "ifrs-full_Revenue", account_nm: "매출액", thstrm_amount: "100", frmtrm_amount: "90", bfefrmtrm_amount: "80", ord: "1", currency: "KRW", rcept_no: "20240312000736" },
    { sj_div: "IS", account_id: "ifrs-full_Revenue", account_nm: "매출액(심은 행)", thstrm_amount: "101", frmtrm_amount: "90", bfefrmtrm_amount: "80", ord: "2", currency: "KRW", rcept_no: "20240312000736" },
  ];
  const facts = markVintage(fnlttFacts({ status: "000", list: rows }, { sym: "005930", corp: "00126380", year: 2023, code: "11011", fs: "CFS", rcept: "20240312000736" }));
  const its = chainItems(facts).filter((i) => i.key === "revenue");
  const cur = its.find((i) => i.period.end === "2023-12-31");
  assert.equal(cur.value, null);
  assert.equal(cur.blank_reason, "ambiguous");
  const prior = its.find((i) => i.period.end === "2022-12-31");
  assert.equal(prior.value, "90", "값이 같은 열은 그대로");
});

test("표 단위를 천원 → 원으로 바꾸면 XBRL 과 어긋남 표시(doc_xbrl_mismatch)", () => {
  const doc = (unit) => zip([["20240312000736.xml", `<DOCUMENT><DOCUMENT-NAME>사업보고서</DOCUMENT-NAME><TITLE>3. 연결재무제표 주석</TITLE><P>30. 금융비용</P><P>당기 및 전기 중 금융비용의 내역은 다음과 같습니다.</P><P>(단위 : ${unit})</P><TABLE><TR><TD>구분</TD><TD>당기</TD><TD>전기</TD></TR><TR><TD>이자비용</TD><TD>1,000</TD><TD>900</TD></TR></TABLE><TITLE>4. 재무제표</TITLE></DOCUMENT>`]]);
  const xbrl = zip([["entity00126380_2023-12-31.xbrl", `<xbrli:xbrl xmlns:xbrli="x" xmlns:dart="d"><xbrli:context id="CFY2023dFY"><xbrli:entity><xbrli:identifier scheme="s">00126380</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2023-01-01</xbrli:startDate><xbrli:endDate>2023-12-31</xbrli:endDate></xbrli:period></xbrli:context><xbrli:unit id="KRW"><xbrli:measure>iso4217:KRW</xbrli:measure></xbrli:unit><dart:InterestExpenseFinanceExpense contextRef="CFY2023dFY" unitRef="KRW" decimals="-3">1000000</dart:InterestExpenseFinanceExpense></xbrli:xbrl>`]]);
  const ok = interestItems({ rcept: "20240312000736", year: 2023, docBuf: doc("천원"), xbrlBuf: xbrl }).find((i) => i.period.end === "2023-12-31");
  assert.equal(ok.value, "1000000");
  assert.equal(ok.flags.doc_xbrl_mismatch, false);
  const bad = interestItems({ rcept: "20240312000736", year: 2023, docBuf: doc("원"), xbrlBuf: xbrl }).find((i) => i.period.end === "2023-12-31");
  assert.equal(bad.flags.doc_xbrl_mismatch, true, "단위 오판독을 잡아야 함");
  // 원문만 있는 해(FY2021·22)는 판독값 그대로 + 「금융비용 합계만」이면 interest_not_separated
  const onlyTotal = zip([["20220312000001.xml", `<DOCUMENT><DOCUMENT-NAME>사업보고서</DOCUMENT-NAME><TITLE>연결재무제표 주석</TITLE><P>25. 금융비용</P><P>금융비용의 내역</P><P>(단위 : 백만원)</P><TABLE><TR><TD>금융비용</TD><TD>5</TD><TD>4</TD></TR></TABLE></DOCUMENT>`]]);
  const r = interestItems({ rcept: "20220312000001", year: 2021, docBuf: onlyTotal });
  assert.ok(r.every((i) => i.value == null && ["confirmed_absent", "parse_failed"].includes(i.blank_reason)), JSON.stringify(r.map((i) => [i.blank_reason, i.blank_detail])));
});

test("앱·검증기가 다른 갱신형 판본을 쓰면 판본 id 가 다르다(차이를 판본 탓으로 가를 수 있음)", async () => {
  const { store, quotaRoot } = setup();
  let body = '{"cik":1,"facts":{"a":1}}';
  const req = makeRequester({ source: "sec", quotaRoot, tool: "verify", dailyCap: null, gapMs: 0, retry: () => null, fetchImpl: async () => new Response(body) });
  const base = { store, req, market: "us", source: "sec", key: "cf", ext: "json", url: "u", validate: () => ({ ok: true }), identity: () => ({ ok: true }) };
  const a = await mutable({ ...base, ttlMs: 0 });
  body = '{"cik":1,"facts":{"a":2}}';
  const b = await mutable({ ...base, ttlMs: 0, now: () => new Date(Date.now() + 1000) });
  assert.notEqual(a.version, b.version);
  assert.equal(store.versions({ market: "us", source: "sec", key: "cf" }).length, 2, "옛 판본 보관");
});
