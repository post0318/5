// 시험 — 일본 판독 구조 규칙(감사 10-16 2차: 심은 J2·J10 을 잡는 사례가 없었다). 외부 요청 없음, 합성 서류.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, crc32 } from "node:zlib";
import { docFacts } from "../jp/read.mjs";
import { cashCfEndItems } from "../jp/items.mjs";

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
const ctx = `<xbrli:context id="CurrentYearDuration"><xbrli:entity><xbrli:identifier scheme="x">E00001-000</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2025-04-01</xbrli:startDate><xbrli:endDate>2026-03-31</xbrli:endDate></xbrli:period></xbrli:context><xbrli:unit id="JPY"><xbrli:measure>iso4217:JPY</xbrli:measure></xbrli:unit>`;
const inst = `<xbrli:xbrl>${ctx}<jppfs_cor:NetSales contextRef="CurrentYearDuration" unitRef="JPY" decimals="-6">1000000000</jppfs_cor:NetSales><jppfs_cor:ProfitLoss contextRef="CurrentYearDuration" unitRef="JPY" decimals="-6">50000000</jppfs_cor:ProfitLoss></xbrli:xbrl>`;
const role = (name, lines) => `<link:presentationLink xlink:type="extended" xlink:role="http://disclosure.edinet-fsa.go.jp/role/jppfs/${name}">`
  + `<link:loc xlink:type="locator" xlink:href="x.xsd#jppfs_cor_Root" xlink:label="root"/>`
  + lines.map((l, i) => `<link:loc xlink:type="locator" xlink:href="x.xsd#jppfs_cor_${l}" xlink:label="l${i}"/><link:presentationArc xlink:type="arc" xlink:from="root" xlink:to="l${i}" order="${i + 1}"/>`).join("")
  + `</link:presentationLink>`;
const doc = (roles) => zip([["XBRL/PublicDoc/jpcrp030000-asr-001_E00001-000_2026-03-31_01_2026-06-20.xbrl", inst], ["XBRL/PublicDoc/x_pre.xml", `<link:linkbase>${roles.join("")}</link:linkbase>`]]);
const filing = { id: "S100TEST", form: "120", filed_at: "2026-06-20", parent: null };

test("일본 한 표 서식 판정(J2): 손익 역할이 있으면 包括利益 역할을 손익으로 바꾸지 않는다", () => {
  const both = docFacts(doc([role("rol_ConsolidatedStatementOfIncome", ["NetSales", "ProfitLoss"]), role("rol_ConsolidatedStatementOfComprehensiveIncome", ["NetSales", "ProfitLoss"])]), { sym: "0000", filing });
  assert.equal(both.roles.filter((r) => r.combined).length, 0, "손익 역할이 따로 있는데 包括利益 역할이 한 표로 바뀌면 안 됨");
  assert.equal(both.roles.filter((r) => r.stmt === "is").length, 1);
  const only = docFacts(doc([role("rol_ConsolidatedStatementOfComprehensiveIncome", ["NetSales", "ProfitLoss"])]), { sym: "0000", filing });
  assert.equal(only.roles.filter((r) => r.combined && r.stmt === "is").length, 1, "손익 역할이 없으면 한 표(8002 형)로 본다");
});

test("일본 현금흐름표 기말 현금(J10): 같은 서류·범위·기말에 값이 둘이면 모호, 하나면 값", () => {
  const f = (v, ctxRef) => ({ concept: { id: "jppfs_cor:CashAndCashEquivalents", label: null }, filing: { id: "S1", form: "120", filed_at: "2026-06-20" }, scope: { consolidation: "consolidated", dims: [] },
    period: { kind: "instant", start: null, end: "2026-03-31" }, value: { num: v }, placement: { face: true, stmts: [{ stmt: "cf", preferredLabel: "periodEndLabel" }] }, locator: { contextRef: ctxRef } });
  const two = cashCfEndItems([f("100", "a"), f("120", "b")]);
  assert.equal(two.length, 1);
  assert.equal(two[0].value, null);
  assert.equal(two[0].blank_reason, "ambiguous");
  const one = cashCfEndItems([f("100", "a"), f("100", "b")]);
  assert.equal(one[0].value, "100");
});
