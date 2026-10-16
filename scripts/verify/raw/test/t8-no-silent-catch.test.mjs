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
const RECORD = /\bfail\(|\bthrow\b|failures|failed\.push|note\(|noSrc\+\+|Err\b|err\b|Err =|why =|reason|ok: false|incident|bad\(|code:/;

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
      if (!body.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").trim() || !RECORD.test(body)) bad.push(`${f.slice(ROOT.length)}:${line} catch {${body.trim().slice(0, 60)}}`);
    }
    for (const m of src.matchAll(/\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*(null|undefined|\[\]|\{\}|\(\{\}\)|""|0|false)\s*\)/g)) {
      const line = src.slice(0, m.index).split("\n").length;
      const near = `${lines[line - 2] ?? ""}\n${lines[line - 1] ?? ""}`;
      if (!/silent-ok:\s*\S/.test(near)) bad.push(`${f.slice(ROOT.length)}:${line} ${m[0]}`);
    }
  }
  assert.deepEqual(bad, [], `조용한 catch ${bad.length}곳:\n${bad.join("\n")}`);
});
