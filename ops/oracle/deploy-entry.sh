#!/usr/bin/env bash
# GitHub 배포 키 전용 입구(2026-10-06, 오너 승인 — GitHub 가 쥔 운영 권한 축소).
# 1호기 ~ubuntu/.ssh/authorized_keys 의 github-actions-deploy 줄이
#   command="/opt/macro/ops/deploy-entry.sh",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding
# 로 이 스크립트에 묶여 있다 — 그 키로는 아래 두 명령만 된다(셸·파일 복사·임의 명령 불가).
#   deploy <40자 커밋>      앱 빌드·재시작(ops/oracle/deploy-app.sh) — deploy-oracle.yml
#   sync-jobs <40자 커밋>   작업 폴더만 그 커밋으로(ops/oracle/post-deploy.sh) — oracle-sync-jobs.yml
# 커밋은 GitHub master 에 이미 들어간 것만 받는다(포크·임의 브랜치 커밋 거부). 거부·수락은 syslog(태그 macro-deploy-entry)에 남는다.
# 이 파일은 배포가 자동으로 바꾸지 않는다 — 고치면 손으로 설치: sudo install -m 755 ops/oracle/deploy-entry.sh /opt/macro/ops/deploy-entry.sh
set -euo pipefail
REQ="${SSH_ORIGINAL_COMMAND:-}"
FROM="${SSH_CLIENT%% *}"
log() { logger -t macro-deploy-entry -- "$*" 2>/dev/null || true; }

if [[ "$REQ" =~ ^(deploy|sync-jobs)\ ([0-9a-f]{40})$ ]]; then
  ACTION="${BASH_REMATCH[1]}"; SHA="${BASH_REMATCH[2]}"
else
  log "거부 from=$FROM 요청=$(printf '%q' "${REQ:0:200}")"
  echo "거부: 허용되지 않은 명령" >&2
  exit 2
fi

case "$ACTION" in
  deploy)    R=/opt/macro/src;  SCRIPT=ops/oracle/deploy-app.sh ;;
  sync-jobs) R=/opt/macro/jobs; SCRIPT=ops/oracle/post-deploy.sh ;;
esac
[ -d "$R/.git" ] || R=/opt/macro/src

if ! git -C "$R" fetch -q origin "+refs/heads/master:refs/remotes/origin/master" "$SHA"; then
  log "거부 from=$FROM $ACTION $SHA (커밋 받기 실패)"
  echo "거부: 커밋을 받을 수 없음" >&2
  exit 3
fi
if ! git -C "$R" merge-base --is-ancestor "$SHA" refs/remotes/origin/master; then
  log "거부 from=$FROM $ACTION $SHA (master 에 없는 커밋)"
  echo "거부: master 에 없는 커밋" >&2
  exit 3
fi
log "수락 from=$FROM $ACTION $SHA"

T=$(mktemp /tmp/macro-entry.XXXXXX)
trap 'rm -f "$T"' EXIT
git -C "$R" show "$SHA:$SCRIPT" > "$T"
bash "$T" "$SHA"
