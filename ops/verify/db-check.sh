#!/usr/bin/env bash
# 2호기 검증 DB·DB 백업 점검 — 종료코드 0 = 정상, 1 = 이상(이유를 한 줄 출력).
#  mongod 실행 중 · 로컬 응답(ping) · 마지막 매일 복사(db-sync.sh)가 성공했고 26시간 안 ·
#  그 백업 파일이 1MB 이상이고 gzip 이 온전함.
# 사용: macro-db-check — root 가 아니면(백업 폴더 700) 복사 때 확인해 상태 파일에 남긴 크기만 보고,
#  root(sudo)면 파일을 직접 다시 확인한다(gzip -t, 크기, 존재).
set -u
MAX_AGE=${MAX_AGE:-93600}
MIN_BYTES=1048576
systemctl is-active --quiet mongod || { echo "mongod 정지"; exit 1; }
[[ $(mongosh --quiet --eval 'db.runCommand({ping:1}).ok' 2>/dev/null) == 1 ]] || { echo "mongod 응답 없음"; exit 1; }
f=/var/lib/macro-db/last-sync.json
[[ -r $f ]] || { echo "복사 기록 없음"; exit 1; }
grep -q '"ok":true' "$f" || { echo "마지막 복사 실패: $(cat "$f")"; exit 1; }
ep=$(sed -n 's/.*"epoch":\([0-9]*\).*/\1/p' "$f")
age=$(( $(date +%s) - ${ep:-0} ))
(( age <= MAX_AGE )) || { echo "마지막 성공 복사가 $((age / 3600))시간 전"; exit 1; }
arc=$(sed -n 's/.*"archive":"\([^"]*\)".*/\1/p' "$f")
bytes=$(sed -n 's/.*"bytes":\([0-9]*\).*/\1/p' "$f")
(( ${bytes:-0} >= MIN_BYTES )) || { echo "백업 파일 크기 ${bytes:-?} B(1MB 미만): $arc"; exit 1; }
if [[ $EUID -eq 0 ]]; then
  [[ -f $arc ]] || { echo "백업 파일 없음: $arc"; exit 1; }
  (( $(stat -c %s "$arc") >= MIN_BYTES )) || { echo "백업 파일 1MB 미만: $arc"; exit 1; }
  gzip -t "$arc" 2>/dev/null || { echo "백업 파일 손상(gzip -t): $arc"; exit 1; }
fi
echo "정상 — 마지막 복사·백업 $((age / 60))분 전, $((bytes / 1048576))MB$([[ $EUID -eq 0 ]] && echo ', 파일 직접 확인')"
