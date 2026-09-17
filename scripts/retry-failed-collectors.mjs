#!/usr/bin/env node
/**
 * 깃허브에서 실패한 수집을 이 PC 에서 다시 돌린다 (오너 지시 2026-09-17 —
 * "깃허브로 하되 실패하면 로컬로 실행하는 건?").
 *
 * 왜 필요한가: 일부 증권사 서버가 깃허브 러너 아이피를 막는다(실측 2026-09 —
 * BNK 는 9/14 부터 8회 연속, 신한 해외는 간헐적으로 `UND_ERR_CONNECT_TIMEOUT`.
 * 같은 주소가 로컬에서는 0.1초에 열린다). 코드 문제가 아니라 망 문제라 재시도
 * 횟수를 늘려도 안 풀린다. 그래서 평소엔 깃허브가 돌리고, 막힌 것만 이 PC 가
 * 뒤에서 한 번 더 시도한다.
 *
 * 쓰는 법:
 *   node scripts/retry-failed-collectors.mjs            최근 24시간 실패분 재실행
 *   node scripts/retry-failed-collectors.mjs --hours=48
 *   node scripts/retry-failed-collectors.mjs --dry-run  대상만 출력
 *
 * 필요한 것: GitHub CLI(`gh`) 로그인. 이미 이 저장소에서 쓰고 있다.
 *
 * Windows 작업 스케줄러가 하루 2회(13:30 / 21:00) 이 스크립트를 직접 부른다.
 * 스케줄러는 출력을 리다이렉트할 수 없어서 **로그를 여기서 직접 남긴다**
 * (`logs/retry-collectors.log`). 배치 파일 래퍼를 쓰다가 날짜 파싱·PATH
 * 처리에서 깨져(실측 2026-09-17, 종료코드 255에 로그조차 안 남음) 없앴다.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes("--dry-run");
const HOURS = Number((ARGS.find((a) => a.startsWith("--hours=")) ?? "").split("=")[1]) || 24;

/**
 * 콘솔 출력을 파일에도 남긴다. 스케줄러로 돌 때는 화면이 없어 이 로그가 유일한
 * 기록이다. 한 파일에 덧붙이되 2MB 를 넘으면 잘라 다시 시작한다.
 */
function startLogging() {
  const dir = path.join(ROOT, "logs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "retry-collectors.log");
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) {
      fs.truncateSync(file, 0);
    }
  } catch {
    // 크기 확인 실패는 무시 — 로그가 조금 길어질 뿐
  }
  // 한글이 깨지지 않게 UTF-8 로 고정한다. 하위 수집기 출력도 아래에서 같은
  // 인코딩으로 받는다 — 스케줄러로 돌면 콘솔 코드페이지가 949 라 기본값으로
  // 두면 로그가 전부 깨진다(실측 2026-09-17).
  const out = fs.createWriteStream(file, { flags: "a", encoding: "utf8" });
  out.write(`\n===== ${new Date().toISOString()}\n`);
  for (const key of ["log", "error"]) {
    const orig = console[key].bind(console);
    console[key] = (...args) => {
      orig(...args);
      out.write(
        args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n",
      );
    };
  }
  return out;
}

/** 워크플로 파일에서 실제 실행하는 수집 스크립트를 읽어 짝을 만든다. */
function workflowScriptMap() {
  const dir = path.join(ROOT, ".github", "workflows");
  const map = new Map();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".yml"))) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    const m = text.match(/node\s+(scripts\/[\w-]+\.mjs)/);
    if (m) map.set(f, m[1]);
  }
  return map;
}

function gh(args) {
  return execFileSync("gh", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
}

function findFailed() {
  const map = workflowScriptMap();
  const sinceMs = Date.now() - HOURS * 3600_000;
  console.log(`▶ 최근 ${HOURS}시간 실패한 수집을 찾습니다 (워크플로 ${map.size}개)`);

  const failed = [];
  for (const [wf, script] of map) {
    // 텔레그램은 5시간 반짜리 장시간 루프라 취소(cancelled)가 정상이고,
    // 로컬에서 다시 돌릴 성질도 아니다.
    if (wf === "telegram-posts.yml") continue;
    let rows;
    try {
      rows = JSON.parse(
        gh(["run", "list", "--workflow", wf, "--limit", "1", "--json", "conclusion,createdAt"]),
      );
    } catch {
      continue; // 아직 한 번도 안 돈 워크플로 등
    }
    const last = rows[0];
    if (!last || last.conclusion !== "failure") continue;
    if (Date.parse(last.createdAt) < sinceMs) continue;
    failed.push({ wf, script, at: last.createdAt });
  }
  return failed;
}

function main() {
  const failed = findFailed();
  if (failed.length === 0) {
    console.log("· 다시 돌릴 실패가 없습니다.");
    return;
  }

  console.log(`· 대상 ${failed.length}개:`);
  for (const f of failed) console.log(`   ${f.wf} → ${f.script} (${f.at})`);

  if (DRY_RUN) {
    console.log("\n--dry-run: 실행 생략");
    return;
  }

  let ok = 0;
  let bad = 0;
  for (const f of failed) {
    console.log(`\n=== ${f.script}`);
    // 로컬 .env.local 의 CRON_SECRET/APP_PASSWORD 를 각 수집기가 알아서 읽는다.
    // 하위 수집기 출력도 로그 파일에 남도록 받아서 다시 찍는다.
    const r = spawnSync(process.execPath, [f.script], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      // 자식 노드도 UTF-8 로 출력하게 맞춘다(스케줄러 환경의 기본 코드페이지
      // 949 때문에 한글이 깨지던 문제)
      env: { ...process.env, PYTHONIOENCODING: "utf-8", LANG: "ko_KR.UTF-8" },
    });
    const text = `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd();
    if (text) console.log(text);
    if (r.status === 0) {
      ok += 1;
    } else {
      bad += 1;
      console.error(`✗ ${f.script} 실패 (종료코드 ${r.status})`);
    }
  }

  console.log(`\n▶ 완료 — 성공 ${ok}, 실패 ${bad}`);
}

const logStream = startLogging();
try {
  main();
} catch (err) {
  console.error("✗ 재실행 도구 자체가 실패:", err?.message ?? err);
} finally {
  logStream.end();
}
// 일부가 또 실패해도 스케줄러가 시끄럽지 않게 0 으로 끝낸다. 위 로그로 확인.
process.exitCode = 0;
