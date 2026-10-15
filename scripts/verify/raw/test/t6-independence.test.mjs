// 시험 T6(설계 10 §7-6) 독립성 정적 검사 — ① 코드가 앱 코드·앱 데이터·앱 캐시(파생)를 읽지 않는지, 원본을 읽는 곳이 신원 확인을 거치는지.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
function files(d) {
  const out = [];
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) { if (n !== "test") out.push(...files(p)); }
    else if (n.endsWith(".mjs")) out.push(p);
  }
  return out;
}
const SRC = files(ROOT).map((p) => ({ p: p.slice(ROOT.length + 1), s: readFileSync(p, "utf8") }));

test("앱 코드(src/)를 import 하지 않는다", () => {
  for (const { p, s } of SRC) {
    for (const m of s.matchAll(/(?:import|from)\s*\(?\s*["']([^"']+)["']/g)) {
      assert.ok(!/(^|\/)src\//.test(m[1]) && !/^@\//.test(m[1]), `${p}: ${m[1]}`);
    }
  }
});

test("앱 데이터 파일·앱 캐시 폴더 경로를 쓰지 않는다(들여오기 스크립트만 예외 — 원본을 하드링크로 들여올 뿐 판독하지 않음)", () => {
  const BAD = /src\/lib|corpcodes\.json|market-calendar\.ts|["'`/]\.cache\b|\/opt\/macro/;
  const APP_CACHE = /sec-cache|dart-cache|edinet-cache/;
  for (const { p, s } of SRC) {
    const code = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.ok(!BAD.test(code), `${p}: 앱 경로 ${code.match(BAD)?.[0]}`);
    if (p !== "import-legacy.mjs") assert.ok(!APP_CACHE.test(code), `${p}: 앱 캐시 경로 ${code.match(APP_CACHE)?.[0]}`);
  }
});

test("원천 받기는 모두 신원 확인을 넘긴다(immutable/mutable 호출마다 identity)", () => {
  for (const { p, s } of SRC) {
    if (!/^((us|kr|jp)\/(sec|dart|krx|edinet)|common\/market-global)\.mjs$/.test(p)) continue;
    const calls = [...s.matchAll(/\b(immutable|mutable)\(\{/g)];
    for (const c of calls) {
      // 호출 블록(다음 '});' 까지)에 identity 가 있어야 한다 — 단 KRX 휴장일·일별은 저장 전 형식 검사 + 날짜 판본(내용에 신원 칸 없음)
      const block = s.slice(c.index, s.indexOf("});", c.index));
      assert.ok(/\bidentity\b/.test(block), `${p}: ${c[1]} 호출에 identity 없음 @${c.index}`);
    }
  }
});

test("옛 사본 대체 없음(D16) — fetchstore 가 실패 시 보관본을 돌려주는 경로가 없다", () => {
  const fs = SRC.find((x) => x.p === "common/fetchstore.mjs").s;
  assert.ok(!/catch\s*\([^)]*\)\s*\{[^}]*store\.get/.test(fs), "실패 후 보관본 읽기 경로");
});
