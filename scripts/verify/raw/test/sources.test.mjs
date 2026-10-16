// 원천 받기 시험(가짜 응답 — 외부 요청 없음). 실행: node --test scripts/verify/raw/test/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../common/store.mjs";
import { identityFor, makeSec, secUserAgent } from "../us/sec.mjs";
import { makeDart } from "../kr/dart.mjs";
import { makeEdinet } from "../jp/edinet.mjs";
import { makeKrx } from "../kr/krx.mjs";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "raw-src-test-"));
  return { root, store: openStore({ root, actor: "verify" }), quotaRoot: join(root, "quota") };
}
/** 경로 → 응답 함수 표로 가짜 fetch. 호출 기록 남김 */
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init) => {
    calls.push(String(url));
    for (const [re, h] of routes) if (re.test(String(url))) return h(url, init);
    throw new Error(`연결 막힘: ${url}`);
  };
  f.calls = calls;
  return f;
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
const env = { SEC_USER_AGENT: "test post0318@gmail.com" };

test("SEC: 자리표시자 UA 면 실행 거부(D17)", () => {
  assert.throws(() => secUserAgent({ SEC_USER_AGENT: "x contact@example.com" }));
  assert.throws(() => secUserAgent({}));
  assert.equal(secUserAgent(env), env.SEC_USER_AGENT);
});

test("SEC companyfacts: 두 번째는 보관본(요청 0), 새로 받기 실패면 옛 사본 안 씀(D16)", async () => {
  const { store, quotaRoot } = setup();
  let n = 0;
  const f = fakeFetch([[/companyfacts/, () => (n++ === 0 ? json({ cik: 320193, facts: { a: 1 } }) : new Response("", { status: 503 }))]]);
  const t = Date.now();
  const sec = makeSec({ store, quotaRoot, fetchImpl: f, env });
  const r1 = await sec.companyfacts("320193");
  assert.equal(r1.json.cik, 320193);
  const r2 = await sec.companyfacts("0000320193");
  assert.equal(r2.fromStore, true);
  assert.equal(f.calls.length, 1, "두 번째 실행 요청 0");
  // 12시간 지난 뒤 — 새로 받기 실패(503 재시도 소진) → 옛 사본으로 대신하지 않고 실패
  const { mutable } = await import("../common/fetchstore.mjs");
  await assert.rejects(
    mutable({ store, req: sec.req, market: "us", source: "sec", key: "companyfacts_CIK0000320193", ext: "json", url: "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json", ttlMs: 0, validate: () => ({ ok: true }), now: () => new Date(t + 13 * 3600e3) }),
    (e) => e.code === "fetch_failed",
  );
});

test("SEC companyfacts: 엉뚱한 회사 응답이면 신원 실패", async () => {
  const { store, quotaRoot } = setup();
  const f = fakeFetch([[/companyfacts/, () => json({ cik: 789019, facts: {} })]]);
  const sec = makeSec({ store, quotaRoot, fetchImpl: f, env });
  await assert.rejects(sec.companyfacts("320193"), (e) => e.name === "IdentityFailed");
  assert.ok(store.incidents.some((x) => x.kind === "identity_mismatch"));
});

test("SEC archive: 잘린 XML 은 저장하지 않고 실패", async () => {
  const { store, quotaRoot } = setup();
  const f = fakeFetch([[/Archives/, () => new Response('<xbrl><dei:EntityCentralIndexKey>0000320193</dei:EntityCentralIndexKey><a>')]]);
  const sec = makeSec({ store, quotaRoot, fetchImpl: f, env });
  await assert.rejects(sec.archive("320193", "0000320193-24-000123", "aapl-20240928_htm.xml"), (e) => e.code === "fetch_failed");
});

test("DART: 013 은 판본과 함께 저장, 020 은 전체 중단, 하루 상한", async () => {
  const { store, quotaRoot } = setup();
  let mode = "013";
  const f = fakeFetch([[/opendart/, () => (mode === "013" ? json({ status: "013", message: "없음" }) : json({ status: "020", message: "한도" }))]]);
  const dart = makeDart({ store, quotaRoot, key: "K", fetchImpl: f, cap: 3 });
  const a = await dart.fnltt("00126380", 2026, "11011", "CFS", null);
  assert.equal(a.json.status, "013");
  const b = await dart.fnltt("00126380", 2026, "11011", "CFS", null);
  assert.equal(b.fromStore, true);
  mode = "020";
  await assert.rejects(dart.fnltt("00126380", 2025, "11011", "CFS", "20260301000001"), (e) => e.code === "quota_stop" && e.kind === "020");
  await assert.rejects(dart.fnltt("00126380", 2024, "11011", "CFS", "20250301000001"), (e) => e.code === "quota_stop", "중단 뒤 요청 없음");
  assert.equal(f.calls.length, 2);
  // 상한
  const s2 = setup();
  const f2 = fakeFetch([[/opendart/, () => json({ status: "013" })]]);
  const d2 = makeDart({ store: s2.store, quotaRoot: s2.quotaRoot, key: "K", fetchImpl: f2, cap: 2 });
  await d2.alot("00126380", 2021, "11011", null);
  await d2.alot("00126380", 2022, "11011", null);
  await assert.rejects(d2.alot("00126380", 2023, "11011", null), (e) => e.code === "quota_stop" && e.kind === "cap");
});

test("DART: 정정 공시(새 접수번호) = 새 판본 추가, 옛 판본 보관·복구 불가 표시", async () => {
  const { store, quotaRoot } = setup();
  let rc = "20240312000736";
  const f = fakeFetch([[/opendart/, () => json({ status: "000", list: [{ corp_code: "00126380", rcept_no: rc, v: rc }] })]]);
  const dart = makeDart({ store, quotaRoot, key: "K", fetchImpl: f });
  await dart.fnltt("00126380", 2023, "11011", "CFS", rc);
  rc = "20240501000099";
  await dart.fnltt("00126380", 2023, "11011", "CFS", rc);
  const vs = store.versions({ market: "kr", source: "dart", key: "fnltt_00126380_2023_11011_CFS" });
  assert.deepEqual(vs.map((v) => v.v), ["20240312000736", "20240501000099"]);
  assert.ok(vs.every((v) => v.irrecoverable));
});

test("EDINET: 최근 2일 목록은 저장 안 함, 확정일은 저장, 건수 불일치는 실패", async () => {
  const { store, quotaRoot } = setup();
  const lst = (date, n, cnt = n) => json({ metadata: { status: "200", parameter: { date, type: "2" }, resultset: { count: cnt } }, results: Array.from({ length: n }, () => ({ submitDateTime: `${date} 09:00` })) });
  const f = fakeFetch([[/date=2026-10-14/, () => lst("2026-10-14", 2)], [/date=2026-10-01/, () => lst("2026-10-01", 3)], [/date=2026-10-02/, () => lst("2026-10-02", 3, 4)]]);
  const ed = makeEdinet({ store, quotaRoot, key: "K", fetchImpl: f, now: () => new Date("2026-10-15T03:00:00Z") });
  assert.equal((await ed.dayList("2026-10-14")).final, false);
  await ed.dayList("2026-10-14");
  assert.equal(f.calls.filter((u) => u.includes("2026-10-14")).length, 2, "최근 날짜는 매번 받음");
  await ed.dayList("2026-10-01");
  assert.equal((await ed.dayList("2026-10-01")).fromStore, true);
  await assert.rejects(ed.dayList("2026-10-02"), (e) => e.code === "fetch_failed");
});

test("EDINET 목록: 다른 날짜 응답이면 신원 실패(그 날짜 목록이 아님)", async () => {
  const { store, quotaRoot } = setup();
  const f = fakeFetch([[/date=2026-10-01/, () => json({ metadata: { status: "200", parameter: { date: "2026-09-30", type: "2" }, resultset: { count: 0 } }, results: [] })]]);
  const ed = makeEdinet({ store, quotaRoot, key: "K", fetchImpl: f, now: () => new Date("2026-10-15T03:00:00Z") });
  await assert.rejects(ed.dayList("2026-10-01"), (e) => e.name === "IdentityFailed");
});

test("EDINET 서류: HTTP 200 + JSON 오류는 실패", async () => {
  const { store, quotaRoot } = setup();
  const f = fakeFetch([[/documents\/S100ABCD/, () => json({ metadata: { status: "404", message: "Not Found" } })]]);
  const ed = makeEdinet({ store, quotaRoot, key: "K", fetchImpl: f });
  await assert.rejects(ed.docZip("S100ABCD"), (e) => e.code === "fetch_failed" && /404/.test(e.message));
});

test("KRX: 빈 응답·오늘 응답은 저장 안 함, 지난 날짜 행 있는 응답만 저장", async () => {
  const { store, quotaRoot } = setup();
  const f = fakeFetch([[/basDd=20261013/, () => json({ OutBlock_1: [{ ISU_CD: "005930" }] })], [/basDd=20261014/, () => json({ OutBlock_1: [] })]]);
  const krx = makeKrx({ store, quotaRoot, key: "K", fetchImpl: f, now: () => new Date("2026-10-15T03:00:00Z") });
  assert.equal((await krx.day("stk_bydd_trd", "20261013")).stored, true);
  assert.equal((await krx.day("stk_bydd_trd", "20261013")).fromStore, true);
  const e = await krx.day("stk_bydd_trd", "20261014");
  assert.equal(e.stored, false);
  assert.equal(e.rows.length, 0);
  assert.equal(f.calls.length, 2);
});

test("SEC 인스턴스 신원: 같은 회사라도 서류 종류·기간 끝이 다르면 실패(감사 10-16 ③-5)", () => {
  const inst = (dt, pe) => Buffer.from(`<xbrl><dei:EntityCentralIndexKey contextRef="c">0000320193</dei:EntityCentralIndexKey><dei:DocumentType contextRef="c">${dt}</dei:DocumentType><dei:DocumentPeriodEndDate contextRef="c">${pe}</dei:DocumentPeriodEndDate></xbrl>`);
  const id = identityFor({ cik: "320193", a18: "000032019325000079", file: "aapl-20250927_htm.xml", ext: "xml", expect: { form: "10-K", periodEnd: "2025-09-27" } });
  assert.equal(id(inst("10-K", "2025-09-27")).ok, true);
  assert.equal(id(inst("10-Q", "2025-06-28")).ok, false, "10-Q 인스턴스가 10-K 열쇠로 들어오면 실패");
  assert.equal(id(inst("10-K", "2024-09-28")).ok, false, "다른 해 10-K 면 실패");
  assert.equal(id(inst("10-K/A", "2025-09-27")).ok, true, "정정본은 원 종류로");
  // 종류만 다르고 기간 끝은 같은 경우 — 기간 확인이 대신 잡지 못하게(감사 10-16 2차 U8: 종류 확인을 꺼도 위 사례는 기간 확인이 잡아 통과했다)
  assert.equal(id(inst("10-Q", "2025-09-27")).ok, false, "같은 기간 끝의 10-Q 인스턴스가 10-K 열쇠로 오면 실패");
  assert.equal(id(inst("20-F", "2025-09-27")).ok, false, "같은 기간 끝의 20-F 면 실패");
  const idOther = identityFor({ cik: "320193", a18: "000032019325000079", file: "x_htm.xml", ext: "xml", expect: { form: "10-K", periodEnd: "2025-09-27" } });
  assert.equal(idOther(Buffer.from(`<dei:EntityCentralIndexKey>0000789019</dei:EntityCentralIndexKey>`)).ok, false, "다른 회사");
});

/** 시험용 zip(crcOverride 를 주면 그 CRC 를 적는다 — 압축은 정상, CRC 만 틀린 파일) */
function makeZip(files, crcOverride = null) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text), comp = deflateRawSync(data), nb = Buffer.from(name);
    const crc = crcOverride ?? (crc32(data) >>> 0);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, comp); centrals.push(ch, nb);
    off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

test("EDINET 서류 신원: 같은 회사라도 서류 종류·연간 기간 끝이 다르면 실패(감사 10-16 ③-5)", async () => {
  const xb = (kind, pe) => makeZip([[`XBRL/PublicDoc/jpcrp030000-${kind}-001_E02529-000_${pe}_01_2025-06-20.xbrl`, "<xbrli:xbrl/>"]]);
  const run = async (buf, expect) => {
    const { store, quotaRoot } = setup();
    const f = fakeFetch([[/documents\/S100ABCD/, () => new Response(buf, { status: 200 })]]);
    return makeEdinet({ store, quotaRoot, key: "K", fetchImpl: f }).docZip("S100ABCD", "E02529", expect);
  };
  await run(xb("asr", "2025-03-31"), { form: "120", periodEnd: "2025-03-31" });
  await assert.rejects(run(xb("q2r", "2024-09-30"), { form: "120", periodEnd: "2025-03-31" }), "半期 서류가 有報 열쇠로 오면 실패");
  await assert.rejects(run(xb("asr", "2024-03-31"), { form: "120", periodEnd: "2025-03-31" }), "다른 해 有報면 실패");
  // 종류만 다른 경우(파일명 날짜는 같음) — 기간 확인이 대신 잡지 못하게(감사 10-16 2차 J9)
  await assert.rejects(run(xb("q2r", "2025-03-31"), { form: "120", periodEnd: "2025-03-31" }), "같은 날짜의 半期 서류가 有報 열쇠로 오면 실패");
  await assert.rejects(run(xb("asr", "2025-09-30"), { form: "160", periodEnd: "2026-03-31" }), "有報가 半期 열쇠로 오면 실패");
  await assert.rejects(run(xb("q1r", "2025-06-30"), { form: "160", periodEnd: "2026-03-31" }), "四半期 1분기가 半期 열쇠로 오면 실패");
  await run(xb("q2r", "2025-09-30"), { form: "160", periodEnd: "2026-03-31" }); // 半期 = q2r 허용, 기간 끝은 연간만 확인
});

test("DART fnltt 신원: 행의 사업연도·보고서 종류가 요청과 다르면 실패(감사 10-16 ③-5)", async () => {
  const { store, quotaRoot } = setup();
  const row = (y, c) => ({ rcept_no: "20250301000001", corp_code: "00126380", bsns_year: y, reprt_code: c, account_id: "x", thstrm_amount: "1" });
  let body = { status: "000", list: [row("2024", "11011")] };
  const f = fakeFetch([[/opendart/, () => json(body)]]);
  const dart = makeDart({ store, quotaRoot, key: "K", fetchImpl: f });
  await assert.rejects(dart.fnltt("00126380", 2025, "11011", "CFS", "20260301000001"), "2024 행이 2025 요청으로 오면 실패");
  body = { status: "000", list: [row("2025", "11012")] };
  await assert.rejects(dart.fnltt("00126380", 2025, "11011", "CFS", "20260301000002"), "반기 행이 사업보고서 요청으로 오면 실패");
  // 회사 — 첫 행만이 아니라 모든 행(감사 10-16 2차 C6: 첫 행 확인을 꺼도 모든 행 확인이 같은 것을 잡아 시험이 구분하지 못했다 → 한 검사로 합침)
  body = { status: "000", list: [row("2025", "11011"), { ...row("2025", "11011"), corp_code: "00164779" }] };
  await assert.rejects(dart.fnltt("00126380", 2025, "11011", "CFS", "20260301000004"), "둘째 행이 다른 회사면 실패");
  body = { status: "000", list: [{ ...row("2025", "11011"), corp_code: "00164779" }] };
  await assert.rejects(dart.fnltt("00126380", 2025, "11011", "CFS", "20260301000005"), "첫 행이 다른 회사면 실패");
  body = { status: "000", list: [{ ...row("2025", "11011"), corp_code: undefined }] };
  await assert.rejects(dart.fnltt("00126380", 2025, "11011", "CFS", "20260301000006"), "회사 칸이 없으면 실패(확인 불가를 통과로 치지 않음)");
  body = { status: "000", list: [row("2025", "11011")] };
  const ok = await dart.fnltt("00126380", 2025, "11011", "CFS", "20260301000003");
  assert.equal(ok.json.status, "000");
});
