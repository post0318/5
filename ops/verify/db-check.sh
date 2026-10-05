#!/usr/bin/env bash
# 2호기 검증 DB 점검 — 종료코드 0 = 정상, 1 = 이상(이유를 한 줄 출력).
#  mongod 실행 중 · 로컬 응답(ping) · 마지막 매일 복사(db-sync.sh)가 성공했고 26시간 안.
# 사용: macro-db-check   (root 불필요 — 상태 파일은 644, ping 은 인증 없이 된다)
set -u
MAX_AGE=${MAX_AGE:-93600}
systemctl is-active --quiet mongod || { echo "mongod 정지"; exit 1; }
[[ $(mongosh --quiet --eval 'db.runCommand({ping:1}).ok' 2>/dev/null) == 1 ]] || { echo "mongod 응답 없음"; exit 1; }
f=/var/lib/macro-db/last-sync.json
[[ -r $f ]] || { echo "복사 기록 없음"; exit 1; }
grep -q '"ok":true' "$f" || { echo "마지막 복사 실패: $(cat "$f")"; exit 1; }
ep=$(sed -n 's/.*"epoch":\([0-9]*\).*/\1/p' "$f")
age=$(( $(date +%s) - ${ep:-0} ))
(( age <= MAX_AGE )) || { echo "마지막 성공 복사가 $((age / 3600))시간 전"; exit 1; }
echo "정상 — 마지막 복사 $((age / 60))분 전"
