/**
 * 로컬 야간배치 오케스트레이터 — Windows 작업 스케줄러에서 이거 하나만 실행.
 *
 * OpenDART XBRL·네이버 등 일부 소스는 Vercel(데이터센터 IP)을 차단해 서버 크론으로
 * 못 가져온다 → 개인 PC 에서 하루 1회 수집해 DB/앱에 반영한다 (CLAUDE.md 예외 승인 범위).
 *
 * 실행하는 것:
 *   1) collect-foreign-fut.mjs  — 외국인 코스피200 선물 순매수 (네이버, 앱 POST)
 *   2) populate-kr-da.mjs       — 한국 종목 감가상각비·무형자산상각비 (DART XBRL 주석, MongoDB)
 *
 * ── Windows 작업 스케줄러 (일 1회, 예: 08:00) ──────────────────────────
 *   프로그램:  "C:\Program Files\nodejs\node.exe"
 *   인수:      scripts\nightly.mjs
 *   시작 위치: C:\Users\infomax\5
 *   (로그) 인수를 cmd /c "…\node.exe scripts\nightly.mjs >> scripts\.nightly.log 2>&1" 로 감싸도 됨
 *
 * 개별 실행: node scripts/nightly.mjs --only=da        (da | fut)
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").split("=")[1] || null;

/** 스크립트 하나를 돌리고, 실패해도 다음으로 넘어간다 (배치 전체가 죽지 않도록). */
function run(script, args = []) {
  return new Promise((resolve) => {
    const label = script.replace(/\.mjs$/, "");
    console.log(`\n── ${label} ${args.join(" ")} ─────────────────────────`);
    const p = spawn(process.execPath, [join(here, script), ...args], { stdio: "inherit" });
    p.on("close", (code) => {
      console.log(`── ${label} 종료 (code ${code})`);
      resolve(code);
    });
    p.on("error", (e) => {
      console.error(`── ${label} 실행 실패: ${e.message}`);
      resolve(1);
    });
  });
}

const started = new Date().toISOString();
console.log(`야간배치 시작 ${started}`);

let failures = 0;
if (!only || only === "fut") failures += (await run("collect-foreign-fut.mjs")) ? 1 : 0;
if (!only || only === "da") failures += (await run("populate-kr-da.mjs")) ? 1 : 0;

console.log(`\n야간배치 완료 (실패 ${failures}건) — ${new Date().toISOString()}`);
process.exit(failures ? 1 : 0);
