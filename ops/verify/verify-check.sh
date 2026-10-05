#!/usr/bin/env bash
# 2호기 자동 검증(auto-verify.mjs) 점검 — 종료코드 0 = 정상, 1 = 이상(이유를 한 줄 출력).
#  마지막 실행 기록이 있고 30시간 안 · 실행 실패(적재·검증 프로세스 오류, 결과 미저장) 0 · DART 하루 예산 초과 아님 ·
#  latest.json 이 있고 30시간 안. (실패 "항목"이 있는 종목은 검증 결과일 뿐 실행 이상이 아니다 — latest.json 에서 본다)
# 사용: macro-verify-check   (root·ubuntu 모두)
set -u
D=${MACRO_VERIFY_DIR:-/var/lib/macro-verify}
MAX_AGE=${MAX_AGE:-108000}
f=$D/last-run.json
[[ -r $f ]] || { echo "자동 검증 실행 기록 없음"; exit 1; }
age() { echo $(( $(date +%s) - $(date -d "$1" +%s 2>/dev/null || echo 0) )); }
fin=$(sed -n 's/.*"finishedAt": "\([^"]*\)".*/\1/p' "$f" | head -1)
a=$(age "$fin")
(( a <= MAX_AGE )) || { echo "마지막 자동 검증이 $((a / 3600))시간 전"; exit 1; }
rf=$(sed -n 's/.*"runFailed": \([0-9]*\).*/\1/p' "$f" | head -1)
(( ${rf:-1} == 0 )) || { echo "실행 실패 ${rf:-?}건 — $(sed -n 's/.*"log": "\([^"]*\)".*/\1/p' "$f")"; exit 1; }
grep -q '"exceeded": true' "$f" && { echo "DART 하루 예산 초과: $(grep -o '"after": [0-9]*' "$f" | head -1)"; exit 1; }
l=$D/latest.json
[[ -r $l ]] || { echo "latest.json 없음"; exit 1; }
gen=$(sed -n 's/.*"generatedAt": "\([^"]*\)".*/\1/p' "$l" | head -1)
(( $(age "$gen") <= MAX_AGE )) || { echo "latest.json 이 오래됨($gen)"; exit 1; }
def=$(grep -o '"deferred": [0-9]*' "$l" | head -1 | grep -o '[0-9]*$')
echo "정상 — 마지막 자동 검증 $((a / 60))분 전, 미룬 종목 ${def:-0}"
