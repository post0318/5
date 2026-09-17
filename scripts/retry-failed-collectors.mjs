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
 * 자동화하려면 Windows 작업 스케줄러에 하루 1~2회 등록하면 된다.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes("--dry-run");
const HOURS = Number((ARGS.find((a) => a.startsWith("--hours=")) ?? "").split("=")[1]) || 24;

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
    rows = JSON.parse(gh(["run", "list", "--workflow", wf, "--limit", "1", "--json", "conclusion,createdAt"]));
  } catch {
    continue; // 아직 한 번도 안 돈 워크플로 등
  }
  const last = rows[0];
  if (!last || last.conclusion !== "failure") continue;
  if (Date.parse(last.createdAt) < sinceMs) continue;
  failed.push({ wf, script, at: last.createdAt });
}

if (failed.length === 0) {
  console.log("· 다시 돌릴 실패가 없습니다.");
  process.exit(0);
}

console.log(`· 대상 ${failed.length}개:`);
for (const f of failed) console.log(`   ${f.wf} → ${f.script} (${f.at})`);

if (DRY_RUN) {
  console.log("\n--dry-run: 실행 생략");
  process.exit(0);
}

let ok = 0;
let bad = 0;
for (const f of failed) {
  console.log(`\n=== ${f.script}`);
  // 로컬 .env.local 의 CRON_SECRET/APP_PASSWORD 를 각 수집기가 알아서 읽는다.
  const r = spawnSync(process.execPath, [f.script], { cwd: ROOT, stdio: "inherit" });
  if (r.status === 0) {
    ok += 1;
  } else {
    bad += 1;
    console.error(`✗ ${f.script} 실패 (종료코드 ${r.status})`);
  }
}

console.log(`\n▶ 완료 — 성공 ${ok}, 실패 ${bad}`);
// 일부가 또 실패해도 스케줄러가 시끄럽지 않게 0 으로 끝낸다. 위 로그로 확인.
process.exit(0);
