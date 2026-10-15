// 공유 원본 보관소·형식 검사 시험(설계 10 §7 T5 중 보관소 부분). 실행: node --test scripts/verify/raw/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, existsSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync, crc32 } from "node:zlib";
import { openStore, StoreError } from "../common/store.mjs";
import { checkJson, checkXml, checkZip } from "../common/format.mjs";

const tmpRoot = () => mkdtempSync(join(tmpdir(), "raw-store-test-"));
const anyOk = () => ({ ok: true });

function makeZip(files) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text);
    const comp = deflateRawSync(data);
    const nb = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(data) >>> 0, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc32(data) >>> 0, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nb, comp);
    centrals.push(ch, nb);
    off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

test("형식 검사: JSON·XML·zip 정상과 잘린 파일", () => {
  assert.equal(checkJson(Buffer.from('{"cik":1,"facts":{}}'), (j) => (j.cik && j.facts ? null : "필드 없음")).ok, true);
  assert.equal(checkJson(Buffer.from('{"cik":1,"fa')).ok, false);
  assert.equal(checkJson(Buffer.from('{"cik":1}'), (j) => (j.facts ? null : "facts 없음")).ok, false);
  assert.equal(checkJson(Buffer.from("")).ok, false);
  const xml = '<?xml version="1.0"?><!-- c --><xbrl a="x>y"><b/><c>t<![CDATA[<z>]]></c></xbrl>';
  assert.equal(checkXml(Buffer.from(xml)).ok, true);
  assert.equal(checkXml(Buffer.from(xml.slice(0, xml.length - 4))).ok, false);
  assert.equal(checkXml(Buffer.from("<a><b></a></b>")).ok, false);
  const z = makeZip([["a.xml", "<a/>"], ["b.txt", "hello ".repeat(50)]]);
  assert.equal(checkZip(z).ok, true);
  assert.equal(checkZip(z.subarray(0, z.length - 30)).ok, false, "잘린 zip");
  const broken = Buffer.from(z);
  broken[35] ^= 0xff; // 첫 항목 압축 데이터 한 바이트 변조
  assert.equal(checkZip(broken).ok, false, "CRC/압축 해제 실패를 잡아야 함");
});

test("put/get: 저장·읽기·판본 보관·superseded", () => {
  const root = tmpRoot();
  const s = openStore({ root, actor: "verify" });
  const q = { market: "kr", source: "dart", key: "fnltt_00126380_2023_11011_CFS", ext: "json" };
  s.put({ ...q, version: "20240312000736", buf: Buffer.from('{"status":"000","v":1}'), validate: anyOk });
  s.put({ ...q, version: "20240501000001", buf: Buffer.from('{"status":"000","v":2}'), validate: anyOk, irrecoverable: false });
  assert.equal(JSON.parse(s.get({ ...q, version: "20240312000736" }).buf).v, 1, "옛 판본이 남아 있어야 함");
  assert.equal(JSON.parse(s.get({ ...q, version: "20240501000001" }).buf).v, 2);
  const idx = readFileSync(join(s.dirOf(q.market, q.source, q.key), "index.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(idx.some((r) => r.ev === "superseded" && r.v === "20240312000736"));
  assert.equal(s.latest(q).version, "20240501000001");
});

test("형식 검사 실패는 저장하지 않음", () => {
  const root = tmpRoot();
  const s = openStore({ root, actor: "app" });
  assert.throws(
    () => s.put({ market: "us", source: "sec", key: "k", version: "v", ext: "xml", buf: Buffer.from("<a><b>"), validate: checkXml }),
    (e) => e instanceof StoreError && e.code === "format_rejected",
  );
  assert.equal(existsSync(join(root, "us", "sec", "k", "v.xml")), false);
});

test("같은 판본 다른 내용 = 사고 + 두 파일 격리", () => {
  const root = tmpRoot();
  const s = openStore({ root, actor: "verify" });
  const q = { market: "us", source: "sec", key: "acc/x.xml", version: "0000000000-24-000001", ext: "xml", validate: anyOk };
  s.put({ ...q, buf: Buffer.from("<a>1</a>") });
  const r2 = s.put({ ...q, buf: Buffer.from("<a>1</a>") });
  assert.equal(r2.dup, true, "같은 내용은 그대로");
  assert.throws(() => s.put({ ...q, buf: Buffer.from("<a>2</a>") }), (e) => e.code === "conflict");
  assert.equal(s.get(q), null);
  const qd = readdirSync(join(root, "quarantine", readdirSync(join(root, "quarantine"))[0]));
  assert.equal(qd.filter((n) => !n.endsWith(".reason.json")).length, 2);
});

test("읽을 때 신원 확인 실패·sha 변조 = 격리 + null", () => {
  const root = tmpRoot();
  const s = openStore({ root, actor: "verify" });
  const q = { market: "us", source: "sec", key: "cf", version: "h1", ext: "json" };
  s.put({ ...q, buf: Buffer.from('{"cik":320193}'), validate: anyOk });
  const id = (want) => (buf) => { const j = JSON.parse(buf); return { ok: j.cik === want, got: j.cik }; };
  assert.ok(s.get({ ...q, identity: id(320193) }));
  assert.equal(s.get({ ...q, identity: id(789019) }), null, "엉뚱한 회사 파일");
  assert.ok(s.incidents.some((x) => x.kind === "identity_mismatch"));
  // 다시 저장 후 바이트 변조
  s.put({ ...q, buf: Buffer.from('{"cik":320193}'), validate: anyOk });
  writeFileSync(s.fileOf(q.market, q.source, q.key, q.version, q.ext), '{"cik":320194}');
  assert.equal(s.get(q), null);
  assert.ok(s.incidents.some((x) => x.kind === "sha_mismatch"));
});

test("정리: 상한 넘을 때만, 오래 안 쓴 것부터, 복구 불가 판본 제외", () => {
  const root = tmpRoot();
  const s = openStore({ root, actor: "verify", capBytes: { "kr/dart": 250 } });
  const mk = (key, irrecoverable, ageDays) => {
    const r = s.put({ market: "kr", source: "dart", key, version: "v", ext: "bin", buf: Buffer.alloc(100, 1), validate: anyOk, irrecoverable });
    const t = new Date(Date.now() - ageDays * 864e5);
    utimesSync(r.path, t, t);
  };
  mk("old-irr", true, 300);
  mk("old", false, 200);
  mk("mid", false, 100);
  mk("new", false, 1);
  const r = s.evict("kr", "dart");
  assert.equal(r.evicted, 1);
  assert.equal(existsSync(join(root, "kr", "dart", "old-irr", "v.bin")), true, "복구 불가 판본은 남아야 함");
  assert.equal(existsSync(join(root, "kr", "dart", "old", "v.bin")), false);
  assert.equal(existsSync(join(root, "kr", "dart", "mid", "v.bin")), true);
  assert.ok(readFileSync(join(root, "cache-evictions.jsonl"), "utf8").includes("old"));
  // 상한 안이면 아무것도 안 지움(90일 삭제 없음)
  const r2 = s.evict("kr", "dart");
  assert.equal(r2.evicted, 0);
});
