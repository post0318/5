/**
 * 시험 — 원자료 어댑터 코드에 오류를 조용히 삼키는 catch 가 없는지(감사 10-16 K8: fnltt 실패 catch 에서 실패 기록을 지워도 잡는 시험이 없었다).
 * catch 본문이 비었거나, 실패를 기록·전달하는 말(fail(·throw·failures·Err·err·reason·ok: false·return null + 사유 표시)이 없으면 실패.
 * 의도된 예외는 catch 줄 또는 바로 윗줄에 「// silent-ok: <이유>」.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
function files(d) {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    if (statSync(p).isDirectory()) return n === "test" || n === "golden" ? [] : files(p);
    return /\.mjs$/.test(n) ? [p] : [];
  });
}
// 기록·전달 「동작」만 인정(낱말이 아니라) — 실패 기록 함수 호출·실패 목록 넣기·사고 기록·무조건 다시 던지기. 사유 변수 대입(xbrlErr =·why =)은
// 인정하지 않는다(감사 10-16 3차 ③-4) — 대입한 값을 뒤에서 던지는 곳은 catch 줄에 「// silent-ok: <이유>」.
// 조건부로만 던지는 줄(「if (e?.code === "quota_stop") throw e;」)은 지우고 본다 — 그 밖의 오류는 삼키기 때문(감사 10-16 2차 K8b:
// 실패 기록을 그 줄로 바꿔도 「throw」 낱말 때문에 통과했다)
const RECORD = /\bfail\(|\bfailures\.push\(|\bfailed\.push\(|\bmissingDates\.push\(|\bnote\(|\bincident\(|\bbad\(|\bnoSrc\+\+|\bthrow\b/;
/** 본문에서 조건부 문장(if (…) 문장; / if (…) { … })을 지운다 — 무조건 실행되는 것만 남김 */
export function unconditional(body) {
  let out = "", i = 0;
  while (i < body.length) {
    const m = /\bif\s*\(/g;
    m.lastIndex = i;
    const h = m.exec(body);
    if (!h) { out += body.slice(i); break; }
    out += body.slice(i, h.index);
    let j = h.index + h[0].length, d = 1;
    while (j < body.length && d) { if (body[j] === "(") d++; else if (body[j] === ")") d--; j++; }
    while (/\s/.test(body[j] ?? "")) j++;
    if (body[j] === "{") { let e = 1; j++; while (j < body.length && e) { if (body[j] === "{") e++; else if (body[j] === "}") e--; j++; } }
    else { while (j < body.length && body[j] !== ";" && body[j] !== "\n") j++; j++; }
    // else 가지도 조건부
    const rest = /^\s*else\s*/.exec(body.slice(j));
    if (rest) { j += rest[0].length; if (body[j] === "{") { let e = 1; j++; while (j < body.length && e) { if (body[j] === "{") e++; else if (body[j] === "}") e--; j++; } } else if (!/^if\b/.test(body.slice(j))) { while (j < body.length && body[j] !== ";" && body[j] !== "\n") j++; j++; } }
    i = j;
  }
  return out;
}

test("t8 판정기 자체: 조건부로만 던지고 나머지를 삼키는 catch 는 잡는다(심은 K8b)", () => {
  assert.equal(RECORD.test(unconditional(` if (e?.code === "quota_stop") throw e; `)), false);
  assert.equal(RECORD.test(unconditional(` if (e?.code === "quota_stop") { throw e; } `)), false);
  assert.equal(RECORD.test(unconditional(` if (e?.code === "quota_stop") throw e; fail("x", e); `)), true);
  assert.equal(RECORD.test(unconditional(` if (e?.code === "ENOENT") return {}; throw e; `)), true);
  assert.equal(RECORD.test(unconditional(` const reason = "x"; return null; `)), false, "낱말(reason)만으로는 기록이 아니다");
  assert.equal(RECORD.test(unconditional(` x = { code: "a" }; `)), false, "code: 낱말만으로는 기록이 아니다");
  // 사유 변수 대입만으로는 기록이 아니다 — kr/adapter XBRL 조회 실패 catch 에서 fail("xbrl") 을 지우고 xbrlErr 대입만 남겨도 통과했다(감사 10-16 3차 ③-4)
  assert.equal(RECORD.test(unconditional(` xbrlErr = String(e.message).slice(0, 160); `)), false, "xbrlErr = 대입만으로는 기록이 아니다");
  assert.equal(RECORD.test(unconditional(` why = "x"; `)), false, "why = 대입만으로는 기록이 아니다");
});

test("원자료 어댑터: 조용히 삼키는 catch 없음", () => {
  const bad = [];
  for (const f of files(ROOT)) {
    const src = readFileSync(f, "utf8");
    const lines = src.split("\n");
    // try { … } catch (e) { 본문 } — 본문은 짝 맞는 중괄호까지
    for (const m of src.matchAll(/catch\s*(?:\(\s*\w*\s*\))?\s*\{/g)) {
      let depth = 1, i = m.index + m[0].length;
      while (i < src.length && depth) { if (src[i] === "{") depth++; else if (src[i] === "}") depth--; i++; }
      const body = src.slice(m.index + m[0].length, i - 1);
      const line = src.slice(0, m.index).split("\n").length;
      const near = `${lines[line - 2] ?? ""}\n${lines[line - 1] ?? ""}`;
      if (/silent-ok:\s*\S/.test(near)) continue;
      const code = body.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
      if (!code.trim() || !RECORD.test(unconditional(code))) bad.push(`${f.slice(ROOT.length)}:${line} catch {${body.trim().slice(0, 60)}}`);
    }
    for (const m of src.matchAll(/\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(null|undefined|\[\]|\{\}|\(\{\}\)|""|0|false)\s*\)/g)) {
      const line = src.slice(0, m.index).split("\n").length;
      const near = `${lines[line - 2] ?? ""}\n${lines[line - 1] ?? ""}`;
      if (!/silent-ok:\s*\S/.test(near)) bad.push(`${f.slice(ROOT.length)}:${line} ${m[0]}`);
    }
  }
  assert.deepEqual(bad, [], `조용한 catch ${bad.length}곳:\n${bad.join("\n")}`);
});
