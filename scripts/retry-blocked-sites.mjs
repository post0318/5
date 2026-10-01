#!/usr/bin/env node
/**
 * GitHub 실행 서버 IP 가 막힌 사이트 전용 — 이 PC에서 촘촘히 돌린다(오너 지시
 * 2026-09-28 — "bnk kirs 원인확인하고 방법찾아줘" → 로컬 재실행을 더 촘촘하게).
 *
 * 왜 별도 스크립트인가: 기존 retry-failed-collectors.mjs 는 "GitHub 최근 실행이
 * 실패면 재시도"하는 범용 안전망(하루 2회, 13:30/21:00)이라 최대 반나절 공백이
 * 생긴다. BNK투자증권·한국IR협의회(kirs)는 코드 문제가 아니라 망 차단이라 매번
 * 실패가 확정적이므로(실측: BNK 최근 20회 전부, kirs 2회 전부 TCP 연결 자체가
 * 10초 타임아웃 — 403 같은 응답조차 없음. 이 PC 에서는 둘 다 0.2~0.35초에 정상
 * 접속됨) GitHub 실행 결과를 확인할 필요 없이 이 PC 에서 곧장 두 수집기만 돈다.
 * 장중에만 2~3시간 간격으로 실행해 신선도를 높인다 — GitHub 워크플로 자체는
 * 그대로 두고(실패해도 해 없음, 하루 1회 실행 자체가 기록으로 남는 것도 의미
 * 있음), 이 스크립트가 사실상 주 경로가 된다.
 *
 * 쓰는 법: node scripts/retry-blocked-sites.mjs
 * Windows 작업 스케줄러가 장중(08~17시 KST) 2~3시간 간격으로 이 스크립트를
 * 직접 부른다. 로그는 retry-failed-collectors.mjs 와 같은 방식으로
 * logs/retry-collectors.log 에 같이 남긴다(파일을 나누면 확인할 곳만 늘어남).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = ["scripts/collect-bnk-research.mjs", "scripts/collect-kirs-research.mjs"];

/** retry-failed-collectors.mjs 와 동일한 로깅 방식 — 한 로그 파일을 공유한다. */
function startLogging() {
  const dir = path.join(ROOT, "logs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "retry-collectors.log");
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) {
      fs.truncateSync(file, 0);
    }
  } catch {
    // 크기 확인 실패는 무시
  }
  const out = fs.createWriteStream(file, { flags: "a", encoding: "utf8" });
  out.write(`\n===== ${new Date().toISOString()} (blocked-sites)\n`);
  for (const key of ["log", "error"]) {
    const orig = console[key].bind(console);
    console[key] = (...args) => {
      orig(...args);
      out.write(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n");
    };
  }
  return out;
}

function main() {
  console.log(`▶ 망 차단 사이트 전용 실행 — 대상 ${SCRIPTS.length}개: ${SCRIPTS.join(", ")}`);
  let ok = 0;
  let bad = 0;
  for (const script of SCRIPTS) {
    console.log(`\n=== ${script}`);
    const r = spawnSync(process.execPath, [script], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, LANG: "ko_KR.UTF-8" },
    });
    if (r.stdout) console.log(r.stdout.trimEnd());
    if (r.stderr) console.error(r.stderr.trimEnd());
    if (r.status === 0) ok++;
    else {
      bad++;
      console.error(`✗ ${script} 종료코드 ${r.status}`);
    }
  }
  console.log(`\n▶ 완료 — 성공 ${ok}, 실패 ${bad}`);
}

const logStream = startLogging();
try {
  main();
} finally {
  logStream.end();
}
