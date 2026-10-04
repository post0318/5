#!/usr/bin/env node
/**
 * 오류를 조용히 삼키는 catch 금지 검사(오너 지적 2026-10-04 — "조용히 바꾸는 거 저번에 다 정리했는데 또 나왔다고?").
 * 09-26 에 정리한 뒤 10-02 새 20-F·6-K 코드에서 `.catch(() => [])`·내부 catch 가 다시 들어왔다 — 사람 주의가 아니라 lint 로 막는다.
 *
 * 대상: 재무 계산·검증 경로(아래 TARGETS). 잡는 형태:
 *   - `.catch(() => null | [] | "" | '' | {} | ({}) | undefined | 0 | false)` (인자 이름 있어도 같음)
 *   - 본문이 비었거나(주석만 있어도) `return …;` 하나뿐인 `catch {}` / `catch (e) {}`
 * 의도된 예외는 같은 줄 또는 바로 윗줄에 `// silent-ok: <이유>` 가 있을 때만 허용(이유 필수).
 * npm run lint 에 묶여 있다. 실패하면 종료코드 1.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TARGETS = [
  { dir: "scripts", re: /^verify-financials\.mjs$/, deep: false },
  { dir: "scripts/metrics", re: /\.mjs$/, deep: false },
  { dir: "src/lib/fin", re: /\.ts$/, deep: true },
  { dir: "src/lib/markets/us", re: /^edgar.*\.ts$/, deep: false },
  { dir: "src/lib/markets/kr", re: /^dart.*\.ts$/, deep: false },
  { dir: "src/app/api/cron/verify-row", re: /\.ts$/, deep: true },
];
function files() {
  const out = [];
  const walk = (d, re, deep) => {
    if (!existsSync(d)) return;
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { if (deep) walk(p, re, deep); continue; }
      if (re.test(n)) out.push(p);
    }
  };
  for (const t of TARGETS) walk(join(ROOT, t.dir), t.re, t.deep);
  return out;
}
const ARROW = String.raw`(?:\(\s*[\w$]*\s*(?::\s*\w+)?\s*\)|[\w$]+)\s*=>\s*`;
const SILENT_VAL = String.raw`(?:new (?:Map|Set)\(\s*\)|null|\[\s*\]|""|''|\{\s*\}|\(\s*\{\s*\}\s*\)|undefined|0|false)`;
const RE_CATCH_ARROW = new RegExp(String.raw`\.catch\(\s*${ARROW}${SILENT_VAL}\s*\)`, "g");
// catch 블록: 비었거나 주석만, 또는 빈 값·변수 하나를 돌려주는 return 하나(주석 허용) — 함수 호출을 돌려주는 return(jsonError(e) 등)은 대상 아님
const RE_CATCH_BLOCK = new RegExp(String.raw`\bcatch\s*(?:\(\s*[\w$]*\s*(?::\s*\w+)?\s*\))?\s*\{((?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(?:return(?:\s+(?:${SILENT_VAL}|[\w$]+))?\s*;?)?(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*)\}`, "g");

const bad = [];
for (const f of files()) {
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");
  const lineOf = (i) => src.slice(0, i).split("\n").length;
  const ok = (ln) => /\/\/\s*silent-ok:\s*\S/.test(lines[ln - 1] ?? "") || /\/\/\s*silent-ok:\s*\S/.test(lines[ln - 2] ?? "");
  for (const re of [RE_CATCH_ARROW, RE_CATCH_BLOCK]) {
    for (const m of src.matchAll(re)) {
      const ln = lineOf(m.index);
      if (ok(ln)) continue;
      bad.push(`${relative(ROOT, f).split("\\").join("/")}:${ln}  ${m[0].replace(/\s+/g, " ").slice(0, 90)}`);
    }
  }
}
if (bad.length) {
  console.error(`오류를 조용히 삼키는 catch ${bad.length}곳 — 실패를 기록(경고·오류·종료코드)하거나, 정당하면 같은 줄/윗줄에 "// silent-ok: <이유>":`);
  for (const b of bad) console.error(`  ${b}`);
  process.exit(1);
}
console.log("no-silent-catch: 통과");
